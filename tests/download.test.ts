import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  sanitizeTitle,
  formatFilename,
  detectPadWidth,
  getHighestEpisodeNumber,
  getLocalTitles,
} from '../src/services/download.js';
import { writeFileSync, mkdirSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

const TEST_DIR = join(import.meta.dirname, '.test-downloads');

describe('sanitizeTitle', () => {
  it('removes filesystem-unsafe characters', () => {
    expect(sanitizeTitle('Test: Episode / Name?')).toBe('Test Episode Name');
  });

  it('collapses multiple spaces', () => {
    expect(sanitizeTitle('A  B   C')).toBe('A B C');
  });
});

describe('formatFilename', () => {
  it('formats with zero-padded number', () => {
    expect(formatFilename(3, 'T-Rex vs Velociraptor')).toBe(
      '03 - T-Rex vs Velociraptor.mp3'
    );
  });

  it('sanitizes the title', () => {
    expect(formatFilename(1, 'Test: Name?')).toBe('01 - Test Name.mp3');
  });

  it('respects custom pad width', () => {
    expect(formatFilename(3, 'Episode', 3)).toBe('003 - Episode.mp3');
  });
});

describe('detectPadWidth', () => {
  beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it('returns 2 for empty directory', () => {
    expect(detectPadWidth(TEST_DIR)).toBe(2);
  });

  it('detects 3-digit padding', () => {
    writeFileSync(join(TEST_DIR, '001 - First.mp3'), '');
    expect(detectPadWidth(TEST_DIR)).toBe(3);
  });

  it('detects 2-digit padding', () => {
    writeFileSync(join(TEST_DIR, '01 - First.mp3'), '');
    expect(detectPadWidth(TEST_DIR)).toBe(2);
  });
});

describe('getHighestEpisodeNumber', () => {
  beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it('returns 0 for empty directory', () => {
    expect(getHighestEpisodeNumber(TEST_DIR)).toBe(0);
  });

  it('finds the highest numbered mp3', () => {
    writeFileSync(join(TEST_DIR, '01 - First.mp3'), '');
    writeFileSync(join(TEST_DIR, '05 - Fifth.mp3'), '');
    writeFileSync(join(TEST_DIR, '03 - Third.mp3'), '');
    expect(getHighestEpisodeNumber(TEST_DIR)).toBe(5);
  });
});

describe('getLocalTitles', () => {
  beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it('returns empty array for empty directory', () => {
    expect(getLocalTitles(TEST_DIR)).toEqual([]);
  });

  it('returns titles of all numbered mp3s', () => {
    writeFileSync(join(TEST_DIR, '01 - First.mp3'), '');
    writeFileSync(join(TEST_DIR, '03 - Third Episode.mp3'), '');
    writeFileSync(join(TEST_DIR, 'notes.txt'), '');
    expect(getLocalTitles(TEST_DIR).sort()).toEqual(['First', 'Third Episode']);
  });
});

describe('unreadable directories', () => {
  const MISSING = join(TEST_DIR, 'missing');

  beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => {
    chmodSync(TEST_DIR, 0o755);
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('treats a missing directory as empty', () => {
    expect(detectPadWidth(MISSING)).toBe(2);
    expect(getHighestEpisodeNumber(MISSING)).toBe(0);
    expect(getLocalTitles(MISSING)).toEqual([]);
  });

  it('throws when the directory exists but cannot be read', () => {
    writeFileSync(join(TEST_DIR, '05 - Fifth.mp3'), '');
    chmodSync(TEST_DIR, 0o000);
    expect(() => detectPadWidth(TEST_DIR)).toThrow();
    expect(() => getHighestEpisodeNumber(TEST_DIR)).toThrow();
    expect(() => getLocalTitles(TEST_DIR)).toThrow();
  });
});
