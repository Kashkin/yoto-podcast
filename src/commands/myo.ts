import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { getValidTokens } from './auth.js';
import { createYotoService, DEFAULT_ICON, imageType } from '../services/yoto.js';
import { scanAlbum, titleFromFile } from '../services/album.js';
import { searchIcons, formatIcon } from '../services/icons.js';
import { userIconKeys, duplicateGroups, renderContactSheet } from '../services/icon-library.js';
import { resolveIcon } from '../services/icon-resolve.js';
import { searchTinker, writeTinkerSheet } from '../services/tinker.js';
import { uploadTracks, UPLOAD_CONCURRENCY } from '../services/batch.js';
import * as edit from '../services/card-edit.js';
import { parseManifest, cardChapters, coverSlug } from '../services/album-manifest.js';
import type { YotoCard } from '../types.js';

type YotoService = ReturnType<typeof createYotoService>;

export interface Paths {
  configPath: string;
  tokensPath: string;
}

export async function connect({ configPath, tokensPath }: Paths): Promise<YotoService> {
  const tokens = await getValidTokens(configPath, tokensPath);
  if (!tokens) throw new Error('No Yoto tokens found. Run `yoto-podcast auth` first.');
  return createYotoService(tokens.accessToken);
}

// Fail before any upload if the image is missing or a type Yoto won't take.
function checkImage(path: string, what: string): void {
  if (!existsSync(path)) throw new Error(`${what} not found: ${path}`);
  imageType(path);
}

function formatDuration(seconds?: number): string {
  if (seconds === undefined) return '--:--';
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, '0');
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}


// Fetch, apply one edit, print what changed, and save unless it's a dry run.
async function editCard(
  paths: Paths,
  cardId: string,
  dryRun: boolean,
  change: (card: YotoCard, yoto: YotoService) => Promise<YotoCard> | YotoCard
): Promise<void> {
  const yoto = await connect(paths);
  const before = await yoto.getCard(cardId);
  const after = await change(before, yoto);
  const diff = edit.diffCards(before, after);
  if (diff.length === 0) {
    console.log('No change.');
    return;
  }
  console.log(`${dryRun ? 'Would change' : 'Changing'} "${before.title}" (${cardId}):`);
  for (const line of diff) console.log(`  ${line}`);
  if (dryRun) return;
  edit.assertUnchanged(before, await yoto.getCard(cardId));
  await yoto.saveCard(after);
  console.log('Saved.');
}

export async function listCards(paths: Paths): Promise<void> {
  const yoto = await connect(paths);
  const cards = await yoto.listCards();
  for (const c of cards) console.log(`${c.cardId}  ${c.title}`);
  console.log(`\n${cards.length} card(s)`);
}

export async function showCard(paths: Paths, cardId: string): Promise<void> {
  const yoto = await connect(paths);
  const [card, icons] = await Promise.all([yoto.getCard(cardId), yoto.getPublicIcons()]);
  const iconNames = new Map(icons.map((i) => [`yoto:#${i.mediaId}`, i.title ?? '']));
  const iconName = (ref?: string) => (!ref ? '(none)' : iconNames.get(ref) ? `${iconNames.get(ref)} ${ref}` : `custom ${ref}`);

  console.log(`${card.title} (${card.cardId})`);
  console.log(`Cover: ${card.metadata?.cover?.imageL ?? '(none)'}`);
  console.log(`Length: ${formatDuration(card.metadata?.media?.duration)}\n`);
  card.content.chapters.forEach((ch, i) => {
    const duration = ch.duration ?? ch.tracks.reduce((sum, t) => sum + (t.duration ?? 0), 0);
    console.log(`${String(i + 1).padStart(3)}. ${ch.title}  ${formatDuration(duration)}  icon: ${iconName(ch.display?.icon16x16)}`);
    if (ch.tracks.length > 1) {
      for (const t of ch.tracks) console.log(`       - ${t.title}  ${formatDuration(t.duration)}`);
    }
  });
}

// Uses <dir>/album.json when present (titles, per-chapter icons, leave-off
// tracks, cover from Cover images/); otherwise scans "NN - Title.mp3" files.
export async function createCard(
  paths: Paths,
  opts: { dir: string; title?: string; cover?: string; icon?: string; dryRun: boolean; allowDuplicate: boolean }
): Promise<void> {
  const dir = resolve(opts.dir);
  const title = opts.title ?? basename(dir);
  const manifestPath = join(dir, 'album.json');
  const manifest = existsSync(manifestPath) ? parseManifest(readFileSync(manifestPath, 'utf8')) : null;
  const plan = manifest
    ? cardChapters(manifest).map((c) => ({ title: c.title, path: join(dir, c.file), icon: c.yotoIcon }))
    : scanAlbum(dir).map((t) => ({ title: t.title, path: t.path, icon: undefined as string | undefined }));
  const missing = plan.filter((c) => !existsSync(c.path)).map((c) => basename(c.path));
  if (missing.length) throw new Error(`Missing in ${dir} (run \`prepare\` first?): ${missing.join(', ')}`);

  const libraryCover = join(dir, '..', '..', 'Cover images', `${coverSlug(basename(dir))}.jpg`);
  const cover = opts.cover ?? (manifest && existsSync(libraryCover) ? libraryCover : undefined);
  if (cover) checkImage(cover, 'Cover');

  const yoto = await connect(paths);
  const existing = (await yoto.listCards()).filter((c) => c.title === title);
  if (existing.length > 0 && !opts.allowDuplicate) {
    throw new Error(
      `A card called "${title}" already exists (${existing.map((c) => c.cardId).join(', ')}). ` +
        'Edit it instead, or pass --allow-duplicate.'
    );
  }
  const icon = opts.icon ? await resolveIcon(yoto, opts.icon, { dryRun: opts.dryRun }) : DEFAULT_ICON;
  const icons = new Map<string, string>();
  for (const c of plan) {
    if (c.icon && !icons.has(c.icon)) icons.set(c.icon, await resolveIcon(yoto, c.icon, { dryRun: opts.dryRun, baseDir: manifest ? dir : undefined }));
  }
  const chapterIcon = (c: (typeof plan)[number]) => (c.icon ? icons.get(c.icon)! : icon);

  console.log(`${opts.dryRun ? 'Would create' : 'Creating'} "${title}"`);
  if (manifest) {
    const left = manifest.tracks.length - plan.length;
    console.log(`From album.json: ${plan.length} chapter(s)${left ? `, ${left} track(s) left off` : ''}`);
  }
  console.log(`Cover: ${cover ?? '(none)'}`);
  plan.forEach((c, i) => console.log(`${String(i + 1).padStart(3)}. ${c.title}  (${basename(c.path)})  icon: ${chapterIcon(c)}`));
  if (opts.dryRun) return;

  // Upload everything before creating the card, so a failure leaves no half-made card.
  console.log(`\nUploading ${plan.length} track(s), ${UPLOAD_CONCURRENCY} at a time...`);
  const tracks = await uploadTracks(plan, (path, log) => yoto.uploadAudioFile(path, log));
  const chapters = plan.map((c, i) => ({ title: c.title, track: tracks[i], icon: chapterIcon(c) }));
  const coverUrl = cover ? await yoto.uploadCover(cover) : undefined;

  const saved = await yoto.saveCard(edit.buildCard({ title, coverUrl, icon, chapters }));
  console.log(`\nCreated "${saved.title}": ${saved.cardId}`);
  console.log('Link it to a physical card in the Yoto app.');
}

export async function renameCard(paths: Paths, cardId: string, title: string, dryRun: boolean): Promise<void> {
  await editCard(paths, cardId, dryRun, (card) => edit.renameCard(card, title));
}

export async function setCover(paths: Paths, cardId: string, image: string, dryRun: boolean): Promise<void> {
  checkImage(image, 'Cover');
  await editCard(paths, cardId, dryRun, async (card, yoto) =>
    edit.setCover(card, dryRun ? `(upload ${basename(image)})` : await yoto.uploadCover(image))
  );
}

export async function renameChapter(paths: Paths, cardId: string, n: number, title: string, dryRun: boolean): Promise<void> {
  await editCard(paths, cardId, dryRun, (card) => edit.renameChapter(card, n, title));
}

export async function setChapterIcon(paths: Paths, cardId: string, n: number, icon: string, dryRun: boolean): Promise<void> {
  await editCard(paths, cardId, dryRun, async (card, yoto) =>
    edit.setChapterIcon(card, n, await resolveIcon(yoto, icon, { dryRun }))
  );
}

const placeholderTrack = (file: string) => ({ trackUrl: `(upload ${basename(file)})`, format: '(after transcode)' });

export async function replaceChapterAudio(paths: Paths, cardId: string, n: number, file: string, dryRun: boolean): Promise<void> {
  if (!existsSync(file)) throw new Error(`Audio not found: ${file}`);
  await editCard(paths, cardId, dryRun, async (card, yoto) => {
    edit.replaceChapterAudio(card, n, placeholderTrack(file)); // fail fast before uploading
    return edit.replaceChapterAudio(card, n, dryRun ? placeholderTrack(file) : await yoto.uploadAudioFile(file));
  });
}

export async function addChapter(
  paths: Paths,
  cardId: string,
  file: string,
  opts: { title?: string; at?: number; icon?: string; dryRun: boolean }
): Promise<void> {
  if (!existsSync(file)) throw new Error(`Audio not found: ${file}`);
  const title = opts.title ?? titleFromFile(file);
  await editCard(paths, cardId, opts.dryRun, async (card, yoto) => {
    const icon = opts.icon ? await resolveIcon(yoto, opts.icon, { dryRun: opts.dryRun }) : DEFAULT_ICON;
    edit.addChapter(card, { title, track: placeholderTrack(file), icon }, opts.at); // fail fast before uploading
    const track = opts.dryRun ? placeholderTrack(file) : await yoto.uploadAudioFile(file);
    return edit.addChapter(card, { title, track, icon }, opts.at);
  });
}

export async function removeChapter(paths: Paths, cardId: string, n: number, dryRun: boolean): Promise<void> {
  await editCard(paths, cardId, dryRun, (card) => edit.removeChapter(card, n));
}

export async function moveChapter(paths: Paths, cardId: string, from: number, to: number, dryRun: boolean): Promise<void> {
  await editCard(paths, cardId, dryRun, (card) => edit.moveChapter(card, from, to));
}

export async function searchPublicIcons(paths: Paths, query: string): Promise<void> {
  const yoto = await connect(paths);
  const matches = searchIcons(await yoto.getPublicIcons(), query);
  for (const icon of matches) console.log(formatIcon(icon));
  console.log(`\n${matches.length} match(es). Use the name or media ID with \`chapter icon\`.`);
}

// Numbered in the same order as the sheet: left to right, top to bottom
export async function searchTinkerIcons(query: string, opts: { limit: number; sheet?: string }): Promise<void> {
  const results = await searchTinker(query, opts.limit);
  results.forEach((icon, i) => console.log(`${String(i + 1).padStart(3)}. tinker:${icon.id}  ${icon.name}`));
  console.log(`\n${results.length} match(es). Use tinker:<id> with \`chapter icon\` or as a yotoIcon.`);
  if (opts.sheet && results.length) {
    await writeTinkerSheet(results, opts.sheet);
    console.log(`Sheet: ${opts.sheet}`);
  }
}

// Writes an HTML contact sheet of your uploaded icons and reports duplicates.
export async function listMyIcons(paths: Paths, out: string): Promise<void> {
  const yoto = await connect(paths);
  const icons = await yoto.getUserIcons();
  const groups = duplicateGroups(await userIconKeys(icons));
  writeFileSync(out, renderContactSheet(icons, groups));
  console.log(`${icons.length} icon(s) in your library.`);
  if (groups.length) {
    const extra = groups.reduce((n, g) => n + g.length - 1, 0);
    console.log(`${groups.length} picture(s) were uploaded more than once (${extra} extra cop${extra === 1 ? 'y' : 'ies'}).`);
  }
  console.log(`Contact sheet: ${out}`);
  console.log(`Open it with: open "${out}"`);
}
