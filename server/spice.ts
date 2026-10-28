/**
 * SpiceModels classifier — reads each safetensors HEADER (cheap, no tensor
 * data) and determines what the file actually is, so the UI only offers it
 * in menus where it can work:
 *   - lora_A/lora_B/lora_up/lora_down key pairs → LoRA (Extra LoRA menu only)
 *   - anything else → full/transformer model (Checkpoint menu only)
 * Born from the 2026-08-04 incident: a 17GB transformer offered as an
 * "Extra LoRA" (5,872 unmapped keys) and a LoRA offered as a checkpoint
 * ("could not detect model type").
 */
import { readdir, open, stat } from 'fs/promises';
import { join } from 'path';
import { config } from './config.js';

interface SpiceClassification {
  loras: string[];
  models: string[];
}

const cache = new Map<string, { mtime: number; isLora: boolean }>();

async function isLoraFile(path: string): Promise<boolean> {
  const fh = await open(path, 'r');
  try {
    const lenBuf = Buffer.alloc(8);
    await fh.read(lenBuf, 0, 8, 0);
    const len = Number(lenBuf.readBigUInt64LE(0));
    if (len <= 0 || len > 200 * 1024 * 1024) return false; // corrupt/absurd header
    const headBuf = Buffer.alloc(len);
    await fh.read(headBuf, 0, len, 8);
    const header = JSON.parse(headBuf.toString());
    return Object.keys(header).some(
      (k) => /\.lora_(A|B|up|down)\.weight$/.test(k) || k.includes('.lora_up.') || k.includes('.lora_down.')
    );
  } catch {
    return false;
  } finally {
    await fh.close();
  }
}

export async function classifySpice(): Promise<SpiceClassification> {
  const out: SpiceClassification = { loras: [], models: [] };
  if (!config.spiceDir) return out; // feature not configured on this machine
  let files: string[] = [];
  try {
    files = (await readdir(config.spiceDir)).filter((f) => f.endsWith('.safetensors'));
  } catch {
    return out; // configured but absent
  }
  for (const f of files) {
    const path = join(config.spiceDir, f);
    try {
      const st = await stat(path);
      const cached = cache.get(f);
      let isLora: boolean;
      if (cached && cached.mtime === st.mtimeMs) {
        isLora = cached.isLora;
      } else {
        isLora = await isLoraFile(path);
        cache.set(f, { mtime: st.mtimeMs, isLora });
      }
      (isLora ? out.loras : out.models).push(f);
    } catch {
      /* unreadable file — offer nowhere */
    }
  }
  return out;
}
