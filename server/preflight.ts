/**
 * Preflight — ask the engine what it can actually see, and answer "can this
 * render run?" before a graph is ever submitted.
 *
 * Without this, a missing weight surfaces as a ComfyUI validation stack trace
 * naming a node id, which tells a new user nothing. With it, they get the
 * filename, the folder it belongs in, and where to download it.
 */
import { comboOptions, listModelFolder, listNodeClasses } from './comfy.js';
import { BUNDLES, bundle, bundleGb, type Bundle, type ModelFile } from './models.js';

/** ComfyUI folder -> the loader node whose enum lists that folder. */
const LOADER: Partial<Record<ModelFile['dir'], [string, string]>> = {
  diffusion_models: ['UNETLoader', 'unet_name'],
  text_encoders: ['CLIPLoader', 'clip_name'],
  vae: ['VAELoader', 'vae_name'],
  loras: ['LoraLoaderModelOnly', 'lora_name'],
  checkpoints: ['CheckpointLoaderSimple', 'ckpt_name'],
  upscale_models: ['UpscaleModelLoader', 'model_name'],
  latent_upscale_models: ['LatentUpscaleModelLoader', 'model_name'],
  geometry_estimation: ['LoadMoGeModel', 'model_name'],
  clip_vision: ['CLIPVisionLoader', 'clip_name'],
  background_removal: ['LoadBackgroundRemovalModel', 'bg_removal_name'],
  embeddings: ['LTXVLoadConditioning', 'file_name'],
  model_patches: ['ModelPatchLoader', 'name'],
};
/**
 * Folders whose loader dropdown cannot be trusted, read from the engine's
 * folder listing instead. SeedVR2's loaders list every model they could
 * download, present or not, and silently fetch a missing one (up to 16 GB) on
 * first use.
 */
const FOLDER: Partial<Record<ModelFile['dir'], string>> = {
  SEEDVR2: 'seedvr2',
};

export interface BundleStatus {
  id: string;
  label: string;
  purpose: string;
  license: string;
  licenseWarning?: string;
  optional: boolean;
  gb: number;
  ready: boolean;
  missingFiles: ModelFile[];
  missingNodes: { class: string; pack: string; url: string }[];
}

let cache: { at: number; value: BundleStatus[] } | null = null;
const TTL_MS = 15_000;

async function seenByFolder(): Promise<Record<string, Set<string>>> {
  const dirs = [...Object.keys(LOADER), ...Object.keys(FOLDER)] as ModelFile['dir'][];
  const lists = await Promise.all(
    dirs.map(async (d) => {
      const folder = FOLDER[d];
      const names = folder ? await listModelFolder(folder) : await comboOptions(...LOADER[d]!);
      // Filenames only — ComfyUI lists nested files with a path prefix.
      return new Set(names.map((n) => n.split(/[\\/]/).pop()!));
    })
  );
  return Object.fromEntries(dirs.map((d, i) => [d, lists[i]]));
}

function statusFor(b: Bundle, seen: Record<string, Set<string>>, nodes: Set<string>): BundleStatus {
  const missingFiles = b.files.filter((f) => !seen[f.dir]?.has(f.file));
  // An empty node-class set means we could not reach the engine at all; do not
  // then report every custom node as missing.
  const missingNodes = nodes.size ? (b.nodes ?? []).filter((n) => !nodes.has(n.class)) : [];
  return {
    id: b.id,
    label: b.label,
    purpose: b.purpose,
    license: b.license,
    licenseWarning: b.licenseWarning,
    optional: !!b.optional,
    gb: bundleGb(b),
    ready: missingFiles.length === 0 && missingNodes.length === 0,
    missingFiles,
    missingNodes,
  };
}

/** Status of every bundle. Cached briefly — /api/generate calls this per fire. */
export async function preflight(force = false): Promise<BundleStatus[]> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.value;
  const [seen, nodes] = await Promise.all([seenByFolder(), listNodeClasses()]);
  const value = BUNDLES.map((b) => statusFor(b, seen, nodes));
  cache = { at: Date.now(), value };
  return value;
}

/** Invalidate after the engine restarts or new weights land. */
export function clearPreflightCache(): void {
  cache = null;
}

/**
 * One human-readable sentence naming everything a render is missing, or null
 * when it can proceed. This is the string the user sees instead of a stack trace.
 */
export async function blockingReason(bundleIds: string[]): Promise<string | null> {
  const all = await preflight();
  const problems: string[] = [];
  for (const id of bundleIds) {
    const st = all.find((s) => s.id === id);
    const b = bundle(id);
    if (!st || !b || st.ready) continue;
    const files = st.missingFiles.map((f) => `${f.file} (models/${f.dir}/)`);
    const packs = st.missingNodes.map((n) => `${n.pack} custom nodes`);
    problems.push(`${b.label} is missing: ${[...files, ...packs].join(', ')}`);
  }
  if (!problems.length) return null;
  return `${problems.join('; ')}. Run "npm run models" to fetch them, or see docs/MODELS.md.`;
}

/**
 * Effects need one file out of a bundle, not the whole bundle: say what is
 * missing for this effect only (its LoRA, and the bundle's node packs).
 */
export async function effectBlockingReason(bundleId: string, file: string, label: string): Promise<string | null> {
  const st = (await preflight()).find((s) => s.id === bundleId);
  if (!st) return null;
  const f = st.missingFiles.find((m) => m.file === file);
  const packs = st.missingNodes.map((n) => `${n.pack} custom nodes`);
  if (!f && !packs.length) return null;
  const what = [...(f ? [`${f.file} (models/${f.dir}/, from huggingface.co/${f.repo}${f.gated ? ', gated: accept its license first' : ''})`] : []), ...packs];
  return `The ${label} effect is missing: ${what.join(', ')}. Run "npm run models -- --only ${bundleId}" to fetch it, or see docs/MODELS.md.`;
}
