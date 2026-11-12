import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { checkPodcast, downloadNewEpisodes, pushNewEpisodes } from '../src/commands/check.js';
import { notify } from '../src/services/notify.js';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('../src/services/notify.js', () => ({ notify: vi.fn() }));

const TEST_DIR = join(import.meta.dirname, '.test-check');

const PODCAST = {
  name: 'Test',
  feedUrl: 'https://example.com/feed.xml',
  directory: TEST_DIR,
  cardId: 'test-card',
  skipPatterns: [],
};

// Newest first, like a real feed
function feedXml(titles: string[]): string {
  const items = titles
    .map((t, i) => `<item><title>${t}</title><enclosure url="https://example.com/${i}.mp3"/></item>`)
    .join('');
  return `<?xml version="1.0"?><rss version="2.0"><channel>${items}</channel></rss>`;
}

const MOCK_FEED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Test Podcast</title>
    <item>
      <title>Episode 3</title>
      <enclosure url="https://example.com/ep3.mp3" type="audio/mpeg"/>
    </item>
    <item>
      <title>Episode 2</title>
      <enclosure url="https://example.com/ep2.mp3" type="audio/mpeg"/>
    </item>
    <item>
      <title>Episode 1</title>
      <enclosure url="https://example.com/ep1.mp3" type="audio/mpeg"/>
    </item>
  </channel>
</rss>`;

describe('checkPodcast', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    vi.restoreAllMocks();
    vi.mocked(notify).mockClear();
  });
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it('detects new episodes and returns them', async () => {
    // Local has episodes 1 and 2
    writeFileSync(join(TEST_DIR, '01 - Episode 1.mp3'), '');
    writeFileSync(join(TEST_DIR, '02 - Episode 2.mp3'), '');

    // Mock feed fetch
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(MOCK_FEED_XML, { status: 200 })
    );

    const result = await checkPodcast({
      name: 'Test',
      feedUrl: 'https://example.com/feed.xml',
      directory: TEST_DIR,
      cardId: 'test-card',
      skipPatterns: [],
    });

    expect(result.newEpisodes).toHaveLength(1);
    expect(result.newEpisodes[0].title).toBe('Episode 3');
  });

  it('returns empty when up to date', async () => {
    writeFileSync(join(TEST_DIR, '01 - Episode 1.mp3'), '');
    writeFileSync(join(TEST_DIR, '02 - Episode 2.mp3'), '');
    writeFileSync(join(TEST_DIR, '03 - Episode 3.mp3'), '');

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(MOCK_FEED_XML, { status: 200 })
    );

    const result = await checkPodcast({
      name: 'Test',
      feedUrl: 'https://example.com/feed.xml',
      directory: TEST_DIR,
      cardId: 'test-card',
      skipPatterns: [],
    });

    expect(result.newEpisodes).toHaveLength(0);
  });

  it('reports a feed that cannot be reached instead of throwing', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('fetch failed'));
    const result = await checkPodcast(PODCAST);
    expect(result.errors).toEqual(['Failed to fetch feed: fetch failed']);
  });

  it('respects skip patterns', async () => {
    writeFileSync(join(TEST_DIR, '01 - Episode 1.mp3'), '');
    writeFileSync(join(TEST_DIR, '02 - Episode 2.mp3'), '');

    const feedWithReplay = MOCK_FEED_XML.replace(
      'Episode 3',
      'Episode 3 (Replay)'
    );
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(feedWithReplay, { status: 200 })
    );

    const result = await checkPodcast({
      name: 'Test',
      feedUrl: 'https://example.com/feed.xml',
      directory: TEST_DIR,
      cardId: 'test-card',
      skipPatterns: ['(Replay)'],
    });

    expect(result.newEpisodes).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
  });

  it('stops at an older local episode when the newest is renamed in the feed', async () => {
    writeFileSync(join(TEST_DIR, '01 - Episode 1.mp3'), '');
    writeFileSync(join(TEST_DIR, '02 - Episode 2.mp3'), '');
    writeFileSync(join(TEST_DIR, '03 - Episode 3.mp3'), '');

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(feedXml(['Episode 3 Remastered', 'Episode 2', 'Episode 1']), { status: 200 })
    );

    const result = await checkPodcast(PODCAST);

    expect(result.newEpisodes.map((e) => e.title)).toEqual(['Episode 3 Remastered']);
  });

  it('refuses to download more than 5 new episodes at once', async () => {
    writeFileSync(join(TEST_DIR, '01 - Episode 1.mp3'), '');
    const titles = [7, 6, 5, 4, 3, 2, 1].map((n) => `Episode ${n}`);

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(feedXml(titles), { status: 200 })
    );

    const result = await checkPodcast(PODCAST);

    expect(result.newEpisodes).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(notify).toHaveBeenCalledOnce();
  });

  it('downloads more than 5 new episodes when forced', async () => {
    writeFileSync(join(TEST_DIR, '01 - Episode 1.mp3'), '');
    const titles = [7, 6, 5, 4, 3, 2, 1].map((n) => `Episode ${n}`);

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(feedXml(titles), { status: 200 })
    );

    const result = await checkPodcast(PODCAST, { force: true });

    expect(result.newEpisodes).toHaveLength(6);
    expect(result.errors).toHaveLength(0);
  });
});

describe('downloadNewEpisodes', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  const episodes = ['One', 'Two', 'Three'].map((title, i) => ({ title, url: `https://example.com/${title}.mp3`, index: 3 - i }));

  it('stops at the first failed download so the next run retries it', async () => {
    mkdirSync(TEST_DIR, { recursive: true });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) =>
      String(url).includes('Two') ? new Response('', { status: 503 }) : new Response('audio')
    );
    const { downloaded, errors } = await downloadNewEpisodes(PODCAST, episodes);
    expect(downloaded).toEqual([join(TEST_DIR, '01 - One.mp3')]);
    expect(errors).toEqual(['Two: Download failed: 503']);
    expect(readdirSync(TEST_DIR)).toEqual(['01 - One.mp3']);
  });

  it('creates the podcast directory', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('audio'));
    const { downloaded } = await downloadNewEpisodes(PODCAST, episodes.slice(0, 1));
    expect(downloaded).toEqual([join(TEST_DIR, '01 - One.mp3')]);
  });
});

describe('pushNewEpisodes', () => {
  const track = { trackUrl: 'yoto:#t', format: 'opus' };
  const fakeYoto = (...titles: string[]) => ({
    getCard: vi.fn(async () => ({ title: 'Card', content: { chapters: titles.map((title, i) => ({ key: String(i), title, tracks: [] })) } })),
    uploadAudioFile: vi.fn(async () => track),
    prependTrackToCard: vi.fn(async () => {}),
  });

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    for (const f of ['01 - One.mp3', '02 - Two.mp3', '03 - Three.mp3']) writeFileSync(join(TEST_DIR, f), '');
    vi.restoreAllMocks();
    vi.mocked(notify).mockClear();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it('pushes episodes an earlier run left on disk, oldest first', async () => {
    const yoto = fakeYoto('01 - One');
    expect(await pushNewEpisodes(yoto, PODCAST, [])).toEqual(['02 - Two', '03 - Three']);
    expect(yoto.prependTrackToCard.mock.calls.map((c) => c[1])).toEqual(['02 - Two', '03 - Three']);
  });

  it('pushes nothing when the card already has the newest episode', async () => {
    const yoto = fakeYoto('03 - Three');
    expect(await pushNewEpisodes(yoto, PODCAST, [])).toEqual([]);
    expect(yoto.uploadAudioFile).not.toHaveBeenCalled();
  });

  it('pushes nothing to a card kept oldest first that has every episode', async () => {
    const yoto = fakeYoto('01 - One', '02 - Two', '03 - Three');
    expect(await pushNewEpisodes(yoto, PODCAST, [])).toEqual([]);
    expect(yoto.uploadAudioFile).not.toHaveBeenCalled();
  });

  it("pushes only this run's downloads when the card's newest chapter has no number", async () => {
    const yoto = fakeYoto('Welcome');
    expect(await pushNewEpisodes(yoto, PODCAST, [join(TEST_DIR, '03 - Three.mp3')])).toEqual(['03 - Three']);
  });

  it('stops and notifies when a push fails', async () => {
    const yoto = fakeYoto('01 - One');
    yoto.prependTrackToCard.mockRejectedValueOnce(new Error('503'));
    expect(await pushNewEpisodes(yoto, PODCAST, [])).toEqual([]);
    expect(yoto.uploadAudioFile).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith('Podcast: Test', 'Not pushed to Yoto: 503');
  });

  it('refuses to push more than 5 episodes at once', async () => {
    for (let n = 4; n <= 8; n++) writeFileSync(join(TEST_DIR, `0${n} - Ep ${n}.mp3`), '');
    const yoto = fakeYoto('01 - One');
    expect(await pushNewEpisodes(yoto, PODCAST, [])).toEqual([]);
    expect(yoto.uploadAudioFile).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledOnce();
  });
});
