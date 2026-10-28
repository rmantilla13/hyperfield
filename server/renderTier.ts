/**
 * The machine-wide render size (src/renderTier.ts): a choice made in Setup,
 * else OPENFIELD_RENDER_TIER, else what the GPU can hold (24 GB or more = 720p).
 * Requests that name no size render at it.
 */
import { config } from './config.js';
import { meta } from './jobs.js';
import * as comfy from './comfy.js';
import { gpuTier, isRenderTier, type RenderTier, type TierState } from '../src/renderTier.js';

const KEY = 'render_tier';

let gpu: { tier: RenderTier; at: number } | null = null;
/** The GPU's default, re-read at most once a minute. Engine down: the last answer, or 720p. */
async function gpuDefault(): Promise<RenderTier> {
  if (gpu && Date.now() - gpu.at < 60_000) return gpu.tier;
  const st = await comfy.getStatus().catch(() => null);
  if (st?.up && st.vramTotalGb) gpu = { tier: gpuTier(st.vramTotalGb), at: Date.now() };
  return gpu?.tier ?? '720p';
}

/** What the tier would be without a Setup choice. */
async function autoTier(): Promise<{ tier: RenderTier; source: 'env' | 'gpu' }> {
  if (config.renderTier) return { tier: config.renderTier, source: 'env' };
  return { tier: await gpuDefault(), source: 'gpu' };
}

export async function tierState(): Promise<TierState> {
  const auto = await autoTier();
  const chosen = meta.get(KEY);
  if (isRenderTier(chosen)) return { tier: chosen, source: 'user', auto: auto.tier };
  return { tier: auto.tier, source: auto.source, auto: auto.tier };
}

export const currentTier = async (): Promise<RenderTier> => (await tierState()).tier;

/** Set the Setup choice; null goes back to the default. */
export function setTier(t: RenderTier | null) {
  if (t) meta.set(KEY, t);
  else meta.delete(KEY);
}
