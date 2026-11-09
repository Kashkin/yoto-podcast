import { randomBytes } from 'node:crypto';
import type { YotoCard, YotoChapter, YotoTrack } from '../types.js';
import type { UploadedTrack } from './yoto.js';

// Pure edits on a card fetched from the API. Each returns a copy and leaves
// every field it wasn't asked to change exactly as it was.

export interface NewChapter {
  title: string;
  track: UploadedTrack;
  icon: string;
}

function usedKeys(chapters: YotoChapter[]): Set<string> {
  return new Set(chapters.flatMap((c) => [c.key, ...c.tracks.map((t) => t.key)]));
}

function newKey(used: Set<string>): string {
  let key: string;
  do {
    key = randomBytes(8).toString('base64url').slice(0, 10);
  } while (used.has(key));
  used.add(key);
  return key;
}

function makeChapter(ch: NewChapter, label: string, used: Set<string>): YotoChapter {
  const { trackUrl, format, duration, fileSize, channels } = ch.track;
  const track: YotoTrack = {
    key: newKey(used),
    title: ch.title,
    overlayLabel: label,
    display: { icon16x16: ch.icon },
    trackUrl,
    format,
    type: 'audio',
    ...(duration !== undefined && { duration }),
    ...(fileSize !== undefined && { fileSize }),
    ...(channels !== undefined && { channels }),
  };
  return {
    key: newKey(used),
    title: ch.title,
    overlayLabel: label,
    display: { icon16x16: ch.icon },
    tracks: [track],
    ...(duration !== undefined && { duration }),
    ...(fileSize !== undefined && { fileSize }),
  };
}

function chapterAt(card: YotoCard, n: number): YotoChapter {
  const chapter = card.content.chapters[n - 1];
  if (!Number.isInteger(n) || !chapter) {
    throw new Error(`Chapter ${n} not found (card has ${card.content.chapters.length} chapters)`);
  }
  return chapter;
}

function isDefaultNumbering(chapters: YotoChapter[]): boolean {
  return chapters.every((c, i) => c.overlayLabel === String(i + 1));
}

// Only renumber labels that were the plain 1..n sequence; custom labels stay put.
function renumber(chapters: YotoChapter[], wasDefault: boolean): void {
  if (!wasDefault) return;
  chapters.forEach((c, i) => {
    c.overlayLabel = String(i + 1);
    for (const t of c.tracks) if (t.overlayLabel !== undefined) t.overlayLabel = String(i + 1);
  });
}

// `icon` is the default; a chapter's own icon wins.
export function buildCard(opts: {
  title: string;
  coverUrl?: string;
  icon: string;
  chapters: (Omit<NewChapter, 'icon'> & { icon?: string })[];
}): YotoCard {
  const used = new Set<string>();
  const card: YotoCard = {
    title: opts.title,
    content: {
      chapters: opts.chapters.map((ch, i) => makeChapter({ ...ch, icon: ch.icon ?? opts.icon }, String(i + 1), used)),
      // Same playback settings the Yoto app gives a new MYO card
      config: { resumeTimeout: 2592000 },
      playbackType: 'linear',
    },
    metadata: opts.coverUrl ? { cover: { imageL: opts.coverUrl } } : {},
  };
  const tracks = card.content.chapters.flatMap((c) => c.tracks);
  card.metadata!.media = {
    duration: tracks.reduce((sum, t) => sum + (t.duration ?? 0), 0),
    fileSize: tracks.reduce((sum, t) => sum + (t.fileSize ?? 0), 0),
  };
  return card;
}

export function renameCard(card: YotoCard, title: string): YotoCard {
  const next = structuredClone(card);
  next.title = title;
  return next;
}

export function setCover(card: YotoCard, coverUrl: string): YotoCard {
  const next = structuredClone(card);
  next.metadata = { ...next.metadata, cover: { ...next.metadata?.cover, imageL: coverUrl } };
  return next;
}

export function renameChapter(card: YotoCard, n: number, title: string): YotoCard {
  const next = structuredClone(card);
  const chapter = chapterAt(next, n);
  chapter.title = title;
  if (chapter.tracks.length === 1) chapter.tracks[0].title = title;
  return next;
}

export function setChapterIcon(card: YotoCard, n: number, icon: string): YotoCard {
  const next = structuredClone(card);
  const chapter = chapterAt(next, n);
  chapter.display = { ...chapter.display, icon16x16: icon };
  for (const t of chapter.tracks) t.display = { ...t.display, icon16x16: icon };
  return next;
}

export function replaceChapterAudio(card: YotoCard, n: number, track: UploadedTrack): YotoCard {
  const next = structuredClone(card);
  const chapter = chapterAt(next, n);
  if (chapter.tracks.length !== 1) {
    throw new Error(`Chapter ${n} has ${chapter.tracks.length} tracks; only single-track chapters can have their audio replaced`);
  }
  const t = chapter.tracks[0];
  t.trackUrl = track.trackUrl;
  t.format = track.format;
  for (const field of ['duration', 'fileSize', 'channels'] as const) {
    if (track[field] !== undefined) (t as unknown as Record<string, unknown>)[field] = track[field];
  }
  if (track.duration !== undefined) chapter.duration = track.duration;
  if (track.fileSize !== undefined) chapter.fileSize = track.fileSize;
  return next;
}

// `at` is the 1-based position the new chapter ends up in; defaults to the end.
export function addChapter(card: YotoCard, ch: NewChapter, at?: number): YotoCard {
  const next = structuredClone(card);
  const chapters = next.content.chapters;
  const pos = at ?? chapters.length + 1;
  if (!Number.isInteger(pos) || pos < 1 || pos > chapters.length + 1) {
    throw new Error(`Position ${pos} is out of range (1-${chapters.length + 1})`);
  }
  const wasDefault = isDefaultNumbering(chapters);
  chapters.splice(pos - 1, 0, makeChapter(ch, String(pos), usedKeys(chapters)));
  renumber(chapters, wasDefault);
  return next;
}

export function removeChapter(card: YotoCard, n: number): YotoCard {
  const next = structuredClone(card);
  chapterAt(next, n);
  const wasDefault = isDefaultNumbering(next.content.chapters);
  next.content.chapters.splice(n - 1, 1);
  renumber(next.content.chapters, wasDefault);
  return next;
}

export function moveChapter(card: YotoCard, from: number, to: number): YotoCard {
  const next = structuredClone(card);
  chapterAt(next, from);
  chapterAt(next, to);
  const chapters = next.content.chapters;
  const wasDefault = isDefaultNumbering(chapters);
  const [moved] = chapters.splice(from - 1, 1);
  chapters.splice(to - 1, 0, moved);
  renumber(chapters, wasDefault);
  return next;
}

// Edits are read-modify-write; refuse to save over a change made elsewhere meanwhile.
export function assertUnchanged(read: YotoCard, latest: YotoCard): void {
  if (latest.updatedAt !== read.updatedAt) {
    throw new Error(
      `Card ${read.cardId} changed since it was read (saved at ${latest.updatedAt}), so nothing was saved. Run the command again.`
    );
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function show(v: unknown): string {
  return v === undefined ? '(none)' : JSON.stringify(v);
}

// Chapters are matched by key, so a move or insert reads as one line, not a
// change to every chapter after it. Returns null if keys aren't unique.
function diffChapters(before: YotoChapter[], after: YotoChapter[]): string[] | null {
  const beforeIdx = new Map(before.map((c, i) => [c.key, i]));
  const afterIdx = new Map(after.map((c, i) => [c.key, i]));
  if (beforeIdx.size !== before.length || afterIdx.size !== after.length) return null;

  const lines: string[] = [];
  before.forEach((c, i) => !afterIdx.has(c.key) && lines.push(`- chapter ${i + 1} "${c.title}"`));
  after.forEach((c, i) => !beforeIdx.has(c.key) && lines.push(`+ chapter ${i + 1} "${c.title}"`));

  const kept = after.filter((c) => beforeIdx.has(c.key));
  const oldOrder = before.filter((c) => afterIdx.has(c.key)).map((c) => c.key);
  if (kept.some((c, i) => c.key !== oldOrder[i])) {
    lines.push(`chapter order (old numbers): ${kept.map((c) => beforeIdx.get(c.key)! + 1).join(', ')}`);
  }

  let renumbered = false;
  const fields = kept.flatMap((a) => {
    const ai = afterIdx.get(a.key)!;
    const bi = beforeIdx.get(a.key)!;
    const b = before[bi];
    const label = structuredClone(a);
    // Hide plain 1..n renumbering; it's reported once below
    if (ai !== bi && b.overlayLabel === String(bi + 1) && a.overlayLabel === String(ai + 1)) {
      renumbered = true;
      label.overlayLabel = b.overlayLabel;
      label.tracks.forEach((t, ti) => {
        if (t.overlayLabel === String(ai + 1) && b.tracks[ti]?.overlayLabel === String(bi + 1)) t.overlayLabel = b.overlayLabel;
      });
    }
    return diffCards(b, label, `content.chapters[${ai}]`);
  });
  if (renumbered) lines.push(`player numbers renumbered 1-${after.length}`);
  return [...lines, ...fields];
}

// One line per changed leaf: `path: old → new`.
export function diffCards(before: unknown, after: unknown, path = ''): string[] {
  if (path === 'content.chapters' && Array.isArray(before) && Array.isArray(after)) {
    const chapters = diffChapters(before as YotoChapter[], after as YotoChapter[]);
    if (chapters) return chapters;
  }
  if (isObject(before) && isObject(after) && Array.isArray(before) === Array.isArray(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
    return keys.flatMap((k) => {
      const sub = Array.isArray(before) ? `${path}[${k}]` : path ? `${path}.${k}` : k;
      return diffCards(before[k], after[k], sub);
    });
  }
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  return [`${path}: ${show(before)} → ${show(after)}`];
}
