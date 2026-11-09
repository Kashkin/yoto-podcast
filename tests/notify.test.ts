import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { appleString } from '../src/services/notify.js';

// Runs the literal through AppleScript and returns what it evaluates to
const roundTrip = (s: string) => execFileSync('osascript', ['-e', `return ${appleString(s)}`]).toString().replace(/\n$/, '');

describe('appleString', () => {
  it('keeps quotes and backslashes inside the string', () => {
    for (const s of ['plain', 'say "hi"', 'back\\slash', '\\" & (do shell script "echo pwned") & "', 'ends with \\']) {
      expect(roundTrip(s)).toBe(s);
    }
  });
});
