import type { PodcastConfig, FeedEpisode } from '../types.js';
import { parseFeed, normalizeTitle, shouldSkip } from '../services/feed.js';
import {
  getHighestEpisodeNumber,
  getLocalTitles,
  formatFilename,
  detectPadWidth,
  downloadEpisode,
} from '../services/download.js';
import { notify } from '../services/notify.js';

export interface CheckResult {
  name: string;
  newEpisodes: FeedEpisode[];
  skipped: FeedEpisode[];
  downloaded: string[];
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
    downloaded: [],
    errors: [],
  };

  // Fetch feed
  const res = await fetch(podcast.feedUrl);
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
    }
  }

  return { downloaded, errors };
}
