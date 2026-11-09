import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { expandHome } from '../config.js';
import { imageType, type createYotoService } from './yoto.js';
import { pickPublicIcon, parseYotoiconsId, downloadYotoicon, countYotoiconDownload } from './icons.js';
import { iconPixelKey, userIconKeys, rememberIconKey } from './icon-library.js';
import { parseTinkerId, downloadTinkerIcon } from './tinker.js';

type IconApi = Pick<ReturnType<typeof createYotoService>, 'getUserIcons' | 'uploadIcon' | 'getPublicIcons'>;

const libraryKeys = new WeakMap<IconApi, Promise<Map<string, string>>>();

// Reuses a picture already in your icon library instead of uploading it again.
// `uploaded` is false for a reuse or a dry run.
async function uploadOrReuse(
  yoto: IconApi,
  image: Buffer,
  type: string,
  label: string,
  dryRun: boolean
): Promise<{ ref: string | null; uploaded: boolean }> {
  // Animated GIFs can't be compared by their first frame
  const key = type === 'image/gif' ? null : await iconPixelKey(image);
  if (key) {
    if (!libraryKeys.has(yoto)) libraryKeys.set(yoto, yoto.getUserIcons().then((icons) => userIconKeys(icons)));
    const keys = await libraryKeys.get(yoto)!;
    const existing = [...keys].find(([, k]) => k === key)?.[0];
    if (existing) {
      console.log(`${label} is already in your icon library: reusing yoto:#${existing}`);
      return { ref: `yoto:#${existing}`, uploaded: false };
    }
  }
  if (dryRun) return { ref: null, uploaded: false };
  const ref = await yoto.uploadIcon(image, type);
  if (key) rememberIconKey(ref.slice('yoto:#'.length), key);
  return { ref, uploaded: true };
}

// Accepts `yoto:#<mediaId>`, a path to an image (relative to `baseDir`, else
// the working directory; uploaded unless already in your library), a
// yotoicons.com ID or URL (same), a Tinker `tinker:<id>` or CDN URL (same), or a public icon name / ID.
export async function resolveIcon(yoto: IconApi, icon: string, opts: { dryRun: boolean; baseDir?: string }): Promise<string> {
  if (icon.startsWith('yoto:#')) return icon;
  const path = resolve(opts.baseDir ?? process.cwd(), expandHome(icon));
  if (existsSync(path)) {
    const { ref } = await uploadOrReuse(yoto, readFileSync(path), imageType(path), basename(path), opts.dryRun);
    return ref ?? `(upload ${basename(path)})`;
  }
  const yotoiconsId = parseYotoiconsId(icon);
  if (yotoiconsId) {
    const label = `yotoicons ${yotoiconsId}`;
    const { ref, uploaded } = await uploadOrReuse(yoto, await downloadYotoicon(yotoiconsId), 'image/png', label, opts.dryRun);
    if (uploaded) await countYotoiconDownload(yotoiconsId);
    return ref ?? `(upload ${label})`;
  }
  const tinkerId = parseTinkerId(icon);
  if (tinkerId) {
    const label = `Tinker icon ${tinkerId}`;
    const { ref } = await uploadOrReuse(yoto, await downloadTinkerIcon(tinkerId), 'image/png', label, opts.dryRun);
    return ref ?? `(upload ${label})`;
  }
  return pickPublicIcon(await yoto.getPublicIcons(), icon);
}
