import { parseFeed } from '../services/feed.js';
import { formatFilename, detectPadWidth, downloadEpisode } from '../services/download.js';
import { mkdirSync, existsSync } from 'node:fs';
import { notify } from '../services/notify.js';
import { createYotoService } from '../services/yoto.js';
import { mapLimit, UPLOAD_CONCURRENCY } from '../services/batch.js';
import { loadTokens } from '../config.js';
import { join } from 'node:path';
import { homedir } from 'node:os';

interface BackfillOptions {
  feed: string;
  dir: string;
  name: string;
  card?: string;
}

export async function runBackfill(options: BackfillOptions): Promise<void> {
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
    const tokensPath = join(homedir(), '.config', 'yoto-podcast', 'tokens.json');
    const tokens = loadTokens(tokensPath);
    if (!tokens) {
      console.error('No Yoto tokens found. Run `yoto-podcast auth` first.');
      return;
    }

    const yoto = createYotoService(tokens.accessToken);
    console.log(`\nUploading ${filePaths.length} episodes to Yoto...`);

    const chapters: { title: string; track: Awaited<ReturnType<typeof yoto.uploadAudioFile>> }[] = [];

    // A few at a time; results stay in episode order. Failures are skipped, as before.
    const results = await mapLimit(filePaths, UPLOAD_CONCURRENCY, (file) =>
      yoto.uploadAudioFile(file.path, (msg) => console.log(`  ${file.title}: ${msg.trim()}`))
    );
    results.forEach((r, i) => {
      const file = filePaths[i];
      if (r.status === 'fulfilled') {
        chapters.push({ title: file.title, track: r.value });
      } else {
        const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
        console.error(`  ERROR uploading ${file.title}: ${msg}`);
      }
    });

    // Newest first on the card
    chapters.reverse();

    console.log(`\nSetting ${chapters.length} chapters on card ${cardId}...`);
    await yoto.setCardChapters(cardId, chapters);
    console.log('Card updated.');
  }

  console.log(`\nBackfill complete.`);
  notify('Podcast Backfill', `Backfilled ${filePaths.length} episodes of ${name}`);
}
