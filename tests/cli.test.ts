import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Runs the real CLI with HOME pointed at a scratch folder holding its config and tokens
let home: string;
const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');
const TSX = join(import.meta.dirname, '..', 'node_modules', '.bin', 'tsx');

function check(podcasts: object[]) {
  writeFileSync(join(home, '.config', 'yoto-podcast', 'config.json'), JSON.stringify({ podcasts, yoto: { clientId: 'x' } }));
  return spawnSync(TSX, [CLI, 'check'], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'yoto-cli-'));
  mkdirSync(join(home, '.config', 'yoto-podcast'), { recursive: true });
  writeFileSync(join(home, '.config', 'yoto-podcast', 'tokens.json'), JSON.stringify({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 }));
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe('check exit code', () => {
  it('is 0 when nothing went wrong', () => {
    const run = check([]);
    expect(run.stdout).toContain('Done. 0 new episode(s) downloaded.');
    expect(run.status).toBe(0);
  });

  it('is 1 when a podcast had an error', () => {
    const run = check([{ name: 'Down', feedUrl: 'http://127.0.0.1:1/feed.xml', directory: join(home, 'down'), cardId: 'c' }]);
    expect(run.stderr).toContain('Failed to fetch feed');
    expect(run.status).toBe(1);
  });
});
