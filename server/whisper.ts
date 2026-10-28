/**
 * Local transcription of generated dialogue, via whatever whisper CLI the
 * machine has (set WHISPER_BIN). Entirely optional and best-effort: a failure,
 * or no whisper at all, never blocks a finished take.
 */
import { exec } from 'child_process';
import { promisify } from 'util';
import { readFile, rm, mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { config } from './config.js';

const execAsync = promisify(exec);

export async function transcribe(videoPath: string): Promise<string | null> {
  // Opt-in: without WHISPER_BIN set, takes simply carry no transcript.
  if (!config.whisperBin) return null;
  const dir = await mkdtemp(join(tmpdir(), 'openfield-whisper-'));
  try {
    const wav = join(dir, 'a.wav');
    await execAsync(`"${config.ffmpegBin}" -y -v quiet -i "${videoPath}" -vn -ar 16000 -ac 1 "${wav}"`);
    await execAsync(`"${config.whisperBin}" "${wav}" --model base --language en --output_format txt --output_dir "${dir}"`, {
      timeout: 180000,
    });
    const txt = (await readFile(join(dir, 'a.txt'), 'utf-8')).trim();
    return txt || null;
  } catch {
    return null;
  } finally {
    rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
