import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pushToCard, runBackfill } from '../src/commands/backfill.js';
import { DEFAULT_ICON } from '../src/services/yoto.js';
import type { YotoChapter } from '../src/types.js';

vi.mock('../src/services/notify.js', () => ({ notify: vi.fn() }));

const files = [
  { title: '01 - One', path: '/eps/01 - One.mp3' },
  { title: '02 - Two', path: '/eps/02 - Two.mp3' },
];
const track = (id: string) => ({ trackUrl: `yoto:#${id}`, format: 'opus' });
const card = () => ({ cardId: 'card', title: 'Show', content: { chapters: [{ key: 'old', title: 'Old', tracks: [] }] } });

describe('pushToCard', () => {
  it('puts every episode on the card, newest first', async () => {
    const yoto = { uploadAudioFile: vi.fn(async (path: string) => track(path.includes('One') ? 'a' : 'b')), getCard: vi.fn(async () => card()), saveIfUnchanged: vi.fn() };
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await pushToCard(yoto, 'card', files);
    const saved = yoto.saveIfUnchanged.mock.calls[0][1];
    expect(saved.title).toBe('Show');
    expect(saved.content.chapters.map((c: YotoChapter) => [c.title, c.overlayLabel, c.tracks[0].trackUrl, c.display?.icon16x16])).toEqual([
      ['02 - Two', '1', 'yoto:#b', DEFAULT_ICON],
      ['01 - One', '2', 'yoto:#a', DEFAULT_ICON],
    ]);
  });

  it('leaves the card alone when any upload fails', async () => {
    const yoto = {
      uploadAudioFile: vi.fn(async (path: string) => {
        if (path.includes('Two')) throw new Error('401 Unauthorized');
        return track('a');
      }),
      getCard: vi.fn(async () => card()),
      saveIfUnchanged: vi.fn(),
    };
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(pushToCard(yoto, 'card', files)).rejects.toThrow(/1 of 2 track\(s\) failed to upload, so the card was left as it was[\s\S]*02 - Two: 401 Unauthorized/);
    expect(yoto.saveIfUnchanged).not.toHaveBeenCalled();
  });
});

describe('runBackfill', () => {
  const DIR = join(import.meta.dirname, '.test-backfill');
  const feed = (titles: string[]) =>
    `<rss><channel>${titles.map((t, i) => `<item><title>${t}</title><enclosure url="https://example.com/${i}.mp3"/></item>`).join('')}</channel></rss>`;
  const paths = { configPath: '/none', tokensPath: '/none' };

  beforeEach(() => {
    mkdirSync(DIR, { recursive: true });
    vi.restoreAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => rmSync(DIR, { recursive: true, force: true }));

  it('keeps files it already has when the feed has dropped older episodes', async () => {
    writeFileSync(join(DIR, '02 - Two.mp3'), '');
    writeFileSync(join(DIR, '03 - Three.mp3'), '');
    const fetched: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      fetched.push(String(url));
      return new Response(String(url).endsWith('feed.xml') ? feed(['Four', 'Three', 'Two']) : 'audio');
    });
    await runBackfill({ feed: 'https://example.com/feed.xml', dir: DIR, name: 'Test' }, paths);
    expect(fetched).toEqual(['https://example.com/feed.xml', 'https://example.com/0.mp3']);
    expect(readdirSync(DIR).sort()).toEqual(['02 - Two.mp3', '03 - Four.mp3', '03 - Three.mp3']);
  });

  it('writes nothing on a dry run', async () => {
    const fetched: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      fetched.push(String(url));
      return new Response(feed(['Two', 'One']));
    });
    await runBackfill({ feed: 'https://example.com/feed.xml', dir: join(DIR, 'new'), name: 'Test', card: 'card', dryRun: true }, paths);
    expect(fetched).toEqual(['https://example.com/feed.xml']);
    expect(readdirSync(DIR)).toEqual([]);
  });
});
