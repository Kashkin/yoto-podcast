import { describe, it, expect, vi, beforeEach } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createYotoService, imageType } from '../src/services/yoto.js';

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

  it('refuses to save a card that changed since it was read', async () => {
    const before = { cardId: 'test-card', title: 'T', updatedAt: '2026-01-01', content: { chapters: [] } };
    mockSdk.content.getCard.mockResolvedValueOnce({ ...before, updatedAt: '2026-01-02' });
    mockSdk.content.updateCard.mockClear();
    await expect(createYotoService('test-jwt').saveIfUnchanged(before, { ...before, title: 'New' })).rejects.toThrow(/changed since it was read/);
    expect(mockSdk.content.updateCard).not.toHaveBeenCalled();
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
