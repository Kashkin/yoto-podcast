import { describe, it, expect, vi } from 'vitest';
import { mapLimit, withRetry, uploadTracks } from '../src/services/batch.js';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

describe('mapLimit', () => {
  it('runs at most `limit` tasks at once', async () => {
    let running = 0;
    let peak = 0;
    await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async () => {
      peak = Math.max(peak, ++running);
      await wait(5);
      running--;
    });
    expect(peak).toBe(3);
  });

  it('returns results in input order, whatever order they finish in', async () => {
    const results = await mapLimit([30, 10, 20], 3, async (ms) => {
      await wait(ms);
      return ms;
    });
    expect(results.map((r) => r.status === 'fulfilled' && r.value)).toEqual([30, 10, 20]);
  });

  it('keeps going after a failure and reports it in place', async () => {
    const results = await mapLimit([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error('boom');
      return n;
    });
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
  });
});

describe('withRetry', () => {
  const fast = { baseMs: 0 };

  it('retries when Yoto refuses (429) or errors (5xx), then succeeds', async () => {
    const fn = vi.fn().mockRejectedValueOnce(httpError(429)).mockRejectedValueOnce(httpError(503)).mockResolvedValue('ok');
    expect(await withRetry(fn, fast)).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('reads the status from an axios-style error', async () => {
    const axiosErr = Object.assign(new Error('fail'), { response: { status: 502 } });
    const fn = vi.fn().mockRejectedValueOnce(axiosErr).mockResolvedValue('ok');
    expect(await withRetry(fn, fast)).toBe('ok');
  });

  it('retries a dropped connection', async () => {
    const fn = vi.fn().mockRejectedValueOnce(Object.assign(new Error('reset'), { code: 'ECONNRESET' })).mockResolvedValue('ok');
    expect(await withRetry(fn, fast)).toBe('ok');
  });

  it('does not retry other errors', async () => {
    const fn = vi.fn().mockRejectedValue(httpError(400));
    await expect(withRetry(fn, fast)).rejects.toThrow('HTTP 400');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('gives up after its retries', async () => {
    const fn = vi.fn().mockRejectedValue(httpError(503));
    await expect(withRetry(fn, { ...fast, retries: 3 })).rejects.toThrow('HTTP 503');
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('backs off exponentially', async () => {
    const delays: number[] = [];
    const sleep = async (ms: number) => void delays.push(ms);
    const fn = vi.fn().mockRejectedValue(httpError(429));
    await expect(withRetry(fn, { retries: 3, baseMs: 1000, sleep })).rejects.toThrow();
    expect(delays).toEqual([1000, 2000, 4000]);
  });
});

describe('uploadTracks', () => {
  const track = (path: string) => ({ trackUrl: `yoto:#${path}`, format: 'opus' });

  it('returns uploads in plan order when they finish out of order', async () => {
    const items = ['a', 'b', 'c', 'd'].map((path) => ({ title: path, path }));
    const finishTimes: Record<string, number> = { a: 40, b: 10, c: 30, d: 0 };
    const finished: string[] = [];
    const upload = async (path: string) => {
      await wait(finishTimes[path]);
      finished.push(path);
      return track(path);
    };

    const tracks = await uploadTracks(items, upload, { concurrency: 3, log: () => {} });

    expect(finished).not.toEqual(['a', 'b', 'c', 'd']);
    expect(tracks.map((t) => t.trackUrl)).toEqual(['yoto:#a', 'yoto:#b', 'yoto:#c', 'yoto:#d']);
  });

  it('uploads every track, then names each one that failed', async () => {
    const items = ['a', 'b', 'c'].map((path) => ({ title: `Track ${path}`, path }));
    const upload = vi.fn(async (path: string) => {
      if (path !== 'b') throw new Error(`no ${path}`);
      return track(path);
    });

    await expect(uploadTracks(items, upload, { concurrency: 3, log: () => {} })).rejects.toThrow(
      /2 of 3 track\(s\) failed to upload[\s\S]*1\. Track a: no a[\s\S]*3\. Track c: no c/
    );
    expect(upload).toHaveBeenCalledTimes(3);
  });
});
