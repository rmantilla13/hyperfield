/**
 * Cut out post-processing. A transparent clip's deliverable is ProRes 4444
 * with alpha, which no browser plays, so the take is shown as an H.264 preview
 * of the cut out over a checkerboard, made here with ffmpeg next to the .mov.
 */
import { existsSync } from 'fs';
import { config } from './config.js';

let encoder: Promise<string[]> | null = null;

/**
 * H.264 encoder arguments for this machine's ffmpeg. Distribution builds often
 * ship without libx264 (Ubuntu's has only OpenH264), so ask once and pick.
 */
function h264(): Promise<string[]> {
  encoder ??= import('child_process').then(({ execFile }) => new Promise<string[]>((res) =>
    execFile(config.ffmpegBin, ['-hide_banner', '-encoders'], (_e, out) => {
      const has = (name: string) => new RegExp(`\\s${name}\\s`).test(String(out ?? ''));
      res(has('libx264') ? ['-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast']
        : has('libopenh264') ? ['-c:v', 'libopenh264', '-b:v', '8M']
        : ['-c:v', 'h264']);
    })));
  return encoder;
}

/** Write <name>.mp4 (or <name>_preview.mp4) beside a ProRes 4444 .mov; returns its path. */
export async function checkerPreview(mov: string): Promise<string> {
  const base = mov.replace(/\.mov$/i, '');
  const out = existsSync(`${base}.mp4`) ? `${base}_preview.mp4` : `${base}.mp4`;
  const { execFile } = await import('child_process');
  const codec = await h264();
  await new Promise<void>((res, rej) =>
    execFile(config.ffmpegBin, [
      '-v', 'error', '-y', '-i', mov,
      '-filter_complex',
      // A 16 px checkerboard drawn at the clip's own size (geq), the cut out
      // laid over it with its own alpha.
      "[0:v]format=rgba,split[fg][size];[size]format=yuv444p,geq=lum='if(mod(floor(X/16)+floor(Y/16),2),154,110)':cb=128:cr=128[bg];[bg][fg]overlay=format=auto,format=yuv420p[v]",
      '-map', '[v]', '-map', '0:a?', ...codec, '-c:a', 'aac', '-movflags', '+faststart', out,
    ], (e, _o, err) => (e ? rej(new Error(`preview failed: ${String(err || e.message).split('\n')[0]}`)) : res())),
  );
  return out;
}
