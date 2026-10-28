/**
 * Output file management. Finished renders move from ComfyUI's output
 * into the active project folder as <shot>_<seed>.<ext>; upres saves as
 * <shot>_<seed>_UP.mp4, a seam fix as _LOOP, an HDR finish as _HDR. The source in ComfyUI's output directory is only
 * removed after the destination write is verified.
 */
import { mkdir, writeFile, stat } from 'fs/promises';
import { join } from 'path';

export function safeShotName(name: string): string {
  const cleaned = (name || 'shot').replace(/[^a-zA-Z0-9._ -]/g, '').trim().replace(/\s+/g, '_').slice(0, 60);
  return cleaned || 'shot';
}

export async function saveToProject(
  projectFolder: string,
  shotName: string,
  seed: number,
  data: Buffer,
  opts: { ext: string; upres?: boolean; suffix?: string }
): Promise<string> {
  const dir = join(projectFolder, 'OpenField');
  await mkdir(dir, { recursive: true });
  let base = `${safeShotName(shotName)}_${seed}${opts.upres ? '_UP' : ''}${opts.suffix ?? ''}`;
  let path = join(dir, `${base}.${opts.ext}`);
  // Never overwrite an existing take file — bump a counter instead.
  for (let i = 2; ; i++) {
    try {
      await stat(path);
      path = join(dir, `${base}_${i}.${opts.ext}`);
    } catch {
      break;
    }
  }
  await writeFile(path, data);
  const st = await stat(path);
  if (st.size !== data.length) throw new Error('write verification failed');
  return path;
}

/**
 * Pixel size of a PNG, JPEG or WebP from its header, without decoding it.
 * Null for anything else. The edit graphs need it to keep the source aspect.
 */
export function imageDims(b: Buffer): { w: number; h: number } | null {
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  if (b.length > 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    const kind = b.toString('ascii', 12, 16);
    if (kind === 'VP8X') return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
    if (kind === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
    if (kind === 'VP8L') {
      const v = b.readUInt32LE(21);
      return { w: 1 + (v & 0x3fff), h: 1 + ((v >> 14) & 0x3fff) };
    }
    return null;
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC) carry the frame size.
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
      }
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  return null;
}
