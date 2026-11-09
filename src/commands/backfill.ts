import { parseFeed } from '../services/feed.js';
import { formatFilename, detectPadWidth, downloadEpisode } from '../services/download.js';
import { mkdirSync, existsSync } from 'node:fs';
import { notify } from '../services/notify.js';
import { createYotoService, type UploadedTrack } from '../services/yoto.js';
import { uploadTracks } from '../services/batch.js';
import { getValidTokens } from './auth.js';
import type { Paths } from './myo.js';

interface BackfillOptions {
  feed: string;
  dir: string;
  name: string;
  card?: string;
}

type CardApi = {
  uploadAudioFile: (path: string, log?: (msg: string) => void) => Promise<UploadedTrack>;
  setCardChapters: (cardId: string, chapters: { title: string; track: UploadedTrack }[]) => Promise<void>;
};

// Replaces the card's chapters with these episodes, newest first. Every upload must
// succeed first: the card is replaced whole, so a partial set would drop episodes.
export async function pushToCard(yoto: CardApi, cardId: string, files: { title: string; path: string }[]): Promise<void> {
  console.log(`\nUploading ${files.length} episodes to Yoto...`);
  const tracks = await uploadTracks(files, (path, log) => yoto.uploadAudioFile(path, log), { ifFailed: 'the card was left as it was' });
  const chapters = files.map((f, i) => ({ title: f.title, track: tracks[i] })).reverse();
  console.log(`\nSetting ${chapters.length} chapters on card ${cardId}...`);
  await yoto.setCardChapters(cardId, chapters);
  console.log('Card updated.');
}

export async function runBackfill(options: BackfillOptions, paths: Paths): Promise<void> {
  const { feed, dir, name, card: cardId } = options;

  mkdirSync(dir, { recursive: true });

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
  const pad = Math.max(detectPadWidth(dir), String(chronological.length).length);

  // Step 1: Download missing files
  console.log(`Found ${episodes.length} episodes. Downloading missing files...`);
  let downloaded = 0;
  let failed = 0;
  const filePaths: { title: string; path: string }[] = [];

  for (let i = 0; i < chronological.length; i++) {
    const ep = chronological[i];
    const epNum = i + 1;
    const filename = formatFilename(epNum, ep.title, pad);
    const outputPath = `${dir}/${filename}`;

    if (existsSync(outputPath)) {
      console.log(`  Exists: ${filename}`);
      filePaths.push({ title: filename.replace(/\.mp3$/, ''), path: outputPath });
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

  console.log(`\nDownloads: ${downloaded} new, ${filePaths.length - downloaded} existed, ${failed} failed.`);

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
