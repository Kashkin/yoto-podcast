import { readdirSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';

export interface AlbumTrack {
  number: number;
  title: string;
  path: string;
}

export function parseTrackFilename(name: string): { number: number; title: string | undefined } | null {
  // "NN - Title", "NN. Title", "NN Title" or just "NN"
  const match = name.match(/^(\d+)(?:\s*[-.]\s*|\s+)?(.*?)\s*\.mp3$/i);
  if (!match) return null;
  return { number: Number(match[1]), title: match[2] || undefined };
}

function decodeText(encoding: number, bytes: Buffer): string {
  let text: string;
  if (encoding === 1 || encoding === 2) {
    // UTF-16: with BOM (1) or big-endian without (2)
    const bigEndian = encoding === 2 || (bytes[0] === 0xfe && bytes[1] === 0xff);
    const hasBom = encoding === 1 && (bytes[0] === 0xff || bytes[0] === 0xfe);
    let body = hasBom ? bytes.subarray(2) : bytes;
    if (bigEndian) body = Buffer.from(body.subarray(0, body.length & ~1)).swap16();
    text = body.toString('utf16le');
  } else if (encoding === 3) {
    text = bytes.toString('utf8');
  } else {
    text = bytes.toString('latin1');
  }
  return text.replace(/\0+$/, '').trim();
}

// Reads the TIT2 (title) frame of an ID3v2.3/2.4 tag at the start of the file.
export function readId3Title(buf: Buffer): string | undefined {
  if (buf.length < 10 || buf.toString('latin1', 0, 3) !== 'ID3') return undefined;
  const version = buf[3];
  const syncsafe = (o: number) => (buf[o] << 21) | (buf[o + 1] << 14) | (buf[o + 2] << 7) | buf[o + 3];
  const end = Math.min(buf.length, 10 + syncsafe(6));
  let pos = 10;
  if (buf[5] & 0x40) {
    // Extended header: v2.4 size includes itself, v2.3 size doesn't
    pos += version === 4 ? syncsafe(10) : 4 + buf.readUInt32BE(10);
  }
  while (pos + 10 <= end) {
    const id = buf.toString('latin1', pos, pos + 4);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const size = version === 4 ? syncsafe(pos + 4) : buf.readUInt32BE(pos + 4);
    const body = buf.subarray(pos + 10, Math.min(pos + 10 + size, end));
    if (id === 'TIT2' && body.length > 1) {
      return decodeText(body[0], body.subarray(1)) || undefined;
    }
    pos += 10 + size;
  }
  return undefined;
}

// The whole ID3 tag, which can be large when it embeds cover art.
function readTag(path: string): Buffer {
  const fd = openSync(path, 'r');
  try {
    const header = Buffer.alloc(10);
    if (readSync(fd, header, 0, 10, 0) < 10 || header.toString('latin1', 0, 3) !== 'ID3') return header;
    const size = 10 + ((header[6] << 21) | (header[7] << 14) | (header[8] << 7) | header[9]);
    const tag = Buffer.alloc(size);
    return tag.subarray(0, readSync(fd, tag, 0, size, 0));
  } finally {
    closeSync(fd);
  }
}

// Title from "NN - Title.mp3", else the ID3 title, else the bare file name.
export function titleFromFile(path: string): string {
  const file = path.split('/').pop() ?? path;
  return parseTrackFilename(file)?.title ?? readId3Title(readTag(path)) ?? file.replace(/\.mp3$/i, '');
}

// Tracks named "NN - Title.mp3", ordered by NN. The ID3 title is used when the name has none.
export function scanAlbum(dir: string): AlbumTrack[] {
  const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.mp3') && !f.startsWith('.'));
  if (files.length === 0) throw new Error(`No .mp3 files in ${dir}`);

  const unnumbered = files.filter((f) => !parseTrackFilename(f));
  if (unnumbered.length > 0) {
    throw new Error(`These files need a leading track number ("NN - Title.mp3"): ${unnumbered.join(', ')}`);
  }

  const tracks = files.map((file) => {
    const path = join(dir, file);
    return { number: parseTrackFilename(file)!.number, title: titleFromFile(path), path };
  });

  tracks.sort((a, b) => a.number - b.number);
  for (let i = 1; i < tracks.length; i++) {
    if (tracks[i].number === tracks[i - 1].number) {
      throw new Error(`Two files share track number ${tracks[i].number}`);
    }
  }
  return tracks;
}
