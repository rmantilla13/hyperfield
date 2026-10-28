/**
 * ComfyUI server introspection: health, VRAM, model enums, node classes,
 * and launching the engine. Comfy API v2 does not cover node introspection
 * yet, so these read the ComfyUI server API directly. Every job (submit,
 * progress, outputs, cancel) goes through the Comfy SDK in engine.ts.
 */
import { existsSync } from 'fs';
import { config, ROOT } from './config.js';

const COMFY = config.comfyUrl;

export interface ComfyStatus {
  up: boolean;
  version?: string;
  gpu?: string;
  vramFreeGb?: number;
  vramTotalGb?: number;
  queueRemaining?: number;
  otherGpuProcess?: boolean;
}

export async function getStatus(): Promise<ComfyStatus> {
  try {
    const r = await fetch(`${COMFY}/system_stats`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return { up: false };
    const d = (await r.json()) as any;
    const dev = d.devices?.[0] ?? {};
    const q = await fetch(`${COMFY}/prompt`, { signal: AbortSignal.timeout(4000) })
      .then((x) => x.json() as any)
      .catch(() => null);
    return {
      up: true,
      version: d.system?.comfyui_version,
      gpu: typeof dev.name === 'string' ? dev.name.replace(/^cuda:\d+\s*/, '').replace(/\s*:\s*cudaMallocAsync$/, '') : undefined,
      vramFreeGb: dev.vram_free ? dev.vram_free / 1e9 : undefined,
      vramTotalGb: dev.vram_total ? dev.vram_total / 1e9 : undefined,
      queueRemaining: q?.exec_info?.queue_remaining,
      // Heuristic from the 2026-06-29 Topaz incident: almost-no free VRAM
      // while our queue is empty means another process owns the GPU.
      otherGpuProcess:
        q?.exec_info?.queue_remaining === 0 && dev.vram_free && dev.vram_free < 3e9,
    };
  } catch {
    return { up: false };
  }
}

/**
 * Start ComfyUI using the COMFY_LAUNCH command, then wait for it to answer.
 * Idempotent: no-ops if the engine is already up. Returns false immediately
 * when no launch command is configured — OpenField never guesses how to start a
 * renderer it did not install.
 */
export async function launchEngine(timeoutMs = config.comfyLaunchTimeout): Promise<boolean> {
  if ((await getStatus()).up) return true;
  if (!config.comfyLaunch) return false;
  const { spawn } = await import('child_process');
  // cmd.exe refuses to run with a UNC working directory, which is what a WSL
  // path looks like to it — so hand the child a drive-backed cwd when we have one.
  const cwd = existsSync('/mnt/c') ? '/mnt/c' : ROOT;
  try {
    const child = spawn(config.comfyLaunch, { cwd, shell: true, detached: true, stdio: 'ignore' });
    child.on('error', (e) => console.error('[openfield] COMFY_LAUNCH failed:', e.message));
    child.unref();
  } catch (e) {
    console.error('[openfield] COMFY_LAUNCH failed:', e instanceof Error ? e.message : e);
    return false;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    if ((await getStatus()).up) return true;
  }
  return false;
}

/** True when a launch command is configured, i.e. START ENGINE can do anything. */
export function canLaunchEngine(): boolean {
  return !!config.comfyLaunch;
}

/**
 * Read a node's COMBO option list out of /object_info.
 *
 * ComfyUI has two shapes in the wild and both appear in a single install:
 * legacy `[[...options], {...}]` and the V3 schema's
 * `["COMBO", { options: [...] }]`. Reading only the first breaks silently
 * (`.filter is not a function`) the day a node is ported.
 */
export async function comboOptions(nodeClass: string, input: string): Promise<string[]> {
  try {
    const r = await fetch(`${COMFY}/object_info/${encodeURIComponent(nodeClass)}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return [];
    const spec = ((await r.json()) as any)?.[nodeClass]?.input?.required?.[input];
    if (!Array.isArray(spec)) return [];
    if (Array.isArray(spec[0])) return spec[0].filter((x: unknown) => typeof x === 'string');
    const opts = spec[1]?.options;
    return Array.isArray(opts) ? opts.filter((x: unknown) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Files in one of the engine's model folders (GET /models/<folder>), for
 * loaders whose dropdown lists files that are not on disk yet (SeedVR2 offers
 * its whole download registry). Empty when the engine is down.
 */
export async function listModelFolder(folder: string): Promise<string[]> {
  try {
    const r = await fetch(`${COMFY}/models/${encodeURIComponent(folder)}`, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return [];
    const d = (await r.json()) as unknown;
    return Array.isArray(d) ? d.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** Node class names the engine knows about — used by preflight. */
export async function listNodeClasses(): Promise<Set<string>> {
  try {
    const r = await fetch(`${COMFY}/object_info`, { signal: AbortSignal.timeout(30_000) });
    if (!r.ok) return new Set();
    return new Set(Object.keys((await r.json()) as Record<string, unknown>));
  } catch {
    return new Set();
  }
}

import { classifySpice } from './spice.js';

/** Model files the engine can currently see, grouped for the UI. */
export async function listCheckpoints(): Promise<Record<string, string[]>> {
  const [unets, ckpts, loras] = await Promise.all([
    comboOptions('UNETLoader', 'unet_name'),
    comboOptions('CheckpointLoaderSimple', 'ckpt_name'),
    comboOptions('LoraLoaderModelOnly', 'lora_name'),
  ]);
  // Spice files are mapped into every ComfyUI folder, so header-classify
  // them and only offer each file where it can actually function.
  const spice = await classifySpice();
  const spiceLoraSet = new Set(spice.loras);
  const spiceModelSet = new Set(spice.models);
  return {
    h3_fl2va: unets.filter((n) => n.includes('minimax_h3_fl2va')),
    h3_ref2va: unets.filter((n) => n.includes('minimax_h3_ref2va')),
    flux2: unets.filter((n) => n.startsWith('flux2')),
    qwen: unets.filter((n) => n.startsWith('qwen_image')),
    // LTX family: full checkpoints + spice transformers — NEVER spice loras
    ltx: [...new Set([...ckpts, ...unets])].filter(
      (n) => (/ltx/i.test(n) || /lt3x/i.test(n) || spiceModelSet.has(n)) && !spiceLoraSet.has(n)
    ),
    checkpoints_all: ckpts,
    unets_all: unets,
    // Extra-LoRA menu: engine loras minus anything that's a full model
    loras: loras.filter((n) => !spiceModelSet.has(n)),
  };
}
