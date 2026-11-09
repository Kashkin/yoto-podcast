import { createYotoSdk } from '@yotoplay/yoto-sdk';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { YotoCard, YotoChapter } from '../types.js';
import type { PublicIcon } from './icons.js';
import type { UserIcon } from './icon-library.js';
import { withRetry } from './batch.js';

export const DEFAULT_ICON = 'yoto:#aUm9i3ex3qqAMYBv-i-O-pYMKuMJGICtR3Vhf289u2Q';

export interface UploadedTrack {
  trackUrl: string;
  format: string;
  duration?: number;
  fileSize?: number;
  channels?: string;
}

interface TranscodedInfo {
  format?: string;
  duration?: number;
  fileSize?: number;
  channels?: string;
}

const IMAGE_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
};

export function imageType(filePath: string): string {
  const type = IMAGE_TYPES[filePath.split('.').pop()?.toLowerCase() ?? ''];
  if (!type) throw new Error(`Unsupported image type: ${filePath} (use jpg, png, gif or webp)`);
  return type;
}

export function createYotoService(jwt: string, opts: { retryBaseMs?: number } = {}) {
  const sdk = createYotoSdk({ jwt });
  const retry = <T>(fn: () => Promise<T>) => withRetry(fn, { baseMs: opts.retryBaseMs });

  // The SDK has no image uploads, so these go straight to the API.
  async function postImage(path: string, body: Buffer, type: string): Promise<Record<string, any>> {
    const res = await fetch(`https://api.yotoplay.com${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': type },
      body: new Uint8Array(body),
    });
    if (!res.ok) throw new Error(`Image upload failed: ${res.status} ${await res.text()}`);
    return (await res.json()) as Record<string, any>;
  }

  async function postIcon(body: Buffer, type: string): Promise<string> {
    const res = await postImage('/media/displayIcons/user/me/upload?autoConvert=true', body, type);
    const mediaId = res.displayIcon?.mediaId;
    if (!mediaId) throw new Error('Icon upload response missing displayIcon.mediaId');
    return `yoto:#${mediaId}`;
  }

  return {
    // `log` lets batch uploads label each track's progress lines.
    async uploadAudio(fileBuffer: Buffer, filename: string, log = (msg: string) => console.log(msg)): Promise<UploadedTrack> {
      const sha256 = createHash('sha256').update(fileBuffer).digest('hex');
      const { uploadUrl, uploadId } = await retry(() => sdk.media.getUploadUrlForTranscode(sha256, filename));

      if (uploadUrl) {
        log('    Uploading file...');
        await retry(() => sdk.media.uploadFile(uploadUrl, fileBuffer));
        log('    Upload complete. Waiting for transcoding...');
      } else {
        log('    File already uploaded. Waiting for transcoding...');
      }

      // Poll for transcoding completion
      for (let i = 0; i < 60; i++) {
        const result = (await retry(() => sdk.media.getTranscodedUpload(uploadId, true))) as Record<string, unknown>;
        const progress = result.progress as { phase?: string; percent?: number } | undefined;
        const phase = progress?.phase;

        if (phase === 'complete' || result.transcodedSha256) {
          const sha = result.transcodedSha256 as string;
          const info = (result.transcodedInfo ?? {}) as TranscodedInfo;
          if (!info.format) {
            throw new Error('Transcoder response missing transcodedInfo.format');
          }
          log(`    Transcoding complete (${i * 5}s, format=${info.format})`);
          return {
            trackUrl: `yoto:#${sha}`,
            format: info.format,
            duration: info.duration,
            fileSize: info.fileSize,
            channels: info.channels,
          };
        }

        if (phase && !['queued', 'downloading', 'analyzing', 'processing', 'transcoding'].includes(phase)) {
          throw new Error(`Transcoding failed: ${phase}`);
        }

        if (i > 0 && i % 6 === 0) {
          const percent = progress?.percent ?? 0;
          log(`    Transcoding: ${phase ?? 'unknown'} ${percent}% (${i * 5}s)`);
        }
        await new Promise((r) => setTimeout(r, 5000));
      }
      throw new Error('Transcoding timed out after 300s');
    },

    async uploadAudioFile(filePath: string, log?: (msg: string) => void): Promise<UploadedTrack> {
      const buffer = readFileSync(filePath);
      const filename = filePath.split('/').pop() ?? 'audio.mp3';
      return this.uploadAudio(buffer, filename, log);
    },

    async getCard(cardId: string): Promise<YotoCard> {
      return (await sdk.content.getCard(cardId)) as unknown as YotoCard;
    },

    async updateCard(card: YotoCard): Promise<void> {
      await sdk.content.updateCard(card as never, true);
    },

    async getMediaUrl(cardId: string, mediaId: string): Promise<string> {
      return sdk.media.getMediaUrl(cardId, mediaId);
    },

    async prependTrackToCard(
      cardId: string,
      title: string,
      track: UploadedTrack
    ): Promise<void> {
      const card = await this.getCard(cardId);

      const newChapter: YotoChapter = {
        key: '00',
        title,
        display: { icon16x16: DEFAULT_ICON },
        tracks: [
          {
            key: '01',
            title,
            trackUrl: track.trackUrl,
            format: track.format,
            type: 'audio',
            ...(track.duration !== undefined && { duration: track.duration }),
            ...(track.fileSize !== undefined && { fileSize: track.fileSize }),
            ...(track.channels !== undefined && { channels: track.channels }),
          },
        ],
      };

      // Prepend new chapter, then re-key all chapters; their icons stay as they are
      card.content.chapters.unshift(newChapter);
      for (let i = 0; i < card.content.chapters.length; i++) {
        const ch = card.content.chapters[i];
        ch.key = String(i).padStart(2, '0');
        ch.overlayLabel = String(i + 1);
      }

      await sdk.content.updateCard(card as never, true);
    },

    async listCards(): Promise<YotoCard[]> {
      return (await sdk.content.getMyCards()) as unknown as YotoCard[];
    },

    // POST /content: creates a card when it has no cardId, otherwise replaces that card.
    async saveCard(card: YotoCard): Promise<YotoCard> {
      return (await sdk.content.updateCard(card as never, true)) as unknown as YotoCard;
    },

    async getPublicIcons(): Promise<PublicIcon[]> {
      return (await sdk.icons.getDisplayIcons()) as unknown as PublicIcon[];
    },

    // Body must be the raw image, not form data. coverType=default scales the cover
    // to 638x1011 as the Yoto web app does; "myo" crops it to a 520x400 tile.
    async uploadCover(filePath: string): Promise<string> {
      const res = await postImage(
        '/media/coverImage/user/me/upload?autoconvert=true&coverType=default',
        readFileSync(filePath),
        imageType(filePath)
      );
      const url = res.coverImage?.mediaUrl;
      if (!url) throw new Error('Cover upload response missing coverImage.mediaUrl');
      return url;
    },

    // Returns a `yoto:#<mediaId>` reference. Yoto resizes to 16x16.
    async uploadIcon(image: Buffer, type: string): Promise<string> {
      return postIcon(image, type);
    },

    // Icons this account uploaded (the Yoto app's "My icons").
    async getUserIcons(): Promise<UserIcon[]> {
      const res = await fetch('https://api.yotoplay.com/media/displayIcons/user/me', {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      if (!res.ok) throw new Error(`Listing your icons failed: ${res.status} ${await res.text()}`);
      const { displayIcons } = (await res.json()) as { displayIcons: (UserIcon & { public?: boolean })[] };
      return displayIcons.filter((i) => !i.public).map(({ mediaId, url, createdAt }) => ({ mediaId, url, createdAt }));
    },

    async getCardChapterCount(cardId: string): Promise<number> {
      const card = await this.getCard(cardId);
      return card.content.chapters.length;
    },

    async setCardChapters(
      cardId: string,
      chapters: { title: string; track: UploadedTrack }[]
    ): Promise<void> {
      const card = await this.getCard(cardId);

      card.content.chapters = chapters.map((ch, i) => ({
        key: String(i).padStart(2, '0'),
        title: ch.title,
        overlayLabel: String(i + 1),
        display: { icon16x16: DEFAULT_ICON },
        tracks: [
          {
            key: '01',
            title: ch.title,
            trackUrl: ch.track.trackUrl,
            format: ch.track.format,
            type: 'audio',
            ...(ch.track.duration !== undefined && { duration: ch.track.duration }),
            ...(ch.track.fileSize !== undefined && { fileSize: ch.track.fileSize }),
            ...(ch.track.channels !== undefined && { channels: ch.track.channels }),
          },
        ],
      }));

      await sdk.content.updateCard(card as never, true);
    },
  };
}
