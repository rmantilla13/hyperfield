/**
 * Render size tiers: the one source of truth for how big a video renders.
 *
 * LTX-2.5 looks far better at 720p than below it, so 720p is the default on any
 * card with 24 GB or more. Smaller cards default to 480p. Past 720p, the
 * Upscale app is the next step; 1080p is offered only where it fits.
 *
 * The machine-wide choice lives on the server (GET/PUT /api/settings), so the
 * UI, every browser and the MCP server share it. Each app keeps its own size
 * chip that overrides it for that page.
 *
 * Shared by the pages, the server (defaults for requests without a size) and
 * the MCP bodies. No imports, so anything can use it.
 */

export type RenderTier = '480p' | '720p' | '1080p';

export interface TierDef {
  id: RenderTier;
  /** Pixel budget in megapixels. */
  mp: number;
  /** The full name, as Setup shows it. */
  label: string;
  /** The second half of the label, for size chips. */
  short: string;
  /** One line on what it costs. */
  note: string;
}

export const RENDER_TIERS: readonly TierDef[] = [
  { id: '480p', mp: 0.41, label: '480p · fast', short: 'fast', note: 'Fastest. The default on cards under 24 GB.' },
  { id: '720p', mp: 0.92, label: '720p · recommended', short: 'recommended', note: 'Where LTX-2.5 looks its best. 1.3 to 2x the time of 480p; needs 24 GB.' },
  { id: '1080p', mp: 2.07, label: '1080p · slow, hero shots', short: 'slow, hero shots', note: 'Over twice the pixels of 720p and much slower. Video, loops and Director shots.' },
];

export const RENDER_TIER_IDS = RENDER_TIERS.map((t) => t.id) as ['480p', '720p', '1080p'];

export const isRenderTier = (v: unknown): v is RenderTier => typeof v === 'string' && (RENDER_TIER_IDS as string[]).includes(v);

/** A tier from free text (an env var, a request field), or undefined. */
export const parseTier = (v: unknown): RenderTier | undefined => {
  const t = typeof v === 'string' ? v.trim().toLowerCase() : v;
  return isRenderTier(t) ? t : undefined;
};

export const tierDef = (t: RenderTier): TierDef => RENDER_TIERS.find((x) => x.id === t) ?? RENDER_TIERS[1];

/**
 * A card with this much memory or more defaults to 720p. A 24 GB card reports
 * about 24 GiB through ComfyUI (25.8 decimal GB); a 20 GB card about 20 GiB.
 */
export const TIER_720_MIN_GIB = 23;

/** The default tier for a card, from ComfyUI's vram_total in decimal GB. Unknown (cloud) = 720p. */
export function gpuTier(vramTotalGb: number | undefined): RenderTier {
  if (!vramTotalGb || !Number.isFinite(vramTotalGb)) return '720p';
  return (vramTotalGb * 1e9) / 2 ** 30 >= TIER_720_MIN_GIB ? '720p' : '480p';
}

const ORDER: Record<RenderTier, number> = { '480p': 0, '720p': 1, '1080p': 2 };

/** The tier, held at or under an app's largest safe size. */
export function capTier(t: RenderTier, max: RenderTier = '1080p'): RenderTier {
  return ORDER[t] > ORDER[max] ? max : t;
}

/** The tiers an app offers, up to its largest safe size. */
export const tiersUpTo = (max: RenderTier = '1080p'): TierDef[] => RENDER_TIERS.filter((t) => ORDER[t.id] <= ORDER[max]);

/**
 * The largest size each app runs at. Measured on a 32 GB 5090 at 720p: Mirror,
 * Restyle, clip Effects, Speak and Extend all peak near 31.4 GB (so 1080p does
 * not fit) and take 1.3 to 2x their 480p time. Reshoot at 720p ran 271 s for
 * 5 s against about 100 s at 960x544, for little visible gain, so it stops at
 * 480p. Stage (Layout to Render, an IC-LoRA with a look-frame guide) carries
 * the same load as Mirror, so it stops at 720p too. Past these, use Upscale.
 */
export const APP_MAX_TIER = {
  video: '1080p',
  director: '1080p',
  scene: '720p',
  mirror: '720p',
  restyle: '720p',
  swap: '720p',
  effects: '720p',
  speak: '720p',
  extend: '720p',
  transition: '720p',
  reshoot: '480p',
  stage: '720p',
} as const satisfies Record<string, RenderTier>;
export type TierApp = keyof typeof APP_MAX_TIER;

/** Why an app stops below 1080p, for its size chip. */
export function tierCapNote(app: TierApp): string | null {
  const max = APP_MAX_TIER[app];
  if (max === '1080p') return null;
  if (app === 'reshoot') return 'Reshoot stops at 480p: 720p takes nearly 3x as long for little gain. Upscale takes it further.';
  if (app === 'stage') return 'Stage stops at 720p: Layout to Render with its look guide is the same 22B IC-LoRA load as Mirror. Upscale takes it further.';
  return `This app stops at ${max}: past it, it does not fit in 32 GB. Upscale takes it further.`;
}

/** The tier an app renders at: the chosen one, capped at what the app can hold. */
export const appTier = (app: TierApp, t: RenderTier): RenderTier => capTier(t, APP_MAX_TIER[app]);

/**
 * Pixel size at a tier for a frame shaped `ratio` (width / height), on a 32 or
 * 64 grid. Two-stage LTX renders and every IC-LoRA guide need 64; single-stage
 * continue tools (Extend, Transition, Reshoot) take 32. Of the grid points
 * around the budget, the one closest in both shape and area wins, so 16:9 at
 * 720p is 1280x704 on 64 and 1280x704 on 32, and 480p is 896x512 / 864x480.
 */
export function tierSize(t: RenderTier, ratio: number, align: 32 | 64 = 64): { w: number; h: number } {
  const r = ratio > 0 && Number.isFinite(ratio) ? ratio : 16 / 9;
  const px = tierDef(t).mp * 1e6;
  const h0 = Math.sqrt(px / r);
  const grid = (n: number) => [Math.max(256, Math.floor(n / align) * align), Math.max(256, Math.ceil(n / align) * align)];
  let best = { w: 0, h: 0 };
  let score = Infinity;
  for (const h of grid(h0)) {
    for (const w of grid(h * r)) {
      const s = Math.abs(Math.log(w / h / r)) + Math.abs(Math.log((w * h) / px));
      if (s < score - 1e-9) { score = s; best = { w, h }; }
    }
  }
  return best;
}

/** tierSize for a source of w x h (16:9 when unknown). */
export const tierSizeOf = (t: RenderTier, w: number | undefined, h: number | undefined, align: 32 | 64 = 64) =>
  tierSize(t, w && h ? w / h : 16 / 9, align);

/** Where the machine-wide tier came from: a choice in Setup, OPENFIELD_RENDER_TIER, or the GPU. */
export type TierSource = 'user' | 'env' | 'gpu';
export interface TierState { tier: RenderTier; source: TierSource; /** What it would be without a Setup choice. */ auto: RenderTier }
