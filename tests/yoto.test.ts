import { describe, it, expect, vi, beforeEach } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createYotoService, imageType, DEFAULT_ICON } from '../src/services/yoto.js';

// Shared mock SDK instance so tests can inspect calls
const mockSdk = {
  media: {
    getUploadUrlForTranscode: vi.fn().mockResolvedValue({
      uploadUrl: 'https://s3.example.com/upload',
      uploadId: 'upload-123',
    }),
    uploadFile: vi.fn().mockResolvedValue(undefined),
    getTranscodedUpload: vi.fn().mockResolvedValue({
      transcodedSha256: 'transcoded-hash',
      progress: { phase: 'complete', percent: 100 },
      transcodedInfo: {
        format: 'opus',
        duration: 800,
        fileSize: 9971190,
        channels: 'stereo',
      },
    }),
  },
  content: {
    getCard: vi.fn().mockResolvedValue({
      cardId: 'test-card',
      title: 'Test Podcast',
      content: {
        chapters: [
          {
            key: '01',
            title: 'Episode 1',
            tracks: [{ key: '01', title: 'Episode 1', trackUrl: 'yoto:#abc' }],
          },
        ],
        config: { resumeTimeout: 2592000 },
        playbackType: 'linear',
      },
      metadata: { category: 'podcast' },
    }),
    updateCard: vi.fn().mockResolvedValue({}),
  },
};

vi.mock('@yotoplay/yoto-sdk', () => ({
  createYotoSdk: vi.fn(() => mockSdk),
}));

describe('YotoService', () => {
  it('uploads audio and returns track info from transcoder', async () => {
    const service = createYotoService('test-jwt');
    const result = await service.uploadAudio(
      Buffer.from('fake-audio'),
      'episode.mp3'
    );
    expect(result).toEqual({
      trackUrl: 'yoto:#transcoded-hash',
      format: 'opus',
      duration: 800,
      fileSize: 9971190,
      channels: 'stereo',
    });
  });

  it('retries a refused upload and a failing status check', async () => {
    mockSdk.media.uploadFile.mockRejectedValueOnce(Object.assign(new Error('slow down'), { response: { status: 503 } }));
    mockSdk.media.getTranscodedUpload.mockRejectedValueOnce(Object.assign(new Error('Too Many Requests'), { status: 429 }));
    const service = createYotoService('test-jwt', { retryBaseMs: 0 });
    const result = await service.uploadAudio(Buffer.from('fake-audio'), 'episode.mp3', () => {});
    expect(result.trackUrl).toBe('yoto:#transcoded-hash');
  });

  it('uploads covers to be scaled like the Yoto web app, not cropped to a landscape tile', async () => {
    const cover = join(mkdtempSync(join(tmpdir(), 'yoto-cover-')), 'cover.jpg');
    writeFileSync(cover, Buffer.from([0xff, 0xd8, 0xff]));
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ coverImage: { mediaUrl: 'https://card-content/x' } }))
    );
    await createYotoService('test-jwt').uploadCover(cover);
    const url = String(fetchSpy.mock.calls[0][0]);
    expect(url).toContain('coverType=default');
    expect(url).not.toContain('coverType=myo');
    fetchSpy.mockRestore();
  });

  it('prepends a chapter to the top of an existing card', async () => {
    const service = createYotoService('test-jwt');
    await service.prependTrackToCard('test-card', 'New Episode', {
      trackUrl: 'yoto:#new-hash',
      format: 'opus',
      duration: 100,
      fileSize: 12345,
      channels: 'stereo',
    });

    expect(mockSdk.content.updateCard).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.objectContaining({
          chapters: [
            expect.objectContaining({ key: '00', title: 'New Episode' }),
            expect.objectContaining({ key: '01', title: 'Episode 1' }),
          ],
        }),
      }),
      true
    );
  });
});

describe('prependTrackToCard icons', () => {
  it('keeps the icons already on the card and gives only the new chapter the default', async () => {
    mockSdk.content.getCard.mockResolvedValueOnce({
      cardId: 'test-card',
      title: 'Test Podcast',
      content: {
        chapters: [{ key: '00', title: 'Episode 1', display: { icon16x16: 'yoto:#dino' }, tracks: [{ key: '01', title: 'Episode 1', trackUrl: 'yoto:#abc' }] }],
      },
    });
    await createYotoService('test-jwt').prependTrackToCard('test-card', 'New Episode', { trackUrl: 'yoto:#new', format: 'opus' });
    const saved = mockSdk.content.updateCard.mock.calls.at(-1)![0];
    expect(saved.content.chapters.map((c: { display?: { icon16x16: string } }) => c.display?.icon16x16)).toEqual([DEFAULT_ICON, 'yoto:#dino']);
  });
});

describe('imageType', () => {
  it('maps image extensions to MIME types', () => {
    expect(imageType('/covers/Mice.JPG')).toBe('image/jpeg');
    expect(imageType('icon.png')).toBe('image/png');
  });

  it('rejects types Yoto does not take', () => {
    expect(() => imageType('cover.heic')).toThrow(/Unsupported image type/);
  });
});
