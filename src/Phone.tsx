/**
 * "Use your phone": shows a QR code for a single-use LAN link (server/phone.ts).
 * The phone films or picks a clip and uploads it; the clip lands here over the
 * live socket and goes straight into the page's clip slot via onClip.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import qrcode from 'qrcode-generator';
import { api, type PhoneEvent, type PhoneSession } from './api';
import { onPhoneEvent, toast } from './store';
import { Icon } from './ui';

type Phase =
  | { kind: 'off' }
  | { kind: 'opening' }
  | { kind: 'open'; session: PhoneSession; step: 'waiting' | 'opened' | 'receiving'; bytes: number }
  | { kind: 'ended'; text: string }
  | { kind: 'error'; text: string };

const ENDED: Record<string, string> = {
  expired: 'The code expired. Make a new one when you are ready to film.',
  abuse: 'The link closed after too many bad requests on the network.',
  replaced: 'The code moved to another Hyperfield window.',
};

export function PhoneDrop({ onClip }: { onClip: (token: string, name: string) => void | Promise<void> }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'off' });
  const [now, setNow] = useState(Date.now());
  const sessionId = phase.kind === 'open' ? phase.session.id : null;
  const onClipRef = useRef(onClip);
  onClipRef.current = onClip;

  // Live state for our session only; other windows' sessions are ignored.
  useEffect(() => {
    if (!sessionId) return;
    return onPhoneEvent((e: PhoneEvent) => {
      if (e.id !== sessionId) return;
      if (e.state === 'opened' || e.state === 'waiting' || e.state === 'receiving') {
        setPhase((p) => (p.kind === 'open' ? { ...p, step: e.state as 'waiting' | 'opened' | 'receiving', bytes: e.bytes ?? 0 } : p));
      } else if (e.state === 'received' && e.result) {
        setPhase({ kind: 'off' });
        void onClipRef.current(e.result.token, e.result.name);
      } else if (e.state === 'closed' && e.reason !== 'received' && e.reason !== 'cancelled') {
        setPhase({ kind: 'ended', text: ENDED[e.reason ?? ''] ?? 'The phone link closed.' });
      }
    });
  }, [sessionId]);

  // Countdown, and close the LAN listener when this page goes away.
  useEffect(() => {
    if (!sessionId) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => { clearInterval(t); void api.phoneStop(sessionId).catch(() => {}); };
  }, [sessionId]);

  async function start() {
    setPhase({ kind: 'opening' });
    try {
      const session = await api.phoneStart();
      setNow(Date.now());
      setPhase({ kind: 'open', session, step: 'waiting', bytes: 0 });
    } catch (e) {
      setPhase({ kind: 'error', text: e instanceof Error ? e.message : 'Could not open the phone link' });
    }
  }

  if (phase.kind === 'off' || phase.kind === 'opening') {
    return (
      <button type="button" className="btn sm phone-btn" disabled={phase.kind === 'opening'} onClick={() => void start()}>
        <Icon name="phone" size={14} />{phase.kind === 'opening' ? 'Opening a link...' : 'Use your phone'}
      </button>
    );
  }

  if (phase.kind !== 'open') {
    return (
      <div className="phone-panel">
        <div className="dim" style={{ fontSize: 12.5 }}>{phase.text}</div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button type="button" className="btn sm accent" onClick={() => void start()}>New code</button>
          <button type="button" className="btn sm ghost" onClick={() => setPhase({ kind: 'off' })}>Close</button>
        </div>
      </div>
    );
  }

  const { session, step, bytes } = phase;
  const left = Math.max(0, session.expiresAt - now);
  const clock = `${Math.floor(left / 60000)}:${String(Math.floor(left / 1000) % 60).padStart(2, '0')}`;
  const net = session.network;
  return (
    <div className="phone-panel">
      <div className="phone-qr"><Qr text={session.url} /></div>
      <div className="phone-status">
        <span className={`dot ${step === 'waiting' ? 'busy' : 'up'}`} />
        <span>
          {step === 'waiting' && 'Scan with your phone camera'}
          {step === 'opened' && 'Phone connected. Film the move.'}
          {step === 'receiving' && `Receiving the clip${bytes ? ` · ${(bytes / 1048576).toFixed(0)} MB` : '...'}`}
        </span>
        <span className="mono dim" style={{ marginLeft: 'auto' }}>{clock}</span>
      </div>
      <div className="dim" style={{ fontSize: 12 }}>Same Wi-Fi as this computer. The code works once, for 10 minutes.</div>

      {net.warning ? (
        <div className="phone-warn">
          <div>{net.warning}</div>
          <Commands lines={net.commands} />
        </div>
      ) : net.commands.length > 0 && (
        <details className="phone-help">
          <summary>Phone can't connect?</summary>
          <div className="dim" style={{ fontSize: 12, margin: '6px 0' }}>
            Windows may be blocking the port. Allow it once from an elevated PowerShell:
          </div>
          <Commands lines={net.commands} />
        </details>
      )}

      <button type="button" className="btn sm ghost" onClick={() => setPhase({ kind: 'off' })}>Cancel</button>
    </div>
  );
}

function Commands({ lines }: { lines: string[] }) {
  return (
    <div className="phone-cmds">
      {lines.map((l) => (
        <button key={l} type="button" title="Copy" onClick={() => void navigator.clipboard?.writeText(l).then(() => toast('Copied'))}>
          <code>{l}</code>
        </button>
      ))}
    </div>
  );
}

/** QR as SVG, encoded here: the link carries a secret, so it never goes to a QR web service. */
function Qr({ text }: { text: string }) {
  const { n, d } = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    let d = '';
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.isDark(y, x)) d += `M${x} ${y}h1v1h-1z`;
    return { n, d };
  }, [text]);
  const q = 4; // quiet zone, in modules
  return (
    <svg viewBox={`${-q} ${-q} ${n + 2 * q} ${n + 2 * q}`} shapeRendering="crispEdges" role="img" aria-label="QR code for the phone link">
      <rect x={-q} y={-q} width={n + 2 * q} height={n + 2 * q} fill="#eceffc" />
      <path d={d} fill="#070913" />
    </svg>
  );
}
