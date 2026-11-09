import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig, loadTokens, saveTokens } from '../src/config.js';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const TEST_DIR = join(import.meta.dirname, '.test-config');

describe('config', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('loads a valid config file', () => {
    const configPath = join(TEST_DIR, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      podcasts: [{
        name: 'Test Pod',
        feedUrl: 'https://example.com/feed.xml',
        directory: '/tmp/test',
        cardId: 'abc123',
      }],
      yoto: { clientId: 'test-client' },
    }));

    const config = loadConfig(configPath);
    expect(config.podcasts).toHaveLength(1);
    expect(config.podcasts[0].name).toBe('Test Pod');
    expect(config.yoto.clientId).toBe('test-client');
  });

  it('throws if config file is missing', () => {
    expect(() => loadConfig(join(TEST_DIR, 'nope.json'))).toThrow();
  });

  it('saves and loads tokens', () => {
    const tokensPath = join(TEST_DIR, 'tokens.json');
    const tokens = {
      accessToken: 'abc',
      refreshToken: 'def',
      expiresAt: Date.now() + 86400000,
    };

    saveTokens(tokens, tokensPath);
    const loaded = loadTokens(tokensPath);
    expect(loaded).toEqual(tokens);
  });

  it('returns null for missing tokens', () => {
    const loaded = loadTokens(join(TEST_DIR, 'nope.json'));
    expect(loaded).toBeNull();
  });
});
