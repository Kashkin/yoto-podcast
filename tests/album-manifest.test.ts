import { describe, it, expect } from 'vitest';
import {
  parseManifest,
  albumFolderName,
  coverSlug,
  trackFilename,
  suggestedName,
  trackTags,
  renderGuide,
  cardChapters,
  type AlbumManifest,
} from '../src/services/album-manifest.js';

function manifest(overrides: Partial<AlbumManifest> = {}): AlbumManifest {
  return {
    category: 'Stories',
    series: 'Enid Blyton',
    title: 'Summer Stories',
    author: 'Enid Blyton',
    narrators: ['Sandra Duncan', 'Thomas Judd'],
    publisher: "Hodder Children's Books",
    year: 2016,
    source: '/rips/Unknown Album',
    cover: 'https://example.com/cover.jpg',
    tracks: [
      { file: 'Track 01.mp3', title: "Publisher's Note", icon: '📜', description: 'Note about the text' },
      { file: 'Track 02.mp3', title: 'The Fish That Got Away (Part 1)', icon: '🪨', description: 'At the beach' },
      { file: 'Track 03.mp3', title: 'End of Disc 1', icon: '💿', description: '"This is the end of CD1."', leaveOff: true },
    ],
    ...overrides,
  };
}

describe('parseManifest', () => {
  it('accepts a complete manifest', () => {
    expect(parseManifest(JSON.stringify(manifest())).title).toBe('Summer Stories');
  });

  it('lists every missing field', () => {
    const { title, publisher, ...rest } = manifest();
    expect(() => parseManifest(JSON.stringify(rest))).toThrow(/title.*publisher|publisher.*title/);
  });

  it('rejects an unknown category', () => {
    expect(() => parseManifest(JSON.stringify(manifest({ category: 'Music' as never })))).toThrow(/category/);
  });

  it('rejects a track without a title or icon', () => {
    const m = manifest();
    (m.tracks[1] as Record<string, unknown>).icon = undefined;
    expect(() => parseManifest(JSON.stringify(m))).toThrow(/track 2.*icon/);
  });

  it('rejects two tracks sharing an icon outside a story', () => {
    const m = manifest();
    m.tracks[2].icon = '🪨';
    expect(() => parseManifest(JSON.stringify(m))).toThrow(/🪨.*track 2.*track 3/);
  });

  it('rejects an empty narrator list', () => {
    expect(() => parseManifest(JSON.stringify(manifest({ narrators: [] })))).toThrow(/narrators must be a list of names/);
  });

  it('rejects narrators given as a single string', () => {
    expect(() => parseManifest(JSON.stringify(manifest({ narrators: 'Bob' as never })))).toThrow(/narrators must be a list of names/);
  });

  it('rejects an empty genre', () => {
    expect(() => parseManifest(JSON.stringify(manifest({ genre: '' })))).toThrow(/genre/);
  });

  it('rejects an unknown narration verb', () => {
    expect(() => parseManifest(JSON.stringify(manifest({ narration: 'Shouted by' as never })))).toThrow(/narration/);
  });

  it('rejects the same file written two ways', () => {
    const m = manifest();
    m.tracks[2].file = './Track 01.mp3';
    expect(() => parseManifest(JSON.stringify(m))).toThrow(/Track 01\.mp3/);
  });

  it('rejects the same source file used twice', () => {
    const m = manifest();
    m.tracks[2].file = 'Track 01.mp3';
    expect(() => parseManifest(JSON.stringify(m))).toThrow(/Track 01\.mp3/);
  });
});

describe('names', () => {
  it('names the folder "<Series> - <Title>"', () => {
    expect(albumFolderName(manifest())).toBe('Enid Blyton - Summer Stories');
  });

  it('drops characters Box rejects from the folder name', () => {
    expect(albumFolderName(manifest({ series: 'Test Series', title: "Where's Spot? Part: One" }))).toBe(
      "Test Series - Where's Spot Part One"
    );
    expect(albumFolderName(manifest({ series: 'AC/DC', title: 'Back\\slash' }))).toBe('ACDC - Back slash');
  });

  it('makes a kebab-case cover slug', () => {
    expect(coverSlug('Adventure Mice - Mice on the Moon')).toBe('adventure-mice-mice-on-the-moon');
    expect(coverSlug("Zelda's Big Adventure & Friends!")).toBe('zeldas-big-adventure-friends');
  });

  it('numbers files and drops characters Box rejects', () => {
    expect(trackFilename(3, 'Where Is Bear?', 13)).toBe('03 - Where Is Bear.mp3');
    expect(trackFilename(7, 'Pig: The Winner', 120)).toBe('007 - Pig The Winner.mp3');
    expect(trackFilename(2, 'Back\\slash', 3)).toBe('02 - Back slash.mp3');
  });

  it('suggests snake_case names without articles or the word Part', () => {
    expect(suggestedName('The Fish That Got Away (Part 1)')).toBe('fish_that_got_away_1');
    expect(suggestedName("Publisher's Note")).toBe('publishers_note');
    expect(suggestedName('Where Is Bear?')).toBe('where_is_bear');
  });
});

describe('trackTags', () => {
  it('sets the album tags from the manifest', () => {
    expect(trackTags(manifest(), 1)).toEqual({
      title: 'The Fish That Got Away (Part 1)',
      track: '2/3',
      album: 'Enid Blyton - Summer Stories',
      artist: 'Enid Blyton',
      album_artist: 'Enid Blyton',
      composer: 'Sandra Duncan & Thomas Judd',
      comment: 'Read by Sandra Duncan & Thomas Judd',
      publisher: "Hodder Children's Books",
      date: '2016',
    });
  });

  it('leaves the total off the track number for multi-disc sets', () => {
    expect(trackTags(manifest({ multiDisc: true }), 1).track).toBe('2');
  });

  it('keeps "?" in the title tag', () => {
    const m = manifest();
    m.tracks[0].title = 'Where Is Bear?';
    expect(trackTags(m, 0).title).toBe('Where Is Bear?');
  });

  it('credits singers and performers on song albums', () => {
    expect(trackTags(manifest({ narrators: ['Peter Combe'], narration: 'Sung by' }), 0).comment).toBe('Sung by Peter Combe');
    expect(trackTags(manifest({ narrators: ['The Wiggles'], narration: 'Performed by' }), 0).comment).toBe(
      'Performed by The Wiggles'
    );
    expect(() => parseManifest(JSON.stringify(manifest({ narration: 'Sung by' })))).not.toThrow();
  });

  it('joins three narrators and uses the narration verb', () => {
    const tags = trackTags(manifest({ narrators: ['A', 'B', 'C'], narration: 'Told by' }), 0);
    expect(tags.composer).toBe('A, B & C');
    expect(tags.comment).toBe('Told by A, B & C');
  });

  it('includes genre only when the manifest sets one', () => {
    expect(trackTags(manifest({ genre: 'Audiobook' }), 0).genre).toBe('Audiobook');
  });
});

describe('renderGuide', () => {
  it('writes the header, notes and track table', () => {
    const guide = renderGuide(
      manifest({ discCoverage: 'Disc 1 (tracks 01–03): stories 1–5 of 27.', iconNotes: 'Icons come from short clips.' })
    );
    expect(guide).toBe(`# Enid Blyton – Summer Stories

**Author:** Enid Blyton
**Read by:** Sandra Duncan & Thomas Judd
**Publisher:** Hodder Children's Books (2016)

Disc 1 (tracks 01–03): stories 1–5 of 27.
Icons come from short clips.

| Track | Current File | Suggested Name | Icon | Description |
|---|---|---|---|---|
| 01 | 01 - Publisher's Note.mp3 | publishers_note | 📜 | Note about the text |
| 02 | 02 - The Fish That Got Away (Part 1).mp3 | fish_that_got_away_1 | 🪨 | At the beach |
| 03 | 03 - End of Disc 1.mp3 | end_of_disc_1 | 💿 | "This is the end of CD1." Probably worth leaving off the Yoto card |
`);
  });

  it('uses a heading override and a custom suggested name', () => {
    const m = manifest({ heading: 'Enid Blyton – Summer Stories (Discs 1–2)' });
    m.tracks[0].name = 'note';
    const guide = renderGuide(m);
    expect(guide.split('\n')[0]).toBe('# Enid Blyton – Summer Stories (Discs 1–2)');
    expect(guide).toContain('| 01 | 01 - Publisher\'s Note.mp3 | note |');
  });

  it('does not repeat a leave-off note the description already has', () => {
    const m = manifest();
    m.tracks[2].description = '"CD2" announcement. Probably worth leaving off the Yoto card';
    expect(renderGuide(m)).toContain('| "CD2" announcement. Probably worth leaving off the Yoto card |');
  });

  it('uses the narration verb in the narrator line', () => {
    const guide = renderGuide(manifest({ narrators: ['Peter Combe'], narration: 'Sung by' }));
    expect(guide).toContain('**Sung by:** Peter Combe');
  });

  it('escapes pipes in descriptions', () => {
    const m = manifest();
    m.tracks[0].description = 'Either | or';
    expect(renderGuide(m)).toContain('Either \\| or');
  });
});

describe('cardChapters', () => {
  it('lists the finished files to put on the card, skipping leave-off tracks', () => {
    const m = manifest();
    m.tracks[1].yotoIcon = 'yotoicons:1701';
    expect(cardChapters(m)).toEqual([
      { title: "Publisher's Note", file: "01 - Publisher's Note.mp3", yotoIcon: undefined },
      { title: 'The Fish That Got Away (Part 1)', file: '02 - The Fish That Got Away (Part 1).mp3', yotoIcon: 'yotoicons:1701' },
    ]);
  });
});

describe('stories', () => {
  // Two-part story between two non-story tracks
  function storyManifest(): AlbumManifest {
    return manifest({
      stories: [{ title: 'The Fish That Got Away', icon: '🐟', yotoIcon: 'yotoicons:1701' }],
      tracks: [
        { file: 'Track 01.mp3', title: "Publisher's Note", icon: '📜', description: 'Note' },
        { file: 'Track 02.mp3', title: 'The Fish That Got Away (Part 1)', story: 'The Fish That Got Away', description: 'Beach' },
        { file: 'Track 03.mp3', title: 'The Fish That Got Away (Part 2)', story: 'The Fish That Got Away', description: 'Gull' },
        { file: 'Track 04.mp3', title: 'End of Disc 1', icon: '💿', description: 'CD1 end', leaveOff: true },
      ],
    });
  }

  it('accepts story parts that take their icon from the story', () => {
    expect(() => parseManifest(JSON.stringify(storyManifest()))).not.toThrow();
  });

  it('shows the story icon on every part in the guide', () => {
    const guide = renderGuide(storyManifest());
    expect(guide).toContain('| fish_that_got_away_1 | 🐟 | Beach |');
    expect(guide).toContain('| fish_that_got_away_2 | 🐟 | Gull |');
  });

  it('gives every part the story card icon', () => {
    expect(cardChapters(storyManifest()).map((c) => c.yotoIcon)).toEqual([undefined, 'yotoicons:1701', 'yotoicons:1701']);
  });

  it('rejects a part naming a story that is not listed', () => {
    const m = storyManifest();
    m.tracks[2].story = 'The Fish';
    expect(() => parseManifest(JSON.stringify(m))).toThrow(/track 3: story "The Fish" is not in stories/);
  });

  it('rejects a part with its own icon, since the story owns it', () => {
    const m = storyManifest();
    m.tracks[1].icon = '🦀';
    expect(() => parseManifest(JSON.stringify(m))).toThrow(/track 2: icon comes from story "The Fish That Got Away"/);
  });

  it('rejects a non-story track without an icon', () => {
    const m = storyManifest();
    delete m.tracks[0].icon;
    expect(() => parseManifest(JSON.stringify(m))).toThrow(/track 1: missing icon/);
  });

  it('rejects a story icon reused by another track', () => {
    const m = storyManifest();
    m.tracks[3].icon = '🐟';
    expect(() => parseManifest(JSON.stringify(m))).toThrow(/🐟.*story "The Fish That Got Away".*track 4/);
  });

  it('lets disc markers left off the card sit between the parts of a story', () => {
    const m = storyManifest();
    m.tracks.splice(2, 0, { file: 'Track 05.mp3', title: 'Disc 2', icon: '📀', description: 'CD2', leaveOff: true });
    expect(() => parseManifest(JSON.stringify(m))).not.toThrow();
  });

  it('rejects two stories with the same title', () => {
    const m = storyManifest();
    m.stories!.push({ title: 'The Fish That Got Away', icon: '🦈' });
    expect(() => parseManifest(JSON.stringify(m))).toThrow(/story "The Fish That Got Away" is listed twice/);
  });

  it('rejects story parts that are not next to each other', () => {
    const m = storyManifest();
    m.tracks[3] = { ...m.tracks[3], icon: undefined, story: 'The Fish That Got Away' };
    m.tracks[2] = { file: 'Track 03.mp3', title: 'Interlude', icon: '🎵', description: 'Music' };
    expect(() => parseManifest(JSON.stringify(m))).toThrow(/story "The Fish That Got Away".*tracks 2, 4.*next to each other/);
  });
});

describe(':label: icons', () => {
  it('accepts a :label: in place of an emoji, for stories and tracks', () => {
    const m = manifest({ stories: [{ title: 'Bingo', icon: ':bingo:' }] });
    m.tracks[0].icon = ':mackenzie:';
    m.tracks[1] = { ...m.tracks[1], icon: undefined, story: 'Bingo' };
    expect(() => parseManifest(JSON.stringify(m))).not.toThrow();
  });

  it('accepts keycap emoji such as 3️⃣', () => {
    const m = manifest();
    m.tracks[0].icon = '3️⃣';
    expect(() => parseManifest(JSON.stringify(m))).not.toThrow();
  });

  it('shows the label in the guide', () => {
    const m = manifest();
    m.tracks[0].icon = ':pig_the_pug:';
    expect(renderGuide(m)).toContain("| publishers_note | :pig_the_pug: |");
  });

  it('rejects a label that is not lowercase snake_case', () => {
    const m = manifest();
    m.tracks[0].icon = ':Mac Kenzie:';
    expect(() => parseManifest(JSON.stringify(m))).toThrow(/track 1: icon ":Mac Kenzie:" must be an emoji or a :label: like :bingo:/);
  });

  it('rejects plain text that is neither an emoji nor a label', () => {
    const m = manifest();
    m.tracks[0].icon = 'bingo';
    expect(() => parseManifest(JSON.stringify(m))).toThrow(/track 1: icon "bingo"/);
  });

  it('checks a story label is valid too', () => {
    expect(() => parseManifest(JSON.stringify(manifest({ stories: [{ title: 'Bingo', icon: 'bingo:' }] })))).toThrow(
      /story "Bingo": icon "bingo:"/
    );
  });

  it('treats a repeated label like a repeated emoji', () => {
    const m = manifest();
    m.tracks[0].icon = ':bingo:';
    m.tracks[2].icon = ':bingo:';
    expect(() => parseManifest(JSON.stringify(m))).toThrow(/icon :bingo: is used by track 1 and track 3/);
  });
});
