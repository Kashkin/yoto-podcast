import { describe, it, expect } from 'vitest';
import { searchIcons, pickPublicIcon, parseYotoiconsId } from '../src/services/icons.js';

describe('parseYotoiconsId', () => {
  it('reads the ID from an icon image URL', () => {
    expect(parseYotoiconsId('https://yotoicons.com/static/uploads/1701.png')).toBe('1701');
  });

  it('accepts yotoicons:<id>', () => {
    expect(parseYotoiconsId('yotoicons:1701')).toBe('1701');
  });

  it('leaves bare numbers to the Yoto public icon search', () => {
    expect(parseYotoiconsId('1')).toBeNull();
  });

  it('ignores icon names and other sites', () => {
    expect(parseYotoiconsId('rocket')).toBeNull();
    expect(parseYotoiconsId('https://example.com/static/uploads/1701.png')).toBeNull();
  });
});

const icons = [
  { mediaId: 'moon1', title: 'Moon', publicTags: ['night', 'space'] },
  { mediaId: 'moon2', title: 'Moon', publicTags: ['planet'] },
  { mediaId: 'cres', title: 'Crescent moon', publicTags: ['night'] },
  { mediaId: 'rock', title: 'Rocket, vehicle', publicTags: ['rocket'] },
  { mediaId: 'star', title: 'Star', publicTags: ['space'] },
];

describe('searchIcons', () => {
  it('matches titles and tags, case-insensitively', () => {
    expect(searchIcons(icons, 'SPACE').map((i) => i.mediaId)).toEqual(['moon1', 'star']);
  });

  it('lists exact title matches first', () => {
    expect(searchIcons(icons, 'moon').map((i) => i.mediaId)).toEqual(['moon1', 'moon2', 'cres']);
  });
});

describe('pickPublicIcon', () => {
  it('accepts a unique exact title', () => {
    expect(pickPublicIcon(icons, 'star')).toBe('yoto:#star');
  });

  it('accepts a single search hit', () => {
    expect(pickPublicIcon(icons, 'rocket')).toBe('yoto:#rock');
  });

  it('accepts a media ID from search results', () => {
    expect(pickPublicIcon(icons, 'moon2')).toBe('yoto:#moon2');
  });

  it('lists the candidates when the name is ambiguous', () => {
    expect(() => pickPublicIcon(icons, 'moon')).toThrow(/3 icons match "moon"[\s\S]*moon1[\s\S]*moon2/);
  });

  it('says when nothing matches', () => {
    expect(() => pickPublicIcon(icons, 'dragon')).toThrow(/No public icon matches "dragon"/);
  });
});
