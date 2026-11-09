import { describe, it, expect, vi } from 'vitest';
import { pushToCard } from '../src/commands/backfill.js';

const files = [
  { title: '01 - One', path: '/eps/01 - One.mp3' },
  { title: '02 - Two', path: '/eps/02 - Two.mp3' },
];
const track = (id: string) => ({ trackUrl: `yoto:#${id}`, format: 'opus' });

describe('pushToCard', () => {
  it('puts every episode on the card, newest first', async () => {
    const yoto = { uploadAudioFile: vi.fn(async (path: string) => track(path.includes('One') ? 'a' : 'b')), setCardChapters: vi.fn() };
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await pushToCard(yoto, 'card', files);
    expect(yoto.setCardChapters).toHaveBeenCalledWith('card', [
      { title: '02 - Two', track: track('b') },
      { title: '01 - One', track: track('a') },
    ]);
  });

  it('leaves the card alone when any upload fails', async () => {
    const yoto = {
      uploadAudioFile: vi.fn(async (path: string) => {
        if (path.includes('Two')) throw new Error('401 Unauthorized');
        return track('a');
      }),
      setCardChapters: vi.fn(),
    };
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(pushToCard(yoto, 'card', files)).rejects.toThrow(/1 of 2 track\(s\) failed to upload, so the card was left as it was[\s\S]*02 - Two: 401 Unauthorized/);
    expect(yoto.setCardChapters).not.toHaveBeenCalled();
  });
});
