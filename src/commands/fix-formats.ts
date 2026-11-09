import type { AppConfig } from '../types.js';
import { createYotoService } from '../services/yoto.js';

interface FixOptions {
  dryRun: boolean;
}

const CONTENT_TYPE_TO_FORMAT: Record<string, string> = {
  'audio/ogg': 'opus',
  'audio/mp4': 'aac',
  'audio/mpeg': 'mp3',
};

async function detectFormat(url: string): Promise<string | null> {
  const res = await fetch(url, { method: 'HEAD' });
  if (!res.ok) return null;
  const ct = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  return CONTENT_TYPE_TO_FORMAT[ct] ?? null;
}

export async function runFixFormats(
  config: AppConfig,
  jwt: string,
  options: FixOptions
): Promise<void> {
  const yoto = createYotoService(jwt);

  for (const podcast of config.podcasts) {
    if (!podcast.cardId) continue;
    console.log(`\n=== ${podcast.name} (${podcast.cardId}) ===`);

    const card = await yoto.getCard(podcast.cardId);
    let changed = 0;
    let skippedUnknown = 0;
    let errors = 0;

    for (const ch of card.content.chapters) {
      for (const t of ch.tracks) {
        const mediaId = t.trackUrl.replace('yoto:#', '');
        let actual: string | null = null;
        try {
          const url = await yoto.getMediaUrl(podcast.cardId, mediaId);
          actual = await detectFormat(url);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.log(`  ✗ ${ch.title}: getMediaUrl failed (${msg})`);
          errors++;
          continue;
        }

        if (actual === null) {
          console.log(`  ? ${ch.title}: unknown content-type, leaving format=${t.format}`);
          skippedUnknown++;
          continue;
        }

        if (t.format === actual) continue;

        console.log(`  ${options.dryRun ? '~' : '→'} ${ch.title}: ${t.format} → ${actual}`);
        t.format = actual;
        changed++;
      }
    }

    console.log(
      `  ${changed} chapter(s) need patching, ${skippedUnknown} unknown, ${errors} error(s)`
    );

    if (changed > 0 && !options.dryRun) {
      await yoto.updateCard(card);
      console.log(`  ✓ card updated`);
    } else if (changed > 0) {
      console.log(`  (dry-run, not writing)`);
    }
  }
}
