/**
 * @mentions of cast members, shared by the pages (autocomplete, the chips under
 * a prompt) and the server (server/cast.ts, which resolves them).
 *
 * Names may hold spaces. At each @ the longest member name that follows wins,
 * case-insensitive, and it must end at a word boundary, so @Mara does not match
 * @Marabou. An @ right after a letter (an email address) is not a mention.
 */
export interface Named { id: number; name: string }
export interface Mention<T extends Named> { member: T; start: number; end: number }

export function findMentions<T extends Named>(text: string, members: T[]): Mention<T>[] {
  if (!text || !text.includes('@') || !members.length) return [];
  const byLength = [...members].sort((a, b) => b.name.length - a.name.length);
  const out: Mention<T>[] = [];
  for (let i = text.indexOf('@'); i >= 0; i = text.indexOf('@', i + 1)) {
    if (i > 0 && /[\p{L}\p{N}_@]/u.test(text[i - 1])) continue;
    const rest = text.slice(i + 1);
    const m = byLength.find((x) => rest.slice(0, x.name.length).toLowerCase() === x.name.toLowerCase()
      && !/[\p{L}\p{N}_]/u.test(rest[x.name.length] ?? ''));
    if (m) out.push({ member: m, start: i, end: i + 1 + m.name.length });
  }
  return out;
}

/** The distinct members mentioned, in order of first mention. */
export function mentioned<T extends Named>(text: string, members: T[]): T[] {
  const seen = new Map<number, T>();
  for (const m of findMentions(text, members)) if (!seen.has(m.member.id)) seen.set(m.member.id, m.member);
  return [...seen.values()];
}

/**
 * The @query being typed at the caret, if any: "walks with @ma|" -> { at, query: 'ma' }.
 * A query may hold one space so two-word names stay findable while typing.
 */
export function mentionQuery(text: string, caret: number): { at: number; query: string } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at < 0) return null;
  if (at > 0 && /[\p{L}\p{N}_@]/u.test(before[at - 1])) return null;
  const query = before.slice(at + 1);
  if (query.length > 40 || /[\n@]/.test(query) || (query.match(/ /g) ?? []).length > 1) return null;
  return { at, query };
}
