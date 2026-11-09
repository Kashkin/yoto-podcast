import { describe, it, expect } from 'vitest';
import { parseFeed, normalizeTitle, shouldSkip } from '../src/services/feed.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FIXTURE = readFileSync(
  join(import.meta.dirname, 'fixtures/dino-dome-feed.xml'),
  'utf-8'
);

describe('parseFeed', () => {
  it('extracts episodes with titles and enclosure URLs', () => {
    const episodes = parseFeed(FIXTURE);
    expect(episodes.length).toBeGreaterThan(0);
    expect(episodes[0]).toHaveProperty('title');
    expect(episodes[0]).toHaveProperty('url');
    expect(episodes[0].url).toMatch(/^https?:\/\//);
    // Feed is newest-first, index 1 = newest
    expect(episodes[0].index).toBe(1);
  });

  it('returns episodes in newest-first order', () => {
    const episodes = parseFeed(FIXTURE);
    expect(episodes[0].index).toBe(1);
    expect(episodes[1].index).toBe(2);
  });
});

describe('normalizeTitle', () => {
  it('lowercases and strips punctuation', () => {
    expect(normalizeTitle('T-Rex vs. Velociraptor!')).toBe('trex vs velociraptor');
  });

  it('collapses whitespace', () => {
    expect(normalizeTitle('  hello   world  ')).toBe('hello world');
  });
});

describe('shouldSkip', () => {
  it('returns true when title matches a skip pattern', () => {
    expect(shouldSkip('The Snowball (Replay)', ['(Replay)'])).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(shouldSkip('Episode (replay)', ['(Replay)'])).toBe(true);
  });

  it('returns false when no patterns match', () => {
    expect(shouldSkip('The Snowball', ['(Replay)'])).toBe(false);
  });

  it('returns false with empty patterns', () => {
    expect(shouldSkip('Anything', [])).toBe(false);
  });
});

describe('parseFeed with no episodes', () => {
  it('returns nothing for a channel without items', () => {
    expect(parseFeed('<?xml version="1.0"?><rss version="2.0"><channel><title>Empty</title></channel></rss>')).toEqual([]);
  });
});
