/**
 * The Stage viewport: a three.js view of the set you can block in, and the
 * WebGL export of the blocking (clay and depth passes, read back frame by
 * frame). Two ways to look:
 *   set   a free orbit view: drag props on the ground, see the camera, its
 *         path, its keys and where moving props end up;
 *   shot  through the shot camera, letterboxed to the frame. It follows the
 *         camera path at the playhead; dragging frames a new view (drag to
 *         swing, right-drag to slide, wheel to move in) that the page stores
 *         into a key ("Set key from this view") or adds as one.
 * Geometry comes from src/stageMesh.ts and the clay formula from src/stage.ts,
 * so the server rasterizer draws the same picture.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  CLAY, DEPTH_NEAR, FILL_DIR, KEY_DIR, cameraAt, depthFar, propAt, propSpan, verticalFov,
  type CameraKey, type StageProp, type StageScene, type Vec3,
} from './stage';
import { groundMesh, placeProp, propObject } from './stageMesh';

export type ViewMode = 'set' | 'shot';

export interface ViewEvents {
  /** A prop was dragged. `end` = its end position (`to`) moved. */
  onMoveProp: (id: string, at: Vec3, end: boolean) => void;
  onSelect: (id: string | null) => void;
  /** The shot view was framed by hand (true), or went back to following the path (false). */
  onFrame: (framed: boolean) => void;
}

// ---------- the clay shader: src/stage.ts clayGrey(), in GLSL ----------

const VERT = /* glsl */ `
varying vec3 vW;
varying vec3 vN;
varying float vD;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  vN = normalize(mat3(transpose(inverse(modelMatrix))) * normal);
  vec4 v = viewMatrix * w;
  vD = -v.z;
  gl_Position = projectionMatrix * v;
}`;

const FRAG = /* glsl */ `
uniform float uGround;
uniform float uDepth;
uniform float uFar;
uniform vec3 uTint;
uniform float uTintAmt;
uniform vec3 uKey;
uniform vec3 uFill;
varying vec3 vW;
varying vec3 vN;
varying float vD;
void main() {
  if (uDepth > 0.5) {
    float d = clamp(1.0 - (vD - ${DEPTH_NEAR.toFixed(3)}) / (uFar - ${DEPTH_NEAR.toFixed(3)}), 0.0, 1.0);
    gl_FragColor = vec4(vec3(d), 1.0);
    return;
  }
  vec3 n = normalize(vN);
  if (dot(n, cameraPosition - vW) < 0.0) n = -n;
  float albedo = ${CLAY.albedo.toFixed(3)};
  if (uGround > 0.5) {
    float odd = mod(floor(vW.x / ${CLAY.tile.toFixed(3)}) + floor(vW.z / ${CLAY.tile.toFixed(3)}), 2.0);
    albedo = ${CLAY.ground.toFixed(3)} + (odd > 0.5 ? ${CLAY.checker.toFixed(4)} : -${CLAY.checker.toFixed(4)});
  }
  float k = max(0.0, dot(n, uKey));
  float f = max(0.0, dot(n, uFill));
  float g = min(1.0, albedo * (${CLAY.ambient.toFixed(3)} + ${CLAY.key.strength.toFixed(3)} * k + ${CLAY.fill.strength.toFixed(3)} * f) * 1.25);
  gl_FragColor = vec4(mix(vec3(g), uTint, uTintAmt), 1.0);
}`;

function clayMaterial(opts: { ground?: boolean; depth?: boolean; far?: number; tint?: THREE.Color; tintAmt?: number } = {}) {
  return new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    side: THREE.DoubleSide,
    uniforms: {
      uGround: { value: opts.ground ? 1 : 0 },
      uDepth: { value: opts.depth ? 1 : 0 },
      uFar: { value: opts.far ?? 40 },
      uTint: { value: opts.tint ?? new THREE.Color(1, 0.71, 0.28) },
      uTintAmt: { value: opts.tintAmt ?? 0 },
      uKey: { value: new THREE.Vector3(...KEY_DIR) },
      uFill: { value: new THREE.Vector3(...FILL_DIR) },
    },
  });
}

const BG = new THREE.Color().setRGB(...CLAY.background);
const ACCENT = new THREE.Color(1, 0.71, 0.28);

// ---------- GLB props ----------

const glbCache = new Map<string, Promise<THREE.Object3D>>();
/** Where a GLB prop's file is served: an upload token, or an Object take's media. */
export function glbSrc(p: StageProp): string | undefined {
  if (p.type !== 'glb') return undefined;
  if (p.asset) return `/api/input-image/${encodeURIComponent(p.asset)}`;
  if (p.take) return `/api/media/${p.take}`;
  return undefined;
}
/** Load a GLB once (by its URL). */
export function loadGlb(url: string): Promise<THREE.Object3D> {
  let p = glbCache.get(url);
  if (!p) {
    p = new GLTFLoader().loadAsync(url).then((g) => g.scene);
    glbCache.set(url, p);
    p.catch(() => glbCache.delete(url));
  }
  return p;
}
const glbReady = new Map<string, THREE.Object3D>();

/** Swap a GLB prop's stand-in box for the model, fitted inside the prop's size, standing on its base. */
function fitGlb(group: THREE.Group, p: StageProp, model: THREE.Object3D, material: THREE.Material) {
  const m = model.clone(true);
  const box = new THREE.Box3().setFromObject(m);
  const size = box.getSize(new THREE.Vector3());
  const k = Math.min(p.size[0] / (size.x || 1), p.size[1] / (size.y || 1), p.size[2] / (size.z || 1));
  m.scale.setScalar(k);
  const c = box.getCenter(new THREE.Vector3());
  m.position.set(-c.x * k, -box.min.y * k, -c.z * k);
  m.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh) { mesh.material = material; mesh.userData.propId = p.id; }
  });
  group.clear();
  group.add(m);
}

/** Every prop as an object at time t, GLB models in place when they are loaded. */
function buildProps(s: StageScene, mat: (p: StageProp) => THREE.Material, t: number): THREE.Group[] {
  return s.props.map((p) => {
    const g = propObject(p, mat(p), t);
    const src = glbSrc(p);
    const model = src ? glbReady.get(src) : undefined;
    if (model) fitGlb(g, p, model, mat(p));
    return g;
  });
}

/** Wait for every GLB the scene uses (the export must not draw stand-in boxes). */
export async function loadSceneModels(s: StageScene): Promise<void> {
  await Promise.all(s.props.map(glbSrc).filter((u): u is string => !!u).map(async (u) => glbReady.set(u, await loadGlb(u))));
}

// ---------- the view ----------

export class StageView {
  private renderer: THREE.WebGLRenderer;
  private world = new THREE.Scene();
  private props = new THREE.Group();
  private helpers = new THREE.Group();
  private editorCam = new THREE.PerspectiveCamera(40, 1, 0.05, 2000);
  private shotCam = new THREE.PerspectiveCamera(40, 16 / 9, 0.05, 2000);
  private proxy = new THREE.PerspectiveCamera(40, 16 / 9, 0.12, 1.1);
  private proxyHelper: THREE.CameraHelper;
  private editor: OrbitControls;
  private aim: OrbitControls;
  private mats = { clay: clayMaterial(), ground: clayMaterial({ ground: true }), picked: clayMaterial({ tint: ACCENT, tintAmt: 0.35 }), ghost: new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.22, depthWrite: false }) };
  private scn: StageScene | null = null;
  private t = 0;
  private mode: ViewMode = 'set';
  private key: number | null = null;
  private picked: string | null = null;
  private frame = { x: 0, y: 0, w: 1, h: 1 };
  private dirty = true;
  private raf = 0;
  private drag: { id: string; end: boolean; plane: THREE.Plane; offset: THREE.Vector3; moved: boolean } | null = null;
  private down: { x: number; y: number } | null = null;
  private applyingKey = false;
  /** The shot camera was moved by hand and no longer follows the path. */
  private framed = false;
  private ro: ResizeObserver;

  constructor(private host: HTMLElement, private ev: ViewEvents) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.setScissorTest(true);
    const el = this.renderer.domElement;
    el.className = 'stage-canvas';
    host.appendChild(el);
    this.world.add(groundMesh(this.mats.ground), this.props, this.helpers);
    this.proxyHelper = new THREE.CameraHelper(this.proxy);
    this.editorCam.position.set(7.5, 6.5, 11);
    this.editor = new OrbitControls(this.editorCam, el);
    this.editor.target.set(0, 0.8, 0);
    this.editor.maxPolarAngle = Math.PI * 0.495;
    this.editor.addEventListener('change', () => { this.dirty = true; });
    this.aim = new OrbitControls(this.shotCam, el);
    this.aim.enabled = false;
    this.aim.addEventListener('change', () => this.keyMoved());
    el.addEventListener('pointerdown', this.onDown, true);
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.resize();
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      if (this.dirty) { this.dirty = false; this.draw(); }
    };
    loop();
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.editor.dispose();
    this.aim.dispose();
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  /** The canvas, for screenshots and tests. */
  get canvas() { return this.renderer.domElement; }

  setScene(s: StageScene) {
    const lensOrAspect = !this.scn || this.scn.lens !== s.lens || this.scn.aspect !== s.aspect;
    this.scn = s;
    this.rebuild();
    if (lensOrAspect) this.resize();
    if (this.key !== null && this.key >= s.keys.length) this.key = null;
    if (!this.framed) this.syncShotCam();
    else this.syncLens();
    this.dirty = true;
  }
  setTime(t: number) { this.t = t; this.placeAll(); if (!this.framed) this.syncShotCam(); this.dirty = true; }
  setMode(m: ViewMode) { this.mode = m; this.resize(); this.syncControls(); this.dirty = true; }
  /** Highlight a camera key (its dot in the set view). */
  selectKey(i: number | null) { if (this.key === i) return; this.key = i; this.rebuild(); this.dirty = true; }
  /** Drop a hand-framed view: the shot camera follows the path at the playhead again. */
  resetFrame() {
    const was = this.framed;
    this.framed = false;
    this.syncShotCam();
    this.dirty = true;
    if (was) this.ev.onFrame(false);
  }
  /** The shot camera as it is now (hand-framed or on the path), rounded like a stored key. */
  currentView(): CameraKey {
    const p = this.shotCam.position, t = this.aim.target;
    const r = (v: number) => Math.round(v * 1000) / 1000;
    return { pos: [r(p.x), r(p.y), r(p.z)], target: [r(t.x), r(t.y), r(t.z)] };
  }
  select(id: string | null) { this.picked = id; this.rebuild(); this.dirty = true; }

  private syncControls() {
    this.editor.enabled = this.mode === 'set' && !this.drag;
    this.aim.enabled = this.mode === 'shot' && !this.drag;
  }

  private resize() {
    const w = Math.max(1, this.host.clientWidth), h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = `${w}px`;
    this.renderer.domElement.style.height = `${h}px`;
    this.editorCam.aspect = w / h;
    this.editorCam.updateProjectionMatrix();
    // The shot view is letterboxed to the frame's aspect.
    const a = this.scn ? (this.scn.aspect === '9:16' ? 9 / 16 : this.scn.aspect === '1:1' ? 1 : 16 / 9) : 16 / 9;
    const fw = Math.min(w, h * a), fh = fw / a;
    this.frame = { x: (w - fw) / 2, y: (h - fh) / 2, w: fw, h: fh };
    this.syncLens();
    this.dirty = true;
  }

  private rebuild() {
    const s = this.scn;
    this.props.clear();
    this.helpers.clear();
    if (!s) return;
    for (const g of buildProps(s, (p) => (p.id === this.picked ? this.mats.picked : this.mats.clay), this.t)) this.props.add(g);
    // Models still loading draw as their box, then swap in.
    for (const p of s.props) {
      const src = glbSrc(p);
      if (src && !glbReady.has(src)) {
        void loadGlb(src).then((m) => { glbReady.set(src, m); this.rebuild(); this.dirty = true; }).catch(() => {});
      }
    }
    // Set view helpers: the camera path, its keys, and where moving props end up.
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 48; i++) pts.push(new THREE.Vector3(...cameraAt(s, i / 48).pos));
    this.helpers.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: ACCENT })));
    s.keys.forEach((k, i) => {
      const dot = new THREE.Mesh(new THREE.SphereGeometry(i === this.key ? 0.11 : 0.07, 12, 8), new THREE.MeshBasicMaterial({ color: i === this.key ? 0xffffff : ACCENT }));
      dot.position.set(...k.pos);
      this.helpers.add(dot);
    });
    for (const p of s.props) {
      if (!p.to) continue;
      const ghost = propObject({ ...p, pos: p.to, to: undefined }, this.mats.ghost, 0);
      ghost.traverse((o) => { o.userData.propId = undefined; });
      this.helpers.add(ghost);
      this.helpers.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...p.pos), new THREE.Vector3(...p.to)]), new THREE.LineDashedMaterial({ color: ACCENT, dashSize: 0.15, gapSize: 0.1 })).computeLineDistances());
    }
    this.helpers.add(this.proxyHelper);
  }

  private placeAll() {
    if (!this.scn) return;
    for (const g of this.props.children) {
      const p = this.scn.props.find((x) => x.id === g.userData.propId);
      if (p) placeProp(g, p, this.t);
    }
  }

  private syncShotCam() {
    const s = this.scn;
    if (!s) return;
    const k = cameraAt(s, this.t);
    this.applyingKey = true;
    this.shotCam.position.set(...k.pos);
    this.aim.target.set(...k.target);
    this.shotCam.lookAt(this.aim.target);
    this.aim.update();
    this.applyingKey = false;
    this.syncLens();
  }

  private syncLens() {
    const s = this.scn;
    if (!s) return;
    const fov = verticalFov(s.lens, this.frame.w, this.frame.h);
    for (const c of [this.shotCam, this.proxy]) { c.fov = fov; c.aspect = this.frame.w / this.frame.h; c.updateProjectionMatrix(); }
    this.proxy.position.copy(this.shotCam.position);
    this.proxy.quaternion.copy(this.shotCam.quaternion);
    this.proxy.updateMatrixWorld();
    this.proxyHelper.update();
  }

  private keyMoved() {
    if (this.applyingKey) return;
    this.proxy.position.copy(this.shotCam.position);
    this.proxy.quaternion.copy(this.shotCam.quaternion);
    this.proxy.updateMatrixWorld();
    this.proxyHelper.update();
    this.dirty = true;
    if (!this.framed) { this.framed = true; this.ev.onFrame(true); }
  }

  private draw() {
    const r = this.renderer;
    const w = r.domElement.width / r.getPixelRatio(), h = r.domElement.height / r.getPixelRatio();
    r.setScissor(0, 0, w, h);
    r.setViewport(0, 0, w, h);
    r.setClearColor(this.mode === 'shot' ? new THREE.Color(0.03, 0.03, 0.03) : BG, 1);
    r.clear();
    if (this.mode === 'set') {
      this.helpers.visible = true;
      this.world.background = BG;
      r.render(this.world, this.editorCam);
      return;
    }
    this.helpers.visible = false;
    const f = this.frame;
    r.setScissor(f.x, h - f.y - f.h, f.w, f.h);
    r.setViewport(f.x, h - f.y - f.h, f.w, f.h);
    this.world.background = BG;
    r.render(this.world, this.shotCam);
  }

  // ---------- picking and dragging ----------

  private ndc(e: PointerEvent): THREE.Vector2 | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    if (this.mode === 'set') return new THREE.Vector2((x / rect.width) * 2 - 1, -(y / rect.height) * 2 + 1);
    const f = this.frame;
    if (x < f.x || x > f.x + f.w || y < f.y || y > f.y + f.h) return null;
    return new THREE.Vector2(((x - f.x) / f.w) * 2 - 1, -((y - f.y) / f.h) * 2 + 1);
  }

  private ray(e: PointerEvent): THREE.Raycaster | null {
    const n = this.ndc(e);
    if (!n) return null;
    const rc = new THREE.Raycaster();
    rc.setFromCamera(n, this.mode === 'set' ? this.editorCam : this.shotCam);
    return rc;
  }

  /** Which end of a moving prop a drag edits: the end position once the playhead is past the middle of its move. */
  private editsEnd(p: StageProp) { const [a, b] = propSpan(p); return !!p.to && this.t > (a + b) / 2; }

  private onDown = (e: PointerEvent) => {
    // Props move in the set view; in the shot view a drag frames the camera.
    if (e.button !== 0 || !this.scn || this.mode !== 'set') return;
    this.down = { x: e.clientX, y: e.clientY };
    const rc = this.ray(e);
    if (!rc) return;
    const hit = rc.intersectObjects(this.props.children, true).find((h) => h.object.userData.propId);
    if (!hit) return;
    const id = hit.object.userData.propId as string;
    const p = this.scn.props.find((x) => x.id === id);
    if (!p) return;
    // Keep the orbit controls on this element from starting a camera drag.
    e.stopImmediatePropagation();
    const end = this.editsEnd(p);
    const at = propAt(p, end ? 1 : 0);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -at[1]);
    const on = rc.ray.intersectPlane(plane, new THREE.Vector3());
    this.drag = { id, end, plane, offset: on ? on.sub(new THREE.Vector3(...at)) : new THREE.Vector3(), moved: false };
    this.syncControls();
    if (this.picked !== id) this.ev.onSelect(id);
  };

  private onMove = (e: PointerEvent) => {
    const d = this.drag;
    if (!d || !this.scn) return;
    const rc = this.ray(e);
    if (!rc) return;
    const on = rc.ray.intersectPlane(d.plane, new THREE.Vector3());
    if (!on) return;
    const p = this.scn.props.find((x) => x.id === d.id);
    if (!p) return;
    const base = d.end ? p.to! : p.pos;
    const r = (v: number) => Math.round(v * 100) / 100;
    d.moved = true;
    this.ev.onMoveProp(d.id, [r(on.x - d.offset.x), base[1], r(on.z - d.offset.z)], d.end);
  };

  private onUp = (e: PointerEvent) => {
    const wasDrag = this.drag;
    this.drag = null;
    this.syncControls();
    const down = this.down;
    this.down = null;
    // A click on empty space clears the selection; an orbit drag does not.
    if (!wasDrag && down && this.mode === 'set' && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 4 && e.target === this.renderer.domElement) this.ev.onSelect(null);
  };
}

// ---------- export ----------

export interface BlockingFrames {
  width: number;
  height: number;
  /** JPEG data URLs, one per frame. */
  clay: string[];
  depth: string[];
  /** Frame 0 at the look-frame size, PNG. */
  clayStill: string;
  depthStill: string;
}

/**
 * Render the blocking in WebGL and read every frame back: the clay pass and
 * an exact depth pass (near = white, linear to the scene's far plane), at
 * w x h for `frames` frames, plus frame 0 at the look-frame size.
 */
export async function renderBlocking(
  s: StageScene, size: { w: number; h: number }, frames: number, look: { w: number; h: number },
  onProgress?: (done: number, total: number) => void,
): Promise<BlockingFrames> {
  await loadSceneModels(s);
  const canvas = document.createElement('canvas');
  const r = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  r.outputColorSpace = THREE.LinearSRGBColorSpace;
  r.setPixelRatio(1);
  const far = depthFar(s);
  const clay = clayMaterial();
  const ground = clayMaterial({ ground: true });
  const depth = clayMaterial({ depth: true, far });
  const world = new THREE.Scene();
  world.add(groundMesh(ground));
  const groups = buildProps(s, () => clay, 0);
  world.add(...groups);
  const cam = new THREE.PerspectiveCamera(40, 1, 0.05, 2000);
  const black = new THREE.Color(0, 0, 0);
  const shoot = (t: number, w: number, h: number, type: 'image/jpeg' | 'image/png') => {
    groups.forEach((g, i) => placeProp(g, s.props[i], t));
    const k = cameraAt(s, t);
    cam.fov = verticalFov(s.lens, w, h);
    cam.aspect = w / h;
    cam.updateProjectionMatrix();
    cam.position.set(...k.pos);
    cam.lookAt(...k.target);
    world.overrideMaterial = null;
    world.background = BG;
    r.render(world, cam);
    const c = canvas.toDataURL(type, 0.95);
    world.overrideMaterial = depth;
    world.background = black;
    r.render(world, cam);
    const d = canvas.toDataURL(type, 0.95);
    return { c, d };
  };
  try {
    r.setSize(size.w, size.h, false);
    const out: BlockingFrames = { width: size.w, height: size.h, clay: [], depth: [], clayStill: '', depthStill: '' };
    for (let i = 0; i < frames; i++) {
      const f = shoot(frames > 1 ? i / (frames - 1) : 0, size.w, size.h, 'image/jpeg');
      out.clay.push(f.c);
      out.depth.push(f.d);
      if (i % 8 === 0) { onProgress?.(i, frames); await new Promise((res) => setTimeout(res, 0)); }
    }
    r.setSize(look.w, look.h, false);
    const first = shoot(0, look.w, look.h, 'image/png');
    out.clayStill = first.c;
    out.depthStill = first.d;
    onProgress?.(frames, frames);
    return out;
  } finally {
    clay.dispose(); ground.dispose(); depth.dispose();
    r.dispose();
    r.forceContextLoss();
  }
}
