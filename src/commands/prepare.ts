import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import {
  parseManifest,
  albumFolderName,
  coverSlug,
  trackFilename,
  trackTags,
  renderGuide,
  type AlbumManifest,
} from '../services/album-manifest.js';
import { expandHome } from '../config.js';

const run = promisify(execFile);
const BIG = { maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' as const };

export interface ReportItem {
  path: string; // relative to the album folder, or to the library for the cover and a folder move
  status: 'unchanged' | 'create' | 'update' | 'move';
  from?: string; // for a move: where it was, relative to the library
  changes?: string[];
}

export interface PrepareReport {
  album: string;
  items: ReportItem[];
  leftAlone: string[]; // files in the album folder the manifest doesn't produce
}

// Embedded art only shows in Finder and Music, never on the Yoto, so it doesn't need to be big
const EMBED_MAX = 800;

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const isUrl = (s: string) => /^https?:\/\//.test(s);

async function loadImage(src: string, base: string): Promise<Buffer> {
  let data: Buffer;
  if (isUrl(src)) {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`Could not download ${src}: ${res.status}`);
    data = Buffer.from(await res.arrayBuffer());
  } else {
    data = readFileSync(resolve(base, expandHome(src)));
  }
  if (data[0] !== 0xff || data[1] !== 0xd8) throw new Error(`${src} is not a JPEG`);
  return data;
}

// Shrinks to fit maxSide (never enlarges), then drops metadata other than the colour profile and
// optimises losslessly. Deterministic, so a re-run compares equal.
async function optimiseJpeg(img: Buffer, maxSide = Infinity): Promise<Buffer> {
  const work = mkdtempSync(join(tmpdir(), 'yoto-prepare-art-'));
  try {
    const path = join(work, 'art.jpg');
    writeFileSync(path, img);
    const { stdout: dims } = await run('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', path]);
    const sides = [...dims.matchAll(/pixel(?:Width|Height): (\d+)/g)].map((m) => Number(m[1]));
    if (Math.max(...sides) > maxSide) await run('sips', ['-Z', String(maxSide), '-s', 'formatOptions', '80', path]);
    const { stdout } = await run('jpegtran', ['-optimize', '-copy', 'icc', path], BIG);
    return stdout;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function probeTags(file: string): Promise<Record<string, string>> {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format_tags', '-of', 'json', file]);
  return JSON.parse(stdout).format?.tags ?? {};
}

async function embeddedArt(file: string): Promise<Buffer | null> {
  try {
    const { stdout } = await run('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:v:0', '-c', 'copy', '-f', 'image2pipe', '-'], BIG);
    return stdout.length ? stdout : null;
  } catch {
    return null; // no video stream
  }
}

async function audioHash(file: string): Promise<string> {
  const { stdout } = await run('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:a', '-c', 'copy', '-f', 'md5', '-']);
  return stdout.trim();
}

// Box's online-only files time out when read. Fail early, naming the folders to download.
export function checkReadable(paths: string[], read: (path: string) => void = readHead): void {
  const offline: string[] = [];
  for (const path of paths) {
    try {
      read(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ETIMEDOUT') throw err;
      offline.push(path);
    }
  }
  if (offline.length) {
    const folders = [...new Set(offline.map((p) => dirname(p)))];
    throw new Error(
      `${offline.length} file(s) are online-only in Box and couldn't be read, in:\n  ${folders.join('\n  ')}\n` +
        'Make sure the Box app is running, then in Finder right-click the folder, choose Make Available Offline, and run again.'
    );
  }
}

function readHead(path: string): void {
  const fd = openSync(path, 'r');
  try {
    readSync(fd, Buffer.alloc(4096), 0, 4096, 0);
  } finally {
    closeSync(fd);
  }
}

// Inside the library, apart from the _To delete holding folder
function inLibrary(path: string, root: string): boolean {
  const lib = existsSync(root) ? realpathSync(root) : resolve(root);
  const real = realpathSync(path);
  return real.startsWith(lib + sep) && !real.startsWith(join(lib, '_To delete') + sep);
}

function samePath(a: string, b: string): boolean {
  return existsSync(a) && existsSync(b) && realpathSync(a) === realpathSync(b);
}

// Copies the audio untouched, sets the managed tags on top of the source's own, and embeds `art`.
async function writeTrack(source: string, dest: string, tags: Record<string, string>, art: Buffer): Promise<void> {
  const work = mkdtempSync(join(tmpdir(), 'yoto-prepare-'));
  try {
    const artPath = join(work, 'cover.jpg');
    const out = join(work, 'out.mp3');
    writeFileSync(artPath, art);
    const metadata = Object.entries(tags).flatMap(([k, v]) => ['-metadata', `${k}=${v}`]);
    await run('ffmpeg', [
      '-v', 'error', '-y', '-i', source, '-i', artPath,
      '-map', '0:a', '-map', '1:0', '-c', 'copy', '-id3v2_version', '3',
      ...metadata,
      '-metadata:s:v', 'title=Album cover', '-metadata:s:v', 'comment=Cover (front)', '-disposition:v', 'attached_pic',
      out,
    ]);
    // Copy then rename inside the album folder, so a partial file never has the real name
    const temp = join(dirname(dest), `.${Date.now()}.prepare.tmp`);
    writeFileSync(temp, readFileSync(out));
    renameSync(temp, dest);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function writeIfChanged(items: ReportItem[], rel: string, path: string, content: Buffer | string, dryRun: boolean): void {
  const data = Buffer.from(content);
  const exists = existsSync(path);
  if (exists && readFileSync(path).equals(data)) {
    items.push({ path: rel, status: 'unchanged' });
    return;
  }
  items.push({ path: rel, status: exists ? 'update' : 'create' });
  if (dryRun) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
}

export async function prepareAlbum(manifestPath: string, opts: { root: string; dryRun: boolean }): Promise<PrepareReport> {
  const m: AlbumManifest = parseManifest(readFileSync(manifestPath, 'utf8'));
  const base = dirname(resolve(manifestPath));
  const source = resolve(base, expandHome(m.source));
  const folder = albumFolderName(m);
  const albumDir = join(opts.root, m.category, folder);
  const items: ReportItem[] = [];

  // Check every input before writing anything
  const sourceOf = (t: AlbumManifest['tracks'][number]) => resolve(source, expandHome(t.file));
  const missing = m.tracks.filter((t) => !existsSync(sourceOf(t))).map((t) => t.file);
  if (missing.length) throw new Error(`Missing in ${source}: ${missing.join(', ')}`);
  checkReadable(m.tracks.map(sourceOf));
  const cover = await optimiseJpeg(await loadImage(m.cover, base));
  const keepSourceArt = m.embedCover === 'keep';
  const embed = await optimiseJpeg(m.embedCover && !keepSourceArt ? await loadImage(m.embedCover, base) : cover, EMBED_MAX);

  // A re-run can shift a track onto a file that's still another track's
  // source; copy those sources aside first so nothing is read after it's overwritten.
  const names = m.tracks.map((t, i) => trackFilename(i + 1, t.title, m.tracks.length));
  const pathKey = (p: string) => p.normalize('NFC').toLowerCase();
  const destKeys = new Map(names.map((n, i) => [pathKey(join(albumDir, n)), i]));
  const sources = m.tracks.map(sourceOf);
  const dests = names.map((n) => join(albumDir, n));

  // Sources already in the library are renamed and retagged where they are, never copied.
  // A move that would overwrite some other existing file is skipped; that track is copied instead.
  const sourceKeys = new Set(sources.map(pathKey));
  const moving = sources.map(
    (src, i) => inLibrary(src, opts.root) && !samePath(src, dests[i]) && (!existsSync(dests[i]) || sourceKeys.has(pathKey(dests[i])))
  );
  const movedFrom = new Map(sources.flatMap((src, i) => (moving[i] ? [[i, src] as const] : [])));

  // When every track moves out of one folder that holds nothing else, rename the folder itself
  const srcDirs = [...new Set(sources.map((src) => dirname(src)))];
  const albumFiles = new Set([...sources.map((src) => basename(src)), 'album.json', 'track_guide.md']);
  const folderMove =
    moving.every(Boolean) &&
    srcDirs.length === 1 &&
    !existsSync(albumDir) &&
    readdirSync(srcDirs[0], { withFileTypes: true }).every((e) => e.name.startsWith('.') || (e.isFile() && albumFiles.has(e.name)))
      ? srcDirs[0]
      : null;

  const staging = opts.dryRun ? null : mkdtempSync(join(tmpdir(), 'yoto-prepare-sources-'));
  try {
    if (staging) {
      sources.forEach((src, i) => {
        const owner = destKeys.get(pathKey(src));
        if (!moving[i] && owner !== undefined && owner !== i) {
          sources[i] = join(staging, `${i}.mp3`);
          copyFileSync(src, sources[i]);
        }
      });
    }
    return await writeAlbum();
  } finally {
    if (staging) rmSync(staging, { recursive: true, force: true });
  }

  async function writeAlbum(): Promise<PrepareReport> {
    const coverRel = `Cover images/${coverSlug(folder)}.jpg`;
    writeIfChanged(items, coverRel, join(opts.root, coverRel), cover, opts.dryRun);

    if (folderMove) {
      items.push({ path: relative(opts.root, albumDir), status: 'move', from: relative(opts.root, folderMove) });
      if (!opts.dryRun) {
        mkdirSync(dirname(albumDir), { recursive: true });
        renameSync(folderMove, albumDir);
        sources.forEach((src, i) => (sources[i] = join(albumDir, basename(src))));
      }
    }
    if (!opts.dryRun && movedFrom.size) {
      // Two steps, via temporary names, so tracks swapping names can't overwrite each other
      mkdirSync(albumDir, { recursive: true });
      const temps = new Map([...movedFrom.keys()].map((i) => [i, join(albumDir, `.prepare-move-${i}.mp3`)]));
      for (const [i, temp] of temps) if (!samePath(sources[i], dests[i])) renameSync(sources[i], temp);
      for (const [i, temp] of temps) {
        if (existsSync(temp)) renameSync(temp, dests[i]);
        sources[i] = dests[i];
      }
    }

    const expected = new Set(['album.json', 'track_guide.md']);
    for (const [i, t] of m.tracks.entries()) {
      const name = names[i];
      expected.add(name);
      const src = sources[i];
      const dest = dests[i];
      const from = movedFrom.get(i);
      // On a dry run a move hasn't happened, so the file to check is still at its source
      const target = from && opts.dryRun ? src : dest;
      const srcTags = await probeTags(src);
      const tags = { ...trackTags(m, i), genre: m.genre ?? srcTags.genre ?? 'Audiobook' };
      const art = keepSourceArt ? ((await embeddedArt(src)) ?? embed) : embed;

      if (!from && !existsSync(dest)) {
        items.push({ path: name, status: 'create' });
        if (!opts.dryRun) {
          mkdirSync(albumDir, { recursive: true });
          await writeTrack(src, dest, tags, art);
        }
        continue;
      }

      const destTags = samePath(src, target) ? srcTags : await probeTags(target);
      const changes = Object.entries(tags)
        .filter(([k, v]) => destTags[k] !== v)
        .map(([k, v]) => `${k}: ${destTags[k] === undefined ? '(none)' : JSON.stringify(destTags[k])} → ${JSON.stringify(v)}`);
      const destArt = await embeddedArt(target);
      if (!destArt || sha(destArt) !== sha(art)) changes.push('embedded cover');
      if (!samePath(src, target) && (await audioHash(src)) !== (await audioHash(target))) changes.push('audio');

      if (from) {
        items.push({ path: name, status: 'move', from: relative(opts.root, from), ...(changes.length && { changes }) });
        if (!opts.dryRun && changes.length) await writeTrack(dest, dest, tags, art);
        continue;
      }

      if (changes.length === 0) {
        items.push({ path: name, status: 'unchanged' });
        continue;
      }
      items.push({ path: name, status: 'update', changes });
      if (!opts.dryRun) await writeTrack(src, dest, tags, art);
    }

    writeIfChanged(items, 'track_guide.md', join(albumDir, 'track_guide.md'), renderGuide(m), opts.dryRun);
    // Saved pointing at the finished files, so it can be edited and re-run in place
    const finished: AlbumManifest = {
      ...m,
      source: '.',
      cover: relative(albumDir, join(opts.root, coverRel)),
      ...(m.embedCover &&
        !keepSourceArt &&
        !isUrl(m.embedCover) && { embedCover: relative(albumDir, resolve(base, expandHome(m.embedCover))) }),
      tracks: m.tracks.map((t, i) => ({ ...t, file: trackFilename(i + 1, t.title, m.tracks.length) })),
    };
    writeIfChanged(items, 'album.json', join(albumDir, 'album.json'), `${JSON.stringify(finished, null, 2)}\n`, opts.dryRun);

    const visible = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((f) => !f.startsWith('.')) : []);
    const moved = new Set([...movedFrom.values()].map(pathKey));
    const leftAlone = visible(albumDir)
      .filter((f) => !expected.has(f) && !moved.has(pathKey(join(albumDir, f))))
      .sort();
    // Other library folders the tracks came from keep anything that wasn't moved
    for (const dir of srcDirs) {
      if (samePath(dir, albumDir) || dir === folderMove || !existsSync(dir) || !inLibrary(dir, opts.root)) continue;
      const rest = visible(dir).filter((f) => !moved.has(pathKey(join(dir, f))));
      leftAlone.push(...rest.sort().map((f) => relative(opts.root, join(dir, f))));
    }
    return { album: `${m.category}/${folder}`, items, leftAlone };
  }
}

export function printReport(report: PrepareReport, dryRun: boolean): void {
  const verb = {
    unchanged: 'unchanged',
    create: dryRun ? 'would create' : 'created',
    update: dryRun ? 'would update' : 'updated',
    move: dryRun ? 'would move' : 'moved',
  };
  const retag = dryRun ? 'would retag' : 'retagged';
  console.log(`Album: ${report.album}`);
  for (const item of report.items) {
    const changes = item.changes?.join('; ');
    const line =
      item.status === 'move'
        ? `${item.from} → ${item.path}  ${verb.move}${changes ? `; ${retag}: ${changes}` : ''}`
        : `${item.path}  ${verb[item.status]}${changes ? `: ${changes}` : ''}`;
    console.log(`  ${line}`);
  }
  if (report.leftAlone.length) {
    console.log(`\nLeft alone (not produced by the manifest; delete by hand if unwanted):`);
    for (const f of report.leftAlone) console.log(`  ${f}`);
  }
  const changed = report.items.filter((i) => i.status !== 'unchanged').length;
  console.log(`\n${changed === 0 ? 'Everything matches the manifest.' : `${changed} item(s) ${dryRun ? 'would change' : 'changed'}.`}`);
}
