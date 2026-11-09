import { describe, it, expect } from 'vitest';
import {
  buildCard,
  renameCard,
  setCover,
  renameChapter,
  setChapterIcon,
  replaceChapterAudio,
  addChapter,
  removeChapter,
  moveChapter,
  diffCards,
  assertUnchanged,
} from '../src/services/card-edit.js';
import type { YotoCard } from '../src/types.js';

const track = (id: string, duration = 60, fileSize = 1000) => ({
  trackUrl: `yoto:#${id}`,
  format: 'opus',
  duration,
  fileSize,
  channels: 'mono',
});

// Shaped like a card made in the Yoto app, including fields this code doesn't know about
function appCard(): YotoCard {
  const chapter = (key: string, n: number, title: string) => ({
    key,
    title,
    overlayLabel: String(n),
    display: { icon16x16: `yoto:#icon${n}` },
    availableFrom: null,
    duration: 60,
    fileSize: 1000,
    tracks: [
      {
        key: `t${key}`,
        title,
        overlayLabel: String(n),
        display: { icon16x16: `yoto:#icon${n}` },
        trackUrl: `yoto:#audio${n}`,
        format: 'opus',
        type: 'audio',
        duration: 60,
        fileSize: 1000,
        channels: 'mono',
        ambient: null,
      },
    ],
  });
  return {
    cardId: 'abc12',
    title: 'Mice on the Moon',
    userId: 'auth0|x',
    slug: 'slug',
    content: {
      chapters: [chapter('kA', 1, 'One'), chapter('kB', 2, 'Two'), chapter('kC', 3, 'Three')],
      config: { resumeTimeout: 2592000 },
      playbackType: 'linear',
    },
    metadata: { cover: { imageL: 'https://cover/old' }, media: { duration: 180, fileSize: 3000 }, copyrights: ['©'] },
  } as unknown as YotoCard;
}

const titles = (card: YotoCard) => card.content.chapters.map((c) => c.title);
const labels = (card: YotoCard) => card.content.chapters.map((c) => c.overlayLabel);

describe('buildCard', () => {
  const card = buildCard({
    title: 'Mice on the Moon',
    coverUrl: 'https://cover/new',
    icon: 'yoto:#default',
    chapters: [
      { title: 'Title and Credits', track: track('a', 20, 100) },
      { title: 'Part 1', track: track('b', 300, 2000) },
    ],
  });

  it('has no cardId so the API creates a new card', () => {
    expect(card.cardId).toBeUndefined();
  });

  it('makes one chapter per track, in order, numbered from 1', () => {
    expect(titles(card)).toEqual(['Title and Credits', 'Part 1']);
    expect(labels(card)).toEqual(['1', '2']);
    expect(card.content.chapters[1].tracks[0]).toMatchObject({ title: 'Part 1', trackUrl: 'yoto:#b', type: 'audio', duration: 300 });
  });

  it('gives every chapter and track a unique key', () => {
    const keys = card.content.chapters.flatMap((c) => [c.key, ...c.tracks.map((t) => t.key)]);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('sets the icon on chapters and tracks', () => {
    expect(card.content.chapters[0].display?.icon16x16).toBe('yoto:#default');
    expect(card.content.chapters[0].tracks[0].display?.icon16x16).toBe('yoto:#default');
  });

  it('lets a chapter override the card icon', () => {
    const custom = buildCard({
      title: 'x',
      icon: 'yoto:#default',
      chapters: [
        { title: 'One', track: track('a') },
        { title: 'Two', track: track('b'), icon: 'yoto:#rocket' },
      ],
    });
    expect(custom.content.chapters.map((c) => c.display?.icon16x16)).toEqual(['yoto:#default', 'yoto:#rocket']);
    expect(custom.content.chapters[1].tracks[0].display?.icon16x16).toBe('yoto:#rocket');
  });

  it('sets the cover and media totals', () => {
    expect(card.metadata?.cover?.imageL).toBe('https://cover/new');
    expect(card.metadata?.media).toEqual({ duration: 320, fileSize: 2100 });
  });
});

describe('edits', () => {
  it('do not mutate the input card', () => {
    const before = appCard();
    const copy = structuredClone(before);
    renameChapter(before, 1, 'New');
    removeChapter(before, 2);
    expect(before).toEqual(copy);
  });

  it('renameCard changes only the title', () => {
    expect(diffCards(appCard(), renameCard(appCard(), 'New Title'))).toEqual([
      'title: "Mice on the Moon" → "New Title"',
    ]);
  });

  it('setCover changes only the cover', () => {
    expect(diffCards(appCard(), setCover(appCard(), 'https://cover/new'))).toEqual([
      'metadata.cover.imageL: "https://cover/old" → "https://cover/new"',
    ]);
  });

  it('renameChapter renames the chapter and its single track', () => {
    expect(diffCards(appCard(), renameChapter(appCard(), 2, 'Blast off'))).toEqual([
      'content.chapters[1].title: "Two" → "Blast off"',
      'content.chapters[1].tracks[0].title: "Two" → "Blast off"',
    ]);
  });

  it('setChapterIcon sets the chapter and track icon', () => {
    expect(diffCards(appCard(), setChapterIcon(appCard(), 3, 'yoto:#rocket'))).toEqual([
      'content.chapters[2].display.icon16x16: "yoto:#icon3" → "yoto:#rocket"',
      'content.chapters[2].tracks[0].display.icon16x16: "yoto:#icon3" → "yoto:#rocket"',
    ]);
  });

  it('replaceChapterAudio swaps the audio and updates durations', () => {
    const after = replaceChapterAudio(appCard(), 1, track('new', 90, 1500));
    expect(after.content.chapters[0].tracks[0]).toMatchObject({ trackUrl: 'yoto:#new', duration: 90, fileSize: 1500, title: 'One', key: 'tkA' });
    expect(after.content.chapters[0]).toMatchObject({ duration: 90, fileSize: 1500 });
    expect(after.metadata?.media).toEqual({ duration: 180, fileSize: 3000 }); // Yoto keeps its own totals
  });

  it('replaceChapterAudio refuses a chapter with several tracks', () => {
    const card = appCard();
    card.content.chapters[0].tracks.push({ ...card.content.chapters[0].tracks[0], key: 'extra' });
    expect(() => replaceChapterAudio(card, 1, track('new'))).toThrow(/2 tracks/);
  });

  it('rejects chapter numbers that are out of range', () => {
    expect(() => renameChapter(appCard(), 0, 'x')).toThrow(/Chapter 0 not found \(card has 3 chapters\)/);
    expect(() => renameChapter(appCard(), 4, 'x')).toThrow(/Chapter 4 not found/);
  });
});

describe('structural edits', () => {
  it('addChapter appends by default and numbers it', () => {
    const after = addChapter(appCard(), { title: 'Four', track: track('d'), icon: 'yoto:#default' });
    expect(titles(after)).toEqual(['One', 'Two', 'Three', 'Four']);
    expect(labels(after)).toEqual(['1', '2', '3', '4']);
    expect(after.metadata?.media).toEqual({ duration: 180, fileSize: 3000 });
  });

  it('addChapter inserts at a position and renumbers the default labels', () => {
    const after = addChapter(appCard(), { title: 'Intro', track: track('d'), icon: 'yoto:#default' }, 1);
    expect(titles(after)).toEqual(['Intro', 'One', 'Two', 'Three']);
    expect(labels(after)).toEqual(['1', '2', '3', '4']);
    expect(after.content.chapters[1].tracks[0].overlayLabel).toBe('2');
  });

  it('addChapter gives the new chapter keys not already used', () => {
    const after = addChapter(appCard(), { title: 'Four', track: track('d'), icon: 'yoto:#default' });
    const keys = after.content.chapters.flatMap((c) => [c.key, ...c.tracks.map((t) => t.key)]);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('removeChapter drops the chapter, renumbers and keeps keys', () => {
    const after = removeChapter(appCard(), 2);
    expect(titles(after)).toEqual(['One', 'Three']);
    expect(labels(after)).toEqual(['1', '2']);
    expect(after.content.chapters.map((c) => c.key)).toEqual(['kA', 'kC']);
    expect(after.metadata?.media).toEqual({ duration: 180, fileSize: 3000 });
  });

  it('moveChapter reorders and renumbers', () => {
    const after = moveChapter(appCard(), 3, 1);
    expect(titles(after)).toEqual(['Three', 'One', 'Two']);
    expect(labels(after)).toEqual(['1', '2', '3']);
  });

  it('leaves custom overlay labels alone', () => {
    const card = appCard();
    card.content.chapters.forEach((c, i) => (c.overlayLabel = ['A', 'B', 'C'][i]));
    expect(labels(moveChapter(card, 3, 1))).toEqual(['C', 'A', 'B']);
  });
});

describe('diffCards', () => {
  it('reports added and removed fields', () => {
    const a = { title: 'x', metadata: { cover: { imageL: 'u' } } } as unknown as YotoCard;
    const b = { title: 'x', metadata: {} } as unknown as YotoCard;
    expect(diffCards(a, b)).toEqual(['metadata.cover: {"imageL":"u"} → (none)']);
    expect(diffCards(b, a)).toEqual(['metadata.cover: (none) → {"imageL":"u"}']);
  });

  it('summarises a move as the new order', () => {
    expect(diffCards(appCard(), moveChapter(appCard(), 3, 1))).toEqual([
      'chapter order (old numbers): 3, 1, 2',
      'player numbers renumbered 1-3',
    ]);
  });

  it('names added and removed chapters', () => {
    const added = addChapter(appCard(), { title: 'Intro', track: track('d'), icon: 'yoto:#default' }, 1);
    expect(diffCards(appCard(), added)).toEqual(['+ chapter 1 "Intro"', 'player numbers renumbered 1-4']);
    expect(diffCards(appCard(), removeChapter(appCard(), 2))).toEqual(['- chapter 2 "Two"', 'player numbers renumbered 1-2']);
  });

  it('shows field changes against the chapter in its new position', () => {
    const after = renameChapter(moveChapter(appCard(), 3, 1), 1, 'Last first');
    expect(diffCards(appCard(), after)).toEqual([
      'chapter order (old numbers): 3, 1, 2',
      'player numbers renumbered 1-3',
      'content.chapters[0].title: "Three" → "Last first"',
      'content.chapters[0].tracks[0].title: "Three" → "Last first"',
    ]);
  });

  it('is empty when nothing changed', () => {
    expect(diffCards(appCard(), appCard())).toEqual([]);
  });
});

describe('assertUnchanged', () => {
  const at = (updatedAt: string) => ({ ...appCard(), updatedAt }) as YotoCard;

  it('passes when the card has not been saved since it was read', () => {
    expect(() => assertUnchanged(at('2026-10-22T13:29:51Z'), at('2026-10-22T13:29:51Z'))).not.toThrow();
  });

  it('refuses when the card was saved elsewhere in the meantime', () => {
    expect(() => assertUnchanged(at('2026-10-22T13:29:51Z'), at('2026-10-22T13:31:00Z'))).toThrow(
      /changed since it was read.*nothing was saved/s
    );
  });
});
