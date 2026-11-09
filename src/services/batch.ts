import type { UploadedTrack } from './yoto.js';

// Yoto doesn't publish rate limits; three at once keeps well clear of trouble.
export const UPLOAD_CONCURRENCY = 3;

const NETWORK_CODES = new Set(['ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE', 'ENETUNREACH']);

// Refused (429), server errors (5xx) and dropped connections are worth another go.
function isRetryable(err: unknown): boolean {
  const e = err as { status?: number; response?: { status?: number }; code?: string };
  const status = e?.status ?? e?.response?.status;
  if (status !== undefined) return status === 429 || status >= 500;
  return NETWORK_CODES.has(e?.code ?? '');
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { retries?: number; baseMs?: number; sleep?: (ms: number) => Promise<void> } = {}
): Promise<T> {
  const { retries = 3, baseMs = 1000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = opts;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !isRetryable(err)) throw err;
      await sleep(baseMs * 2 ** attempt);
    }
  }
}

// Runs `fn` over `items`, at most `limit` at once. Results keep the input order.
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { status: 'fulfilled', value: await fn(items[i], i) };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Uploads every track, a few at a time, and returns them in plan order.
// Throws, naming each failed track, if any failed: Yoto dedupes by hash, so a re-run only redoes those.
export async function uploadTracks(
  items: { title: string; path: string }[],
  upload: (path: string, log: (msg: string) => void) => Promise<UploadedTrack>,
  opts: { concurrency?: number; log?: (msg: string) => void } = {}
): Promise<UploadedTrack[]> {
  const log = opts.log ?? console.log;
  const n = items.length;
  let done = 0;
  const results = await mapLimit(items, opts.concurrency ?? UPLOAD_CONCURRENCY, async (item, i) => {
    const label = `[${i + 1}/${n}] ${item.title}`;
    const track = await upload(item.path, (msg) => log(`  ${label}: ${msg.trim()}`));
    log(`Uploaded ${++done}/${n}: ${item.title}`);
    return track;
  });
  const failed = results.flatMap((r, i) =>
    r.status === 'rejected' ? [`  ${i + 1}. ${items[i].title}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`] : []
  );
  if (failed.length) {
    throw new Error(`${failed.length} of ${n} track(s) failed to upload, so no card was made. Run again to retry them:\n${failed.join('\n')}`);
  }
  return results.map((r) => (r as PromiseFulfilledResult<UploadedTrack>).value);
}
