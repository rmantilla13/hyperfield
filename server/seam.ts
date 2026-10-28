/**
 * Seam Doctor: measure how a loop closes, and plan the cheapest fix.
 *
 * Two distances, both on 8-bit luma decoded by ffmpeg:
 *
 *   composition  SEAM's own score (ported from MIST/Projects/seam core/src,
 *                analyze.ts + tiles.ts + thresholds.ts): max difference of
 *                8x8 tile means at 256 px wide. Catches a loop whose framing,
 *                light or subject does not come back.
 *   texture      mean absolute difference per pixel at 416 px wide. Tile
 *                means average fine detail away, so a wrap whose clouds,
 *                water or grain jump reads as seamless to the composition
 *                score and still shimmers on screen. This catches it.
 *
 * Each distance at the wrap (last frame -> first frame) is divided by the
 * clip's ordinary motion right around the loop point (SEAM's local baseline),
 * so a ratio of 1 means the wrap moves like any other frame step. A take is
 * seamless when both ratios are low, or the wrap is too small to see.
 *
 * Fixes are planned here and rendered as ComfyUI graphs (graphs/seam.ts):
 * trim to the best-closing window, regenerate the wrap as an LTX first/last
 * bridge, or re-render with a new seed. Never a crossfade.
 */
import { execFile } from 'child_process';
import { config } from './config.js';

// ---------- thresholds ----------

export const SEAM_T = {
  /** SEAM: a wrap smaller than this (tile levels) is invisible. */
  wrapInvisible: 3.0,
  /** SEAM: wrap / local motion at or below this is seamless (composition). */
  seamless: 1.5,
  /** SEAM: floor for the local baseline. */
  localFloor: 0.05,
  /**
   * Texture: wrap / local texture step at or below this is seamless. LTX's own
   * frame steps spread to about 2x their median inside a clip, so a wrap within
   * 2x is indistinguishable from an ordinary frame.
   */
  textureSeamless: 2.0,
  /** Texture: a wrap under this many levels per pixel is invisible however still the clip is. */
  textureInvisible: 0.35,
  /** Texture: floor for the local texture baseline (h264 noise on a static frame). */
  textureFloor: 0.08,
  /** Shortest clip we judge, frames. */
  minFrames: 8,
} as const;

const TILES = 8;
const TILE_WIDTH = 256;
const TEXTURE_WIDTH = 416;

// ---------- decoding ----------

export interface Frames { w: number; h: number; n: number; fps: number; data: Uint8Array[] }

function run(bin: string, args: string[], maxBuffer = 1 << 30): Promise<Buffer> {
  return new Promise((res, rej) =>
    execFile(bin, args, { encoding: 'buffer', maxBuffer }, (e, out) => (e ? rej(new Error(`${bin.split('/').pop()}: ${String(e.message).split('\n')[0]}`)) : res(out))));
}

const ffprobeBin = () => config.ffprobeBin;

export async function videoInfo(path: string): Promise<{ w: number; h: number; fps: number; frames: number; audio: boolean }> {
  const out = await run(ffprobeBin(), ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_type,width,height,r_frame_rate,nb_read_frames', '-of', 'json', path]);
  const d = JSON.parse(out.toString());
  const v = (d.streams ?? []).find((s: any) => s.codec_type === 'video');
  if (!v) throw new Error('the file has no picture');
  const [a, b] = String(v.r_frame_rate ?? '24/1').split('/').map(Number);
  return {
    w: v.width, h: v.height, fps: a && b ? a / b : 24, frames: Number(v.nb_read_frames) || 0,
    audio: (d.streams ?? []).some((s: any) => s.codec_type === 'audio'),
  };
}

/** Every frame as 8-bit luma at `width` px wide (height keeps the aspect, even). */
export async function decodeGray(path: string, width: number, info?: { w: number; h: number; fps: number }): Promise<Frames> {
  const i = info ?? (await videoInfo(path));
  const h = Math.max(2, 2 * Math.round((width * i.h) / i.w / 2));
  const raw = await run(config.ffmpegBin, ['-v', 'error', '-i', path, '-vf', `scale=${width}:${h}:flags=area`, '-fps_mode', 'passthrough', '-an', '-f', 'rawvideo', '-pix_fmt', 'gray', '-']);
  const size = width * h;
  const n = Math.floor(raw.length / size);
  const data: Uint8Array[] = [];
  for (let k = 0; k < n; k++) data.push(new Uint8Array(raw.buffer, raw.byteOffset + k * size, size));
  return { w: width, h, n, fps: i.fps, data };
}

// ---------- distances ----------

/** SEAM tiles.ts: TILES x TILES tile means, leftover rows and columns ignored. */
export function tileVector(gray: Uint8Array, w: number, h: number): Float32Array {
  const th = Math.floor(h / TILES), tw = Math.floor(w / TILES);
  const out = new Float32Array(TILES * TILES);
  const area = th * tw;
  for (let ty = 0; ty < TILES; ty++) {
    for (let tx = 0; tx < TILES; tx++) {
      let sum = 0;
      for (let y = ty * th; y < (ty + 1) * th; y++) {
        const row = y * w;
        for (let x = tx * tw; x < (tx + 1) * tw; x++) sum += gray[row + x];
      }
      out[ty * TILES + tx] = sum / area;
    }
  }
  return out;
}

/** SEAM tiles.ts: max absolute difference between two tile vectors. */
export function tileDist(a: Float32Array, b: Float32Array): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > m) m = d;
  }
  return m;
}

/** Mean absolute difference per pixel. */
export function textureDist(a: Uint8Array, b: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : 0;
}

/**
 * SEAM analyze.ts localSteps: the steps compared against the wrap. Step 0 is
 * skipped because first/last-frame renders often jump right after the pinned
 * frame. Indices are into a steps array of a loop of `n` frames.
 */
const localSteps = (n: number) => [1, 2, 3, n - 4, n - 3, n - 2].filter((i) => i >= 0 && i < n - 1);

// ---------- scoring ----------

export interface SeamMeasure {
  n: number;
  fps: number;
  verdict: 'seamless' | 'visible';
  /** The worse of the two ratios: the wrap as a multiple of an ordinary frame step. */
  ratio: number;
  texture: { wrap: number; local: number; median: number; ratio: number };
  composition: { wrap: number; local: number; ratio: number };
  /** Join points a fix put inside the clip, each judged like the wrap. */
  splices?: { frame: number; ratio: number }[];
}

interface Loaded { tiles: Float32Array[]; tex: Uint8Array[]; fps: number; w: number; h: number; info: { w: number; h: number; fps: number; frames: number; audio: boolean } }

export async function load(path: string): Promise<Loaded> {
  const info = await videoInfo(path);
  const [a, b] = await Promise.all([decodeGray(path, TILE_WIDTH, info), decodeGray(path, TEXTURE_WIDTH, info)]);
  const n = Math.min(a.n, b.n);
  if (n < SEAM_T.minFrames) throw new Error(`The clip is ${n} frames; the seam check needs at least ${SEAM_T.minFrames}.`);
  return {
    tiles: a.data.slice(0, n).map((g) => tileVector(g, a.w, a.h)),
    tex: b.data.slice(0, n),
    fps: info.fps, w: info.w, h: info.h, info,
  };
}

/**
 * Score the loop made of frames [start, end) of a loaded clip, wrap included,
 * exactly as a file holding just those frames would score.
 */
export function scoreWindow(L: Loaded, start = 0, end = L.tex.length): SeamMeasure {
  const n = end - start;
  const texSteps: number[] = [];
  const tileSteps: number[] = [];
  for (let i = start; i < end - 1; i++) {
    texSteps.push(textureDist(L.tex[i], L.tex[i + 1]));
    tileSteps.push(tileDist(L.tiles[i], L.tiles[i + 1]));
  }
  const loc = localSteps(n);
  const texWrap = textureDist(L.tex[end - 1], L.tex[start]);
  const texLocal = Math.max(median(loc.map((i) => texSteps[i])), SEAM_T.textureFloor);
  const tileWrap = tileDist(L.tiles[end - 1], L.tiles[start]);
  const tileLocal = Math.max(median(loc.map((i) => tileSteps[i])), SEAM_T.localFloor);
  const texture = { wrap: texWrap, local: texLocal, median: median(texSteps.slice(1)), ratio: texWrap / texLocal };
  const composition = { wrap: tileWrap, local: tileLocal, ratio: tileWrap / tileLocal };
  const texOk = texWrap < SEAM_T.textureInvisible || texture.ratio <= SEAM_T.textureSeamless;
  const compOk = tileWrap < SEAM_T.wrapInvisible || composition.ratio <= SEAM_T.seamless;
  // Report the ratio on the texture scale (the one people see shimmer on),
  // unless the composition is what breaks.
  const ratio = compOk ? texture.ratio : Math.max(texture.ratio, composition.ratio);
  return { n, fps: L.fps, verdict: texOk && compOk ? 'seamless' : 'visible', ratio: round(ratio), texture: roundAll(texture), composition: roundAll(composition) };
}

/** The ratio of one internal step (frame-1 -> frame) against the clip's texture median. */
export function spliceRatio(L: Loaded, frame: number): number {
  const base = Math.max(median(stepsOf(L).slice(1)), SEAM_T.textureFloor);
  return round(textureDist(L.tex[frame - 1], L.tex[frame]) / base);
}

const stepsOf = (L: Loaded) => L.tex.slice(0, -1).map((f, i) => textureDist(f, L.tex[i + 1]));

const round = (x: number) => Math.round(x * 100) / 100;
function roundAll<T extends Record<string, number>>(o: T): T {
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v * 1000) / 1000])) as T;
}

/** Measure a whole file as a loop. `splices` are internal join frames to judge too. */
export async function measureLoop(path: string, splices: number[] = []): Promise<SeamMeasure> {
  const L = await load(path);
  const m = scoreWindow(L);
  if (splices.length) {
    m.splices = splices.filter((f) => f > 0 && f < L.tex.length).map((f) => ({ frame: f, ratio: spliceRatio(L, f) }));
    // A splice that jumps is as visible as a wrap that does.
    const worst = Math.max(...m.splices.map((s) => s.ratio));
    if (worst > SEAM_T.textureSeamless) m.verdict = 'visible';
    m.ratio = round(Math.max(m.ratio, worst));
  }
  return m;
}

// ---------- fix planning ----------

export interface TrimPlan { start: number; frames: number; predicted: SeamMeasure }

/**
 * The longest window [start, start + frames) that closes, judged by both
 * scores exactly as the trimmed file will be. Trims only, no blending. The
 * window keeps at least max(2 s, half the clip), as in SEAM's trim.ts.
 */
export function planTrim(L: Loaded): TrimPlan | null {
  const n = L.tex.length;
  const minLen = Math.max(SEAM_T.minFrames, Math.round(Math.max(2, n / L.fps / 2) * L.fps));
  // Texture step baseline for a quick prefilter: the wrap of a candidate must be
  // within the seamless ratio of the clip's typical step before it is scored fully.
  const base = Math.max(median(stepsOf(L).slice(1)), SEAM_T.textureFloor);
  for (let len = n - 1; len >= minLen; len--) {
    let best: TrimPlan | null = null;
    for (let s = 0; s + len <= n; s++) {
      const wrap = textureDist(L.tex[s + len - 1], L.tex[s]);
      if (wrap > SEAM_T.textureSeamless * 1.25 * base) continue;
      const m = scoreWindow(L, s, s + len);
      if (m.verdict === 'seamless' && (!best || m.ratio < best.predicted.ratio)) best = { start: s, frames: len, predicted: m };
    }
    if (best) return best;
  }
  return null;
}

export interface BridgePlan {
  /** Frames dropped from the tail, after anchorA. */
  a: number;
  /** Frames dropped from the head, before anchorB. */
  b: number;
  /** Last kept frame: the bridge starts from it. */
  anchorA: number;
  /** First kept frame: the bridge ends on it. */
  anchorB: number;
  /** New frames between the anchors; the clip keeps its length. */
  inner: number;
  /** Bridge render length including both anchors, 8k + 1. */
  bridgeFrames: number;
  /** Frame index in the output where the bridge begins (the splice after the body). */
  splice: number;
}

/**
 * Regenerate the wrap: drop about `seconds` from each end, render an LTX
 * first/last bridge from the last kept frame to the first kept frame, and put
 * its inner frames where the dropped ones were. Output order is
 * body (anchorB..anchorA) then bridge, so it loops bridge -> anchorB with the
 * bridge's own end guide. Inner = a + b, and inner + 2 must be 8k + 1.
 */
export function planBridge(n: number, fps: number, seconds = 1): BridgePlan {
  const want = Math.round(seconds * fps);
  // inner = 8k - 1, about 2 * want, and the body keeps at least a third of the clip.
  let inner = Math.max(7, Math.round((2 * want + 1) / 8) * 8 - 1);
  while (inner > 7 && n - inner < Math.ceil(n / 3)) inner -= 8;
  if (n - inner < 2) throw new Error(`A ${n}-frame clip is too short to bridge.`);
  const a = Math.floor(inner / 2);
  const b = inner - a;
  const anchorA = n - 1 - a;
  const anchorB = b;
  return { a, b, anchorA, anchorB, inner, bridgeFrames: inner + 2, splice: anchorA - anchorB + 1 };
}

export interface RegenPlan {
  /** Rotation point: the re-render runs on clip[h..n-1] + clip[0..h-1]. */
  h: number;
  /** Frozen frames at the rotated clip's start and end, on the latent grid. */
  holdStart: number;
  holdEnd: number;
  /** Output frame where the rotated clip's two frozen ends meet. */
  splices: number[];
}

/**
 * Rotation and holds for a re-render across the wrap. The loop must be 8k + 1
 * frames (every LTX loop is). The old wrap lands mid-sequence at n - h; the
 * first two and the last latent frames stay frozen.
 */
export function planRegen(n: number): RegenPlan {
  if (n % 8 !== 1) throw new Error(`A re-render across the wrap needs an 8k + 1 frame loop; this one has ${n} frames. Trim it first.`);
  if (n < 33) throw new Error(`A ${n}-frame loop is too short to re-render across its wrap.`);
  const h = Math.floor((n - 1) / 2);
  return { h, holdStart: 9, holdEnd: 8, splices: [h] };
}
