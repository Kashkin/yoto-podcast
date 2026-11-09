import { describe, it, expect } from 'vitest';
import { findCard, mergeCards, sheetHtml, type CatalogueCard } from '../src/commands/labels.js';
import type { YotoCard } from '../src/types.js';

const entry = (cardId: string, title: string, added = '2026-01-01', printed: string | null = null): CatalogueCard => ({ cardId, title, added, cover: `${cardId}.png`, printed });
const card = (cardId: string, title: string, createdAt: string): YotoCard => ({ cardId, title, createdAt, content: { chapters: [] } });

describe('mergeCards', () => {
  it('adds new cards newest first, keeping printed state and picking up a cover named after the title', () => {
    const { catalogue, added, needCover } = mergeCards(
      [entry('a', 'Old', '2025-01-01', 'sheet.pdf')],
      [card('a', 'Old renamed', '2025-01-01T00:00:00Z'), card('b', "Nim's Island", '2026-05-24T00:00:00Z'), card('c', 'No Cover', '2026-06-01T00:00:00Z')],
      ['a.png', 'nims-island.jpg']
    );
    expect(catalogue.map((c) => [c.cardId, c.title, c.cover, c.printed])).toEqual([
      ['c', 'No Cover', null, null],
      ['b', "Nim's Island", 'nims-island.jpg', null],
      ['a', 'Old renamed', 'a.png', 'sheet.pdf'],
    ]);
    expect(added.map((c) => c.cardId)).toEqual(['b', 'c']);
    expect(needCover.map((c) => c.cardId)).toEqual(['c']);
  });
});

describe('findCard', () => {
  const cat = [entry('fOXxm', 'Wendy Orr - Nim at Sea'), entry('imca4', "Wendy Orr - Rescue on Nim's Island"), entry('gS2H4', "Nim's Island")];

  it('finds by card ID or title words', () => {
    expect(findCard('imca4', cat).title).toBe("Wendy Orr - Rescue on Nim's Island");
    expect(findCard('nim sea', cat).cardId).toBe('fOXxm');
  });

  it('prefers an exact title over partial matches', () => {
    expect(findCard("nim's island", cat).cardId).toBe('gS2H4');
  });

  it('refuses an ambiguous name', () => {
    expect(() => findCard('wendy', cat)).toThrow(/matches 2 cards/);
  });
});

describe('sheetHtml', () => {
  it('starts a new page after 12 labels in the 2026 format', () => {
    const html = sheetHtml('2026', Array.from({ length: 13 }, (_, i) => `${i}.jpg`));
    expect(html.match(/class="page"/g)).toHaveLength(2);
    expect(html).toContain('src="12.jpg" style="left:9.9mm;top:7.9mm');
  });

  it('draws cut lines only in the 2025 format', () => {
    expect(sheetHtml('2025', ['a.jpg'])).toContain('class="v"');
    expect(sheetHtml('2026', ['a.jpg'])).not.toContain('class="v"');
  });
});
