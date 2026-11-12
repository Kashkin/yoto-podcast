import { mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { AppConfig, PodcastConfig, FeedEpisode, YotoCard } from '../types.js';
import { DEFAULT_ICON, type UploadedTrack } from '../services/yoto.js';
import { addChapter } from '../services/card-edit.js';
import { parseFeed, normalizeTitle, shouldSkip } from '../services/feed.js';
import {
  getHighestEpisodeNumber,
  getLocalTitles,
  getLocalEpisodes,
  formatFilename,
  detectPadWidth,
  downloadEpisode,
} from '../services/download.js';
import { notify } from '../services/notify.js';

interface CheckResult {
  name: string;
  newEpisodes: FeedEpisode[];
  skipped: FeedEpisode[];
  errors: string[];
}

// More new episodes than this in one run usually means the feed was reset or
// retitled, not that the show really released them all.
const MAX_NEW_EPISODES = 5;

async function checkPodcast(
  podcast: PodcastConfig,
  { force = false } = {}
): Promise<CheckResult> {
  const result: CheckResult = {
    name: podcast.name,
    newEpisodes: [],
    skipped: [],
    errors: [],
  };

  // Fetch feed. An unreachable feed is reported, not thrown, so the other podcasts still run.
  let res: Response;
  try {
    res = await fetch(podcast.feedUrl);
  } catch (err) {
    result.errors.push(`Failed to fetch feed: ${err instanceof Error ? err.message : String(err)}`);
    return result;
  }
  if (!res.ok) {
    result.errors.push(`Failed to fetch feed: ${res.status}`);
    return result;
  }

  const xml = await res.text();
  const episodes = parseFeed(xml);
  if (episodes.length === 0) {
    result.errors.push('No episodes in feed');
    return result;
  }

  const highestNum = getHighestEpisodeNumber(podcast.directory);
  const localTitles = new Set(getLocalTitles(podcast.directory).map(normalizeTitle));

  // Find new episodes: walk from newest until we hit any local episode, so one
  // retitled episode in the feed can't trigger a full re-download
  const newEpisodes: FeedEpisode[] = [];
  for (const ep of episodes) {
    if (localTitles.has(normalizeTitle(ep.title))) break;
    newEpisodes.push(ep);
  }

  // If no local episodes exist, only take the latest one
  if (highestNum === 0 && newEpisodes.length > 0) {
    newEpisodes.splice(1);
  }

  // Filter out skip patterns, process oldest first
  for (const ep of [...newEpisodes].reverse()) {
    if (shouldSkip(ep.title, podcast.skipPatterns ?? [])) {
      result.skipped.push(ep);
      continue;
    }
    result.newEpisodes.push(ep);
  }

  if (!force && result.newEpisodes.length > MAX_NEW_EPISODES) {
    const count = result.newEpisodes.length;
    result.errors.push(
      `${count} new episodes found (limit ${MAX_NEW_EPISODES}) - feed may have been reset. ` +
        'Not downloading; run `check --force` if they are real.'
    );
    notify(`Podcast: ${podcast.name}`, `${count} new episodes looks wrong - skipped. Check the feed.`);
    result.newEpisodes = [];
  }

  return result;
}

async function downloadNewEpisodes(
  podcast: PodcastConfig,
  episodes: FeedEpisode[]
): Promise<{ downloaded: string[]; errors: string[] }> {
  const downloaded: string[] = [];
  const errors: string[] = [];
  mkdirSync(podcast.directory, { recursive: true });
  let nextNum = getHighestEpisodeNumber(podcast.directory) + 1;
  const pad = detectPadWidth(podcast.directory);

  for (const ep of episodes) {
    const filename = formatFilename(nextNum, ep.title, pad);
    const outputPath = `${podcast.directory}/${filename}`;

    try {
      console.log(`  Downloading: ${filename}`);
      await downloadEpisode(ep.url, outputPath);
      console.log(`  Done: ${filename}`);
      downloaded.push(outputPath);
      notify(`Podcast: ${podcast.name}`, `New episode: ${ep.title}`);
      nextNum++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${ep.title}: ${msg}`);
      // The next run stops at the newest local episode, so a newer download would hide this one for good
      break;
    }
  }

  return { downloaded, errors };
}

type PushApi = {
  getCard: (cardId: string) => Promise<YotoCard>;
  uploadAudioFile: (path: string) => Promise<UploadedTrack>;
  saveIfUnchanged: (before: YotoCard, after: YotoCard) => Promise<unknown>;
};

// Pushes every local episode numbered above the highest-numbered chapter on the card, oldest
// first, so an episode a failed run left on disk goes up on the next one. A card with no
// numbered chapters gets only this run's downloads.
async function pushNewEpisodes(
  yoto: PushApi,
  podcast: PodcastConfig,
  downloaded: string[],
  force: boolean
): Promise<{ pushed: string[]; error?: string }> {
  const pushed: string[] = [];
  try {
    const card = await yoto.getCard(podcast.cardId);
    // The highest number anywhere on the card: some cards are kept oldest first
    const onCard = card.content.chapters.flatMap((c) => c.title.match(/^(\d+) - /)?.[1] ?? []).map(Number);
    const pending = onCard.length
      ? getLocalEpisodes(podcast.directory)
          .filter((e) => e.number > Math.max(...onCard))
          .map((e) => join(podcast.directory, e.file))
      : downloaded;
    if (!force && pending.length > MAX_NEW_EPISODES) {
      throw new Error(`${pending.length} episodes on disk are missing from the card (limit ${MAX_NEW_EPISODES}); run \`check --force\` or backfill`);
    }
    for (const path of pending) {
      const title = basename(path, '.mp3');
      console.log(`  Uploading to Yoto: ${title}`);
      const track = await yoto.uploadAudioFile(path);
      // Read again after the upload, which takes minutes, so the new chapter goes on the card as it is now
      const before = await yoto.getCard(podcast.cardId);
      await yoto.saveIfUnchanged(before, addChapter(before, { title, track, icon: DEFAULT_ICON }, 1));
      console.log(`  Pushed to card: ${title}`);
      pushed.push(title);
    }
    return { pushed };
  } catch (err) {
    const error = `Not pushed to Yoto: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`  ${error}`);
    notify(`Podcast: ${podcast.name}`, error);
    return { pushed, error };
  }
}

export interface PodcastResult {
  name: string;
  downloaded: string[]; // files saved this run
  pushed: string[]; // chapter titles put on the card this run
  errors: string[];
}

// One check of every podcast: find its new episodes, download them, and push to its card
// whatever the card lacks. `yoto` is null when there is no valid token; episodes still
// download. A podcast that fails is reported in its result and the rest still run.
export async function runCheck(config: AppConfig, yoto: PushApi | null, { force = false } = {}): Promise<PodcastResult[]> {
  console.log(`Checking ${config.podcasts.length} podcast(s)...`);
  const results: PodcastResult[] = [];
  for (const podcast of config.podcasts) {
    console.log(`\n=== ${podcast.name} ===`);
    const result: PodcastResult = { name: podcast.name, downloaded: [], pushed: [], errors: [] };
    results.push(result);
    try {
      const found = await checkPodcast(podcast, { force });
      if (found.errors.length > 0) {
        console.error(`  Errors: ${found.errors.join(', ')}`);
        result.errors.push(...found.errors);
        continue;
      }
      for (const ep of found.skipped) console.log(`  Skipping (matched skip pattern): ${ep.title}`);

      if (found.newEpisodes.length === 0) {
        console.log('  Up to date');
      } else {
        console.log(`  Found ${found.newEpisodes.length} new episode(s)`);
        const download = await downloadNewEpisodes(podcast, found.newEpisodes);
        result.downloaded = download.downloaded;
        if (download.errors.length > 0) {
          console.error(`  Download errors: ${download.errors.join(', ')}`);
          result.errors.push(...download.errors);
        }
      }

      // Runs even when the feed has nothing new, to push episodes an earlier run left on disk
      if (yoto && podcast.cardId) {
        const push = await pushNewEpisodes(yoto, podcast, result.downloaded, force);
        result.pushed = push.pushed;
        if (push.error) result.errors.push(push.error);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  Check failed: ${msg}`);
      notify(`Podcast: ${podcast.name}`, `Check failed: ${msg}`);
      result.errors.push(msg);
    }
  }
  return results;
}
