import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { normalisePixels, iconPixelKey, duplicateGroups, renderContactSheet } from '../src/services/icon-library.js';

const DIR = join(import.meta.dirname, '.test-icons');
const ff = (...args: string[]) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);

beforeAll(() => {
  mkdirSync(DIR, { recursive: true });
  ff('-f', 'lavfi', '-i', 'color=c=0xFFD700:s=16x16', '-frames:v', '1', '-pix_fmt', 'rgba', join(DIR, 'gold.png'));
  // Same pixels, different encoder settings, so different bytes
  ff('-f', 'lavfi', '-i', 'color=c=0xFFD700:s=16x16', '-frames:v', '1', '-pix_fmt', 'rgba', '-compression_level', '0', join(DIR, 'gold-raw.png'));
  ff('-f', 'lavfi', '-i', 'color=c=0x0000FF:s=16x16', '-frames:v', '1', '-pix_fmt', 'rgba', join(DIR, 'blue.png'));
});

afterAll(() => rmSync(DIR, { recursive: true, force: true }));

describe('normalisePixels', () => {
  it('treats all fully transparent pixels as the same', () => {
    const a = Buffer.from([10, 20, 30, 0, 1, 2, 3, 255]);
    const b = Buffer.from([99, 98, 97, 0, 1, 2, 3, 255]);
    expect(normalisePixels(a)).toEqual(normalisePixels(b));
  });
});

describe('iconPixelKey', () => {
  it('matches the same picture saved two ways', async () => {
    const gold = readFileSync(join(DIR, 'gold.png'));
    const raw = readFileSync(join(DIR, 'gold-raw.png'));
    expect(gold.equals(raw)).toBe(false);
    expect(await iconPixelKey(gold)).toBe(await iconPixelKey(raw));
  });

  it('differs for a different picture', async () => {
    expect(await iconPixelKey(readFileSync(join(DIR, 'gold.png')))).not.toBe(await iconPixelKey(readFileSync(join(DIR, 'blue.png'))));
  });
});

describe('duplicateGroups', () => {
  it('groups icon IDs that share pixels', () => {
    expect(duplicateGroups(new Map([['a', 'k1'], ['b', 'k2'], ['c', 'k1']]))).toEqual([['a', 'c']]);
  });
});

describe('renderContactSheet', () => {
  it('shows each icon with its reference and marks duplicates', () => {
    const html = renderContactSheet(
      [
        { mediaId: 'aaa', url: 'https://x/aaa', createdAt: '2026-01-02T00:00:00Z' },
        { mediaId: 'bbb', url: 'https://x/bbb', createdAt: '2026-01-01T00:00:00Z' },
      ],
      [['aaa', 'bbb']]
    );
    expect(html).toContain('<img src="https://x/aaa"');
    expect(html).toContain('yoto:#aaa');
    expect(html).toMatch(/duplicate/i);
  });
});
