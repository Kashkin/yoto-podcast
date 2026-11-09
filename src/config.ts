import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig, StoredTokens } from './types.js';

export const expandHome = (p: string) => (p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);

// .env beside package.json; variables already in the environment win
try {
  process.loadEnvFile(join(import.meta.dirname, '..', '.env'));
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
}

// Folder holding the finished Yoto library (Stories/, Songs/, Cover images/, ...)
export function yotoLibrary(): string {
  const dir = process.env.YOTO_LIBRARY;
  if (!dir) throw new Error('Set YOTO_LIBRARY in .env to your Yoto library folder (see .env.example)');
  return expandHome(dir);
}

export function loadConfig(configPath: string): AppConfig {
  const raw = readFileSync(configPath, 'utf-8');
  return JSON.parse(raw) as AppConfig;
}

export function loadTokens(tokensPath: string): StoredTokens | null {
  try {
    const raw = readFileSync(tokensPath, 'utf-8');
    return JSON.parse(raw) as StoredTokens;
  } catch {
    return null;
  }
}

export function saveTokens(tokens: StoredTokens, tokensPath: string): void {
  mkdirSync(dirname(tokensPath), { recursive: true });
  writeFileSync(tokensPath, JSON.stringify(tokens, null, 2));
}
