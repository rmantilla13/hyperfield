/**
 * Stage geometry: the three.js meshes for each prop. Shared by the page (WebGL
 * viewport and the blocking export) and the server rasterizer, so a scene has
 * one shape wherever it is drawn. No DOM, no renderer: geometry only.
 */
import * as THREE from 'three';
import { propAt, type StageProp, type StageScene } from './stage.js';

const SEG = 28;
const FIG_W = 0.3;
const FIG_D = 0.14;

/** Unit geometries, built once. Each prop scales its own copy of the mesh. */
let shared: Record<string, THREE.BufferGeometry> | null = null;
function geo() {
  if (shared) return shared;
  const box = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const cyl = new THREE.CylinderGeometry(0.5, 0.5, 1, SEG, 1).translate(0, 0.5, 0);
  const sphere = new THREE.SphereGeometry(0.5, SEG, 18).translate(0, 0.5, 0);
  // Mannequin parts in a figure 1 tall, FIG_W wide (arms included) and FIG_D deep;
  // the prop scales them to its own width, height and depth.
  const limb = (r: number, from: number, to: number) => new THREE.CapsuleGeometry(r, to - from - 2 * r, 6, 14).translate(0, (from + to) / 2, 0);
  shared = {
    box, cyl, sphere,
    leg: limb(0.04, 0, 0.49),
    torso: limb(0.08, 0.45, 0.83),
    head: new THREE.SphereGeometry(0.065, 18, 12).translate(0, 0.935, 0),
    arm: limb(0.03, 0.47, 0.8),
  };
  return shared;
}

/**
 * The object for one prop, with its transform at shot time t. `material` is
 * whatever the caller draws with (clay, depth, a selection tint).
 */
export function propObject(p: StageProp, material: THREE.Material, t = 0): THREE.Group {
  const g = geo();
  const group = new THREE.Group();
  group.name = p.id;
  group.userData.propId = p.id;
  const [w, h, d] = p.size;
  const add = (geom: THREE.BufferGeometry, x = 0, z = 0, sx = 1, sy = 1, sz = 1) => {
    const m = new THREE.Mesh(geom, material);
    m.position.set(x, 0, z);
    m.scale.set(sx, sy, sz);
    m.userData.propId = p.id;
    group.add(m);
    return m;
  };
  if (p.type === 'figure') {
    // A mannequin: two legs, torso, head, arms, scaled to the prop's width, height and depth.
    const inner = new THREE.Group();
    const part = (geom: THREE.BufferGeometry, x: number) => {
      const m = new THREE.Mesh(geom, material);
      m.position.x = x;
      m.userData.propId = p.id;
      inner.add(m);
    };
    part(g.leg, -0.045);
    part(g.leg, 0.045);
    part(g.torso, 0);
    part(g.head, 0);
    part(g.arm, -0.12);
    part(g.arm, 0.12);
    inner.scale.set(w / FIG_W, h, d / FIG_D);
    group.add(inner);
  } else if (p.type === 'cylinder') add(g.cyl, 0, 0, w, h, d);
  else if (p.type === 'sphere') add(g.sphere, 0, 0, w, h, d);
  else add(g.box, 0, 0, w, h, d); // box, wall, and a GLB's stand-in until its model loads
  placeProp(group, p, t);
  return group;
}

/** Move an existing prop object to where it is at shot time t. */
export function placeProp(obj: THREE.Object3D, p: StageProp, t: number) {
  const at = propAt(p, t);
  obj.position.set(at[0], at[1], at[2]);
  obj.rotation.set(0, (p.rot * Math.PI) / 180, 0);
}

/** The ground: a big plane at y = 0, drawn with the checker. */
export function groundMesh(material: THREE.Material): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(400, 400).rotateX(-Math.PI / 2), material);
  m.userData.ground = true;
  return m;
}

/** Every mesh of a scene at time t, flattened with world matrices up to date (the rasterizer's input). */
export function sceneMeshes(s: StageScene, material: THREE.Material, t: number): { root: THREE.Group; meshes: THREE.Mesh[] } {
  const root = new THREE.Group();
  root.add(groundMesh(material));
  for (const p of s.props) root.add(propObject(p, material, t));
  root.updateMatrixWorld(true);
  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
  return { root, meshes };
}
