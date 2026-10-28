/**
 * Reference sheet layout for Cast videos, shared by the server (which builds
 * the sheet inside the ComfyUI graph, server/graphs/cast.ts) and the Video page
 * (which previews it before you render).
 */

/** One reference picture placed on the sheet. */
export interface SheetTile {
  image: string; x: number; y: number; w: number; h: number;
  /** cover: fill the panel, trimming the edges (characters: the face stays big). contain: whole picture, black bars. */
  fit: 'cover' | 'contain';
}

/** Who a sheet holds, in the order their panels are laid out. */
export interface SheetMember { name: string; kind: 'character' | 'prop' | 'place'; notes: string; images: string[] }

/** Where each member sits, in the words the prompt uses ("Top row, left two panels"). */
export interface SheetLayout { width: number; height: number; tiles: SheetTile[]; where: string[] }

/** Positional words for a run of panels [a, b] in a row of n. */
function span(a: number, b: number, n: number): string {
  if (a === 0 && b === n - 1) return n === 1 ? 'full panel' : 'all panels';
  if (a === b) {
    if (n === 2) return a === 0 ? 'left panel' : 'right panel';
    if (n === 3) return ['left panel', 'center panel', 'right panel'][a];
    return `panel ${a + 1} from the left`;
  }
  const len = b - a + 1;
  const count = ['', 'one', 'two', 'three', 'four', 'five', 'six'][len] ?? String(len);
  if (a === 0) return `left ${count} panels`;
  if (b === n - 1) return `right ${count} panels`;
  return `panels ${a + 1} to ${b + 1} from the left`;
}

/**
 * Lay the members out on a W x H sheet. Places (locations) take a full-width
 * bottom row, the way the model card's examples do; characters and props share
 * the rows above, one panel per picture, characters first and widest.
 */
export function sheetLayout(members: SheetMember[], width: number, height: number): SheetLayout {
  const places = members.map((m, i) => ({ m, i })).filter((x) => x.m.kind === 'place');
  const others = members.map((m, i) => ({ m, i })).filter((x) => x.m.kind !== 'place');
  const tiles: SheetTile[] = [];
  const where: string[] = members.map(() => '');

  const placeH = places.length ? (others.length ? Math.round(height * 0.42) : height) : 0;
  const topH = height - placeH;

  // Characters and props: one or two rows of equal panels.
  const items = others.flatMap((x) => x.m.images.map((image) => ({ image, owner: x.i, fit: x.m.kind === 'character' ? 'cover' as const : 'contain' as const })));
  if (items.length) {
    const rows = items.length > 3 ? 2 : 1;
    const perRow = Math.ceil(items.length / rows);
    for (let r = 0; r < rows; r++) {
      const row = items.slice(r * perRow, (r + 1) * perRow);
      const y = Math.round((topH * r) / rows);
      const h = Math.round((topH * (r + 1)) / rows) - y;
      row.forEach((it, c) => {
        const x = Math.round((width * c) / row.length);
        tiles.push({ image: it.image, x, y, w: Math.round((width * (c + 1)) / row.length) - x, h, fit: it.fit });
      });
      const rowName = rows === 2 || places.length ? (r === 0 ? 'Top row' : 'Bottom row') : '';
      for (const owner of new Set(row.map((it) => it.owner))) {
        const idx = row.map((it, c) => (it.owner === owner ? c : -1)).filter((c) => c >= 0);
        const words = span(idx[0], idx[idx.length - 1], row.length);
        const part = rowName ? `${rowName}, ${words}` : words.charAt(0).toUpperCase() + words.slice(1);
        where[owner] = where[owner] ? `${where[owner]} and ${part.toLowerCase()}` : part;
      }
    }
  }

  // Places: the bottom row, side by side.
  if (places.length) {
    const pics = places.flatMap((x) => x.m.images.slice(0, 1).map((image) => ({ image, owner: x.i })));
    pics.forEach((it, c) => {
      const x = Math.round((width * c) / pics.length);
      tiles.push({ image: it.image, x, y: topH, w: Math.round((width * (c + 1)) / pics.length) - x, h: placeH, fit: 'cover' });
      const rowName = others.length ? 'Bottom row' : '';
      const words = pics.length === 1 ? 'full width' : span(c, c, pics.length);
      where[it.owner] = rowName ? `${rowName}, ${words}` : words.charAt(0).toUpperCase() + words.slice(1);
    });
  }
  return { width, height, tiles, where };
}


/** The trained bucket of the Ingredients IC-LoRA. */
export const INGREDIENTS_SIZE = { width: 768, height: 448 } as const;

/** A cast member as the sheet needs it: pictures by engine token. */
export interface SheetSource { name: string; kind: SheetMember['kind']; notes: string; refs: { token: string }[] }

/** Sheet size for an aspect: the trained 768x448 area, 64-aligned. */
export function sheetSize(width: number, height: number): { width: number; height: number } {
  const ratio = width && height ? width / height : INGREDIENTS_SIZE.width / INGREDIENTS_SIZE.height;
  // Every 16:9-ish shot snaps to the trained bucket itself.
  if (Math.abs(ratio - INGREDIENTS_SIZE.width / INGREDIENTS_SIZE.height) < 0.15) return { ...INGREDIENTS_SIZE };
  const area = INGREDIENTS_SIZE.width * INGREDIENTS_SIZE.height;
  const h = Math.sqrt(area / ratio);
  // IC-LoRA guides want a 64-aligned frame (an even latent grid).
  const snap = (n: number) => Math.max(256, Math.round(n / 64) * 64);
  return { width: snap(h * ratio), height: snap(h) };
}

/** Members (with their sheet pictures) for an Ingredients sheet: at most six panels. */
export function sheetMembers(members: SheetSource[]): SheetMember[] {
  const order = [...members].sort((a, b) => rank(a.kind) - rank(b.kind));
  let left = 6 - order.filter((m) => m.kind === 'place').length;
  const out = order.map((m) => ({ name: m.name, kind: m.kind, notes: m.notes, images: [] as string[], refs: m.refs }));
  for (const m of out) if (m.kind !== 'place' && left > 0 && m.refs[0]) { m.images.push(m.refs[0].token); left--; }
  for (let round = 1; round < 6 && left > 0; round++) {
    for (const m of out) {
      const cap = m.kind === 'character' ? 3 : 2;
      if (m.kind !== 'place' && left > 0 && m.images.length < cap && m.refs[round]) { m.images.push(m.refs[round].token); left--; }
    }
  }
  for (const m of out) if (m.kind === 'place' && m.refs[0]) m.images.push(m.refs[0].token);
  return out.filter((m) => m.images.length).map(({ refs: _r, ...m }) => m);
}
const rank = (k: SheetMember['kind']) => (k === 'character' ? 0 : k === 'prop' ? 1 : 2);

