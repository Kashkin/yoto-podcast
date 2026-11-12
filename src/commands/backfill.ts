import { parseFeed, normalizeTitle } from '../services/feed.js';
import { formatFilename, detectPadWidth, downloadEpisode, getLocalEpisodes } from '../services/download.js';
import { mkdirSync } from 'node:fs';
import { notify } from '../services/notify.js';
import { createYotoService, DEFAULT_ICON, type UploadedTrack } from '../services/yoto.js';
import { replaceChapters } from '../services/card-edit.js';
import type { YotoCard } from '../types.js';
import { uploadTracks } from '../services/batch.js';
import { getValidTokens } from './auth.js';
import type { Paths } from './myo.js';

interface BackfillOptions {
  feed: string;
  dir: string;
  name: string;
  card?: string;
  dryRun?: boolean;
}

type CardApi = {
  uploadAudioFile: (path: string, log?: (msg: string) => void) => Promise<UploadedTrack>;
  getCard: (cardId: string) => Promise<YotoCard>;
  saveIfUnchanged: (before: YotoCard, after: YotoCard) => Promise<unknown>;
};

// Replaces the card's chapters with these episodes, newest first. Every upload must
// succeed first: the card is replaced whole, so a partial set would drop episodes.
export async function pushToCard(yoto: CardApi, cardId: string, files: { title: string; path: string }[]): Promise<void> {
  console.log(`\nUploading ${files.length} episodes to Yoto...`);
  const tracks = await uploadTracks(files, (path, log) => yoto.uploadAudioFile(path, log), { ifFailed: 'the card was left as it was' });
  const chapters = files.map((f, i) => ({ title: f.title, track: tracks[i], icon: DEFAULT_ICON })).reverse();
  console.log(`\nSetting ${chapters.length} chapters on card ${cardId}...`);
  const before = await yoto.getCard(cardId);
  await yoto.saveIfUnchanged(before, replaceChapters(before, chapters));
  console.log('Card updated.');
}

export async function runBackfill(options: BackfillOptions, paths: Paths): Promise<void> {
  const { feed, dir, name, card: cardId, dryRun = false } = options;

  if (!dryRun) mkdirSync(dir, { recursive: true });

  console.log(`Fetching feed for: ${name}`);
  const res = await fetch(feed);
  if (!res.ok) throw new Error(`Failed to fetch feed: ${res.status}`);

  const xml = await res.text();
  const episodes = parseFeed(xml);

  if (episodes.length === 0) {
    throw new Error('No episodes found in feed');
  }

  // Episodes are newest-first; reverse for chronological download
  const chronological = [...episodes].reverse();
  // Files already here are matched by title and keep their names, so a feed that has grown
  // or dropped old episodes doesn't download them again under new numbers
  const local = new Map<string, string[]>();
  for (const e of getLocalEpisodes(dir)) {
    const key = normalizeTitle(e.title);
    local.set(key, [...(local.get(key) ?? []), e.file]);
  }
  const pad = local.size ? detectPadWidth(dir) : Math.max(2, String(chronological.length).length);

  // Step 1: Download missing files
  console.log(`Found ${episodes.length} episodes. Downloading missing files...`);
  let downloaded = 0;
  let failed = 0;
  const filePaths: { title: string; path: string }[] = [];

  for (let i = 0; i < chronological.length; i++) {
    const ep = chronological[i];
    const existing = local.get(normalizeTitle(ep.title))?.shift();
    const filename = existing ?? formatFilename(i + 1, ep.title, pad);
    const outputPath = `${dir}/${filename}`;

    if (existing) {
      console.log(`  Exists: ${filename}`);
      filePaths.push({ title: filename.replace(/\.mp3$/, ''), path: outputPath });
      continue;
    }
    if (dryRun) {
      console.log(`  Would download: ${filename}`);
      filePaths.push({ title: filename.replace(/\.mp3$/, ''), path: outputPath });
      downloaded++;
      continue;
    }

    try {
      console.log(`  Downloading: ${filename}`);
      await downloadEpisode(ep.url, outputPath);
      console.log(`  Done: ${filename}`);
      filePaths.push({ title: filename.replace(/\.mp3$/, ''), path: outputPath });
      downloaded++;
    } catch {
      console.error(`  ERROR: Failed to download ${filename}`);
      failed++;
    }
  }

  console.log(`\n${dryRun ? 'Would download' : 'Downloads:'} ${downloaded} new, ${filePaths.length - downloaded} existed, ${failed} failed.`);
  if (dryRun) {
    if (cardId) {
      console.log(`\nWould replace every chapter on card ${cardId} with these ${filePaths.length} episode(s) and reset their icons to the default:`);
      for (const f of [...filePaths].reverse()) console.log(`  ${f.title}`);
    }
    return;
  }

  // Step 2: Upload to Yoto if card ID provided
  if (cardId) {
    if (failed > 0) {
      throw new Error(`${failed} episode(s) failed to download, so the card was left as it was. Run again to retry them.`);
    }
    const tokens = await getValidTokens(paths.configPath, paths.tokensPath);
    if (!tokens) {
      console.error('No Yoto tokens found. Run `yoto-podcast auth` first.');
      return;
    }
    await pushToCard(createYotoService(tokens.accessToken), cardId, filePaths);
  }

  console.log(`\nBackfill complete.`);
  notify('Podcast Backfill', `Backfilled ${filePaths.length} episodes of ${name}`);
}
