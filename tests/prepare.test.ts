import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { prepareAlbum, checkReadable } from '../src/commands/prepare.js';
import type { AlbumManifest } from '../src/services/album-manifest.js';

const DIR = join(import.meta.dirname, '.test-prepare');
const SRC = join(DIR, 'rip');
const ROOT = join(DIR, 'Yoto');
const FIXTURES = join(DIR, 'fixtures');
const ALBUM = join(ROOT, 'Stories', 'Adventure Mice - Mermouse Mystery');

const ff = (...args: string[]) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);
const tags = (file: string) =>
  JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format_tags', '-of', 'json', file]).toString()).format
    .tags as Record<string, string>;
const audioMd5 = (file: string) =>
  execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:a', '-c', 'copy', '-f', 'md5', '-']).toString().trim();
const art = (file: string) => execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:v', '-c', 'copy', '-f', 'image2pipe', '-']);
// "WxH" of an image, or of an MP3's embedded art
const size = (file: string) =>
  execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', file])
    .toString()
    .trim();

function manifest(overrides: Partial<AlbumManifest> = {}): AlbumManifest {
  return {
    category: 'Stories',
    series: 'Adventure Mice',
    title: 'Mermouse Mystery',
    author: 'Philip Reeve & Sarah McIntyre',
    narrators: ['Barnaby Edwards'],
    publisher: 'W.F. Howes',
    year: 2023,
    source: SRC,
    cover: join(FIXTURES, 'portrait.jpg'),
    tracks: [
      { file: 'Track 01.mp3', title: 'Title and Credits', icon: '🎬', description: 'Opening titles' },
      { file: 'Track 02.mp3', title: 'Is It a Mermouse?', icon: '🧜', description: 'Part 1' },
    ],
    ...overrides,
  };
}

function writeManifest(m: AlbumManifest): string {
  const path = join(DIR, 'album.json');
  writeFileSync(path, JSON.stringify(m, null, 2));
  return path;
}

beforeAll(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(FIXTURES, { recursive: true });
  ff('-f', 'lavfi', '-i', 'color=c=red:s=60x80', '-frames:v', '1', join(FIXTURES, 'portrait.jpg'));
  ff('-f', 'lavfi', '-i', 'color=c=blue:s=60x60', '-frames:v', '1', join(FIXTURES, 'square.jpg'));
  ff('-f', 'lavfi', '-i', 'testsrc=s=1600x1200', '-frames:v', '1', join(FIXTURES, 'large.jpg'));
  ff('-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-metadata', 'title=Track 01', '-metadata', 'genre=Children', join(FIXTURES, 'Track 01.mp3'));
  ff('-f', 'lavfi', '-i', 'sine=frequency=660:duration=1', '-metadata', 'title=Track 02', join(FIXTURES, 'Track 02.mp3'));
  ff('-f', 'lavfi', '-i', 'sine=frequency=880:duration=1', join(FIXTURES, 'Track 03.mp3'));
  ff('-f', 'lavfi', '-i', 'sine=frequency=1000:duration=1', join(FIXTURES, 'Track 04.mp3'));
  // A rip that already carries its own art
  ff('-i', join(FIXTURES, 'Track 03.mp3'), '-i', join(FIXTURES, 'square.jpg'), '-map', '0:a', '-map', '1:0', '-c', 'copy',
    '-id3v2_version', '3', '-disposition:v', 'attached_pic', join(FIXTURES, 'With Art.mp3'));
});

beforeEach(() => {
  rmSync(SRC, { recursive: true, force: true });
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(SRC, { recursive: true });
  for (const f of ['Track 01.mp3', 'Track 02.mp3', 'Track 03.mp3', 'With Art.mp3']) writeFileSync(join(SRC, f), readFileSync(join(FIXTURES, f)));
});

afterAll(() => rmSync(DIR, { recursive: true, force: true }));

describe('prepareAlbum', () => {
  it('writes the finished album: files, tags, art, cover, guide and manifest', async () => {
    await prepareAlbum(writeManifest(manifest()), { root: ROOT, dryRun: false });

    expect(readdirSync(ALBUM).sort()).toEqual(['01 - Title and Credits.mp3', '02 - Is It a Mermouse.mp3', 'album.json', 'track_guide.md']);
    expect(tags(join(ALBUM, '02 - Is It a Mermouse.mp3'))).toMatchObject({
      title: 'Is It a Mermouse?',
      track: '2/2',
      album: 'Adventure Mice - Mermouse Mystery',
      artist: 'Philip Reeve & Sarah McIntyre',
      album_artist: 'Philip Reeve & Sarah McIntyre',
      composer: 'Barnaby Edwards',
      comment: 'Read by Barnaby Edwards',
      publisher: 'W.F. Howes',
      date: '2023',
      genre: 'Audiobook',
    });
    expect(size(join(ALBUM, '01 - Title and Credits.mp3'))).toBe('60x80');
    const cover = join(ROOT, 'Cover images', 'adventure-mice-mermouse-mystery.jpg');
    expect(size(cover)).toBe('60x80');
    expect(statSync(cover).size).toBeLessThanOrEqual(statSync(join(FIXTURES, 'portrait.jpg')).size);
    expect(readFileSync(join(ALBUM, 'track_guide.md'), 'utf8')).toContain('| 02 | 02 - Is It a Mermouse.mp3 | is_it_a_mermouse | 🧜 | Part 1 |');
  });

  it('keeps the genre the source already has', async () => {
    await prepareAlbum(writeManifest(manifest()), { root: ROOT, dryRun: false });
    expect(tags(join(ALBUM, '01 - Title and Credits.mp3')).genre).toBe('Children');
  });

  it('embeds embedCover when given', async () => {
    await prepareAlbum(writeManifest(manifest({ embedCover: join(FIXTURES, 'square.jpg') })), { root: ROOT, dryRun: false });
    expect(size(join(ALBUM, '01 - Title and Credits.mp3'))).toBe('60x60');
  });

  it('shrinks large art to fit 800 px before embedding, and keeps the stored cover full size', async () => {
    const path = writeManifest(manifest({ cover: join(FIXTURES, 'large.jpg') }));
    await prepareAlbum(path, { root: ROOT, dryRun: false });

    expect(size(join(ALBUM, '01 - Title and Credits.mp3'))).toBe('800x600');
    expect(size(join(ROOT, 'Cover images', 'adventure-mice-mermouse-mystery.jpg'))).toBe('1600x1200');

    const report = await prepareAlbum(path, { root: ROOT, dryRun: true });
    expect(report.items.map((i) => i.status)).toEqual(Array(report.items.length).fill('unchanged'));
  });

  it('reports everything unchanged on a re-run and rewrites nothing', async () => {
    const path = writeManifest(manifest());
    await prepareAlbum(path, { root: ROOT, dryRun: false });
    const mtime = statSync(join(ALBUM, '01 - Title and Credits.mp3')).mtimeMs;

    const report = await prepareAlbum(path, { root: ROOT, dryRun: false });

    expect(report.items.map((i) => i.status)).toEqual(Array(report.items.length).fill('unchanged'));
    expect(statSync(join(ALBUM, '01 - Title and Credits.mp3')).mtimeMs).toBe(mtime);
  });

  it('saves album.json pointing at the finished files, so it re-runs in place', async () => {
    await prepareAlbum(writeManifest(manifest()), { root: ROOT, dryRun: false });
    const saved = JSON.parse(readFileSync(join(ALBUM, 'album.json'), 'utf8')) as AlbumManifest;
    expect(saved.source).toBe('.');
    expect(saved.cover).toBe('../../Cover images/adventure-mice-mermouse-mystery.jpg');
    expect(saved.tracks.map((t) => t.file)).toEqual(['01 - Title and Credits.mp3', '02 - Is It a Mermouse.mp3']);

    const report = await prepareAlbum(join(ALBUM, 'album.json'), { root: ROOT, dryRun: true });

    expect(report.items.map((i) => i.status)).toEqual(Array(report.items.length).fill('unchanged'));
  });

  it('adds a later disc from an absolute source path', async () => {
    await prepareAlbum(writeManifest(manifest()), { root: ROOT, dryRun: false });
    const saved = JSON.parse(readFileSync(join(ALBUM, 'album.json'), 'utf8')) as AlbumManifest;
    saved.multiDisc = true;
    saved.tracks.push({ file: join(FIXTURES, 'Track 02.mp3'), title: 'Disc 2', icon: '📀', description: 'CD2', leaveOff: true });
    writeFileSync(join(ALBUM, 'album.json'), JSON.stringify(saved));

    await prepareAlbum(join(ALBUM, 'album.json'), { root: ROOT, dryRun: false });

    expect(tags(join(ALBUM, '03 - Disc 2.mp3')).track).toBe('3');
    expect(tags(join(ALBUM, '01 - Title and Credits.mp3')).track).toBe('1');
  });

  it('lists what would change on a dry run without writing anything', async () => {
    const report = await prepareAlbum(writeManifest(manifest()), { root: ROOT, dryRun: true });
    expect(report.items.map((i) => i.status)).toEqual(['create', 'create', 'create', 'create', 'create']);
    expect(existsSync(ROOT)).toBe(false);
  });

  it('names the tags that differ', async () => {
    await prepareAlbum(writeManifest(manifest()), { root: ROOT, dryRun: false });
    const report = await prepareAlbum(writeManifest(manifest({ year: 2024 })), { root: ROOT, dryRun: true });
    const track = report.items.find((i) => i.path === '01 - Title and Credits.mp3');
    expect(track).toMatchObject({ status: 'update', changes: ['date: "2023" → "2024"'] });
  });

  it('notices when the embedded cover differs', async () => {
    await prepareAlbum(writeManifest(manifest()), { root: ROOT, dryRun: false });
    const report = await prepareAlbum(writeManifest(manifest({ embedCover: join(FIXTURES, 'square.jpg') })), {
      root: ROOT,
      dryRun: true,
    });
    expect(report.items.find((i) => i.path === '01 - Title and Credits.mp3')).toMatchObject({
      status: 'update',
      changes: ['embedded cover'],
    });
  });

  it('keeps every track intact when a re-run shifts one onto another', async () => {
    const m = manifest();
    m.tracks = [
      { file: 'Track 01.mp3', title: 'Intro', icon: '🎬', description: 'Intro' },
      { file: 'Track 02.mp3', title: 'Song', icon: '🎵', description: 'First song' },
      { file: 'Track 03.mp3', title: 'Song', icon: '🎶', description: 'Second song' },
    ];
    await prepareAlbum(writeManifest(m), { root: ROOT, dryRun: false });
    const saved = JSON.parse(readFileSync(join(ALBUM, 'album.json'), 'utf8')) as AlbumManifest;
    saved.tracks.splice(1, 0, { file: join(FIXTURES, 'Track 04.mp3'), title: 'Disc 2', icon: '📀', description: 'CD2', leaveOff: true });
    writeFileSync(join(ALBUM, 'album.json'), JSON.stringify(saved));

    await prepareAlbum(join(ALBUM, 'album.json'), { root: ROOT, dryRun: false });

    expect(audioMd5(join(ALBUM, '03 - Song.mp3'))).toBe(audioMd5(join(FIXTURES, 'Track 02.mp3')));
    expect(audioMd5(join(ALBUM, '04 - Song.mp3'))).toBe(audioMd5(join(FIXTURES, 'Track 03.mp3')));
  });

  it('re-runs in place when embedCover was a relative path', async () => {
    await prepareAlbum(writeManifest(manifest({ embedCover: 'fixtures/square.jpg' })), { root: ROOT, dryRun: false });
    const report = await prepareAlbum(join(ALBUM, 'album.json'), { root: ROOT, dryRun: true });
    expect(report.items.map((i) => i.status)).toEqual(Array(report.items.length).fill('unchanged'));
  });

  it('re-embeds the art when the cover changes on an in-place re-run', async () => {
    await prepareAlbum(writeManifest(manifest()), { root: ROOT, dryRun: false });
    const saved = JSON.parse(readFileSync(join(ALBUM, 'album.json'), 'utf8')) as AlbumManifest;
    saved.cover = join(FIXTURES, 'square.jpg');
    writeFileSync(join(ALBUM, 'album.json'), JSON.stringify(saved));

    await prepareAlbum(join(ALBUM, 'album.json'), { root: ROOT, dryRun: false });

    expect(size(join(ALBUM, '01 - Title and Credits.mp3'))).toBe('60x60');
  });

  it('embeds the cover even when the source has its own art', async () => {
    const m = manifest();
    m.tracks[0].file = 'With Art.mp3';
    await prepareAlbum(writeManifest(m), { root: ROOT, dryRun: false });
    expect(size(join(ALBUM, '01 - Title and Credits.mp3'))).toBe('60x80');
  });

  it('keeps the source art when embedCover is "keep"', async () => {
    const m = manifest({ embedCover: 'keep' });
    m.tracks[0].file = 'With Art.mp3';
    await prepareAlbum(writeManifest(m), { root: ROOT, dryRun: false });
    expect(art(join(ALBUM, '01 - Title and Credits.mp3'))).toEqual(readFileSync(join(FIXTURES, 'square.jpg')));
    expect(size(join(ALBUM, '02 - Is It a Mermouse.mp3'))).toBe('60x80');
  });

  it('leaves files it no longer manages in place and never touches the source', async () => {
    await prepareAlbum(writeManifest(manifest()), { root: ROOT, dryRun: false });
    const renamed = manifest();
    renamed.tracks[1].title = 'Part 1';
    const before = readFileSync(join(SRC, 'Track 02.mp3'));

    const report = await prepareAlbum(writeManifest(renamed), { root: ROOT, dryRun: false });

    expect(report.leftAlone).toEqual(['02 - Is It a Mermouse.mp3']);
    expect(existsSync(join(ALBUM, '02 - Is It a Mermouse.mp3'))).toBe(true);
    expect(existsSync(join(ALBUM, '02 - Part 1.mp3'))).toBe(true);
    expect(readFileSync(join(SRC, 'Track 02.mp3'))).toEqual(before);
  });

  it('stops before writing when a source file is missing', async () => {
    const m = manifest();
    m.tracks[1].file = 'Track 09.mp3';
    await expect(prepareAlbum(writeManifest(m), { root: ROOT, dryRun: false })).rejects.toThrow(/Track 09\.mp3/);
    expect(existsSync(ROOT)).toBe(false);
  });
});

describe('prepareAlbum with a source already in the library', () => {
  const DROP = join(ROOT, 'Stories', 'Raw Drop');
  const mp3sInLibrary = () =>
    (readdirSync(ROOT, { recursive: true }) as string[]).filter((f) => f.endsWith('.mp3')).sort();
  const dropTracks = (dir: string) => {
    mkdirSync(dir, { recursive: true });
    for (const f of ['Track 01.mp3', 'Track 02.mp3']) writeFileSync(join(dir, f), readFileSync(join(FIXTURES, f)));
  };

  it('renames the folder and files in place instead of copying them', async () => {
    dropTracks(DROP);

    const report = await prepareAlbum(writeManifest(manifest({ source: DROP })), { root: ROOT, dryRun: false });

    expect(existsSync(DROP)).toBe(false);
    expect(mp3sInLibrary()).toEqual([
      join('Stories', 'Adventure Mice - Mermouse Mystery', '01 - Title and Credits.mp3'),
      join('Stories', 'Adventure Mice - Mermouse Mystery', '02 - Is It a Mermouse.mp3'),
    ]);
    expect(tags(join(ALBUM, '02 - Is It a Mermouse.mp3'))).toMatchObject({ title: 'Is It a Mermouse?', track: '2/2' });
    expect(audioMd5(join(ALBUM, '02 - Is It a Mermouse.mp3'))).toBe(audioMd5(join(FIXTURES, 'Track 02.mp3')));
    expect(JSON.parse(readFileSync(join(ALBUM, 'album.json'), 'utf8')).source).toBe('.');
    expect(report.leftAlone).toEqual([]);
  });

  it('moves the tracks but leaves a folder that holds other files', async () => {
    dropTracks(DROP);
    writeFileSync(join(DROP, 'notes.txt'), 'keep me');

    const report = await prepareAlbum(writeManifest(manifest({ source: DROP })), { root: ROOT, dryRun: false });

    expect(readdirSync(DROP)).toEqual(['notes.txt']);
    expect(mp3sInLibrary()).toHaveLength(2);
    expect(report.leftAlone).toEqual([join('Stories', 'Raw Drop', 'notes.txt')]);
  });

  it('renames raw files within the album folder itself', async () => {
    dropTracks(ALBUM);

    await prepareAlbum(writeManifest(manifest({ source: ALBUM })), { root: ROOT, dryRun: false });

    expect(readdirSync(ALBUM).sort()).toEqual(['01 - Title and Credits.mp3', '02 - Is It a Mermouse.mp3', 'album.json', 'track_guide.md']);
  });

  it('shows each move and retag on a dry run, and changes nothing', async () => {
    dropTracks(DROP);

    const report = await prepareAlbum(writeManifest(manifest({ source: DROP })), { root: ROOT, dryRun: true });

    const track = report.items.find((i) => i.path === '01 - Title and Credits.mp3');
    expect(track).toMatchObject({ status: 'move', from: join('Stories', 'Raw Drop', 'Track 01.mp3') });
    expect(track?.changes).toContain('title: "Track 01" → "Title and Credits"');
    expect(report.items[1]).toMatchObject({ status: 'move', path: join('Stories', 'Adventure Mice - Mermouse Mystery'), from: join('Stories', 'Raw Drop') });
    expect(readdirSync(DROP).sort()).toEqual(['Track 01.mp3', 'Track 02.mp3']);
    expect(existsSync(ALBUM)).toBe(false);
  });

  it('never overwrites a different finished file; the raw one stays and is listed', async () => {
    await prepareAlbum(writeManifest(manifest()), { root: ROOT, dryRun: false });
    writeFileSync(join(ALBUM, 'Track 01.mp3'), readFileSync(join(FIXTURES, 'Track 01.mp3')));
    const raw = manifest({ source: ALBUM });
    raw.tracks[0].file = 'Track 01.mp3';
    raw.tracks[1].file = '02 - Is It a Mermouse.mp3';

    const report = await prepareAlbum(writeManifest(raw), { root: ROOT, dryRun: false });

    expect(existsSync(join(ALBUM, 'Track 01.mp3'))).toBe(true);
    expect(report.leftAlone).toContain('Track 01.mp3');
    expect(mp3sInLibrary()).toHaveLength(3);
  });

  it('still copies from a source outside the library', async () => {
    await prepareAlbum(writeManifest(manifest()), { root: ROOT, dryRun: false });
    expect(readdirSync(SRC).sort()).toEqual(['Track 01.mp3', 'Track 02.mp3', 'Track 03.mp3', 'With Art.mp3']);
    expect(mp3sInLibrary()).toHaveLength(2);
  });

  it("copies from the library's _To delete folder rather than moving", async () => {
    const parked = join(ROOT, '_To delete', 'Raw');
    dropTracks(parked);
    await prepareAlbum(writeManifest(manifest({ source: parked })), { root: ROOT, dryRun: false });
    expect(readdirSync(parked).sort()).toEqual(['Track 01.mp3', 'Track 02.mp3']);
  });
});

describe('checkReadable', () => {
  it('names the folder to download when Box has the files online only', () => {
    const timedOut = () => {
      throw Object.assign(new Error('Operation timed out'), { code: 'ETIMEDOUT' });
    };
    expect(() => checkReadable(['/Box/Yoto/Stories/Raw/0001.mp3'], timedOut)).toThrow(
      /online-only in Box[\s\S]*\/Box\/Yoto\/Stories\/Raw[\s\S]*Make Available Offline/
    );
  });

  it('passes readable files', () => {
    expect(() => checkReadable(['/a.mp3'], () => {})).not.toThrow();
  });
});
