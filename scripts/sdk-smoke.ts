// Smoke test: one tiny graph through @comfyorg/sdk against the local proxy.
import { Comfy } from '@comfyorg/sdk';
import { writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

process.env.COMFY_BASE_URL ||= 'http://127.0.0.1:8189';
const client = new Comfy();
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const wf = client.workflows.fromJson({
  '1': { class_type: 'LoadImage', inputs: { image: 'x.png' } },
  '2': { class_type: 'ImageScale', inputs: { image: ['1', 0], upscale_method: 'nearest-exact', width: 64, height: 64, crop: 'disabled' } },
  '3': { class_type: 'SaveImage', inputs: { images: ['2', 0], filename_prefix: 'openfield_smoke' } },
});
wf.setInput('1', 'image', client.assets.fromBytes(new Uint8Array(png), { filename: 'smoke.png', contentType: 'image/png' }));
const job = await client.submit(wf);
console.log('job', job.id, job.status);
for await (const ev of job.events()) {
  console.log('event', ev.kind, ev.kind === 'statusChange' ? ev.status : ev.kind === 'progress' ? ev.value : '');
  if (ev.kind === 'statusChange' && ['succeeded', 'failed', 'canceled', 'cancelled'].includes(ev.status)) break;
}
await job.result();
const out = job.getOutputs('3')[0];
const bytes = await out.toBytes();
writeFileSync(join(tmpdir(), 'openfield-smoke.png'), bytes);
console.log('output', out.name, out.contentType, bytes.length, 'bytes');
