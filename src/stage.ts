/**
 * Stage: a shot blocked in 3D, as plain data. The page edits it, the server
 * renders it (server/stageRaster.ts for agents), and every take keeps it in its
 * settings so "Open in Stage" can load the set again.
 *
 * No three.js here: this module is shared by the browser, the server and the
 * MCP server. Geometry lives in src/stageMesh.ts.
 *
 * Units are metres. Y is up, the ground is y = 0, the camera looks down -Z by
 * default. A prop stands on its base: `pos` is the centre of its footprint.
 */

import { APP_MAX_TIER, capTier, parseTier, tierSize, type RenderTier } from './renderTier.js';

export type Vec3 = [number, number, number];

export const PROP_TYPES = ['box', 'cylinder', 'figure', 'wall', 'sphere', 'glb'] as const;
export type PropType = (typeof PROP_TYPES)[number];

export interface StageProp {
  id: string;
  type: PropType;
  /** Footprint centre at the start of the shot; y is the height of the base. */
  pos: Vec3;
  /** Where the footprint centre is at the end of the move. Absent = it stays put. */
  to?: Vec3;
  /**
   * When the move runs, as shot-time fractions [start, end] (0..1). Absent =
   * the whole shot. Before `start` the prop is at `pos`, after `end` at `to`.
   */
  span?: [number, number];
  /** Width (x), height (y), depth (z) in metres, before rotation. */
  size: Vec3;
  /** Turn around the vertical axis, in degrees. */
  rot: number;
  /** A GLB model (an upload token) for type 'glb'. The browser loads it; the server draws its box. */
  asset?: string;
  /** Or, for type 'glb', an Object take (image to 3D) whose GLB is served at /api/media/<take>. */
  take?: number;
  /** Shown in the rail and in the prompt helper. */
  label?: string;
}

export interface CameraKey {
  pos: Vec3;
  target: Vec3;
  /**
   * When the camera passes this key, as a fraction of the shot (0..1). Either
   * every key has one (rising, 0 first, 1 last) or none does, and then the keys
   * are spread evenly along the path (see keyTimes).
   */
  t?: number;
}

export type StageAspect = '16:9' | '9:16' | '1:1';
export type CameraEase = 'smooth' | 'linear';

export interface StageScene {
  v: 1;
  props: StageProp[];
  /** Two or more keys: evenly spread, or at their own times (CameraKey.t). */
  keys: CameraKey[];
  /** The preset the keys came from (a CAMERA_MOVES id), or 'custom' once they are edited by hand. */
  move?: string;
  /** Focal length in mm on a full-frame (36 mm wide) sensor. */
  lens: number;
  seconds: number;
  aspect: StageAspect;
  ease: CameraEase;
}

export const STAGE_FPS = 24;
export const STAGE_SECONDS = [2, 3, 4, 5] as const;
export const LENS_MIN = 14;
export const LENS_MAX = 100;
export const MAX_PROPS = 32;
export const MAX_KEYS = 12;
/** Room the server will rasterize; anything beyond is clamped. */
const WORLD = 200;

/** Older takes and agents name the size draft or final; they map onto the render tiers. */
export type StageQuality = 'draft' | 'final';
const LEGACY_TIER: Record<StageQuality, RenderTier> = { draft: '480p', final: '720p' };

/** A Stage size from a request: a tier, or the older draft/final names. Undefined when it is neither. */
export function stageTier(v: unknown): RenderTier | undefined {
  const t = parseTier(v) ?? (v === 'draft' || v === 'final' ? LEGACY_TIER[v] : undefined);
  return t ? capTier(t, APP_MAX_TIER.stage) : undefined;
}

/**
 * 480p keeps Stage's measured fast size (the old Draft). The Layout-to-Render
 * graph runs stage 1 at half size, so every side stays 64-aligned.
 */
const STAGE_480: Record<StageAspect, { w: number; h: number }> = {
  '16:9': { w: 768, h: 448 },
  '9:16': { w: 448, h: 768 },
  '1:1': { w: 576, h: 576 },
};
const ASPECT_RATIO: Record<StageAspect, number> = { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1 };

/**
 * The clay (and output) size for an aspect at a render tier, held at Stage's
 * cap (720p): 480p is the fast size above, 720p is tierSize on a 64 grid
 * (1280x704, 704x1280, 960x960).
 */
export function stageSize(aspect: StageAspect, tier: RenderTier): { w: number; h: number } {
  const t = capTier(tier, APP_MAX_TIER.stage);
  return t === '480p' ? STAGE_480[aspect] : tierSize(t, ASPECT_RATIO[aspect], 64);
}

/**
 * The look frame: near 1 MP (1344 on the long side, 16-aligned) at the shape
 * of Stage's largest clay. It does not change with the tier, so one look
 * frame serves every size; the shot graph centre-crops it onto the clay.
 */
export function lookSize(aspect: StageAspect): { w: number; h: number } {
  const c = stageSize(aspect, APP_MAX_TIER.stage);
  const k = 1344 / Math.max(c.w, c.h);
  const snap = (n: number) => Math.round(n / 16) * 16;
  return { w: snap(c.w * k), h: snap(c.h * k) };
}

/** LTX frame counts are 8k+1. */
export function stageFrames(seconds: number): number {
  const target = Math.round(seconds * STAGE_FPS);
  return Math.max(9, Math.round((target - 1) / 8) * 8 + 1);
}

// ---------- defaults ----------

let n = 0;
export const newPropId = () => `p${Date.now().toString(36)}${(n++).toString(36)}`;

export const PROP_DEFAULTS: Record<Exclude<PropType, 'glb'>, { size: Vec3; label: string }> = {
  box: { size: [1.2, 1, 1.2], label: 'Box' },
  cylinder: { size: [0.8, 2.4, 0.8], label: 'Pillar' },
  figure: { size: [0.5, 1.8, 0.3], label: 'Figure' },
  wall: { size: [8, 3, 0.25], label: 'Wall' },
  sphere: { size: [1, 1, 1], label: 'Sphere' },
};

/**
 * Default footprint of a model from the 3D library. Object GLBs come out
 * unit-cube centred, Y up, front +Z (toward the default camera), so a cube a
 * little over a metre reads as a piece of furniture; the view fits the model
 * inside it, keeping proportions, standing on its base.
 */
export const MODEL_PROP_SIZE: Vec3 = [1.2, 1.2, 1.2];

/** A prop for an Object take (image to 3D), placed at `at`. */
export function modelProp(take: number, label: string, at: Vec3 = [0, 0, 0]): StageProp {
  return { id: newPropId(), type: 'glb', pos: at, size: [...MODEL_PROP_SIZE], rot: 0, take, label: label.slice(0, 40) || `model ${take}` };
}

export function newProp(type: Exclude<PropType, 'glb'>, at: Vec3 = [0, 0, 0]): StageProp {
  const d = PROP_DEFAULTS[type];
  return { id: newPropId(), type, pos: at, size: [...d.size], rot: 0, label: d.label };
}

/** A small set: a figure between a crate and a pillar, a wall behind, the camera pushing in. */
export function defaultScene(): StageScene {
  return {
    v: 1,
    props: [
      { id: 'fig', type: 'figure', pos: [0, 0, 0], size: [0.5, 1.8, 0.3], rot: 0, label: 'Figure' },
      { id: 'crate', type: 'box', pos: [-1.9, 0, 0.6], size: [1.4, 1, 1.1], rot: 18, label: 'Crate' },
      { id: 'pillar', type: 'cylinder', pos: [2, 0, -0.8], size: [0.7, 3.2, 0.7], rot: 0, label: 'Pillar' },
      { id: 'wall', type: 'wall', pos: [0, 0, -3.2], size: [10, 3.6, 0.3], rot: 0, label: 'Wall' },
    ],
    keys: pushIn({ pos: [0, 1.55, 7.5], target: [0, 1.1, 0] }),
    move: 'push-in',
    lens: 35,
    seconds: 2,
    aspect: '16:9',
    ease: 'smooth',
  };
}

// ---------- camera moves ----------

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => add(a, mul(sub(b, a), t));
const round3 = (a: Vec3): Vec3 => a.map((x) => Math.round(x * 1000) / 1000) as Vec3;

export function pushIn(k: CameraKey, amount = 0.5): CameraKey[] {
  return [k, { pos: round3(lerp3(k.pos, k.target, amount)), target: k.target }];
}
export function pullBack(k: CameraKey, amount = 0.6): CameraKey[] {
  return [k, { pos: round3(add(k.pos, mul(sub(k.pos, k.target), amount))), target: k.target }];
}
/** Swing around the target, `deg` degrees (+ = to the right), through a few keys so the path is an arc. */
export function orbit(k: CameraKey, deg = 40): CameraKey[] {
  const off = sub(k.pos, k.target);
  const out: CameraKey[] = [];
  for (let i = 0; i <= 4; i++) {
    const a = (deg * Math.PI / 180) * (i / 4);
    const c = Math.cos(a), s = Math.sin(a);
    out.push({ pos: round3(add(k.target, [off[0] * c + off[2] * s, off[1], -off[0] * s + off[2] * c])), target: k.target });
  }
  return out;
}
/** Rise straight up, still looking at the subject, tilting down as it climbs. */
export function crane(k: CameraKey, rise = 2.6): CameraKey[] {
  return [k, { pos: round3(add(k.pos, [0, rise, 0])), target: round3(add(k.target, [0, -0.3, 0])) }];
}
/** Slide sideways, camera and aim together. `side` -1 = left, 1 = right. */
export function dolly(k: CameraKey, side: -1 | 1, dist = 2.2): CameraKey[] {
  const f = sub(k.target, k.pos);
  const r = len([f[0], 0, f[2]]) || 1;
  const right: Vec3 = [-f[2] / r, 0, f[0] / r];
  const d = mul(right, side * dist);
  return [k, { pos: round3(add(k.pos, d)), target: round3(add(k.target, d)) }];
}

export const CAMERA_MOVES = [
  { id: 'push-in', name: 'Push in', make: (k: CameraKey) => pushIn(k) },
  { id: 'pull-back', name: 'Pull back', make: (k: CameraKey) => pullBack(k) },
  { id: 'orbit-left', name: 'Orbit left', make: (k: CameraKey) => orbit(k, -40) },
  { id: 'orbit-right', name: 'Orbit right', make: (k: CameraKey) => orbit(k, 40) },
  { id: 'crane-up', name: 'Crane up', make: (k: CameraKey) => crane(k) },
  { id: 'dolly-left', name: 'Dolly left', make: (k: CameraKey) => dolly(k, -1) },
  { id: 'dolly-right', name: 'Dolly right', make: (k: CameraKey) => dolly(k, 1) },
  { id: 'static', name: 'Locked off', make: (k: CameraKey) => [k, { pos: k.pos, target: k.target }] },
] as const;
export type CameraMoveId = (typeof CAMERA_MOVES)[number]['id'];
export const cameraMove = (id: string) => CAMERA_MOVES.find((m) => m.id === id);

/** Ease in and out, so a move starts and lands like a dolly grip would. */
const smooth = (t: number) => t * t * (3 - 2 * t);
/** The inverse of smooth on 0..1. */
const unsmooth = (u: number) => 0.5 - Math.sin(Math.asin(Math.max(-1, Math.min(1, 1 - 2 * u))) / 3);
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** Uniform Catmull-Rom through p1..p2, with p0 / p3 as neighbours. */
function catmull(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, t: number): Vec3 {
  const t2 = t * t, t3 = t2 * t;
  return [0, 1, 2].map((i) =>
    0.5 * (2 * p1[i] + (-p0[i] + p2[i]) * t + (2 * p0[i] - 5 * p1[i] + 4 * p2[i] - p3[i]) * t2 + (-p0[i] + 3 * p1[i] - 3 * p2[i] + p3[i]) * t3),
  ) as Vec3;
}

/** A point on the path through `points`; x runs 0..points.length - 1 (key i at x = i). */
function along(points: Vec3[], x: number): Vec3 {
  if (points.length === 1) return points[0];
  if (points.length === 2) return lerp3(points[0], points[1], clamp01(x));
  const segs = points.length - 1;
  x = Math.min(segs - 1e-9, Math.max(0, x));
  const i = Math.floor(x);
  const p = (k: number) => points[Math.max(0, Math.min(points.length - 1, k))];
  return catmull(p(i - 1), p(i), p(i + 1), p(i + 2), x - i);
}

const easeOf = (s: Pick<StageScene, 'ease'>) => (s.ease === 'linear' ? (t: number) => clamp01(t) : (t: number) => smooth(clamp01(t)));

/**
 * When the camera passes each key, as shot-time fractions (0 first, 1 last).
 * Keys without times sit evenly along the path, so with an eased move the
 * middle ones pass at eased times.
 */
export function keyTimes(s: Pick<StageScene, 'keys' | 'ease'>): number[] {
  const n = s.keys.length;
  if (s.keys.every((k) => typeof k.t === 'number')) return s.keys.map((k) => k.t!);
  return s.keys.map((_, i) => {
    const u = n > 1 ? i / (n - 1) : 0;
    return i === 0 ? 0 : i === n - 1 ? 1 : s.ease === 'linear' ? u : unsmooth(u);
  });
}

/** Camera at shot time t (0..1). The ease runs over the whole shot; each key is passed at its time. */
export function cameraAt(s: Pick<StageScene, 'keys' | 'ease'>, t: number): CameraKey {
  const ease = easeOf(s);
  const u = ease(t);
  const n = s.keys.length;
  let x = 0;
  if (n > 1) {
    const at = s.keys.every((k) => typeof k.t === 'number') ? s.keys.map((k) => ease(k.t!)) : s.keys.map((_, i) => i / (n - 1));
    let i = 0;
    while (i < n - 2 && u > at[i + 1]) i++;
    x = i + clamp01((u - at[i]) / Math.max(1e-9, at[i + 1] - at[i]));
  }
  return { pos: along(s.keys.map((k) => k.pos), x), target: along(s.keys.map((k) => k.target), x) };
}

/** Shot-time fraction t snapped to the nearest of `frames` frames. */
export const snapToFrame = (t: number, frames: number) => (frames > 1 ? Math.round(clamp01(t) * (frames - 1)) / (frames - 1) : 0);

/** The keys with their times written out (so one can be added or moved). */
export function timedKeys(s: Pick<StageScene, 'keys' | 'ease'>): CameraKey[] {
  const ts = keyTimes(s);
  return s.keys.map((k, i) => ({ pos: k.pos, target: k.target, t: Math.round(ts[i] * 1e4) / 1e4 }));
}

/** Insert a camera key at shot time t (a new key between the two around it). Returns the keys and the new key's index. */
export function insertKey(s: Pick<StageScene, 'keys' | 'ease'>, t: number, key: CameraKey, minGap = 0): { keys: CameraKey[]; index: number } | null {
  const keys = timedKeys(s);
  if (keys.length >= MAX_KEYS) return null;
  const i = keys.findIndex((k) => k.t! >= t);
  // Not on top of an existing key, and never before the start or after the end.
  if (i <= 0 || keys[i].t! - t < Math.max(1e-4, minGap) || t - keys[i - 1].t! < Math.max(1e-4, minGap)) return null;
  keys.splice(i, 0, { pos: key.pos, target: key.target, t: Math.round(t * 1e4) / 1e4 });
  return { keys, index: i };
}

/** Move key i to shot time t, kept between its neighbours (at least `minGap` apart). The first and last keys stay at 0 and 1. */
export function retimeKey(s: Pick<StageScene, 'keys' | 'ease'>, i: number, t: number, minGap = 0.01): CameraKey[] {
  const keys = timedKeys(s);
  if (i <= 0 || i >= keys.length - 1) return keys;
  const lo = keys[i - 1].t! + minGap, hi = keys[i + 1].t! - minGap;
  if (lo > hi) return keys;
  keys[i] = { ...keys[i], t: Math.round(Math.max(lo, Math.min(hi, t)) * 1e4) / 1e4 };
  return keys;
}

/** The keys without key i (at least two stay). Times stay where they were; the ends stay at 0 and 1. */
export function dropKey(s: Pick<StageScene, 'keys' | 'ease'>, i: number): CameraKey[] {
  if (s.keys.length <= 2) return s.keys;
  const keys = timedKeys(s).filter((_, j) => j !== i);
  keys[0] = { ...keys[0], t: 0 };
  keys[keys.length - 1] = { ...keys[keys.length - 1], t: 1 };
  return keys;
}

/** When a prop's move starts and ends, as shot-time fractions. */
export const propSpan = (p: StageProp): [number, number] => p.span ?? [0, 1];

/** Where a prop's footprint is at shot time t. A moving prop goes at an even pace through its span. */
export function propAt(p: StageProp, t: number): Vec3 {
  if (!p.to) return p.pos;
  const [a, b] = propSpan(p);
  return lerp3(p.pos, p.to, clamp01((t - a) / Math.max(1e-6, b - a)));
}

/** Vertical field of view in degrees: the long edge of the frame is 36 mm. */
export function verticalFov(lens: number, w: number, h: number): number {
  const half = 18 / Math.max(1, lens);
  const vHalf = w >= h ? half * (h / w) : half;
  return (2 * Math.atan(vHalf) * 180) / Math.PI;
}

// ---------- clay and depth ----------

/**
 * The clay look, shared by the browser shader and the server rasterizer so a
 * shot blocked in either renders the same. Colours are display values.
 */
export const CLAY = {
  background: [0.11, 0.11, 0.115] as Vec3,
  albedo: 0.64,
  ground: 0.44,
  /** Ground checker: 2 m tiles, this much brighter / darker. */
  checker: 0.045,
  tile: 2,
  ambient: 0.34,
  key: { dir: [0.75, 0.7, 0.45] as Vec3, strength: 0.66 },
  fill: { dir: [-0.7, 0.3, 0.3] as Vec3, strength: 0.14 },
};

const unit = (v: Vec3): Vec3 => mul(v, 1 / (len(v) || 1));
export const KEY_DIR = unit(CLAY.key.dir);
export const FILL_DIR = unit(CLAY.fill.dir);

/**
 * The clay grey at a surface point with unit normal n (facing the camera).
 * The ground gets a soft 2 m checker so a camera move reads against it. The
 * browser shader in src/stageView.ts is this same formula in GLSL.
 */
export function clayGrey(nx: number, ny: number, nz: number, wx: number, wz: number, ground: boolean): number {
  let albedo = CLAY.albedo;
  if (ground) {
    const odd = (Math.floor(wx / CLAY.tile) + Math.floor(wz / CLAY.tile)) & 1;
    albedo = CLAY.ground + (odd ? CLAY.checker : -CLAY.checker);
  }
  const k = Math.max(0, nx * KEY_DIR[0] + ny * KEY_DIR[1] + nz * KEY_DIR[2]);
  const f = Math.max(0, nx * FILL_DIR[0] + ny * FILL_DIR[1] + nz * FILL_DIR[2]);
  return Math.min(1, albedo * (CLAY.ambient + CLAY.key.strength * k + CLAY.fill.strength * f) * 1.25);
}

/** Depth pass range: white at NEAR metres, black at `far` and beyond. */
export const DEPTH_NEAR = 0.3;

/** A far plane that spends the depth range on the set, not on empty ground. */
export function depthFar(s: StageScene): number {
  let far = 8;
  for (const t of [0, 0.5, 1]) {
    const cam = cameraAt(s, t).pos;
    for (const p of s.props) {
      const at = propAt(p, t);
      const r = Math.hypot(p.size[0], p.size[2]) / 2;
      far = Math.max(far, len(sub(at, cam)) + r);
    }
  }
  return Math.min(80, far * 1.35);
}

/** Linear depth to a grey value in 0..1. */
export const depthValue = (viewZ: number, far: number) => Math.max(0, Math.min(1, 1 - (viewZ - DEPTH_NEAR) / (far - DEPTH_NEAR)));

// ---------- validation ----------

const ASSET_TOKEN = /^asset:[0-9a-f-]{36}$/i;
const num = (v: unknown, lo: number, hi: number, d: number) => {
  const x = Number(v);
  return Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : d;
};
const vec = (v: unknown, lo: number, hi: number, d: Vec3): Vec3 =>
  Array.isArray(v) && v.length === 3 ? [num(v[0], lo, hi, d[0]), num(v[1], lo, hi, d[1]), num(v[2], lo, hi, d[2])] : d;

/**
 * A scene from anywhere (the page, an agent, an old take), made safe to render:
 * known prop types, finite numbers inside the set, at most MAX_PROPS props and
 * MAX_KEYS camera keys. Throws on what cannot be fixed.
 */
export function cleanStageScene(raw: unknown): StageScene {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const props: StageProp[] = (Array.isArray(r.props) ? r.props : []).slice(0, MAX_PROPS).map((p: any, i: number) => {
    const type = (PROP_TYPES as readonly string[]).includes(p?.type) ? (p.type as PropType) : 'box';
    const out: StageProp = {
      id: typeof p?.id === 'string' && /^[\w-]{1,24}$/.test(p.id) ? p.id : `p${i}`,
      type,
      pos: vec(p?.pos, -WORLD, WORLD, [0, 0, 0]),
      size: vec(p?.size, 0.02, 60, type === 'glb' ? [1, 1, 1] : PROP_DEFAULTS[type as Exclude<PropType, 'glb'>].size),
      rot: num(p?.rot, -360, 360, 0),
    };
    if (p?.to !== undefined && p?.to !== null) {
      out.to = vec(p.to, -WORLD, WORLD, out.pos);
      if (Array.isArray(p?.span) && p.span.length === 2) {
        const a = num(p.span[0], 0, 1, 0), b = num(p.span[1], 0, 1, 1);
        if (b - a >= 0.01 && (a > 0 || b < 1)) out.span = [a, b];
      }
    }
    if (typeof p?.label === 'string' && p.label.trim()) out.label = p.label.trim().slice(0, 40);
    if (type === 'glb') {
      if (typeof p?.asset === 'string' && ASSET_TOKEN.test(p.asset)) out.asset = p.asset;
      else if (Number.isInteger(p?.take) && p.take > 0) out.take = p.take;
      else throw new Error('A model prop needs its uploaded file (an asset token from /api/upload) or a 3D take id');
    }
    return out;
  });
  const rawKeys: any[] = (Array.isArray(r.keys) ? r.keys : []).slice(0, MAX_KEYS);
  const keys: CameraKey[] = rawKeys.map((k: any) => ({
    pos: vec(k?.pos, -WORLD, WORLD, [0, 1.6, 6]),
    target: vec(k?.target, -WORLD, WORLD, [0, 1, 0]),
  }));
  if (keys.length < 2) throw new Error('The camera needs a start and an end key');
  for (const k of keys) if (len(sub(k.pos, k.target)) < 0.05) throw new Error('A camera key looks at its own position; move the camera or the aim point apart');
  // Key times: all or none. Given, they rise from 0 at the start key to 1 at the end key.
  if (rawKeys.some((k) => k?.t !== undefined && k?.t !== null)) {
    const ts = rawKeys.map((k) => Number(k?.t));
    if (ts.some((t) => !Number.isFinite(t))) throw new Error('Give every camera key a time, or none');
    if (Math.abs(ts[0]) > 1e-6 || Math.abs(ts[ts.length - 1] - 1) > 1e-6) throw new Error('Camera key times run from 0 (the first key) to 1 (the last key)');
    for (let i = 1; i < ts.length; i++) if (!(ts[i] > ts[i - 1])) throw new Error('Camera key times must rise from key to key');
    keys.forEach((k, i) => { k.t = i === 0 ? 0 : i === keys.length - 1 ? 1 : ts[i]; });
  }
  const aspect: StageAspect = r.aspect === '9:16' || r.aspect === '1:1' ? r.aspect : '16:9';
  const move = typeof r.move === 'string' && (r.move === 'custom' || CAMERA_MOVES.some((m) => m.id === r.move)) ? r.move : undefined;
  return {
    v: 1, props, keys, ...(move ? { move } : {}),
    lens: num(r.lens, LENS_MIN, LENS_MAX, 35),
    seconds: num(r.seconds, 1, 8, 2),
    aspect,
    ease: r.ease === 'linear' ? 'linear' : 'smooth',
  };
}

/** A short plain-words description of the set, used as a prompt starter. */
export function describeScene(s: StageScene): string {
  const names = s.props.filter((p) => p.type !== 'wall').map((p) => (p.label ?? p.type).toLowerCase());
  return names.length ? `A set with ${names.join(', ')}` : 'An empty set';
}

/** Stable hash of a scene, to know when a blocking render or look frame is out of date. */
export function sceneKey(s: StageScene, extra = ''): string {
  const str = JSON.stringify(s) + extra;
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}
