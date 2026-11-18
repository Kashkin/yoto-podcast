import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { writeIconSheet } from './icon-library.js';

// Tinker Icons (https://developers.tinker.audio/docs): 16x16 story icons, searched by name,
// misspelling or meaning. The CDN needs no key.
const API = 'https://api.tinker.audio/icons';
const CDN = 'https://cdn.tinker.audio/icons';

const run = promisify(execFile);

// Tinker's room per app, over rolling windows. Each search also reserves its requested
// limit against the day's results, so the default of 12 allows about 400 searches a day.
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WINDOWS = [
  { ms: MINUTE, max: 30, per: 'a minute' },
  { ms: HOUR, max: 150, per: 'an hour' },
  { ms: DAY, max: 500, per: 'a day' },
];
const DAY_RESULTS = 5000;
export const DEFAULT_LIMIT = 12;

interface Search {
  at: number;
  results: number;
}

// TINKER_USAGE lets tests use a scratch file
const usagePath = () => process.env.TINKER_USAGE ?? join(homedir(), 'Library', 'Caches', 'yoto-podcast', 'tinker-usage.json');

const inTime = (ms: number) =>
  ms < 2 * MINUTE ? `${Math.ceil(ms / 1000)} s` : ms < 2 * HOUR ? `${Math.ceil(ms / MINUTE)} min` : `${Math.ceil(ms / HOUR)} h`;

// Counts a search against Tinker's limits, or throws saying when there's room again,
// so we stop before Tinker refuses. Shared by every session using this Mac's key.
export function reserveSearch(results: number, now = Date.now()): void {
  if (!Number.isInteger(results) || results < 1 || results > 100) throw new Error('A Tinker search returns 1 to 100 results.');
  const path = usagePath();
  const searches = (existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Search[]) : [])
    .filter((s) => now - s.at < DAY)
    .sort((a, b) => a.at - b.at);

  for (const { ms, max, per } of WINDOWS) {
    const recent = searches.filter((s) => now - s.at < ms);
    if (recent.length >= max) {
      throw new Error(`Tinker allows ${max} searches ${per}; the next one is free in ${inTime(recent[0].at + ms - now)}.`);
    }
  }
  let over = searches.reduce((sum, s) => sum + s.results, 0) + results - DAY_RESULTS;
  if (over > 0) {
    const freedBy = searches.find((s) => (over -= s.results) <= 0)!;
    throw new Error(`Tinker allows 5,000 results a day; ${results} more are free in ${inTime(freedBy.at + DAY - now)}.`);
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify([...searches, { at: now, results }]));
}

export interface TinkerIcon {
  id: string;
  name: string;
  url: string;
}

// `tinker:<id>` or the icon's CDN URL
export function parseTinkerId(ref: string): string | null {
  const match = ref.match(/^tinker:([0-9a-f-]+)$/i) ?? ref.match(/^https:\/\/cdn\.tinker\.audio\/icons\/([0-9a-f-]+)\.png$/i);
  return match ? match[1] : null;
}

// TINKER_API_KEY from .env: the key itself, or an op:// reference read from 1Password
export async function tinkerKey(read: (ref: string) => Promise<string> = opRead): Promise<string> {
  const key = process.env.TINKER_API_KEY;
  if (!key) throw new Error('Set TINKER_API_KEY in .env to your Tinker key or its op:// reference (see .env.example)');
  return key.startsWith('op://') ? read(key) : key;
}

async function opRead(ref: string): Promise<string> {
  const { stdout } = await run('op', ['read', ref]);
  return stdout.trim();
}

export async function searchTinker(query: string, limit = DEFAULT_LIMIT, key?: string): Promise<TinkerIcon[]> {
  key ??= await tinkerKey();
  reserveSearch(limit);
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  const res = await fetch(`${API}?${params}`, { headers: { 'X-Tinker-Key': key } });
  const body = (await res.json().catch(() => ({}))) as { results?: TinkerIcon[]; error?: string };
  if (!res.ok) {
    const retry = res.headers.get('retry-after');
    throw new Error(`Tinker search failed (${res.status}): ${body.error ?? res.statusText}${retry ? ` Try again in ${retry} s.` : ''}`);
  }
  return body.results ?? [];
}

export async function downloadTinkerIcon(id: string): Promise<Buffer> {
  const res = await fetch(`${CDN}/${id}.png`);
  if (!res.ok) throw new Error(`Tinker icon ${id} not found (${res.status}); it may have left the library`);
  return Buffer.from(await res.arrayBuffer());
}

export const writeTinkerSheet = (icons: TinkerIcon[], out: string) => writeIconSheet(icons.map((i) => i.url), out);
