// Diagnostic: submit a Qwen draft still through the SDK, then read the raw
// v2 SSE stream and print every frame with a timestamp.
import { Comfy } from '@comfyorg/sdk';
import { buildStillsGraph } from '../server/graphs/stills.js';

const base = process.env.COMFY_BASE_URL || 'http://127.0.0.1:8189';
process.env.COMFY_BASE_URL = base;
const client = new Comfy();
const graph = buildStillsGraph({
  model: 'qwen', quality: 'draft', prompt: 'a red paper kite caught in a dead oak at dawn, fog, 50mm',
  width: 1328, height: 752, seed: 7,
});
const job = await client.submit(client.workflows.fromJson(graph));
const t0 = Date.now();
const ts = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
console.log(ts(), 'submitted', job.id);
const r = await fetch(`${base}/api/v2/jobs/${job.id}/events`);
const dec = new TextDecoder();
let buf = '';
for await (const chunk of r.body as any) {
  buf += dec.decode(chunk, { stream: true });
  let i;
  while ((i = buf.indexOf('\n\n')) >= 0) {
    const frame = buf.slice(0, i); buf = buf.slice(i + 2);
    const ev = /^event: (.*)$/m.exec(frame)?.[1] ?? '(comment)';
    const data = /^data: (.*)$/m.exec(frame)?.[1] ?? frame;
    console.log(ts(), ev, ev === 'preview' ? `${data.length}b` : data.slice(0, 160));
    if (ev === 'status' && /succeeded|failed|cancel/.test(data)) process.exit(0);
  }
}
