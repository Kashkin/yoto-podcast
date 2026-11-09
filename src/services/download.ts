import { createWriteStream, readdirSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

export function sanitizeTitle(title: string): string {
  return title
    .replace(/[/:?*"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function formatFilename(number: number, title: string, pad = 2): string {
  const clean = sanitizeTitle(title);
  return `${String(number).padStart(pad, '0')} - ${clean}.mp3`;
}

// A missing directory is empty, but any other error (e.g. macOS denying access
// to Box) must throw - treating it as empty re-downloads the latest episode.
function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

export function detectPadWidth(dir: string): number {
  for (const file of listDir(dir)) {
    if (!file.endsWith('.mp3')) continue;
    const match = file.match(/^(\d+)/);
    if (match) return match[1].length;
  }
  return 2;
}

export function getHighestEpisodeNumber(dir: string): number {
  let highest = 0;
  for (const file of listDir(dir)) {
    if (!file.endsWith('.mp3')) continue;
    const match = file.match(/^(\d+)/);
    if (match) {
      const num = parseInt(match[1], 10);
      if (num > highest) highest = num;
    }
  }
  return highest;
}

export function getLocalTitles(dir: string): string[] {
  return listDir(dir)
    .filter((file) => file.endsWith('.mp3') && /^\d+ - /.test(file))
    .map((file) => file.replace(/^\d+ - /, '').replace(/\.mp3$/, ''));
}

export async function downloadEpisode(
  url: string,
  outputPath: string
): Promise<void> {
  const tmpPath = `${outputPath}.tmp`;
  try {
    const response = await fetch(url);
    if (!response.ok || !response.body) {
      throw new Error(`Download failed: ${response.status}`);
    }
    const fileStream = createWriteStream(tmpPath);
    await pipeline(Readable.fromWeb(response.body as never), fileStream);
    renameSync(tmpPath, outputPath);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}
