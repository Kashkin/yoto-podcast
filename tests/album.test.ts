import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseTrackFilename, readId3Title, scanAlbum } from '../src/services/album.js';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const TEST_DIR = join(import.meta.dirname, '.test-album');

function syncsafe(n: number): Buffer {
  return Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);
}

function frame(id: string, body: Buffer, version: 3 | 4): Buffer {
  const size = Buffer.alloc(4);
  if (version === 4) syncsafe(body.length).copy(size);
  else size.writeUInt32BE(body.length);
  return Buffer.concat([Buffer.from(id), size, Buffer.from([0, 0]), body]);
}

// Minimal ID3v2 tag holding a TIT2 frame, optionally after other frames or an extended header
function id3(
  title: string,
  opts: { version?: 3 | 4; encoding?: 0 | 1 | 3; before?: Buffer; extendedHeader?: boolean; titleBody?: Buffer } = {}
): Buffer {
  const version = opts.version ?? 3;
  const encoding = opts.encoding ?? 0;
  let text: Buffer;
  if (encoding === 1) text = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(title, 'utf16le')]);
  else if (encoding === 3) text = Buffer.from(title, 'utf8');
  else text = Buffer.from(title, 'latin1');
  const body = opts.titleBody ?? Buffer.concat([Buffer.from([encoding]), text]);
  // v2.4 extended header: syncsafe size including itself; v2.3: size excluding itself
  const ext = !opts.extendedHeader
    ? Buffer.alloc(0)
    : version === 4
      ? Buffer.concat([syncsafe(6), Buffer.from([1, 0])])
      : Buffer.concat([Buffer.from([0, 0, 0, 6]), Buffer.alloc(6)]);
  const tag = Buffer.concat([ext, opts.before ?? Buffer.alloc(0), frame('TIT2', body, version)]);
  const flags = opts.extendedHeader ? 0x40 : 0;
  const header = Buffer.concat([Buffer.from('ID3'), Buffer.from([version, 0, flags]), syncsafe(tag.length)]);
  return Buffer.concat([header, tag, Buffer.from([0xff, 0xfb, 0x90, 0x00])]);
}

describe('parseTrackFilename', () => {
  it('splits "NN - Title.mp3" into number and title', () => {
    expect(parseTrackFilename('03 - Part 2.mp3')).toEqual({ number: 3, title: 'Part 2' });
  });

  it('keeps dashes inside the title', () => {
    expect(parseTrackFilename('12 - Mice - The Return.mp3')).toEqual({ number: 12, title: 'Mice - The Return' });
  });

  it('returns no title for a bare number', () => {
    expect(parseTrackFilename('07.mp3')).toEqual({ number: 7, title: undefined });
  });

  it('accepts a space or dot after the number', () => {
    expect(parseTrackFilename('01 Title and Credits.mp3')).toEqual({ number: 1, title: 'Title and Credits' });
    expect(parseTrackFilename('02. Part 1.mp3')).toEqual({ number: 2, title: 'Part 1' });
  });

  it('returns null without a leading number', () => {
    expect(parseTrackFilename('Intro.mp3')).toBeNull();
  });
});

describe('readId3Title', () => {
  it('reads a latin-1 ID3v2.3 title', () => {
    expect(readId3Title(id3('Café Moon'))).toBe('Café Moon');
  });

  it('reads a UTF-16 title', () => {
    expect(readId3Title(id3('Mice on the Moon', { encoding: 1 }))).toBe('Mice on the Moon');
  });

  it('reads a UTF-8 ID3v2.4 title', () => {
    expect(readId3Title(id3('Moon 🌙', { version: 4, encoding: 3 }))).toBe('Moon 🌙');
  });

  it('skips a v2.3 extended header', () => {
    expect(readId3Title(id3('Part 1', { extendedHeader: true }))).toBe('Part 1');
  });

  it('skips a v2.4 extended header', () => {
    expect(readId3Title(id3('Part 1', { version: 4, encoding: 3, extendedHeader: true }))).toBe('Part 1');
  });

  it('reads an odd-length UTF-16 big-endian title without throwing', () => {
    const body = Buffer.concat([Buffer.from([1, 0xfe, 0xff]), Buffer.from('Moon', 'utf16le').swap16(), Buffer.from([0])]);
    expect(readId3Title(id3('', { titleBody: body }))).toBe('Moon');
  });

  it('returns undefined without an ID3 tag', () => {
    expect(readId3Title(Buffer.from([0xff, 0xfb, 0x90, 0x00]))).toBeUndefined();
  });
});

describe('scanAlbum', () => {
  beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it('orders tracks by number, not by name', () => {
    writeFileSync(join(TEST_DIR, '10 - Ten.mp3'), id3('x'));
    writeFileSync(join(TEST_DIR, '2 - Two.mp3'), id3('x'));
    writeFileSync(join(TEST_DIR, '01 - One.mp3'), id3('x'));
    expect(scanAlbum(TEST_DIR).map((t) => t.title)).toEqual(['One', 'Two', 'Ten']);
  });

  it('falls back to the ID3 title when the file name has none', () => {
    writeFileSync(join(TEST_DIR, '01.mp3'), id3('Title and Credits'));
    expect(scanAlbum(TEST_DIR)[0].title).toBe('Title and Credits');
  });

  it('finds the ID3 title behind large embedded cover art', () => {
    const art = frame('APIC', Buffer.alloc(200 * 1024, 1), 3);
    writeFileSync(join(TEST_DIR, '01.mp3'), id3('Title and Credits', { before: art }));
    expect(scanAlbum(TEST_DIR)[0].title).toBe('Title and Credits');
  });

  it('ignores non-mp3 files', () => {
    writeFileSync(join(TEST_DIR, '01 - One.mp3'), id3('x'));
    writeFileSync(join(TEST_DIR, 'cover.jpg'), 'x');
    expect(scanAlbum(TEST_DIR)).toHaveLength(1);
  });

  it('rejects mp3s without a track number', () => {
    writeFileSync(join(TEST_DIR, 'Intro.mp3'), id3('x'));
    expect(() => scanAlbum(TEST_DIR)).toThrow(/Intro\.mp3/);
  });

  it('rejects duplicate track numbers', () => {
    writeFileSync(join(TEST_DIR, '01 - One.mp3'), id3('x'));
    writeFileSync(join(TEST_DIR, '1 - Uno.mp3'), id3('x'));
    expect(() => scanAlbum(TEST_DIR)).toThrow(/number 1/);
  });

  it('rejects a folder with no mp3s', () => {
    expect(() => scanAlbum(TEST_DIR)).toThrow(/No .mp3 files/);
  });
});
