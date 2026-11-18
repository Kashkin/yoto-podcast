import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { normalisePixels, iconPixelKey, duplicateGroups, renderContactSheet, userIconKeys, writeIconSheets } from '../src/services/icon-library.js';

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

describe('userIconKeys', () => {
  it('skips an icon it cannot read and still keys the rest', async () => {
    process.env.YOTO_ICON_CACHE = join(DIR, 'cache.json');
    const gold = readFileSync(join(DIR, 'gold.png'));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) =>
      String(url).endsWith('/bad') ? new Response('not an image') : new Response(gold)
    );
    const keys = await userIconKeys(
      [
        { mediaId: 'bad', url: 'https://icons/bad' },
        { mediaId: 'good', url: 'https://icons/good' },
      ],
      () => {}
    );
    expect([...keys.keys()]).toEqual(['good']);
    vi.restoreAllMocks();
    delete process.env.YOTO_ICON_CACHE;
  });
});

describe('writeIconSheets', () => {
  it('writes pages of 100, newest first, with an index of where each icon is', async () => {
    const gold = readFileSync(join(DIR, 'gold.png'));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(gold, { headers: { 'content-type': 'image/png' } }));
    const icons = Array.from({ length: 103 }, (_, i) => ({
      mediaId: `id${i}`,
      url: `https://example.test/${i}.png`,
      createdAt: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}.${String(i).padStart(3, '0')}Z`,
    }));
    const newest = [...icons].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    const files = await writeIconSheets(icons, join(DIR, 'mine.png'));

    expect(files).toEqual([join(DIR, 'mine-1.png'), join(DIR, 'mine-2.png'), join(DIR, 'mine.txt')]);
    const size = (f: string) =>
      execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', f]).toString().trim();
    expect(size(files[0])).toBe('720x720');
    expect(size(files[1])).toBe('216x72');
    const index = readFileSync(files[2], 'utf8').trim().split('\n');
    expect(index).toHaveLength(104);
    expect(index[0]).toBe('page row column icon added');
    expect(index[1]).toBe(`1 1 1 yoto:#${newest[0].mediaId} 2026-01-01`);
    expect(index[12]).toBe(`1 2 2 yoto:#${newest[11].mediaId} 2026-01-01`);
    expect(index[103]).toBe(`2 1 3 yoto:#${newest[102].mediaId} 2026-01-01`);
    vi.restoreAllMocks();
  });
});
