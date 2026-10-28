/**
 * "Film it on your phone": a one-shot LAN drop box for a single clip.
 *
 * The main OpenField server binds loopback and has no authentication, so it is
 * never put on the network. Instead, while a phone session is open, this module
 * runs a second, deliberately tiny HTTP listener on the LAN interface that
 * answers exactly two requests:
 *
 *   GET  /p/<token>          the mobile page
 *   POST /p/<token>/upload   one video, raw body (no multipart)
 *
 * Everything else is a 404. The token is 32 random bytes, lives only in the QR
 * URL, and is spent by the first successful upload. The listener shuts itself
 * down after that upload, on expiry, on too many bad requests, or when the
 * desktop closes the session. It never touches the filesystem or the database:
 * accepted bytes go to the `onClip` callback, and the caller decides what to do.
 *
 * Nothing in here reads config.ts so it can be exercised in isolation
 * (see scripts/test-phone.ts).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { randomBytes, timingSafeEqual } from 'crypto';
import { readFileSync, existsSync } from 'fs';
import { networkInterfaces } from 'os';
import { execFile } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const PAGE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'phone.html'), 'utf8');

export interface PhoneClip { data: Buffer; mime: string; ext: 'mp4' | 'mov' | 'webm'; name: string }

export type PhoneState =
  | { state: 'waiting' }
  | { state: 'opened' }
  | { state: 'receiving'; bytes: number }
  | { state: 'received'; result: unknown }
  | { state: 'closed'; reason: 'received' | 'expired' | 'cancelled' | 'abuse' | 'replaced' };

export interface PhoneNetwork {
  /** 'none' when not under WSL. */
  wsl: 'none' | 'mirrored' | 'nat';
  /** Interface address the listener is bound to. */
  bindHost: string;
  /** Address put in the QR URL. Differs from bindHost only behind a WSL2 NAT. */
  urlHost: string;
  /** Plain-language problem, or null when the phone should simply be able to connect. */
  warning: string | null;
  /** Commands that fix the warning (run in an elevated Windows PowerShell). */
  commands: string[];
}

export interface PhoneSessionInfo {
  /** Public session id (not the secret). The desktop matches live events on it. */
  id: string;
  url: string;
  expiresAt: number;
  port: number;
  maxBytes: number;
  network: PhoneNetwork;
}

export interface PhoneOptions {
  port: number;
  /** Bind/advertise this address instead of auto-detecting one. */
  host?: string;
  ttlMs?: number;
  maxBytes?: number;
  /** Store the clip. Its return value is passed through to the 'received' state. Throwing keeps the session open. */
  onClip: (clip: PhoneClip) => Promise<unknown>;
  onState: (id: string, s: PhoneState) => void;
}

const DEFAULT_TTL = 10 * 60_000;
const DEFAULT_MAX = 300 * 1024 * 1024;
const MAX_BAD_REQUESTS = 30;

interface Session {
  info: PhoneSessionInfo;
  token: Buffer;
  server: Server;
  timer: NodeJS.Timeout;
  uploading: boolean;
  bad: number;
  opts: PhoneOptions;
}

let current: Session | null = null;

export function phoneSession(): PhoneSessionInfo | null {
  return current?.info ?? null;
}

/** Open a session (closing any previous one) and start the LAN listener. */
export async function openPhoneSession(opts: PhoneOptions): Promise<PhoneSessionInfo> {
  if (current) closePhoneSession('replaced');
  const ttl = opts.ttlMs ?? DEFAULT_TTL;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX;
  const network = await detectNetwork(opts.host, opts.port);
  const token = randomBytes(32);
  const id = randomBytes(8).toString('hex');
  const tokenStr = token.toString('base64url');

  const server = createServer((req, res) => handle(req, res));
  // Slowloris and parked sockets: nothing about this needs more than a few clients.
  server.maxConnections = 8;
  server.headersTimeout = 15_000;
  server.requestTimeout = ttl;
  server.keepAliveTimeout = 5_000;

  await new Promise<void>((resolve, reject) => {
    server.once('error', (e: NodeJS.ErrnoException) => {
      reject(new Error(
        e.code === 'EADDRINUSE'
          ? `Port ${opts.port} is taken. Set OPENFIELD_PHONE_PORT to a free port.`
          : e.code === 'EADDRNOTAVAIL'
            ? `${network.bindHost} is not an address on this machine. Check OPENFIELD_PHONE_HOST.`
            : `Could not open the phone listener: ${e.message}`,
      ));
    });
    server.listen(opts.port, network.bindHost, () => resolve());
  });

  const expiresAt = Date.now() + ttl;
  const s: Session = {
    info: { id, url: `http://${fmtHost(network.urlHost)}:${opts.port}/p/${tokenStr}`, expiresAt, port: opts.port, maxBytes, network },
    token,
    server,
    timer: setTimeout(() => closePhoneSession('expired'), ttl),
    uploading: false,
    bad: 0,
    opts,
  };
  s.timer.unref();
  current = s;
  opts.onState(id, { state: 'waiting' });
  return s.info;

  function handle(req: IncomingMessage, res: ServerResponse) {
    // Requests that arrive on a socket accepted just before close still land here.
    if (current !== s) return send(res, 410, { error: 'This link is closed.' });
    const m = /^\/p\/([A-Za-z0-9_-]{1,64})(\/upload)?$/.exec((req.url || '').split('?')[0]);
    if (!m || !tokenOk(m[1])) {
      if (++s.bad >= MAX_BAD_REQUESTS) setImmediate(() => closePhoneSession('abuse'));
      req.resume();
      return send(res, 404, { error: 'Not found' });
    }
    if (!m[2] && req.method === 'GET') {
      opts.onState(id, { state: 'opened' });
      const html = PAGE
        .replace('__MAX_BYTES__', String(maxBytes))
        .replace('__EXPIRES_AT__', String(expiresAt));
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        // The token is in the URL; keep it out of Referer headers and other origins.
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; media-src blob:; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
      });
      return res.end(html);
    }
    if (m[2] && req.method === 'POST') return void upload(req, res);
    req.resume();
    return send(res, 405, { error: 'Method not allowed' });
  }

  function tokenOk(candidate: string): boolean {
    const b = Buffer.from(candidate, 'base64url');
    return b.length === token.length && timingSafeEqual(b, token);
  }

  async function upload(req: IncomingMessage, res: ServerResponse) {
    if (s.uploading) { req.resume(); return send(res, 409, { error: 'A clip is already on its way.' }); }
    const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!mime.startsWith('video/')) { req.resume(); return send(res, 415, { error: 'That is not a video file.' }); }
    const declared = Number(req.headers['content-length']);
    if (!Number.isFinite(declared) || declared <= 0) { req.resume(); return send(res, 411, { error: 'Missing file size.' }); }
    if (declared > maxBytes) { req.resume(); return send(res, 413, { error: `Clip is over ${Math.round(maxBytes / 1048576)} MB. Film a shorter take.` }); }

    s.uploading = true;
    const chunks: Buffer[] = [];
    let got = 0;
    let lastReport = 0;
    let failed = false;
    opts.onState(id, { state: 'receiving', bytes: 0 });
    try {
      for await (const chunk of req as AsyncIterable<Buffer>) {
        got += chunk.length;
        // Content-Length is the client's word; enforce the cap on actual bytes.
        if (got > declared || got > maxBytes) { failed = true; break; }
        chunks.push(chunk);
        if (got - lastReport > 4 * 1048576) { lastReport = got; opts.onState(id, { state: 'receiving', bytes: got }); }
      }
    } catch {
      s.uploading = false;
      opts.onState(id, { state: 'waiting' });
      return; // client went away mid-upload; let them retry
    }
    if (failed || got !== declared) {
      s.uploading = false;
      opts.onState(id, { state: 'waiting' });
      res.setHeader('Connection', 'close');
      return send(res, failed ? 413 : 400, { error: failed ? 'Clip is larger than it said it was.' : 'Upload was cut short. Try again.' });
    }
    const data = Buffer.concat(chunks);
    const ext = sniffVideo(data);
    if (!ext) {
      s.uploading = false;
      opts.onState(id, { state: 'waiting' });
      return send(res, 415, { error: 'That file is not an MP4, MOV or WebM video.' });
    }
    const rawName = decodeName(req.headers['x-filename']);
    try {
      // Label the bytes by what they are, not by what the phone said.
      const realMime = ext === 'mov' ? 'video/quicktime' : ext === 'webm' ? 'video/webm' : 'video/mp4';
      const result = await opts.onClip({ data, mime: realMime, ext, name: rawName || `phone.${ext}` });
      send(res, 200, { ok: true });
      opts.onState(id, { state: 'received', result });
      // Spent: the token cannot be used again. Give the response a moment to flush.
      setTimeout(() => { if (current === s) closePhoneSession('received'); }, 250);
    } catch (e) {
      s.uploading = false;
      opts.onState(id, { state: 'waiting' });
      send(res, 500, { error: `OpenField could not keep the clip: ${e instanceof Error ? e.message : 'unknown error'}` });
    }
  }
}

/** Close the current session and its listener. Safe to call when none is open. */
export function closePhoneSession(reason: 'received' | 'expired' | 'cancelled' | 'abuse' | 'replaced' = 'cancelled') {
  const s = current;
  if (!s) return;
  current = null;
  clearTimeout(s.timer);
  s.server.close();
  s.server.closeAllConnections();
  s.opts.onState(s.info.id, { state: 'closed', reason });
}

function send(res: ServerResponse, code: number, body: unknown) {
  if (res.headersSent) return;
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(body));
}

function decodeName(h: string | string[] | undefined): string {
  if (typeof h !== 'string') return '';
  let s = h;
  try { s = decodeURIComponent(h); } catch { /* keep raw */ }
  return s.replace(/[^\w.\- ]+/g, '').slice(0, 80);
}

/** Container from magic bytes, not from what the client claims. */
export function sniffVideo(b: Buffer): PhoneClip['ext'] | null {
  if (b.length < 12) return null;
  if (b.readUInt32BE(0) === 0x1a45dfa3) return 'webm'; // EBML (WebM / Matroska)
  const atom = b.toString('latin1', 4, 8);
  if (atom === 'ftyp') return b.toString('latin1', 8, 12) === 'qt  ' ? 'mov' : 'mp4';
  // Older QuickTime files can open with another top-level atom before ftyp/moov.
  if (['moov', 'mdat', 'wide', 'free', 'skip'].includes(atom)) return 'mov';
  return null;
}

// ---------- network ----------

const fmtHost = (h: string) => (h.includes(':') ? `[${h}]` : h);

function isWsl(): boolean {
  if (process.platform !== 'linux') return false;
  if (process.env.WSL_DISTRO_NAME) return true;
  try { return /microsoft/i.test(readFileSync('/proc/version', 'utf8')); } catch { return false; }
}

const isPrivate = (ip: string) =>
  /^192\.168\./.test(ip) || /^10\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
const VIRTUAL_IF = /^(docker|br-|veth|virbr|vmnet|vboxnet|tailscale|zt|utun|tun|tap|lo)/i;

/** Interface name -> metric of its default route (Linux only). */
function defaultRouteMetrics(): Map<string, number> {
  const out = new Map<string, number>();
  if (!existsSync('/proc/net/route')) return out;
  try {
    for (const line of readFileSync('/proc/net/route', 'utf8').split('\n').slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length > 7 && f[1] === '00000000' && f[7] === '00000000') {
        const metric = Number(f[6]);
        if (!out.has(f[0]) || metric < out.get(f[0])!) out.set(f[0], metric);
      }
    }
  } catch { /* fall back to ranking */ }
  return out;
}

/** Best guess at the address a phone on the same Wi-Fi can reach. */
export function pickLanAddress(): { name: string; address: string } | null {
  const routes = defaultRouteMetrics();
  const cands: { name: string; address: string; score: number }[] = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue;
      if (VIRTUAL_IF.test(name)) continue;
      let score = isPrivate(a.address) ? 100 : 10;
      if (a.address.startsWith('192.168.')) score += 20;
      else if (a.address.startsWith('10.')) score += 10;
      if (routes.has(name)) score += 1000 - Math.min(999, routes.get(name)!);
      cands.push({ name, address: a.address, score });
    }
  }
  cands.sort((x, y) => y.score - x.score);
  return cands[0] ?? null;
}

/** Mirrored-mode WSL puts 10.255.255.254 on lo; NAT mode never does. */
function wslMode(): 'none' | 'mirrored' | 'nat' {
  if (!isWsl()) return 'none';
  const lo = networkInterfaces().lo ?? [];
  return lo.some((a) => a.address === '10.255.255.254') ? 'mirrored' : 'nat';
}

/** Windows' own LAN address, from ipconfig.exe through WSL interop. Best effort. */
function windowsLanAddress(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('ipconfig.exe', { timeout: 3000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      const ips = [...String(stdout).matchAll(/IPv4[^:\r\n]*:\s*([\d.]+)/g)].map((m) => m[1]);
      resolve(ips.find((ip) => ip.startsWith('192.168.')) ?? ips.find((ip) => ip.startsWith('10.')) ?? null);
    });
  });
}

const VM_CREATOR_WSL = '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}';

export async function detectNetwork(override: string | undefined, port: number): Promise<PhoneNetwork> {
  const wsl = wslMode();
  const local = pickLanAddress();
  const localAddrs = new Set(Object.values(networkInterfaces()).flat().map((a) => a?.address));
  const overrideIsLocal = !!override && localAddrs.has(override);
  const bindHost = overrideIsLocal ? override! : local?.address ?? '';
  if (!bindHost) {
    throw new Error('No network connection found. Connect this machine to the same Wi-Fi as your phone.');
  }
  const firewall = `New-NetFirewallRule -DisplayName "OpenField phone" -Direction Inbound -Protocol TCP -LocalPort ${port} -Action Allow -Profile Private`;

  if (wsl === 'nat') {
    // WSL2 NAT: the Linux address is behind Windows and unreachable from the phone.
    // The phone has to hit Windows, which forwards to us via portproxy.
    const win = (override && !overrideIsLocal ? override : null) ?? (await windowsLanAddress());
    return {
      wsl,
      bindHost,
      urlHost: win ?? bindHost,
      warning:
        'OpenField is running inside WSL2 with NAT networking, so your phone cannot reach it directly. ' +
        'Forward the port from Windows once (elevated PowerShell), or switch WSL to mirrored networking ' +
        '(add networkingMode=mirrored under [wsl2] in %UserProfile%\\.wslconfig, then wsl --shutdown).' +
        (win ? '' : ' Windows\' LAN address could not be detected; set OPENFIELD_PHONE_HOST to it.'),
      commands: [
        `netsh interface portproxy add v4tov4 listenaddress=${win ?? '0.0.0.0'} listenport=${port} connectaddress=${bindHost} connectport=${port}`,
        firewall,
      ],
    };
  }
  if (wsl === 'mirrored') {
    return {
      wsl,
      bindHost,
      urlHost: bindHost,
      warning: null,
      // Mirrored mode shares Windows' address, but Hyper-V's firewall still filters inbound.
      commands: [
        `New-NetFirewallHyperVRule -Name OpenFieldPhone -DisplayName "OpenField phone" -Direction Inbound -VMCreatorId '${VM_CREATOR_WSL}' -Protocol TCP -LocalPorts ${port}`,
        firewall,
      ],
    };
  }
  return { wsl, bindHost, urlHost: bindHost, warning: null, commands: [] };
}
