import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { parseTinkerId, tinkerKey, searchTinker, downloadTinkerIcon, writeTinkerSheet } from '../src/services/tinker.js';

const DIR = join(import.meta.dirname, '.test-tinker');
const ID = '0b2f1c5e-1234-4abc-9def-0123456789ab';
const ff = (...args: string[]) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);
const size = (file: string) =>
  execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', file]).toString().trim();
let red: Buffer;

beforeAll(() => {
  mkdirSync(DIR, { recursive: true });
  ff('-f', 'lavfi', '-i', 'color=c=red:s=16x16', '-frames:v', '1', '-pix_fmt', 'rgba', join(DIR, 'red.png'));
  red = readFileSync(join(DIR, 'red.png'));
});

beforeEach(() => {
  vi.restoreAllMocks();
  delete process.env.TINKER_API_KEY;
});

afterAll(() => rmSync(DIR, { recursive: true, force: true }));

describe('parseTinkerId', () => {
  it('accepts tinker:<id> and the icon CDN URL', () => {
    expect(parseTinkerId(`tinker:${ID}`)).toBe(ID);
    expect(parseTinkerId(`https://cdn.tinker.audio/icons/${ID}.png`)).toBe(ID);
  });

  it('ignores other icons', () => {
    expect(parseTinkerId('yotoicons:1701')).toBeNull();
    expect(parseTinkerId('rocket')).toBeNull();
    expect(parseTinkerId(`https://example.com/icons/${ID}.png`)).toBeNull();
  });
});

describe('tinkerKey', () => {
  it('reads an op:// reference from 1Password', async () => {
    process.env.TINKER_API_KEY = 'op://Private/Tinker API/key';
    const read = vi.fn(async () => 'tk_live_secret');
    expect(await tinkerKey(read)).toBe('tk_live_secret');
    expect(read).toHaveBeenCalledWith('op://Private/Tinker API/key');
  });

  it('takes a plain key as it is', async () => {
    process.env.TINKER_API_KEY = 'tk_live_plain';
    expect(await tinkerKey(vi.fn())).toBe('tk_live_plain');
  });

  it('says how to set it when missing', async () => {
    await expect(tinkerKey(vi.fn())).rejects.toThrow(/TINKER_API_KEY/);
  });
});

describe('searchTinker', () => {
  it('sends the key as a header, never in the URL', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({ query: 'wolf', results: [{ id: ID, name: 'Wolf', url: `https://cdn.tinker.audio/icons/${ID}.png` }] })
    );

    const results = await searchTinker('grey wolf', 12, 'tk_live_secret');

    expect(results).toEqual([{ id: ID, name: 'Wolf', url: `https://cdn.tinker.audio/icons/${ID}.png` }]);
    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toBe('https://api.tinker.audio/icons?q=grey+wolf&limit=12');
    expect(String(url)).not.toContain('tk_live');
    expect(new Headers(init?.headers).get('X-Tinker-Key')).toBe('tk_live_secret');
  });

  it("reports Tinker's error and when to retry", async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({ error: 'Out of room for now.' }, { status: 429, headers: { 'Retry-After': '30' } })
    );
    await expect(searchTinker('wolf', 20, 'k')).rejects.toThrow('Tinker search failed (429): Out of room for now. Try again in 30 s.');
  });
});

describe('downloadTinkerIcon', () => {
  it('fetches the PNG from the CDN', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(red, { headers: { 'content-type': 'image/png' } }));
    expect(await downloadTinkerIcon(ID)).toEqual(red);
    expect(String(fetch.mock.calls[0][0])).toBe(`https://cdn.tinker.audio/icons/${ID}.png`);
  });

  it('says when an icon has left the library', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 404 }));
    await expect(downloadTinkerIcon(ID)).rejects.toThrow(/left the library/);
  });
});

describe('writeTinkerSheet', () => {
  it('tiles the icons in result order, ten to a row, enlarged', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(red, { headers: { 'content-type': 'image/png' } }));
    const icons = Array.from({ length: 12 }, (_, i) => ({ id: `${i}`, name: `Icon ${i}`, url: `https://cdn.tinker.audio/icons/${i}.png` }));
    const out = join(DIR, 'sheet.png');

    await writeTinkerSheet(icons, out);

    expect(size(out)).toBe('720x144');
    // The two empty slots at the end of the second row are grey, not black
    const corner = execFileSync('ffmpeg', ['-v', 'error', '-i', out, '-vf', 'crop=1:1:719:143,format=rgb24', '-f', 'rawvideo', '-']);
    expect([...corner]).toEqual([0xbb, 0xbb, 0xbb]);
  });

  it('makes a single row narrower when there are fewer than ten', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(red, { headers: { 'content-type': 'image/png' } }));
    const icons = Array.from({ length: 3 }, (_, i) => ({ id: `${i}`, name: `Icon ${i}`, url: `https://cdn.tinker.audio/icons/${i}.png` }));
    const out = join(DIR, 'small.png');

    await writeTinkerSheet(icons, out);

    expect(size(out)).toBe('216x72');
  });
});
