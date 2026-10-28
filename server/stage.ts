/**
 * Stage on the server: turns a blocked shot into the engine inputs the
 * Layout-to-Render graph reads.
 *
 *   ingestBlocking   the page rendered the clay and depth passes with WebGL and
 *                    sends the frames (JPEG/PNG data URLs); we check them,
 *                    encode the clips with ffmpeg and upload them as inputs.
 *   rasterBlocking   an agent sent only the scene JSON; the CPU rasterizer
 *                    (stageRaster.ts) draws the same passes here.
 *   stageLookFrame   no look frame yet: queue one (an ordinary still take, app
 *                    'stage') from the depth pass and wait for it.
 *
 * Nothing here reads a path from a request: frames arrive as data, models as
 * upload tokens.
 */
import { spawn } from 'child_process';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import * as eng from './engine.js';
import { config } from './config.js';
import { imageDims } from './files.js';
import { waitForTake } from './cast.js';
import { rasterFrame } from './stageRaster.js';
import { STAGE_FPS, depthFar, lookSize, stageFrames, stageSize, type StageScene } from '../src/stage.js';
import type { RenderTier } from '../src/renderTier.js';

/** What a blocking render becomes: engine input tokens for the clips and stills. */
export interface Blocking {
  clayVideo: string;
  depthVideo: string;
  /** Depth pass of the first frame at the look-frame size (near = white). */
  depthImage: string;
  /** Clay of the first frame at the look-frame size (the Qwen-Image-Edit fallback edits it). */
  clayImage: string;
  width: number;
  height: number;
  frames: number;
}

const MAX_FRAMES = 241;
const DATA_URL = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=\s]+)$/;

function decodeTyped(v: unknown, what: string): { buf: Buffer; ext: 'png' | 'jpg' } {
  const m = typeof v === 'string' ? DATA_URL.exec(v) : null;
  if (!m) throw new Error(`${what} must be a PNG or JPEG data URL`);
  return { buf: Buffer.from(m[2], 'base64'), ext: m[1] === 'png' ? 'png' : 'jpg' };
}
const decode = (v: unknown, what: string) => decodeTyped(v, what).buf;

/** Run ffmpeg, optionally feeding raw frames to stdin. */
function ffmpeg(args: string[], frames?: AsyncIterable<Buffer> | Iterable<Buffer>): Promise<void> {
  return new Promise((res, rej) => {
    const p = spawn(config.ffmpegBin, ['-v', 'error', '-y', ...args], { stdio: [frames ? 'pipe' : 'ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr!.on('data', (d) => { err += d; });
    p.on('error', rej);
    p.on('close', (code) => (code === 0 ? res() : rej(new Error(`ffmpeg failed: ${err.trim().split('\n').pop() ?? code}`))));
    if (frames) {
      // If ffmpeg exits early the next write fails with EPIPE; 'close' reports its stderr.
      p.stdin!.on('error', () => {});
      void (async () => {
        try {
          for await (const f of frames as AsyncIterable<Buffer>) {
            if (p.stdin!.destroyed) break;
            if (!p.stdin!.write(f)) await new Promise((r) => { p.stdin!.once('drain', r); p.stdin!.once('close', r); });
          }
        } catch (e) {
          p.kill();
          rej(e);
        }
        p.stdin!.end();
      })();
    }
  });
}

/** x264, near-lossless: the clay is a control signal, so keep its edges clean. */
const H264 = ['-c:v', 'libx264', '-preset', 'fast', '-crf', '12', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];

async function upload(dir: string, file: string, name: string, mime: string): Promise<string> {
  return eng.uploadInput(`openfield_stage_${Date.now()}_${name}`, await readFile(join(dir, file)), mime);
}

export function checkSize(width: number, height: number) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width % 64 || height % 64) throw new Error(`The clay must be a multiple of 64 on both sides (got ${width}x${height})`);
  if (width < 256 || height < 256 || width > 1920 || height > 1920) throw new Error(`The clay must be 256 to 1920 pixels a side (got ${width}x${height})`);
}

/**
 * The page's WebGL blocking: clay and depth frames (equal counts, 8k+1, the
 * clay size), plus the first frame's depth and clay at the look-frame size.
 */
export async function ingestBlocking(b: any): Promise<Blocking> {
  const width = Number(b?.width), height = Number(b?.height);
  checkSize(width, height);
  const clay: unknown[] = Array.isArray(b?.clay) ? b.clay : [];
  const depth: unknown[] = Array.isArray(b?.depth) ? b.depth : [];
  const n = clay.length;
  if (n < 9 || n > MAX_FRAMES || n % 8 !== 1) throw new Error(`The blocking needs 8k+1 frames, 9 to ${MAX_FRAMES} (got ${n})`);
  if (depth.length !== n) throw new Error('The depth pass must have one frame per clay frame');
  const dir = await mkdtemp(join(tmpdir(), 'openfield-stage-'));
  try {
    /** Write one pass's frames; returns their extension (one type per pass). */
    const write = async (list: unknown[], prefix: string) => {
      let type: string | undefined;
      for (let i = 0; i < list.length; i++) {
        const { buf, ext } = decodeTyped(list[i], `${prefix} frame ${i + 1}`);
        if ((type ??= ext) !== ext) throw new Error(`The ${prefix} frames mix PNG and JPEG`);
        const dims = imageDims(buf);
        if (!dims || dims.w !== width || dims.h !== height) throw new Error(`${prefix} frame ${i + 1} is not ${width}x${height}`);
        await writeFile(join(dir, `${prefix}_${String(i).padStart(4, '0')}.${ext}`), buf);
      }
      return type!;
    };
    const ext = { clay: await write(clay, 'clay'), depth: await write(depth, 'depth') };
    const stills: Record<string, Buffer> = { depth0: decode(b?.depthStill, 'The depth still'), clay0: decode(b?.clayStill, 'The clay still') };
    for (const [k, buf] of Object.entries(stills)) {
      if (!imageDims(buf)) throw new Error(`${k} is not a readable image`);
      await writeFile(join(dir, `${k}.png`), buf);
    }
    for (const prefix of ['clay', 'depth'] as const) {
      await ffmpeg(['-framerate', String(STAGE_FPS), '-f', 'image2', '-i', join(dir, `${prefix}_%04d.${ext[prefix]}`), ...H264, join(dir, `${prefix}.mp4`)]);
    }
    return {
      clayVideo: await upload(dir, 'clay.mp4', 'clay.mp4', 'video/mp4'),
      depthVideo: await upload(dir, 'depth.mp4', 'depth.mp4', 'video/mp4'),
      depthImage: await upload(dir, 'depth0.png', 'depth.png', 'image/png'),
      clayImage: await upload(dir, 'clay0.png', 'clay.png', 'image/png'),
      width, height, frames: n,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Draw a scene's blocking on the CPU (for agents) and upload it like the page's. */
export async function rasterBlocking(s: StageScene, tier: RenderTier): Promise<Blocking> {
  const { w, h } = stageSize(s.aspect, tier);
  const look = lookSize(s.aspect);
  const n = stageFrames(s.seconds);
  const far = depthFar(s);
  const dir = await mkdtemp(join(tmpdir(), 'openfield-stage-'));
  try {
    const t = (i: number) => (n > 1 ? i / (n - 1) : 0);
    // Draw each frame once and keep its depth for the second encode.
    const depthFrames: Buffer[] = [];
    function* clayFrames() {
      for (let i = 0; i < n; i++) {
        const f = rasterFrame(s, t(i), w, h, far);
        depthFrames.push(f.depth);
        yield f.clay;
      }
    }
    const raw = (fw: number, fh: number) => ['-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${fw}x${fh}`, '-framerate', String(STAGE_FPS), '-i', '-'];
    await ffmpeg([...raw(w, h), ...H264, join(dir, 'clay.mp4')], clayFrames());
    await ffmpeg([...raw(w, h), ...H264, join(dir, 'depth.mp4')], depthFrames);
    const first = rasterFrame(s, 0, look.w, look.h, far);
    await ffmpeg([...raw(look.w, look.h), '-frames:v', '1', join(dir, 'depth0.png')], [first.depth]);
    await ffmpeg([...raw(look.w, look.h), '-frames:v', '1', join(dir, 'clay0.png')], [first.clay]);
    return {
      clayVideo: await upload(dir, 'clay.mp4', 'clay.mp4', 'video/mp4'),
      depthVideo: await upload(dir, 'depth.mp4', 'depth.mp4', 'video/mp4'),
      depthImage: await upload(dir, 'depth0.png', 'depth.png', 'image/png'),
      clayImage: await upload(dir, 'clay0.png', 'clay.png', 'image/png'),
      width: w, height: h, frames: n,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------- look frame chain ----------

type Queue = (body: Record<string, unknown>, count: number) => Promise<number[]>;

/**
 * Queue a look frame for a shot that has none, wait for it, and hand it back
 * as an engine input. The frame is an ordinary still take, so it shows in the
 * feed and can be reused for the next render.
 */
export async function stageLookFrame(queue: Queue, shot: Record<string, any>, onQueued?: (takeId: number) => void): Promise<{ takeId: number; token: string }> {
  const [takeId] = await queue({
    kind: 'stage-look', app: 'stage', mode: 'look', engine: shot.lookEngine === 'edit' ? 'edit' : 'depth',
    // The shot's own words (cast mentions already resolved), so the look and the shot describe the same picture.
    prompt: shot.lookPrompt || shot.prompt, userPrompt: shot.lookPrompt || shot.userPrompt || shot.prompt,
    castSource: shot.castSource, cast: shot.cast,
    depthImage: shot.depthImage, clayImage: shot.clayImage, scene: shot.scene, resolution: shot.resolution,
    width: shot.lookWidth, height: shot.lookHeight, seed: shot.seed, projectId: shot.projectId,
    shotName: shot.shotName ? `${shot.shotName}_look`.slice(0, 40) : 'stage_look',
  }, 1);
  onQueued?.(takeId);
  const t = await waitForTake(takeId);
  const token = await eng.uploadInput(`openfield_stage_look_${takeId}.png`, await readFile(t.output_path!), 'image/png');
  return { takeId, token };
}
