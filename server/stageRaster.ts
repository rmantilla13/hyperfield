/**
 * Stage blocking without a browser: a small z-buffer rasterizer that draws a
 * scene's clay and depth passes on the CPU. Agents (the MCP stage_render tool)
 * send a scene as JSON and have no WebGL, so the server renders it here.
 *
 * Same geometry as the page (src/stageMesh.ts), same camera math and the same
 * clay formula (src/stage.ts clayGrey), so a scene renders alike in both. It
 * draws at 2x and averages down for anti-aliasing. GLB props draw as their box,
 * whether they came as an upload token or a 3D take id (the server never
 * loads the mesh); the page draws the real model.
 */
import * as THREE from 'three';
import { CLAY, cameraAt, clayGrey, depthFar, depthValue, verticalFov, type StageScene } from '../src/stage.js';
import { sceneMeshes } from '../src/stageMesh.js';

const CLIP_NEAR = 0.05;
const SS = 2;

export interface RasterFrame { clay: Buffer; depth: Buffer }

interface SV { sx: number; sy: number; iw: number; v: Vert }
interface Vert { x: number; y: number; z: number; wx: number; wy: number; wz: number; nx: number; ny: number; nz: number }

/** Clay (RGB) and depth (RGB grey) for scene time t, at w x h. */
export function rasterFrame(s: StageScene, t: number, w: number, h: number, far = depthFar(s)): RasterFrame {
  const W = w * SS, H = h * SS;
  const zbuf = new Float32Array(W * H).fill(Infinity);
  const grey = new Float32Array(W * H).fill(-1);
  const key = cameraAt(s, t);
  const cam = new THREE.PerspectiveCamera(verticalFov(s.lens, w, h), w / h, CLIP_NEAR, 2000);
  cam.position.set(...key.pos);
  cam.lookAt(new THREE.Vector3(...key.target));
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();
  const view = cam.matrixWorldInverse;
  const proj = cam.projectionMatrix.elements;
  const [cx, cy, cz] = key.pos;

  const mat = new THREE.MeshBasicMaterial();
  const { meshes } = sceneMeshes(s, mat, t);
  const p = new THREE.Vector3();
  const nrm = new THREE.Vector3();
  const nmat = new THREE.Matrix3();
  /** The mesh being drawn is the ground (it gets the checker). */
  let ground = false;

  for (const mesh of meshes) {
    ground = !!mesh.userData.ground;
    const geom = mesh.geometry as THREE.BufferGeometry;
    const pos = geom.getAttribute('position');
    const nor = geom.getAttribute('normal');
    const idx = geom.getIndex();
    nmat.getNormalMatrix(mesh.matrixWorld);
    const verts: Vert[] = [];
    for (let i = 0; i < pos.count; i++) {
      p.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      const wx = p.x, wy = p.y, wz = p.z;
      p.applyMatrix4(view);
      nrm.fromBufferAttribute(nor, i).applyMatrix3(nmat).normalize();
      verts.push({ x: p.x, y: p.y, z: p.z, wx, wy, wz, nx: nrm.x, ny: nrm.y, nz: nrm.z });
    }
    const tri = (a: number, b: number, c: number) => drawTri(clipNear([verts[a], verts[b], verts[c]]));
    if (idx) for (let i = 0; i < idx.count; i += 3) tri(idx.getX(i), idx.getX(i + 1), idx.getX(i + 2));
    else for (let i = 0; i < pos.count; i += 3) tri(i, i + 1, i + 2);
  }

  function clipNear(poly: Vert[]): Vert[] {
    // Keep the part in front of the camera: view space looks down -z.
    const inside = (v: Vert) => -v.z >= CLIP_NEAR;
    if (poly.every(inside)) return poly;
    const out: Vert[] = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const ia = inside(a), ib = inside(b);
      if (ia) out.push(a);
      if (ia !== ib) {
        const k = (-a.z - CLIP_NEAR) / ((-a.z - CLIP_NEAR) - (-b.z - CLIP_NEAR));
        const m = {} as Vert;
        for (const f of ['x', 'y', 'z', 'wx', 'wy', 'wz', 'nx', 'ny', 'nz'] as const) m[f] = a[f] + (b[f] - a[f]) * k;
        out.push(m);
      }
    }
    return out;
  }

  function drawTri(poly: Vert[]) {
    if (poly.length < 3) return;
    // Project to screen. Perspective-correct attributes: carry a/d and 1/d, d = distance along the view axis.
    const sv = poly.map((v) => {
      const d = -v.z;
      const ndcX = (proj[0] * v.x + proj[8] * v.z + proj[12]) / d;
      const ndcY = (proj[5] * v.y + proj[9] * v.z + proj[13]) / d;
      return { sx: (ndcX * 0.5 + 0.5) * W, sy: (0.5 - ndcY * 0.5) * H, iw: 1 / d, v };
    });
    for (let i = 1; i + 1 < sv.length; i++) raster(sv[0], sv[i], sv[i + 1]);
  }

  function raster(a: SV, b: SV, c: SV) {
    const area = (b.sx - a.sx) * (c.sy - a.sy) - (b.sy - a.sy) * (c.sx - a.sx);
    if (Math.abs(area) < 1e-9) return;
    const minX = Math.max(0, Math.floor(Math.min(a.sx, b.sx, c.sx)));
    const maxX = Math.min(W - 1, Math.ceil(Math.max(a.sx, b.sx, c.sx)));
    const minY = Math.max(0, Math.floor(Math.min(a.sy, b.sy, c.sy)));
    const maxY = Math.min(H - 1, Math.ceil(Math.max(a.sy, b.sy, c.sy)));
    if (minX > maxX || minY > maxY) return;
    const inv = 1 / area;
    for (let y = minY; y <= maxY; y++) {
      const py = y + 0.5;
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5;
        const w0 = ((b.sx - px) * (c.sy - py) - (b.sy - py) * (c.sx - px)) * inv;
        const w1 = ((c.sx - px) * (a.sy - py) - (c.sy - py) * (a.sx - px)) * inv;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const iw = w0 * a.iw + w1 * b.iw + w2 * c.iw;
        const d = 1 / iw;
        const o = y * W + x;
        if (d >= zbuf[o]) continue;
        zbuf[o] = d;
        const k0 = (w0 * a.iw) * d, k1 = (w1 * b.iw) * d, k2 = (w2 * c.iw) * d;
        const A = a.v, B = b.v, C = c.v;
        const wx = k0 * A.wx + k1 * B.wx + k2 * C.wx;
        const wy = k0 * A.wy + k1 * B.wy + k2 * C.wy;
        const wz = k0 * A.wz + k1 * B.wz + k2 * C.wz;
        let nx = k0 * A.nx + k1 * B.nx + k2 * C.nx;
        let ny = k0 * A.ny + k1 * B.ny + k2 * C.ny;
        let nz = k0 * A.nz + k1 * B.nz + k2 * C.nz;
        const nl = Math.hypot(nx, ny, nz) || 1;
        nx /= nl; ny /= nl; nz /= nl;
        // Two-sided: light the face the camera sees.
        if (nx * (cx - wx) + ny * (cy - wy) + nz * (cz - wz) < 0) { nx = -nx; ny = -ny; nz = -nz; }
        grey[o] = clayGrey(nx, ny, nz, wx, wz, ground);
      }
    }
  }

  // ---- downsample ----
  const clay = Buffer.alloc(w * h * 3);
  const depth = Buffer.alloc(w * h * 3);
  const bg = CLAY.background.map((v) => v * 255);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, dv = 0;
      for (let j = 0; j < SS; j++) {
        for (let i = 0; i < SS; i++) {
          const o = (y * SS + j) * W + (x * SS + i);
          const v = grey[o];
          if (v < 0) { r += bg[0]; g += bg[1]; b += bg[2]; } else { const q = v * 255; r += q; g += q; b += q; }
          if (zbuf[o] !== Infinity) dv += depthValue(zbuf[o], far) * 255;
        }
      }
      const n = SS * SS, o = (y * w + x) * 3;
      clay[o] = Math.round(r / n); clay[o + 1] = Math.round(g / n); clay[o + 2] = Math.round(b / n);
      depth[o] = depth[o + 1] = depth[o + 2] = Math.round(dv / n);
    }
  }
  return { clay, depth };
}
