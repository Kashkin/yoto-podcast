import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// Nick's own uploaded icons have no names, so duplicates are found by
// comparing pixels. Yoto re-encodes uploads, so the bytes differ even when
// the picture is the same. A media ID is a hash of the stored PNG, so a
// cached key per ID never goes stale.

export interface UserIcon {
  mediaId: string;
  url: string;
  createdAt?: string;
}

// YOTO_ICON_CACHE lets tests use a scratch file
const cachePath = () => process.env.YOTO_ICON_CACHE ?? join(homedir(), 'Library', 'Caches', 'yoto-podcast', 'icon-pixels.json');

function ffmpegPipe(args: string[], input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', ['-v', 'error', ...args]);
    const out: Buffer[] = [];
    let err = '';
    proc.stdout.on('data', (d) => out.push(d));
    proc.stderr.on('data', (d) => (err += d));
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg: ${err.trim()}`))));
    proc.stdin.end(input);
  });
}

// Fully transparent pixels can carry any colour; zero them so they compare equal.
export function normalisePixels(rgba: Buffer): Buffer {
  const out = Buffer.from(rgba);
  for (let i = 0; i < out.length; i += 4) if (out[i + 3] === 0) out.fill(0, i, i + 3);
  return out;
}

// Hash of the image's pixels at 16x16 (Yoto's icon size).
export async function iconPixelKey(image: Buffer): Promise<string> {
  const rgba = await ffmpegPipe(
    ['-i', 'pipe:0', '-frames:v', '1', '-vf', 'scale=16:16:flags=neighbor', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'],
    image
  );
  return createHash('sha256').update(normalisePixels(rgba)).digest('hex');
}

function loadCache(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(cachePath(), 'utf8'));
  } catch {
    return {};
  }
}

export function rememberIconKey(mediaId: string, key: string): void {
  const cache = loadCache();
  cache[mediaId] = key;
  mkdirSync(dirname(cachePath()), { recursive: true });
  writeFileSync(cachePath(), JSON.stringify(cache));
}

// Pixel key for each icon, downloading only the ones not seen before.
export async function userIconKeys(icons: UserIcon[], log = console.log): Promise<Map<string, string>> {
  const cache = loadCache();
  const todo = icons.filter((i) => !cache[i.mediaId]);
  if (todo.length) log(`Checking ${todo.length} icon(s) in your library (cached after this)...`);
  for (let i = 0; i < todo.length; i += 8) {
    await Promise.all(
      todo.slice(i, i + 8).map(async (icon) => {
        const res = await fetch(icon.url);
        if (!res.ok) return; // skip; it'll be retried next time
        cache[icon.mediaId] = await iconPixelKey(Buffer.from(await res.arrayBuffer()));
      })
    );
  }
  if (todo.length) {
    mkdirSync(dirname(cachePath()), { recursive: true });
    writeFileSync(cachePath(), JSON.stringify(cache));
  }
  return new Map(icons.filter((i) => cache[i.mediaId]).map((i) => [i.mediaId, cache[i.mediaId]]));
}

export function duplicateGroups(keys: Map<string, string>): string[][] {
  const byKey = new Map<string, string[]>();
  for (const [id, key] of keys) byKey.set(key, [...(byKey.get(key) ?? []), id]);
  return [...byKey.values()].filter((ids) => ids.length > 1);
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// A page to pick icons by sight: newest first, click to copy the reference.
export function renderContactSheet(icons: UserIcon[], duplicates: string[][]): string {
  const dupOf = new Map(duplicates.flatMap((ids, g) => ids.map((id) => [id, g + 1] as const)));
  const sorted = [...icons].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  const tiles = sorted
    .map((icon) => {
      const ref = `yoto:#${icon.mediaId}`;
      const dup = dupOf.get(icon.mediaId);
      return `<button class="tile${dup ? ' dup' : ''}" data-ref="${escape(ref)}" title="${escape(ref)}">
  <img src="${escape(icon.url)}" alt="" width="64" height="64">
  <span>${escape((icon.createdAt ?? '').slice(0, 10))}${dup ? ` · duplicate ${dup}` : ''}</span>
</button>`;
    })
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>My Yoto icons</title>
<style>
  :root { color-scheme: light dark; --bg: #fff; --fg: #222; --tile: #f2f2f2; --dup: #e8a33a; }
  @media (prefers-color-scheme: dark) { :root { --bg: #161616; --fg: #eee; --tile: #262626; } }
  body { margin: 0; padding: 16px; background: var(--bg); color: var(--fg); font: 14px system-ui, sans-serif; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 8px; }
  .tile { display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 8px; border: 2px solid transparent;
    border-radius: 8px; background: var(--tile); color: inherit; font: inherit; font-size: 11px; cursor: pointer; }
  .tile img { image-rendering: pixelated; }
  .tile.dup { border-color: var(--dup); }
  .tile.copied { outline: 2px solid #3a8ee8; }
</style>
</head>
<body>
<h1>My Yoto icons</h1>
<p>${icons.length} icons, newest first. Click one to copy its reference for <code>chapter icon</code> or <code>yotoIcon</code>.${
    duplicates.length ? ` ${duplicates.length} picture(s) were uploaded more than once (outlined, numbered by group).` : ''
  }</p>
<div class="grid">
${tiles}
</div>
<script>
  document.querySelectorAll('.tile').forEach((tile) => tile.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(tile.dataset.ref); } catch {}
    document.querySelectorAll('.copied').forEach((t) => t.classList.remove('copied'));
    tile.classList.add('copied');
  }));
</script>
</body>
</html>
`;
}
