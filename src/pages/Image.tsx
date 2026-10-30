/** Image create: results canvas + floating bottom composer. */
import { useEffect, useRef, useState } from 'react';
import { api, inputUrl, posterUrl, uploadFile } from '../api';
import { usePageDrop } from '../drop';
import { ASPECTS, IMAGE_MODELS, IMAGE_QUALITY, IMAGE_RES, sizeFor, type AspectId } from '../catalog';
import { navigate, setParams, useRoute } from '../router';
import { isImage, setHandoff, toast, useStore, inFeed } from '../store';
import { ChipMenu, Clip, Icon, MediaCard, Spill, Stepper, fmtSeconds, presetClip, useEstimate } from '../ui';
import Viewer, { animate, recreate, remove } from '../Viewer';
import { MentionBox } from '../Mention';
import { LoraChips, useLoraPicks } from '../Loras';

/** FLUX.2 reads up to six reference pictures, your own plus any @cast. */
const MAX_REFS = 6;

export default function ImagePage() {
  const { params } = useRoute();
  const modelId = (params.get('model') as 'qwen' | 'flux2') || 'qwen';
  const model = IMAGE_MODELS.find((m) => m.id === modelId) ?? IMAGE_MODELS[0];
  const [prompt, setPrompt] = useState(() => params.get('prompt') ?? '');
  // A link (Cast page: Still) carries its prompt once; drop it from the URL after reading.
  useEffect(() => { if (params.get('prompt')) setParams({ prompt: null }); }, []);
  const [aspect, setAspect] = useState<AspectId>('16:9');
  const [quality, setQuality] = useState<'draft' | 'quality'>('draft');
  const [res, setRes] = useState<'1K' | '2K'>('1K');
  const [count, setCount] = useState(1);
  const [busy, setBusy] = useState(false);
  const [loras, setLoras] = useLoraPicks(model.id);
  const [refs, setRefs] = useState<{ token: string; name: string }[]>([]);
  const refInput = useRef<HTMLInputElement>(null);
  const refsOn = model.id === 'flux2';

  async function addRefs(files: File[]) {
    for (const f of files.filter((x) => x.type.startsWith('image/'))) {
      try {
        const token = await uploadFile(f);
        setRefs((cur) => [...cur, { token, name: f.name }].slice(0, MAX_REFS));
      } catch (e) { toast(e instanceof Error ? e.message : 'upload failed', true); }
    }
  }

  usePageDrop(refsOn ? 'Drop images to use as references' : 'Drop an image to animate it', async (files) => {
    if (refsOn) { void addRefs(files); return; }
    const f = files.find((x) => x.type.startsWith('image/'));
    if (!f) { toast('Drop an image to animate it', true); return; }
    try {
      setHandoff({ refs: [{ token: await uploadFile(f), role: 'start', kind: 'image', name: f.name }] });
      navigate('/video');
    } catch (e) { toast(e instanceof Error ? e.message : 'upload failed', true); }
  });
  const [viewing, setViewing] = useState<number | null>(null);

  const size = sizeFor(aspect, IMAGE_RES.find((r) => r.id === res)!.mp);
  const est = useEstimate({ kind: 'still', model: model.id, quality, w: size.w, h: size.h });
  const takes = useStore((s) => s.takes.filter((t) => inFeed(t) && isImage(t)));
  const done = takes.filter((t) => t.status === 'done');

  async function go() {
    if (!prompt.trim()) return;
    setBusy(true);
    try {
      const r = await api.generate({
        kind: 'still', model: model.id, quality, prompt, userPrompt: prompt, width: size.w, height: size.h, count,
        shotName: prompt.slice(0, 40),
        ...(loras.length ? { loras } : {}),
        ...(refsOn && refs.length ? { refImages: refs.map((r) => r.token) } : {}),
      });
      toast(`Queued ${r.takeIds.length} image${r.takeIds.length > 1 ? 's' : ''}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'failed', true);
    } finally {
      setBusy(false);
    }
  }

  const step = (dir: 1 | -1) => {
    const i = done.findIndex((t) => t.id === viewing);
    const n = done[(i + dir + done.length) % done.length];
    if (n) setViewing(n.id);
  };

  return (
    <div className="image-page">
      <div className="canvas-body page-scroll">
        {takes.length === 0 ? (
          <div className="hero-empty">
            <div className="explore-glow" style={{ top: -60 }}><Spill src={presetClip('golden')} video /></div>
            <div className="fan">
              {['ink-bloom', 'golden', 'neon-rain', 'bloom'].map((id) => <div key={id}><Clip src={presetClip(id)} className="" /></div>)}
            </div>
            <div className="display" style={{ fontSize: 'clamp(24px,3.5vw,46px)' }}>Make an image with <span className="hl">{model.label}</span></div>
            <p className="dim" style={{ marginTop: 14 }}>Open weights, on your own GPU. Describe it below.</p>
          </div>
        ) : (
          <div className="grid dense" style={{ maxWidth: 1500, margin: '0 auto' }}>
            {takes.map((t) => (
              <MediaCard key={t.id} take={t} onOpen={() => setViewing(t.id)} actions={<>
                {t.status === 'done' && <button type="button" className="icon-btn" title="Animate" onClick={() => void animate(t)}><Icon name="video" size={14} /></button>}
                <button type="button" className="icon-btn" title="Recreate" onClick={() => void recreate(t)}><Icon name="redo" size={14} /></button>
                <button type="button" className="icon-btn" title="Delete" onClick={() => void remove(t)}><Icon name="trash" size={14} /></button>
              </>} />
            ))}
          </div>
        )}
      </div>

      <div className="composer-dock">
        <div className="composer">
          <div>
            {refsOn && refs.length > 0 && (
              <div className="chip-row" style={{ marginBottom: 6 }}>
                {refs.map((r, i) => (
                  <span key={r.token} className="ref-thumb" title={`Reference ${i + 1}: ${r.name}. Say "the person in image ${i + 1}" to point at it.`}>
                    <img src={inputUrl(r.token)} alt="" />
                    <small>{i + 1}</small>
                    <button type="button" onClick={() => setRefs((c) => c.filter((_, j) => j !== i))} aria-label="remove"><Icon name="x" size={11} /></button>
                  </span>
                ))}
              </div>
            )}
            <MentionBox value={prompt} onChange={setPrompt} placeholder="Describe the image you want. Type @ to bring in your cast." dir="up"
              rows={2} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!busy) void go(); } }} />
            <div className="chip-row">
              <ChipMenu icon="sparkle" value={model.id} onChange={(v) => setParams({ model: v === 'qwen' ? null : v })} title="Model"
                options={IMAGE_MODELS.map((m) => ({ value: m.id, label: m.label, note: m.warn ?? m.license }))} />
              <ChipMenu icon="aspect" value={aspect} onChange={setAspect} title="Aspect" options={ASPECTS.map((a) => ({ value: a.id, label: a.id }))} />
              <ChipMenu icon="res" value={quality} onChange={setQuality} title="Quality" options={IMAGE_QUALITY.map((q) => ({ value: q.id, label: q.label, note: q.note }))} />
              <ChipMenu icon="grid" value={res} onChange={setRes} title="Resolution" options={IMAGE_RES.map((r) => ({ value: r.id, label: r.id, note: `${r.mp} MP` }))} />
              <Stepper value={count} min={1} max={4} onChange={setCount} fmt={(v) => `${v}/4`} />
              {refsOn && (
                <>
                  <button type="button" className={`chip ${refs.length ? 'on' : ''}`} disabled={refs.length >= MAX_REFS} onClick={() => refInput.current?.click()}
                    title="Reference pictures: FLUX.2 keeps their faces, clothes and objects in a new photograph. @cast members add theirs too.">
                    <Icon name="ref" size={14} /><span>{refs.length ? `Refs ${refs.length}` : 'Refs'}</span>
                  </button>
                  <input ref={refInput} type="file" accept="image/*" multiple hidden
                    onChange={(e) => { if (e.target.files) void addRefs(Array.from(e.target.files)); e.target.value = ''; }} />
                </>
              )}
              <LoraChips family={model.id} value={loras} onChange={setLoras} />
            </div>
          </div>
          <button type="button" className="gen-tile" disabled={busy || !prompt.trim()} onClick={() => void go()}>
            <Icon name="sparkle" size={18} />
            Generate
            <small>{size.w}x{size.h}{est ? <><br />{fmtSeconds(est * count)}</> : null}</small>
          </button>
        </div>
      </div>
      {viewing !== null && <Viewer takeId={viewing} onClose={() => setViewing(null)} onStep={step} />}
      {/* warm the poster cache for the newest image so the fan stays snappy */}
      {done[0] && <link rel="prefetch" href={posterUrl(done[0].id)} />}
    </div>
  );
}
