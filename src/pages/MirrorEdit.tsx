/**
 * Mirror's two edit modes, Restyle and Object swap. Both keep the source
 * clip's motion and change what is in it: Restyle redraws frame 0 in a new
 * look (Qwen-Image-Edit) and Mirror carries the motion through it; Swap tracks
 * one object (SAM 3.1), replaces it in frame 0 and redraws only that region
 * through the clip (LTX in/outpainting IC-LoRA). One click each, one take each.
 */
import { useRef, useState } from 'react';
import { api, inputUrl, uploadFile } from '../api';
import {
  RESTYLE_CONTROLS, RESTYLE_STYLES, SWAP_MAX_SECONDS, mirrorSize, restyleById, restyleInstruction, restyleLook, restylePrompt, swapPrompt,
} from '../catalog';
import { toast } from '../store';
import { Icon, Stepper, Switch, TierChip, fmtSeconds, useEstimate, useTierChoice } from '../ui';
import { DropWell } from './Mirror';

export interface MirrorClip { token: string; url: string; seconds: number; w: number; h: number; name: string }

export function RestyleControls({ clip }: { clip: MirrorClip | null }) {
  const [style, setStyle] = useState<string | null>('watercolor');
  const [text, setText] = useState('');
  const [control, setControl] = useState<'depth' | 'edges'>('depth');
  const [strength, setStrength] = useState(0.9);
  const [audio, setAudio] = useState(false);
  const [count, setCount] = useState(1);
  const [busy, setBusy] = useState<string | null>(null);
  const [res, setRes] = useTierChoice('restyle');

  const seconds = clip ? Math.max(1, Math.min(12, Math.floor(clip.seconds))) : 5;
  const size = mirrorSize(clip?.w ?? 0, clip?.h ?? 0, res);
  const est = useEstimate({ kind: 'video', app: 'restyle', w: size.w, h: size.h, seconds });
  const look = restyleLook(style, text);

  function restyleBody() {
    const name = style ? restyleById(style)?.label : undefined;
    const body = {
      kind: 'restyle', app: 'restyle', videoModel: 'mirror', control, sourceVideo: clip!.token, style: style ?? undefined, styleName: name, text,
      instruction: restyleInstruction(look), prompt: restylePrompt(look), userPrompt: text.trim() || name || 'Restyle',
      width: size.w, height: size.h, seconds, guideStrength: strength, withAudio: audio, count,
      shotName: `restyle_${name ?? text}`.slice(0, 40),
    };
    return body;
  }

  async function go() {
    if (!clip || !look) return;
    setBusy('Queuing...');
    try {
      const r = await api.generate(restyleBody());
      toast(`Queued ${r.takeIds.length} restyle${r.takeIds.length > 1 ? 's' : ''}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'failed', true);
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <div className="rail-section">
        <div className="label">Style</div>
        <div className="chip-row">
          {RESTYLE_STYLES.map((s) => (
            <button key={s.id} type="button" className={`chip ${style === s.id ? 'on' : ''}`} onClick={() => setStyle(style === s.id ? null : s.id)}>{s.label}</button>
          ))}
        </div>
      </div>

      <div className="rail-section">
        <div className="label">{style ? 'Add to the look · optional' : 'The look'}</div>
        <textarea className="prompt" rows={3} value={text} onChange={(e) => setText(e.target.value)}
          placeholder={style ? 'warm autumn colors, falling leaves' : 'a hand-painted 1930s cartoon, rubber-hose limbs, sepia film'} />
      </div>

      <div className="rail-section">
        <div className="label">Keep from the clip</div>
        <div className="seg">
          {RESTYLE_CONTROLS.map((c) => (
            <button key={c.id} type="button" className={control === c.id ? 'on' : ''} onClick={() => setControl(c.id as 'depth' | 'edges')}>{c.label}</button>
          ))}
        </div>
        <div className="dim" style={{ fontSize: 12.5 }}>{RESTYLE_CONTROLS.find((c) => c.id === control)!.note}</div>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}><span className="label">Hold to the clip</span><span className="mono dim" style={{ fontSize: 12 }}>{Math.round(strength * 100)}%</span></div>
        <input type="range" min={0.4} max={1} step={0.05} value={strength} onChange={(e) => setStrength(Number(e.target.value))} style={{ accentColor: 'var(--accent)' }} />
      </div>

      <div className="chip-row" style={{ alignItems: 'center' }}>
        <span className="chip"><Icon name="clock" size={14} />{seconds}s</span>
        <TierChip app="restyle" value={res} onChange={setRes} />
        <Stepper value={count} min={1} max={4} onChange={setCount} fmt={(v) => `${v}/4`} />
        <span className="chip" style={{ gap: 10 }}><Icon name="audio" size={14} />Sound <Switch on={audio} onChange={setAudio} label="sound" /></span>
      </div>

      <button type="button" className="generate" style={{ marginTop: 'auto' }} disabled={!!busy || !clip || !look} onClick={() => void go()}>
        <span>{busy ?? 'Restyle it'}</span>
        <span className="cost">{size.w}x{size.h}{est ? ` · ${fmtSeconds(est * count)}` : ' · Qwen-Image-Edit + LTX-2.5'}</span>
      </button>
    </>
  );
}

export function SwapControls({ clip }: { clip: MirrorClip | null }) {
  const [target, setTarget] = useState('');
  const [replacement, setReplacement] = useState('');
  const [reference, setReference] = useState<string | null>(null);
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
  const [count, setCount] = useState(1);
  const [busy, setBusy] = useState<string | null>(null);
  const frame = useRef<HTMLVideoElement>(null);
  const [res, setRes] = useTierChoice('swap');

  const seconds = clip ? Math.max(1, Math.min(SWAP_MAX_SECONDS, Math.floor(clip.seconds))) : 4;
  const size = mirrorSize(clip?.w ?? 0, clip?.h ?? 0, res);
  const est = useEstimate({ kind: 'video', app: 'swap', w: size.w, h: size.h, seconds });

  async function addReference(f: File) {
    if (!f.type.startsWith('image/')) return;
    setBusy('Uploading...');
    try { setReference(await uploadFile(f)); } catch (e) { toast(String(e), true); } finally { setBusy(null); }
  }

  function swapBody() {
    const what = replacement.trim();
    const body = {
      kind: 'swap', app: 'swap', videoModel: 'mirror', sourceVideo: clip!.token, target: target.trim(), point: point ?? undefined,
      replacement: what, reference: reference ?? undefined, prompt: swapPrompt(what || 'the object from the picture'),
      userPrompt: `Swap ${target.trim()} for ${what || 'the picture'}`, width: size.w, height: size.h, seconds, count,
      shotName: `swap_${what || target}`.slice(0, 40),
    };
    return body;
  }

  async function go() {
    if (!clip) return;
    setBusy('Queuing...');
    try {
      const r = await api.generate(swapBody());
      toast(`Queued ${r.takeIds.length} swap${r.takeIds.length > 1 ? 's' : ''}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'failed', true);
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      {clip && (
        <div className="rail-section">
          <div className="label">Click the object · optional</div>
          <div className="ref" style={{ aspectRatio: `${clip.w || 16} / ${clip.h || 9}`, cursor: 'crosshair' }}
            onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setPoint({ x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }); }}>
            <video ref={frame} src={clip.url} muted playsInline preload="auto" onLoadedData={() => { if (frame.current) frame.current.currentTime = 0; }} />
            {point && <span className="pin" style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }} />}
            <span className="role">first frame</span>
            {point && <button type="button" className="x" onClick={(e) => { e.stopPropagation(); setPoint(null); }} aria-label="clear the point"><Icon name="x" size={12} /></button>}
          </div>
          <div className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>A click picks one object when there are several. Without one, the words below find it.</div>
        </div>
      )}

      <div className="rail-section">
        <div className="label">Replace</div>
        <input className="field" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="the red car" />
        <div className="label">With</div>
        <textarea className="prompt" rows={2} value={replacement} onChange={(e) => setReplacement(e.target.value)} placeholder="a white horse at full gallop" />
        {reference ? (
          <div className="ref" style={{ aspectRatio: '1' , maxWidth: 120 }}>
            <img src={inputUrl(reference)} alt="" />
            <span className="role">looks like this</span>
            <button type="button" className="x" onClick={() => setReference(null)} aria-label="remove"><Icon name="x" size={12} /></button>
          </div>
        ) : (
          <DropWell accept="image/*" onFile={(f) => void addReference(f)} icon="ref" compact title="+ Picture of the new object · optional" sub="" />
        )}
      </div>

      <div className="chip-row" style={{ alignItems: 'center' }}>
        <span className="chip"><Icon name="clock" size={14} />{seconds}s</span>
        <TierChip app="swap" value={res} onChange={setRes} />
        <Stepper value={count} min={1} max={4} onChange={setCount} fmt={(v) => `${v}/4`} />
      </div>

      <button type="button" className="generate" style={{ marginTop: 'auto' }} disabled={!!busy || !clip || !target.trim() || (!replacement.trim() && !reference)} onClick={() => void go()}>
        <span>{busy ?? 'Swap it'}</span>
        <span className="cost">{size.w}x{size.h}{est ? ` · ${fmtSeconds(est * count)}` : ' · SAM 3.1 + LTX-2.5 inpaint'}</span>
      </button>
    </>
  );
}
