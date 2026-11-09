import { XMLParser } from 'fast-xml-parser';
import type { FeedEpisode } from '../types.js';

export function parseFeed(xml: string): FeedEpisode[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
  });
  const parsed = parser.parse(xml);

  const channel = parsed?.rss?.channel;
  if (!channel) return [];

  const items = Array.isArray(channel.item) ? channel.item : [channel.item];

  return items.map((item: Record<string, unknown>, i: number) => ({
    title: String(item.title ?? ''),
    url: String(
      (item.enclosure as Record<string, unknown>)?.['@_url'] ?? ''
    ),
    index: i + 1,
  }));
}

export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function shouldSkip(title: string, patterns: string[]): boolean {
  const lower = title.toLowerCase();
  return patterns.some((p) => lower.includes(p.toLowerCase()));
}
