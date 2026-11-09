import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { coverSlug } from '../services/album-manifest.js';
import type { YotoCard } from '../types.js';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp'];
const EXT_FOR_TYPE: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };

// Sizes in mm, measured from the printed sheets ("Yoto Labels 0N.pdf" and 2026-08-09-yoto-cards-all-print.pdf).
export const FORMATS = {
  // Landscape labels with the cover turned so its top faces left, plus light cut lines across the page.
  '2025': { cols: 2, rows: 5, w: 72.6, h: 41.6, left: 20.2, top: 14.5, colGap: 18.8, rowGap: 14.5, rotate: true, guides: true },
  '2026': { cols: 4, rows: 3, w: 45, h: 74.1, left: 9.9, top: 7.9, colGap: 3.5, rowGap: 5.3, rotate: false, guides: false },
} as const;
export type LabelFormat = keyof typeof FORMATS;

export interface LabelPaths {
  covers: string; // Yoto/Cover images
  labels: string; // Yoto/Labels, holding catalogue.json and new sheets
}

/** One Yoto card. `cover` is relative to Cover images; `printed` is the sheet its label is on (any text counts as done). */
export interface CatalogueCard {
  cardId: string;
  title: string;
  added: string;
  cover: string | null;
  printed: string | null;
}

function listCovers(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => IMAGE_EXTS.includes(extname(f).toLowerCase()))
    .sort();
}

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Adds new Yoto cards and refreshes titles, newest first. A new card takes the cover file named after
 * its title, if there is one. Returns the cards still without a cover file.
 */
export function mergeCards(catalogue: CatalogueCard[], cards: YotoCard[], coverFiles: string[]): { catalogue: CatalogueCard[]; added: CatalogueCard[]; needCover: CatalogueCard[] } {
  const byId = new Map(catalogue.map((c) => [c.cardId, { ...c }]));
  const added: CatalogueCard[] = [];
  for (const card of cards) {
    if (!card.cardId) continue;
    const entry = byId.get(card.cardId);
    if (entry) {
      entry.title = card.title;
      continue;
    }
    const slug = coverSlug(card.title);
    const cover = coverFiles.find((f) => basename(f, extname(f)) === slug) ?? null;
    const fresh = { cardId: card.cardId, title: card.title, added: card.createdAt?.slice(0, 10) ?? '', cover, printed: null };
    byId.set(card.cardId, fresh);
    added.push(fresh);
  }
  const merged = [...byId.values()].sort((a, b) => b.added.localeCompare(a.added));
  const files = new Set(coverFiles);
  return { catalogue: merged, added, needCover: merged.filter((c) => !c.cover || !files.has(c.cover)) };
}

/** Find a card by ID, or by words from its title. */
export function findCard(arg: string, catalogue: CatalogueCard[]): CatalogueCard {
  const byId = catalogue.find((c) => c.cardId === arg);
  if (byId) return byId;
  const words = arg.split(/[^a-z0-9]+/i).map(squash).filter(Boolean);
  const exact = catalogue.filter((c) => squash(c.title) === words.join(''));
  const hits = exact.length ? exact : catalogue.filter((c) => words.every((w) => squash(c.title).includes(w)));
  if (hits.length === 1) return hits[0];
  if (hits.length === 0) throw new Error(`No card matches "${arg}"`);
  throw new Error(`"${arg}" matches ${hits.length} cards:\n  ${hits.map((c) => `${c.cardId}  ${c.title}`).join('\n  ')}`);
}

/** One A4 page per slice of images, laid out in the format's grid. */
export function sheetHtml(format: LabelFormat, images: string[]): string {
  const f = FORMATS[format];
  const per = f.cols * f.rows;
  const x = (c: number) => f.left + c * (f.w + f.colGap);
  const y = (r: number) => f.top + r * (f.h + f.rowGap);
  const pages: string[] = [];
  for (let p = 0; p < images.length; p += per) {
    const parts: string[] = [];
    if (f.guides) {
      for (let c = 0; c < f.cols; c++) for (const v of [x(c), x(c) + f.w]) parts.push(`<i class="v" style="left:${v}mm"></i>`);
      for (let r = 0; r < f.rows; r++) for (const v of [y(r), y(r) + f.h]) parts.push(`<i class="h" style="top:${v}mm"></i>`);
    }
    images.slice(p, p + per).forEach((src, i) => {
      const c = i % f.cols;
      const r = Math.floor(i / f.cols);
      parts.push(`<img src="${encodeURI(src)}" style="left:${x(c)}mm;top:${y(r)}mm;width:${f.w}mm;height:${f.h}mm">`);
    });
    pages.push(`<div class="page">${parts.join('')}</div>`);
  }
  return `<!doctype html><meta charset="utf-8"><style>
@page { size: A4; margin: 0 }
body { margin: 0 }
.page { position: relative; width: 210mm; height: 297mm; overflow: hidden; break-after: page }
.page:last-child { break-after: auto }
img { position: absolute; object-fit: cover }
.v { position: absolute; top: 0; bottom: 0; border-left: 0.2mm solid #e6e6e6 }
.h { position: absolute; left: 0; right: 0; border-top: 0.2mm solid #e6e6e6 }
</style>${pages.join('')}`;
}

function nextSheetPath(dir: string, format: LabelFormat): string {
  const stem = `${new Date().toLocaleDateString('en-CA')}-labels-${format}`; // en-CA gives local YYYY-MM-DD
  for (let n = 1; ; n++) {
    const p = join(dir, `${stem}${n > 1 ? `-${n}` : ''}.pdf`);
    if (!existsSync(p)) return p;
  }
}

const cataloguePath = (paths: LabelPaths) => join(paths.labels, 'catalogue.json');

function readCatalogue(paths: LabelPaths): CatalogueCard[] {
  const file = cataloguePath(paths);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
}

function writeCatalogue(paths: LabelPaths, catalogue: CatalogueCard[]): void {
  mkdirSync(paths.labels, { recursive: true });
  writeFileSync(cataloguePath(paths), JSON.stringify(catalogue, null, 2) + '\n');
}

/** Pull the card list from Yoto into the catalogue, downloading covers that aren't in Cover images. */
export async function sync(paths: LabelPaths, cards: YotoCard[], dryRun: boolean): Promise<void> {
  const { catalogue, added, needCover } = mergeCards(readCatalogue(paths), cards, listCovers(paths.covers));
  const coverUrls = new Map(cards.map((c) => [c.cardId, c.metadata?.cover?.imageL]));
  for (const c of added) console.log(`new card: ${c.cardId}  ${c.title}${c.cover ? `  (cover ${c.cover})` : ''}`);

  for (const c of needCover) {
    const url = coverUrls.get(c.cardId);
    if (!url) {
      console.log(`no cover on Yoto: ${c.cardId}  ${c.title}`);
      continue;
    }
    if (dryRun) {
      console.log(`would download cover: ${c.cardId}  ${c.title}`);
      continue;
    }
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Cover download failed for ${c.title}: HTTP ${res.status}`);
    const ext = EXT_FOR_TYPE[(res.headers.get('content-type') ?? '').split(';')[0]] ?? '.png';
    // A file already named after the title belongs to another card, so add the card ID.
    const slug = coverSlug(c.title) || c.cardId;
    c.cover = existsSync(join(paths.covers, `${slug}${ext}`)) ? `${slug}-${c.cardId}${ext}` : `${slug}${ext}`;
    writeFileSync(join(paths.covers, c.cover), Buffer.from(await res.arrayBuffer()));
    console.log(`downloaded cover: ${c.cover}`);
  }

  if (dryRun) {
    console.log(`\nWould save ${catalogue.length} card(s) to catalogue.json`);
    return;
  }
  writeCatalogue(paths, catalogue);
  console.log(`\n${catalogue.length} card(s) in ${cataloguePath(paths)}, ${catalogue.filter((c) => !c.printed).length} not printed`);
}

export function todo(paths: LabelPaths): void {
  const left = readCatalogue(paths).filter((c) => !c.printed);
  for (const c of left) console.log(`${c.added}  ${c.cardId}  ${c.title}${c.cover ? '' : '  (no cover, run labels sync)'}`);
  console.log(`\n${left.length} card(s) not printed yet, newest first`);
}

interface SheetOptions {
  format: LabelFormat;
  next?: boolean;
  out?: string;
  dryRun: boolean;
}

export function makeSheet(paths: LabelPaths, args: string[], o: SheetOptions): void {
  const f = FORMATS[o.format];
  if (!f) throw new Error(`Unknown format "${o.format}" (use ${Object.keys(FORMATS).join(' or ')})`);
  const per = f.cols * f.rows;
  const catalogue = readCatalogue(paths);
  if (catalogue.length === 0) throw new Error('No catalogue yet. Run `labels sync` first.');
  const picked = args.map((a) => findCard(a, catalogue));
  if (o.next) {
    // Fill the empty slots on the last page (a whole page when no cards are named) with the newest unprinted cards.
    const room = picked.length === 0 ? per : (per - (picked.length % per)) % per;
    picked.push(...catalogue.filter((c) => !c.printed && !picked.includes(c)).slice(0, room));
  }
  if (picked.length === 0) throw new Error('No cards given (name them, or pass --next)');
  const noCover = picked.filter((c) => !c.cover || !existsSync(join(paths.covers, c.cover)));
  if (noCover.length) throw new Error(`No cover file for: ${noCover.map((c) => c.title).join(', ')}. Run \`labels sync\` first.`);

  const out = o.out ? resolve(o.out) : nextSheetPath(paths.labels, o.format);
  const pages = Math.ceil(picked.length / per);
  console.log(`${o.format} format, ${picked.length} label(s) on ${pages} page(s), ${pages * per - picked.length} empty slot(s)`);
  picked.forEach((c, i) => console.log(`  ${i + 1}. ${c.title}${c.printed ? `  (already printed on ${c.printed})` : ''}`));
  if (o.dryRun) {
    console.log(`\nWould write ${out} and mark these printed in catalogue.json`);
    return;
  }

  // Shrunk JPEG copies keep the PDF small; 1000 px is about 340 dpi on the long side.
  const tmp = mkdtempSync(join(tmpdir(), 'yoto-labels-'));
  const images = picked.map((c, i) => {
    const dest = join(tmp, `${i}.jpg`);
    execFileSync('magick', [`${join(paths.covers, c.cover!)}[0]`, '-auto-orient', ...(f.rotate ? ['-rotate', '-90'] : []), '-background', 'white', '-alpha', 'remove', '-resize', '1000x1000>', '-quality', '90', dest]);
    return basename(dest);
  });
  const html = join(tmp, 'sheet.html');
  writeFileSync(html, sheetHtml(o.format, images));
  mkdirSync(paths.labels, { recursive: true });
  execFileSync(CHROME, ['--headless', '--disable-gpu', '--no-pdf-header-footer', `--print-to-pdf=${out}`, `file://${html}`], { stdio: 'ignore', timeout: 120_000 });
  if (!existsSync(out)) throw new Error(`Chrome didn't write ${out}`);

  for (const c of picked) c.printed = basename(out);
  writeCatalogue(paths, catalogue);
  console.log(`\nWrote ${out}\nMarked ${picked.length} card(s) printed in ${cataloguePath(paths)}`);
}
