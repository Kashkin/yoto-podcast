import { mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { PodcastConfig, FeedEpisode, YotoCard } from '../types.js';
import type { UploadedTrack } from '../services/yoto.js';
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

export interface CheckResult {
  name: string;
  newEpisodes: FeedEpisode[];
  skipped: FeedEpisode[];
  errors: string[];
}

// More new episodes than this in one run usually means the feed was reset or
// retitled, not that the show really released them all.
const MAX_NEW_EPISODES = 5;

export async function checkPodcast(
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

export async function downloadNewEpisodes(
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
  prependTrackToCard: (cardId: string, title: string, track: UploadedTrack) => Promise<void>;
};

// Pushes every local episode numbered above the highest-numbered chapter on the card, oldest
// first, so an episode a failed run left on disk goes up on the next one. A card with no
// numbered chapters gets only this run's downloads. Returns the titles pushed.
export async function pushNewEpisodes(yoto: PushApi, podcast: PodcastConfig, downloaded: string[]): Promise<string[]> {
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
    if (pending.length > MAX_NEW_EPISODES) {
      throw new Error(`${pending.length} episodes on disk are missing from the card (limit ${MAX_NEW_EPISODES}); use backfill`);
    }
    for (const path of pending) {
      const title = basename(path, '.mp3');
      console.log(`  Uploading to Yoto: ${title}`);
      await yoto.prependTrackToCard(podcast.cardId, title, await yoto.uploadAudioFile(path));
      console.log(`  Pushed to card: ${title}`);
      pushed.push(title);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  Yoto push failed: ${msg}`);
    notify(`Podcast: ${podcast.name}`, `Not pushed to Yoto: ${msg}`);
  }
  return pushed;
}
