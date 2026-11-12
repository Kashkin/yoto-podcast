import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCheck } from '../src/commands/check.js';
import { notify } from '../src/services/notify.js';
import { DEFAULT_ICON } from '../src/services/yoto.js';
import type { PodcastConfig, YotoCard } from '../src/types.js';

vi.mock('../src/services/notify.js', () => ({ notify: vi.fn() }));

const TEST_DIR = join(import.meta.dirname, '.test-check');
const FEED = 'https://example.com/feed.xml';
const PODCAST: PodcastConfig = { name: 'Test', feedUrl: FEED, directory: TEST_DIR, cardId: 'test-card', skipPatterns: [] };
const track = { trackUrl: 'yoto:#t', format: 'opus' };

const audioUrl = (title: string) => `https://example.com/${encodeURIComponent(title)}.mp3`;
const episodes = (...numbers: number[]) => numbers.map((n) => `Episode ${n}`);
const have = (...files: string[]) => files.forEach((f) => writeFileSync(join(TEST_DIR, f), ''));
const files = () => readdirSync(TEST_DIR).sort();

// Serves a feed of these titles (newest first, like a real feed) and each episode's audio.
// Audio for a title in `failing` returns 503.
function serve(titles: string[], failing: string[] = []) {
  const items = titles.map((t) => `<item><title>${t}</title><enclosure url="${audioUrl(t)}"/></item>`).join('');
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    if (url === FEED) return new Response(`<?xml version="1.0"?><rss version="2.0"><channel>${items}</channel></rss>`);
    if (failing.some((t) => url === audioUrl(t))) return new Response('', { status: 503 });
    return new Response('audio');
  });
}

// Holds a card with these chapter titles and saves over it, like the real thing
function fakeYoto(...titles: string[]) {
  let card: YotoCard = {
    cardId: 'test-card',
    title: 'Card',
    content: { chapters: titles.map((title, i) => ({ key: String(i), title, overlayLabel: String(i + 1), display: { icon16x16: 'yoto:#dino' }, tracks: [] })) },
  };
  return {
    getCard: vi.fn(async () => card),
    uploadAudioFile: vi.fn(async () => track),
    saveCard: vi.fn(async (after: YotoCard) => {
      card = after;
    }),
    chapters: () => card.content.chapters.map((c) => c.title),
    card: () => card,
  };
}

async function run(yoto: ReturnType<typeof fakeYoto> | null = fakeYoto(), opts?: { force?: boolean }, podcast = PODCAST) {
  const [result] = await runCheck({ podcasts: [podcast], yoto: { clientId: 'x' } }, yoto, opts);
  return result;
}

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  vi.restoreAllMocks();
  vi.mocked(notify).mockClear();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

describe('runCheck: finding and downloading', () => {
  it('downloads a new episode and puts it on top of the card', async () => {
    have('01 - Episode 1.mp3', '02 - Episode 2.mp3');
    serve(episodes(3, 2, 1));
    const yoto = fakeYoto('02 - Episode 2', '01 - Episode 1');

    const result = await run(yoto);

    expect(result).toEqual({ name: 'Test', downloaded: [join(TEST_DIR, '03 - Episode 3.mp3')], pushed: ['03 - Episode 3'], errors: [] });
    expect(yoto.chapters()).toEqual(['03 - Episode 3', '02 - Episode 2', '01 - Episode 1']);
  });

  it('does nothing when the folder and card are up to date', async () => {
    have('01 - Episode 1.mp3', '02 - Episode 2.mp3', '03 - Episode 3.mp3');
    const fetched = serve(episodes(3, 2, 1));
    const yoto = fakeYoto('03 - Episode 3');

    expect(await run(yoto)).toEqual({ name: 'Test', downloaded: [], pushed: [], errors: [] });
    expect(fetched).toHaveBeenCalledOnce();
    expect(yoto.saveCard).not.toHaveBeenCalled();
  });

  it('takes only the latest episode when the folder is empty', async () => {
    serve(episodes(3, 2, 1));
    await run();
    expect(files()).toEqual(['01 - Episode 3.mp3']);
  });

  it('creates the podcast directory', async () => {
    rmSync(TEST_DIR, { recursive: true });
    serve(episodes(1));
    expect((await run()).downloaded).toEqual([join(TEST_DIR, '01 - Episode 1.mp3')]);
  });

  it('skips episodes matching a skip pattern', async () => {
    have('01 - Episode 1.mp3', '02 - Episode 2.mp3');
    serve(['Episode 3 (Replay)', 'Episode 2', 'Episode 1']);
    const result = await run(fakeYoto('02 - Episode 2'), {}, { ...PODCAST, skipPatterns: ['(Replay)'] });
    expect(result.downloaded).toEqual([]);
    expect(files()).toHaveLength(2);
  });

  it('stops at an older local episode when the newest is renamed in the feed', async () => {
    have('01 - Episode 1.mp3', '02 - Episode 2.mp3', '03 - Episode 3.mp3');
    serve(['Episode 3 Remastered', 'Episode 2', 'Episode 1']);
    await run();
    expect(files()).toEqual(['01 - Episode 1.mp3', '02 - Episode 2.mp3', '03 - Episode 3.mp3', '04 - Episode 3 Remastered.mp3']);
  });

  it('refuses to download more than 5 new episodes at once', async () => {
    have('01 - Episode 1.mp3');
    serve(episodes(7, 6, 5, 4, 3, 2, 1));

    const result = await run();

    expect(result.downloaded).toEqual([]);
    expect(result.errors).toEqual([expect.stringContaining('6 new episodes found (limit 5)')]);
    expect(files()).toEqual(['01 - Episode 1.mp3']);
    expect(notify).toHaveBeenCalledOnce();
  });

  it('downloads and pushes more than 5 new episodes when forced', async () => {
    have('01 - Episode 1.mp3');
    serve(episodes(7, 6, 5, 4, 3, 2, 1));

    const result = await run(fakeYoto('01 - Episode 1'), { force: true });

    expect(result.downloaded).toHaveLength(6);
    expect(result.pushed).toHaveLength(6);
    expect(result.errors).toEqual([]);
  });

  it('stops at the first failed download and picks it up on the next run', async () => {
    have('01 - Episode 1.mp3');
    const yoto = fakeYoto('01 - Episode 1');

    serve(episodes(4, 3, 2, 1), ['Episode 3']);
    const first = await run(yoto);
    expect(first.errors).toEqual(['Episode 3: Download failed: 503']);
    expect(files()).toEqual(['01 - Episode 1.mp3', '02 - Episode 2.mp3']);

    vi.mocked(globalThis.fetch).mockRestore();
    serve(episodes(4, 3, 2, 1));
    const second = await run(yoto);
    expect(second.errors).toEqual([]);
    expect(yoto.chapters()).toEqual(['04 - Episode 4', '03 - Episode 3', '02 - Episode 2', '01 - Episode 1']);
  });

  it('reports a feed that cannot be reached and still checks the next podcast', async () => {
    const other = join(TEST_DIR, 'other');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input) === 'https://example.com/broken.xml') throw new TypeError('fetch failed');
      return new Response(String(input) === FEED ? '<rss><channel><item><title>One</title><enclosure url="https://example.com/1.mp3"/></item></channel></rss>' : 'audio');
    });

    const results = await runCheck(
      { podcasts: [{ ...PODCAST, name: 'Broken', feedUrl: 'https://example.com/broken.xml' }, { ...PODCAST, directory: other }], yoto: { clientId: 'x' } },
      null
    );

    expect(results[0].errors).toEqual(['Failed to fetch feed: fetch failed']);
    expect(results[1].downloaded).toEqual([join(other, '01 - One.mp3')]);
  });

  it('reports a podcast that crashes, notifies, and still checks the next one', async () => {
    writeFileSync(join(TEST_DIR, 'a-file'), '');
    serve(episodes(1));

    const results = await runCheck(
      { podcasts: [{ ...PODCAST, name: 'Crashes', directory: join(TEST_DIR, 'a-file') }, { ...PODCAST, directory: join(TEST_DIR, 'ok') }], yoto: { clientId: 'x' } },
      null
    );

    expect(results[0].errors).toEqual([expect.stringContaining('ENOTDIR')]);
    expect(notify).toHaveBeenCalledWith('Podcast: Crashes', expect.stringContaining('Check failed'));
    expect(results[1].downloaded).toHaveLength(1);
  });

  it('reads the card once to see what is missing and once per episode pushed', async () => {
    have('01 - Episode 1.mp3', '02 - Episode 2.mp3', '03 - Episode 3.mp3');
    serve(episodes(3, 2, 1));
    const yoto = fakeYoto('01 - Episode 1');
    await run(yoto);
    expect(yoto.getCard).toHaveBeenCalledTimes(3);
  });

  it('downloads but pushes nothing without a Yoto connection', async () => {
    serve(episodes(1));
    const result = await run(null);
    expect(result.downloaded).toHaveLength(1);
    expect(result.pushed).toEqual([]);
    expect(result.errors).toEqual([]);
  });
});

describe('runCheck: pushing to the card', () => {
  beforeEach(() => {
    have('01 - Episode 1.mp3', '02 - Episode 2.mp3', '03 - Episode 3.mp3');
    serve(episodes(3, 2, 1));
  });

  it('pushes episodes an earlier run left on disk, oldest first', async () => {
    const yoto = fakeYoto('01 - Episode 1');
    expect((await run(yoto)).pushed).toEqual(['02 - Episode 2', '03 - Episode 3']);
    expect(yoto.chapters()).toEqual(['03 - Episode 3', '02 - Episode 2', '01 - Episode 1']);
    expect(yoto.card().content.chapters.map((c) => c.overlayLabel)).toEqual(['1', '2', '3']);
  });

  it('renumbers the whole card even when its numbers had a gap', async () => {
    const yoto = fakeYoto('02 - Episode 2', '01 - Episode 1');
    yoto.card().content.chapters[1].overlayLabel = '7';
    await run(yoto);
    expect(yoto.card().content.chapters.map((c) => c.overlayLabel)).toEqual(['1', '2', '3']);
  });

  it('keeps the icons already on the card and gives only the new chapter the default', async () => {
    const yoto = fakeYoto('02 - Episode 2');
    await run(yoto);
    expect(yoto.card().content.chapters.map((c) => c.display?.icon16x16)).toEqual([DEFAULT_ICON, 'yoto:#dino']);
  });

  it('pushes nothing to a card kept oldest first that has every episode', async () => {
    const yoto = fakeYoto('01 - Episode 1', '02 - Episode 2', '03 - Episode 3');
    expect((await run(yoto)).pushed).toEqual([]);
    expect(yoto.uploadAudioFile).not.toHaveBeenCalled();
  });

  it("pushes only this run's downloads when the card has no numbered chapters", async () => {
    serve(episodes(4, 3, 2, 1));
    const yoto = fakeYoto('Welcome');
    expect((await run(yoto)).pushed).toEqual(['04 - Episode 4']);
  });

  it('stops, reports and notifies when a push fails', async () => {
    const yoto = fakeYoto('01 - Episode 1');
    yoto.saveCard.mockRejectedValueOnce(new Error('503'));

    const result = await run(yoto);

    expect(result.pushed).toEqual([]);
    expect(result.errors).toEqual(['Not pushed to Yoto: 503']);
    expect(yoto.uploadAudioFile).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith('Podcast: Test', 'Not pushed to Yoto: 503');
  });

  it('refuses to push more than 5 episodes at once', async () => {
    for (let n = 4; n <= 8; n++) have(`0${n} - Episode ${n}.mp3`);
    serve(episodes(8, 7, 6, 5, 4, 3, 2, 1));
    const yoto = fakeYoto('01 - Episode 1');

    const result = await run(yoto);

    expect(result.pushed).toEqual([]);
    expect(result.errors).toEqual([expect.stringContaining('7 episodes on disk are missing from the card')]);
    expect(yoto.uploadAudioFile).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledOnce();
  });
});
