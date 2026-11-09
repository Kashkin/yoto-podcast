import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(import.meta.dirname, '.test-icon-resolve');
process.env.YOTO_ICON_CACHE = join(DIR, 'cache.json');
const { resolveIcon } = await import('../src/services/icon-resolve.js');

const ff = (...args: string[]) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);
let gold: Buffer;
let blue: Buffer;
let fetched: string[];

// A stand-in for the Yoto service, holding the given library icons
function fakeYoto(library: { mediaId: string; url: string }[]) {
  return {
    getUserIcons: vi.fn(async () => library),
    uploadIcon: vi.fn(async () => 'yoto:#uploaded'),
    getPublicIcons: vi.fn(async () => [{ mediaId: 'pub', title: 'Gold' }]),
  };
}

beforeAll(() => {
  mkdirSync(join(DIR, 'album', 'icons'), { recursive: true });
  ff('-f', 'lavfi', '-i', 'color=c=0xFFD700:s=16x16', '-frames:v', '1', '-pix_fmt', 'rgba', join(DIR, 'album', 'icons', 'gold.png'));
  ff('-f', 'lavfi', '-i', 'color=c=0x0000FF:s=16x16', '-frames:v', '1', '-pix_fmt', 'rgba', join(DIR, 'blue.png'));
  gold = readFileSync(join(DIR, 'album', 'icons', 'gold.png'));
  blue = readFileSync(join(DIR, 'blue.png'));
});

beforeEach(() => {
  vi.restoreAllMocks();
  rmSync(process.env.YOTO_ICON_CACHE!, { force: true });
  fetched = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    fetched.push(url);
    if (url === 'https://yotoicons.com/static/uploads/1701.png') return new Response(gold, { headers: { 'content-type': 'image/png' } });
    if (url.startsWith('https://yotoicons.com/api/counter')) return new Response('ok');
    if (url === 'https://library/gold') return new Response(gold);
    if (url === 'https://library/blue') return new Response(blue);
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterAll(() => rmSync(DIR, { recursive: true, force: true }));

const counted = () => fetched.filter((u) => u.includes('/api/counter'));

describe('resolveIcon with yotoicons', () => {
  it('reuses a library match on a dry run without counting a download', async () => {
    const yoto = fakeYoto([{ mediaId: 'g1', url: 'https://library/gold' }]);
    expect(await resolveIcon(yoto, 'yotoicons:1701', { dryRun: true })).toBe('yoto:#g1');
    expect(counted()).toEqual([]);
  });

  it('reuses a library match on a real run without counting a download', async () => {
    const yoto = fakeYoto([{ mediaId: 'g1', url: 'https://library/gold' }]);
    expect(await resolveIcon(yoto, 'yotoicons:1701', { dryRun: false })).toBe('yoto:#g1');
    expect(yoto.uploadIcon).not.toHaveBeenCalled();
    expect(counted()).toEqual([]);
  });

  it('counts the download once when it uploads', async () => {
    const yoto = fakeYoto([{ mediaId: 'b1', url: 'https://library/blue' }]);
    expect(await resolveIcon(yoto, 'yotoicons:1701', { dryRun: false })).toBe('yoto:#uploaded');
    expect(counted()).toEqual(['https://yotoicons.com/api/counter?download=1701']);
  });
});

describe('resolveIcon with an image path', () => {
  it('finds a relative path in the album folder, not the working directory', async () => {
    const yoto = fakeYoto([{ mediaId: 'b1', url: 'https://library/blue' }]);
    const ref = await resolveIcon(yoto, 'icons/gold.png', { dryRun: false, baseDir: join(DIR, 'album') });
    expect(ref).toBe('yoto:#uploaded');
    expect(yoto.getPublicIcons).not.toHaveBeenCalled();
  });
});
