import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Tinker Icons (https://developers.tinker.audio/docs): 16x16 story icons, searched by name,
// misspelling or meaning. 500 searches a day; the CDN needs no key.
const API = 'https://api.tinker.audio/icons';
const CDN = 'https://cdn.tinker.audio/icons';

const run = promisify(execFile);

export interface TinkerIcon {
  id: string;
  name: string;
  url: string;
}

// `tinker:<id>` or the icon's CDN URL
export function parseTinkerId(ref: string): string | null {
  const match = ref.match(/^tinker:([0-9a-f-]+)$/i) ?? ref.match(/^https:\/\/cdn\.tinker\.audio\/icons\/([0-9a-f-]+)\.png$/i);
  return match ? match[1] : null;
}

// TINKER_API_KEY from .env: the key itself, or an op:// reference read from 1Password
export async function tinkerKey(read: (ref: string) => Promise<string> = opRead): Promise<string> {
  const key = process.env.TINKER_API_KEY;
  if (!key) throw new Error('Set TINKER_API_KEY in .env to your Tinker key or its op:// reference (see .env.example)');
  return key.startsWith('op://') ? read(key) : key;
}

async function opRead(ref: string): Promise<string> {
  const { stdout } = await run('op', ['read', ref]);
  return stdout.trim();
}

export async function searchTinker(query: string, limit = 20, key?: string): Promise<TinkerIcon[]> {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  const res = await fetch(`${API}?${params}`, { headers: { 'X-Tinker-Key': key ?? (await tinkerKey()) } });
  const body = (await res.json().catch(() => ({}))) as { results?: TinkerIcon[]; error?: string };
  if (!res.ok) {
    const retry = res.headers.get('retry-after');
    throw new Error(`Tinker search failed (${res.status}): ${body.error ?? res.statusText}${retry ? ` Try again in ${retry} s.` : ''}`);
  }
  return body.results ?? [];
}

export async function downloadTinkerIcon(id: string): Promise<Buffer> {
  const res = await fetch(`${CDN}/${id}.png`);
  if (!res.ok) throw new Error(`Tinker icon ${id} not found (${res.status}); it may have left the library`);
  return Buffer.from(await res.arrayBuffer());
}

// A PNG of the icons at 4x on grey, ten to a row in result order, for choosing by eye
export async function writeTinkerSheet(icons: TinkerIcon[], out: string): Promise<void> {
  const work = mkdtempSync(join(tmpdir(), 'yoto-tinker-sheet-'));
  try {
    await Promise.all(
      icons.map(async (icon, i) => {
        const res = await fetch(icon.url);
        if (!res.ok) throw new Error(`Could not download ${icon.url} (${res.status})`);
        writeFileSync(join(work, `${String(i).padStart(3, '0')}.png`), Buffer.from(await res.arrayBuffer()));
      })
    );
    const cols = Math.min(icons.length, 10);
    const rows = Math.ceil(icons.length / 10);
    await run('ffmpeg', [
      '-v', 'error', '-y', '-start_number', '0', '-i', join(work, '%03d.png'),
      '-filter_complex',
      `[0]scale=64:64:flags=neighbor,pad=72:72:4:4:color=0xBBBBBB@0,tile=${cols}x${rows}:color=0xBBBBBB@0[t];` +
        `color=c=0xBBBBBB:s=${cols * 72}x${rows * 72}[bg];[bg][t]overlay=shortest=1,format=rgb24`,
      '-frames:v', '1', out,
    ]);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
