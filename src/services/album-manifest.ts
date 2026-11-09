import { normalize } from 'node:path';
import { formatFilename, sanitizeTitle } from './download.js';

// album.json: everything needed to turn a folder of source audio into a
// finished album in Box. Written by Claude (see the yoto-album skill), read
// by `prepare` and `card create`.

export const CATEGORIES = ['Stories', 'Songs', 'Non-fiction'] as const;

export interface ManifestTrack {
  file: string; // source file, relative to `source` or absolute (e.g. a later disc's rip)
  title: string; // goes in the file name (minus Box-unsafe characters) and the title tag
  icon?: string; // emoji or :label: for the track guide; required unless the track is part of a story
  story?: string; // title of an entry in `stories`: the part takes that story's icons
  description: string;
  name?: string; // snake_case suggested name; derived from the title if absent
  leaveOff?: boolean; // e.g. disc announcements: kept as a file, skipped on the card
  yotoIcon?: string; // card icon: anything `chapter icon` accepts
}

// A story told over several tracks. Its parts share one icon, different from every other in the album.
export interface ManifestStory {
  title: string;
  icon: string; // emoji or :label:
  yotoIcon?: string;
}

export interface AlbumManifest {
  category: (typeof CATEGORIES)[number];
  series: string; // series or author: the folder is "<series> - <title>"
  title: string;
  heading?: string; // track guide heading, default "<series> – <title>"
  author: string;
  narrators: string[];
  narration?: (typeof NARRATIONS)[number];
  publisher: string;
  year: number;
  genre?: string; // default: keep the source's genre, else Audiobook
  multiDisc?: boolean; // track tag without "/total"
  discCoverage?: string;
  iconNotes?: string;
  source: string; // folder holding the source files, relative to the manifest; "." once prepared
  cover: string; // portrait cover URL or path, saved as Cover images/<slug>.jpg
  embedCover?: string; // different art to embed (URL or path), e.g. square audiobook art; default `cover`; "keep" keeps each source's own art
  stories?: ManifestStory[];
  tracks: ManifestTrack[];
}

// An icon is an emoji, or a :label: naming what it should show (:bingo:) when an emoji would be vague
const LABEL = /^:[a-z0-9_]+:$/;
const isIcon = (icon: string) =>
  LABEL.test(icon) || (/\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(icon) && !/[A-Za-z]/.test(icon));
const badIcon = (icon: string) => `icon "${icon}" must be an emoji or a :label: like :bingo:`;

const NARRATIONS = ['Read by', 'Told by', 'Sung by', 'Performed by'] as const;
const REQUIRED = ['category', 'series', 'title', 'author', 'narrators', 'publisher', 'year', 'source', 'cover', 'tracks'] as const;
const TRACK_REQUIRED = ['file', 'title', 'description'] as const;

export function parseManifest(json: string): AlbumManifest {
  const m = JSON.parse(json) as AlbumManifest;
  const missing = REQUIRED.filter((k) => m[k] === undefined || m[k] === '');
  if (missing.length) throw new Error(`Manifest is missing: ${missing.join(', ')}`);
  if (!CATEGORIES.includes(m.category)) {
    throw new Error(`Manifest category must be one of ${CATEGORIES.join(', ')} (got "${m.category}")`);
  }
  if (!Array.isArray(m.tracks) || m.tracks.length === 0) throw new Error('Manifest has no tracks');

  const errors: string[] = [];
  if (!Array.isArray(m.narrators) || m.narrators.length === 0 || m.narrators.some((n) => typeof n !== 'string' || !n)) {
    errors.push('narrators must be a list of names, e.g. ["Barnaby Edwards"]');
  }
  if (m.genre !== undefined && (typeof m.genre !== 'string' || !m.genre)) errors.push('genre must be text; leave it out to keep the source genre');
  if (m.narration !== undefined && !NARRATIONS.includes(m.narration)) {
    errors.push(`narration must be one of ${NARRATIONS.map((v) => `"${v}"`).join(', ')}`);
  }
  const stories = new Map<string, ManifestStory>();
  for (const st of m.stories ?? []) {
    if (stories.has(st.title)) errors.push(`story "${st.title}" is listed twice`);
    stories.set(st.title, st);
  }
  for (const st of stories.values()) {
    if (!st.icon) errors.push(`story "${st.title}": missing icon`);
    else if (!isIcon(st.icon)) errors.push(`story "${st.title}": ${badIcon(st.icon)}`);
  }

  const iconOwners = new Map<string, string[]>();
  const own = (icon: string, owner: string) => iconOwners.set(icon, [...(iconOwners.get(icon) ?? []), owner]);
  for (const st of stories.values()) if (st.icon) own(st.icon, `story "${st.title}"`);
  const parts = new Map<string, number[]>();

  m.tracks.forEach((t, i) => {
    const n = i + 1;
    const gaps = TRACK_REQUIRED.filter((k) => !t[k]);
    if (gaps.length) errors.push(`track ${n}: missing ${gaps.join(', ')}`);
    if (t.story) {
      if (!stories.has(t.story)) errors.push(`track ${n}: story "${t.story}" is not in stories`);
      for (const k of ['icon', 'yotoIcon'] as const) {
        if (t[k]) errors.push(`track ${n}: ${k} comes from story "${t.story}"; remove it from the track`);
      }
      parts.set(t.story, [...(parts.get(t.story) ?? []), n]);
    } else if (!t.icon) {
      errors.push(`track ${n}: missing icon`);
    } else if (!isIcon(t.icon)) {
      errors.push(`track ${n}: ${badIcon(t.icon)}`);
    } else {
      own(t.icon, `track ${n}`);
    }
  });

  for (const [icon, owners] of iconOwners) {
    if (owners.length > 1) errors.push(`icon ${icon} is used by ${owners.join(' and ')}`);
  }
  // Parts may be split only by tracks left off the card, such as disc markers
  for (const [story, ns] of parts) {
    const between = m.tracks.slice(ns[0] - 1, ns[ns.length - 1]).filter((t) => t.story !== story);
    if (between.some((t) => !t.leaveOff)) {
      errors.push(`story "${story}" has tracks ${ns.join(', ')}; its parts must be next to each other`);
    }
  }
  // Same file however it's written: "./x.mp3", "X.mp3" (Box and APFS ignore case)
  const files = new Map<string, number[]>();
  m.tracks.forEach((t, i) => {
    const key = t.file && normalize(t.file).normalize('NFC').toLowerCase();
    if (key) files.set(key, [...(files.get(key) ?? []), i + 1]);
  });
  for (const ns of files.values()) {
    if (ns.length > 1) errors.push(`file ${m.tracks[ns[0] - 1].file} is used by tracks ${ns.join(', ')}`);
  }
  if (errors.length) throw new Error(`Manifest problems:\n  ${errors.join('\n  ')}`);
  return m;
}

// Box rejects these in names (sanitizeTitle covers all but the backslash)
const safeName = (s: string) => sanitizeTitle(s.replace(/\\/g, ' '));

export function albumFolderName(m: AlbumManifest): string {
  return safeName(`${m.series} - ${m.title}`);
}

export function coverSlug(folderName: string): string {
  return folderName
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function trackFilename(n: number, title: string, total: number): string {
  return formatFilename(n, safeName(title), Math.max(2, String(total).length));
}

export function suggestedName(title: string): string {
  return title
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/\(part (\d+)\)/g, '$1')
    .replace(/^(the|a|an) /, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

function joinNames(names: string[]): string {
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}` : (names[0] ?? '');
}

// The ID3 tags `prepare` manages. Other tags on the source file are kept.
export function trackTags(m: AlbumManifest, i: number): Record<string, string> {
  const narrators = joinNames(m.narrators);
  return {
    title: m.tracks[i].title,
    track: m.multiDisc ? String(i + 1) : `${i + 1}/${m.tracks.length}`,
    album: albumFolderName(m),
    artist: m.author,
    album_artist: m.author,
    composer: narrators,
    comment: `${m.narration ?? 'Read by'} ${narrators}`,
    publisher: m.publisher,
    date: String(m.year),
    ...(m.genre && { genre: m.genre }),
  };
}

const storyOf = (m: AlbumManifest, t: ManifestTrack) => m.stories?.find((st) => st.title === t.story);

// A story's parts take its icons; other tracks have their own.
export function trackIcon(m: AlbumManifest, t: ManifestTrack): string {
  return storyOf(m, t)?.icon ?? t.icon ?? '';
}

export function trackYotoIcon(m: AlbumManifest, t: ManifestTrack): string | undefined {
  return t.story ? storyOf(m, t)?.yotoIcon : t.yotoIcon;
}

const LEAVE_OFF_NOTE = 'Probably worth leaving off the Yoto card';
const cell = (s: string) => s.replace(/\|/g, '\\|');

export function renderGuide(m: AlbumManifest): string {
  const total = m.tracks.length;
  const pad = Math.max(2, String(total).length);
  const notes = [m.discCoverage, m.iconNotes].filter(Boolean);
  const rows = m.tracks.map((t, i) => {
    const description =
      t.leaveOff && !/leaving off/i.test(t.description) ? `${t.description} ${LEAVE_OFF_NOTE}` : t.description;
    return `| ${String(i + 1).padStart(pad, '0')} | ${cell(trackFilename(i + 1, t.title, total))} | ${t.name ?? suggestedName(t.title)} | ${trackIcon(m, t)} | ${cell(description)} |`;
  });
  return [
    `# ${m.heading ?? `${m.series} – ${m.title}`}`,
    '',
    `**Author:** ${m.author}`,
    `**${m.narration ?? 'Read by'}:** ${joinNames(m.narrators)}`,
    `**Publisher:** ${m.publisher} (${m.year})`,
    '',
    ...(notes.length ? [...notes, ''] : []),
    '| Track | Current File | Suggested Name | Icon | Description |',
    '|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
}

// Chapters for `card create`: the finished files, minus tracks flagged to leave off.
export function cardChapters(m: AlbumManifest): { title: string; file: string; yotoIcon?: string }[] {
  return m.tracks.flatMap((t, i) =>
    t.leaveOff ? [] : [{ title: t.title, file: trackFilename(i + 1, t.title, m.tracks.length), yotoIcon: trackYotoIcon(m, t) }]
  );
}
