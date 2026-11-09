export interface PublicIcon {
  mediaId: string;
  title?: string;
  publicTags?: string[];
}

export function searchIcons<T extends PublicIcon>(icons: T[], query: string): T[] {
  const q = query.toLowerCase();
  const exact = icons.filter((i) => i.title?.toLowerCase() === q);
  const partial = icons.filter(
    (i) =>
      !exact.includes(i) &&
      (i.title?.toLowerCase().includes(q) || i.publicTags?.some((t) => t.toLowerCase().includes(q)))
  );
  return [...exact, ...partial];
}

export function formatIcon(icon: PublicIcon): string {
  return `${icon.mediaId}  ${icon.title ?? ''}${icon.publicTags?.length ? `  [${icon.publicTags.join(', ')}]` : ''}`;
}

// Resolves a name or media ID to one public icon reference, or throws listing the candidates.
export function pickPublicIcon(icons: PublicIcon[], query: string): string {
  const byId = icons.find((i) => i.mediaId === query);
  if (byId) return `yoto:#${byId.mediaId}`;

  const exact = icons.filter((i) => i.title?.toLowerCase() === query.toLowerCase());
  if (exact.length === 1) return `yoto:#${exact[0].mediaId}`;

  const matches = searchIcons(icons, query);
  if (matches.length === 1) return `yoto:#${matches[0].mediaId}`;
  if (matches.length === 0) throw new Error(`No public icon matches "${query}". Try \`icons search\`.`);

  const list = matches.slice(0, 20).map((i) => `  ${formatIcon(i)}`).join('\n');
  const more = matches.length > 20 ? `\n  ...and ${matches.length - 20} more` : '';
  throw new Error(`${matches.length} icons match "${query}". Pass one of these media IDs instead:\n${list}${more}`);
}

// yotoicons.com icon, pasted as its image URL or `yotoicons:<id>`. Bare numbers are left
// to the Yoto icon search. Search isn't supported: their API needs a key.
export function parseYotoiconsId(ref: string): string | null {
  const match =
    ref.match(/^yotoicons:(\d+)$/) ?? ref.match(/^https?:\/\/(?:www\.)?yotoicons\.com\/static\/uploads\/(\d+)\.png$/);
  return match ? match[1] : null;
}

export async function downloadYotoicon(id: string): Promise<Buffer> {
  const res = await fetch(`https://yotoicons.com/static/uploads/${id}.png`);
  if (!res.ok || res.headers.get('content-type') !== 'image/png') {
    throw new Error(`yotoicons icon ${id} not found (${res.status})`);
  }
  return Buffer.from(await res.arrayBuffer());
}

// Same download count the site records, so the artist gets credit. Call only when the icon is used.
export async function countYotoiconDownload(id: string): Promise<void> {
  await fetch(`https://yotoicons.com/api/counter?download=${id}`).catch(() => {});
}
