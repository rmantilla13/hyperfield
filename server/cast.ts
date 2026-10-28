/**
 * Cast: characters, props and places saved once and @mentioned in any prompt.
 *
 * A mention does two things. Its words (the member's name and notes) go into
 * the prompt, and its reference pictures go to the engine the app runs:
 *
 *   still (Image, Director frame)   Qwen-Image-Edit 2509 composes a new frame from
 *                                   up to 3 cast pictures (graphs/edit.ts compose)
 *   Edit                            cast pictures fill the free image slots 2 and 3
 *   Video, Director shot (no frame) 'sheet': LTX-2.5 Ingredients IC-LoRA on a
 *                                   reference sheet (graphs/cast.ts), or 'frame':
 *                                   a Qwen-Edit hero frame, then image to video
 *   Mirror, Speak (no frame)        a Qwen-Edit hero frame becomes the first frame
 *   everything else                 words only
 *
 * Reference pictures live twice: as engine input tokens (what graphs load) and
 * as files under <output>/Cast/<name>/, so a cleared engine cache re-uploads.
 */
import { copyFile, mkdir, readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { extname, join, resolve, sep } from 'path';
import * as eng from './engine.js';
import { config } from './config.js';
import { imageDims, safeShotName } from './files.js';
import { cast as castDb, takes, type CastKind, type CastMember, type CastRef } from './jobs.js';
import { findMentions as find, mentioned as distinct, type Mention as M } from '../src/mentions.js';
import { ingredientsPrompt, sheetLayout, type SheetLayout, type SheetMember } from './graphs/cast.js';
import { sheetMembers, sheetSize } from '../src/castSheet.js';

export const CAST_KINDS: CastKind[] = ['character', 'prop', 'place'];
export const MAX_REFS = 6;
/** Qwen-Image-Edit 2509 reads at most three pictures. */
const EDIT_SLOTS = 3;

// ---------- mentions ----------

export type Mention = M<CastMember>;

/** Every @mention of a cast member in `text`, in order (src/mentions.ts). */
export function findMentions(text: string, members: CastMember[] = castDb.list()): Mention[] {
  return find(text, members);
}

/** The distinct members mentioned, in order of first mention. */
export function mentioned(text: string, members: CastMember[] = castDb.list()): CastMember[] {
  return distinct(text, members);
}

/** Replace each mention: the first one of a member with `first(member)`, later ones with the name. */
function rewrite(text: string, first: (m: CastMember) => string, members?: CastMember[]): string {
  const ms = findMentions(text, members);
  if (!ms.length) return text;
  const done = new Set<number>();
  let out = '';
  let at = 0;
  for (const m of ms) {
    out += text.slice(at, m.start);
    out += done.has(m.member.id) ? m.member.name : first(m.member);
    done.add(m.member.id);
    at = m.end;
  }
  return out + text.slice(at);
}

const notesOf = (m: CastMember) => m.notes.trim().replace(/[.\s]+$/, '');

/** Words-only resolution: "@Mara walks" -> "Mara, a woman in her forties with ..., walks". */
export function plainText(text: string, members?: CastMember[]): string {
  return rewrite(text, (m) => (notesOf(m) ? `${m.name} (${notesOf(m)})` : m.name), members);
}

/** Without the @ signs, for display and file names. */
export function bareText(text: string, members?: CastMember[]): string {
  return rewrite(text, (m) => m.name, members);
}

// ---------- reference pictures ----------

/** Every cast picture lives under here; nothing outside it is ever read back as a ref. */
export const castRoot = () => resolve(config.outputDir, 'Cast');
function castDir(name: string): string {
  const slug = safeShotName(name);
  if (/^\.*$/.test(slug)) throw new Error('That name cannot be a folder name');
  const dir = resolve(castRoot(), slug);
  if (!dir.startsWith(castRoot() + sep)) throw new Error('That name cannot be a folder name');
  return dir;
}

/** Is this a ref file the server itself wrote under the Cast folder? */
export function isCastFile(file: string): boolean {
  const f = resolve(file);
  return f.startsWith(castRoot() + sep) && existsSync(f);
}

/** Store one picture for a member: our own copy on disk plus an engine input token. */
export async function storeRef(memberName: string, data: Buffer, nameHint: string, token?: string): Promise<CastRef> {
  const dims = imageDims(data);
  if (!dims) throw new Error(`${nameHint} is not a PNG, JPEG or WebP image`);
  const dir = castDir(memberName);
  await mkdir(dir, { recursive: true });
  const ext = (extname(nameHint).toLowerCase() || '.png').replace('.jpeg', '.jpg');
  const file = join(dir, `${safeShotName(memberName)}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}${ext}`);
  await writeFile(file, data);
  const t = token ?? (await eng.uploadInput(`openfield_cast_${safeShotName(memberName)}_${Date.now()}${ext}`, data,
    ext === '.jpg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png'));
  return { token: t, file, w: dims.w, h: dims.h };
}

/**
 * A picture from an upload token (asset:<id> from /api/upload) or a finished
 * still take. Local paths are deliberately not accepted: the HTTP API must not
 * read arbitrary files (the MCP server uploads files first, like every tool).
 */
export async function refFrom(memberName: string, src: { token?: string; takeId?: number }): Promise<CastRef> {
  if (typeof src.token === 'string' && src.token) {
    if (!/^asset:[0-9a-f-]{36}$/i.test(src.token)) throw new Error('A cast picture must come from an upload');
    const inp = await eng.readInput(src.token);
    if (!inp) throw new Error('That upload is no longer on this machine. Add the picture again.');
    return storeRef(memberName, inp.data, inp.name, src.token);
  }
  if (Number.isInteger(src.takeId) && src.takeId! > 0) {
    const t = takes.get(src.takeId!);
    if (!t?.output_path || !existsSync(t.output_path)) throw new Error(`Take ${src.takeId} has no file on disk`);
    if (t.kind !== 'still') throw new Error(`Take ${src.takeId} is a video. Cast pictures are stills.`);
    return storeRef(memberName, await readFile(t.output_path), t.output_path);
  }
  throw new Error('A cast picture needs an upload or a take');
}

/** The member's pictures with live engine tokens; re-uploads any the engine cache lost. */
export async function liveRefs(m: CastMember): Promise<CastRef[]> {
  let changed = false;
  const out: CastRef[] = [];
  for (const r of m.refs) {
    if (await eng.readInput(r.token)) { out.push(r); continue; }
    if (!isCastFile(r.file)) continue;
    const data = await readFile(r.file);
    out.push({ ...r, token: await eng.uploadInput(`openfield_cast_${safeShotName(m.name)}_${Date.now()}${extname(r.file)}`, data) });
    changed = true;
  }
  if (changed) castDb.update(m.id, { refs: out });
  return out;
}

/** Move a member's folder along with a rename, so files stay findable by name. */
export async function renameFiles(m: CastMember, newName: string): Promise<CastRef[]> {
  const dir = castDir(newName);
  await mkdir(dir, { recursive: true });
  const out: CastRef[] = [];
  for (const r of m.refs) {
    if (!isCastFile(r.file) || resolve(r.file).startsWith(dir + sep)) { out.push(r); continue; }
    const file = join(dir, r.file.split(/[\\/]/).pop()!);
    await copyFile(r.file, file);
    out.push({ ...r, file });
  }
  return out;
}

// ---------- engines ----------

/**
 * Share EDIT_SLOTS pictures between members: each gets one in order of mention
 * (characters first), then characters get their second and third pictures.
 */
export function allocate(members: CastMember[], slots: number): { member: CastMember; refs: CastRef[] }[] {
  const order = [...members].sort((a, b) => Number(b.kind === 'character') - Number(a.kind === 'character'));
  const picks = order.map((member) => ({ member, refs: [] as CastRef[] }));
  let left = slots;
  for (const p of picks) if (left > 0 && p.member.refs[0]) { p.refs.push(p.member.refs[0]); left--; }
  for (let round = 1; round < MAX_REFS && left > 0; round++) {
    for (const p of picks) {
      if (left > 0 && p.member.kind === 'character' && p.member.refs[round]) { p.refs.push(p.member.refs[round]); left--; }
    }
  }
  return picks.filter((p) => p.refs.length);
}

const KIND_WORD: Record<CastKind, string> = { character: 'person', prop: 'object', place: 'place' };

/** "image 2", "images 1 and 2", "images 1 to 3". */
function imagesPhrase(first: number, n: number): string {
  if (n === 1) return `image ${first}`;
  if (n === 2) return `images ${first} and ${first + 1}`;
  return `images ${first} to ${first + n - 1}`;
}

/**
 * A Qwen-Image-Edit instruction that names which pictures hold whom, then asks
 * for a new photograph, not a collage of the references.
 *   offset: how many images come before the cast (Edit's own pictures).
 *   nameless: point at members by picture only. FLUX.2 letters a name it reads
 *             into the frame (a shop sign, a bus stop), so its prompts drop them.
 */
export function composeInstruction(
  text: string,
  picks: { member: CastMember; refs: CastRef[] }[],
  opts: { offset?: number; newFrame?: boolean; all?: CastMember[]; nameless?: boolean } = {},
): { instruction: string; images: string[] } {
  let n = (opts.offset ?? 0) + 1;
  const where = new Map<number, string>();
  const images: string[] = [];
  for (const p of picks) {
    where.set(p.member.id, imagesPhrase(n, p.refs.length));
    images.push(...p.refs.map((r) => r.token));
    n += p.refs.length;
  }
  const label = (m: CastMember) => {
    const w = where.get(m.id);
    const notes = notesOf(m);
    if (!w) return notes ? `${m.name} (${notes})` : m.name;
    if (opts.nameless) return `the ${KIND_WORD[m.kind]} in ${w}${notes ? ` (${notes})` : ''}`;
    return `${m.name} (the ${KIND_WORD[m.kind]} shown in ${w}${notes ? `: ${notes}` : ''})`;
  };
  const who = (m: CastMember) => (opts.nameless ? `the ${KIND_WORD[m.kind]} in ${where.get(m.id)}` : m.name);
  const inText = new Set(mentioned(text, opts.all).map((m) => m.id));
  let body = rewrite(text.trim(), label, opts.all);
  // Members passed in but not named in the text (castHeroFrame) still get introduced.
  const extra = picks.filter((p) => !inText.has(p.member.id)).map((p) => label(p.member));
  if (extra.length) body = `${extra.join(' and ')}. ${body}`;
  if (opts.nameless) body = body.charAt(0).toUpperCase() + body.slice(1);
  const keep = picks.map((p) => {
    if (p.member.kind === 'character') return `Keep ${who(p.member)}'s face, hair, build and clothing exactly as in the reference.`;
    if (p.member.kind === 'prop') return `Keep ${who(p.member)}'s shape, color and details exactly as in the reference.`;
    return `Keep the look of ${who(p.member)} as in the reference.`;
  });
  const frame = opts.newFrame
    ? 'Make one new, natural photograph of this scene with its own camera angle and lighting. Do not copy the reference backgrounds or lay the references side by side.'
    : '';
  return { instruction: [body.replace(/\s*$/, '').replace(/([^.!?])$/, '$1.'), ...keep, frame].filter(Boolean).join(' '), images };
}

/** Layout + two-part prompt for an Ingredients video. */
export function sheetPlan(text: string, members: CastMember[], width: number, height: number, all?: CastMember[]): { layout: SheetLayout; prompt: string; members: SheetMember[] } {
  const sm = sheetMembers(members);
  const size = sheetSize(width, height);
  const layout = sheetLayout(sm, size.width, size.height);
  return { layout, members: sm, prompt: ingredientsPrompt(sm, layout, plainText(text, all)) };
}

// ---------- hero frames (used by Mirror, Speak, Video 'frame' mode and Director) ----------

type Queue = (body: Record<string, unknown>, count: number) => Promise<number[]>;
let queueFn: Queue | null = null;
/** index.ts hands over its take queue at boot, so hero frames are ordinary takes. */
export function setCastQueue(fn: Queue) { queueFn = fn; }

export interface HeroFrame { takeId: number; token: string; path: string }

export interface HeroOpts {
  width?: number;
  height?: number;
  seed?: number;
  /** A picture whose pose and framing the frame copies (Mirror's first clip frame). */
  poseImage?: string;
  /** Extra direction appended to the instruction (Speak asks for a talking-head framing). */
  framing?: string;
  projectId?: number | null;
  quality?: 'draft' | 'quality';
  /** Called with the hero take's id as soon as it is queued (before it renders). */
  onQueued?: (takeId: number) => void;
  /** Bookkeeping fields stored on the hero take (the Director tags scene frames with sceneOf). */
  extra?: Record<string, unknown>;
}

/**
 * Compose a hero frame of these cast members in the shot `shotText` (which may
 * itself @mention them), wait for it, and return it as an engine input ready to
 * be a start frame. The frame is an ordinary still take (app 'cast'), so it
 * shows in the Library and can be reused.
 */
export async function castHeroFrame(castIds: number[], shotText: string, opts: HeroOpts = {}): Promise<HeroFrame> {
  if (!queueFn) throw new Error('castHeroFrame: the take queue is not ready yet');
  const all = castDb.list();
  const named = mentioned(shotText, all).map((m) => m.id);
  const ids = [...new Set([...castIds, ...named])];
  const members = ids.map((id) => all.find((m) => m.id === id)).filter((m): m is CastMember => !!m);
  if (!members.length) throw new Error('castHeroFrame needs at least one cast member');
  for (const m of members) m.refs = await liveRefs(m);
  const picks = allocate(members, opts.poseImage ? EDIT_SLOTS - 1 : EDIT_SLOTS);
  if (!picks.length) throw new Error(`${members.map((m) => m.name).join(', ')} ${members.length > 1 ? 'have' : 'has'} no reference pictures`);
  const c = composeInstruction(shotText, picks, { newFrame: !opts.poseImage, all });
  const images = [...c.images];
  let instruction = c.instruction;
  if (opts.poseImage) {
    images.push(opts.poseImage);
    const n = images.length;
    instruction += ` Use image ${n} only for the pose, framing, camera angle and where the person stands: put ${picks[0].member.name} exactly there, in that pose, in the place described.`;
  }
  if (opts.framing) instruction += ` ${opts.framing}`;
  const [takeId] = await queueFn({
    kind: 'still', app: 'cast', castEngine: 'compose', castImages: images, castInstruction: instruction,
    cast: members.map((m) => m.id), castSource: shotText,
    prompt: instruction, userPrompt: bareText(shotText, all) || members.map((m) => m.name).join(', '),
    width: opts.width ?? 1328, height: opts.height ?? 752, quality: opts.quality ?? 'quality',
    projectId: opts.projectId ?? undefined, seed: opts.seed,
    shotName: `cast_${members.map((m) => m.name).join('_')}`.slice(0, 40),
    ...opts.extra,
  }, 1);
  opts.onQueued?.(takeId);
  const t = await waitForTake(takeId);
  const data = await readFile(t.output_path!);
  const token = await eng.uploadInput(`openfield_hero_${takeId}.png`, data, 'image/png');
  return { takeId, token, path: t.output_path! };
}

/** Poll the take table until a take finishes. The completion path writes it there. */
export async function waitForTake(id: number, timeoutMs = 20 * 60_000) {
  const t0 = Date.now();
  for (;;) {
    const t = takes.get(id);
    if (!t) throw new Error(`take ${id} disappeared`);
    if (t.status === 'done' && t.output_path) return t;
    if (t.status === 'failed' || t.status === 'stopped') throw new Error(`hero frame (take ${id}) ${t.status}: ${t.error ?? ''}`.trim());
    if (Date.now() - t0 > timeoutMs) throw new Error(`hero frame (take ${id}) timed out`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}
