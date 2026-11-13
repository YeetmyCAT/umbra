// Three.js meshes built from the shape library (js/shapes.js), so what is drawn is what the photometry uses.
// Panels turn to the Sun every frame exactly as their facets do.
import * as THREE from '../vendor/three.module.min.js';
import { hash } from './light.js';

// ---- procedural textures (solar cells, crinkled MLI) ----
function canvasTex(w, h, draw) { const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h); const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 4; return t; }
let TEX = null;
function textures() {
  if (TEX) return TEX;
  const cells = (base, line) => canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = base; g.fillRect(0, 0, w, h);
    g.strokeStyle = line; g.lineWidth = 2;
    for (let i = 0; i <= 8; i++) { g.beginPath(); g.moveTo(i * 32, 0); g.lineTo(i * 32, h); g.stroke(); g.beginPath(); g.moveTo(0, i * 32); g.lineTo(w, i * 32); g.stroke(); }
    g.strokeStyle = 'rgba(200,200,220,0.25)'; g.lineWidth = 0.6;
    for (let i = 0; i < 64; i++) { g.beginPath(); g.moveTo(0, i * 4 + 2); g.lineTo(w, i * 4 + 2); g.stroke(); }
  });
  const crinkle = canvasTex(256, 256, (g, w, h) => {
    const im = g.createImageData(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const k = (y * w + x) * 4, n = Math.sin(x * 0.21 + Math.sin(y * 0.13) * 3) * 0.5 + Math.sin(y * 0.37 + x * 0.05) * 0.3 + (hash(x * 13 + y * 7.1) - 0.5) * 0.4;
      im.data[k] = 128 + n * 60; im.data[k + 1] = 128 + Math.cos(x * 0.17 - y * 0.29) * 50; im.data[k + 2] = 255; im.data[k + 3] = 255;
    }
    g.putImageData(im, 0, 0);
  });
  TEX = { cellBlue: cells('#0b1430', '#2a3550'), cellGold: cells('#4a2c10', '#6a4a20'), crinkle };
  return TEX;
}
let MATS = null;
export function materials() {
  if (MATS) return MATS;
  const T = textures();
  const S = (o) => new THREE.MeshStandardMaterial(o);
  MATS = {
    cell: S({ color: 0x9aa6d8, map: T.cellBlue, metalness: 0.35, roughness: 0.22 }),
    cellGold: S({ color: 0xffd9a8, map: T.cellGold, metalness: 0.3, roughness: 0.3 }),
    cellBack: S({ color: 0xcfcfc6, metalness: 0.0, roughness: 0.8 }),
    cellBackDark: S({ color: 0x1c1c20, metalness: 0.1, roughness: 0.7 }),
    mliGold: S({ color: 0xd9a24a, metalness: 0.85, roughness: 0.42, normalMap: T.crinkle, normalScale: new THREE.Vector2(0.7, 0.7) }),
    mliSilver: S({ color: 0xc9ccd2, metalness: 0.9, roughness: 0.35, normalMap: T.crinkle, normalScale: new THREE.Vector2(0.5, 0.5) }),
    beta: S({ color: 0xe9e6dc, metalness: 0.0, roughness: 0.9 }),
    white: S({ color: 0xe8e8e8, metalness: 0.0, roughness: 0.75 }),
    alu: S({ color: 0xb8bcc2, metalness: 1.0, roughness: 0.3 }),
    osr: S({ color: 0xf0f2f6, metalness: 1.0, roughness: 0.05 }),
    dark: S({ color: 0x18181b, metalness: 0.2, roughness: 0.6 }),
    mirrorFilm: S({ color: 0xe8ecf2, metalness: 1.0, roughness: 0.08 }),
    grey: S({ color: 0x77797d, metalness: 0.2, roughness: 0.7 }),
    foam: S({ color: 0xc0601e, metalness: 0.0, roughness: 0.95 }),
    mma: S({ color: 0xf4f6fa, metalness: 1.0, roughness: 0.03 }),
    truss: S({ color: 0xa8a8a4, metalness: 0.6, roughness: 0.5 }),
  };
  for (const m of Object.values(MATS)) m.side = THREE.DoubleSide;
  return MATS;
}
const AXV = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };
const Y3 = new THREE.Vector3(0, 1, 0);
function orientAxis(mesh, ax) { mesh.quaternion.setFromUnitVectors(Y3, AXV[ax]); }

function jaggedPlate(size, seed, bend) {
  const sh = new THREE.Shape(), n = 7 + Math.floor(hash(seed) * 5);
  for (let i = 0; i < n; i++) { const a = i / n * 6.283, r = size * 0.5 * (0.45 + 0.6 * hash(seed + i * 3.1)); const x = Math.cos(a) * r, y = Math.sin(a) * r * (0.5 + hash(seed * 1.3) * 0.5); i ? sh.lineTo(x, y) : sh.moveTo(x, y); }
  const g = new THREE.ShapeGeometry(sh, 4), p = g.attributes.position;
  for (let i = 0; i < p.count; i++) { const x = p.getX(i), y = p.getY(i); p.setZ(i, (Math.sin(x / size * 5 + seed) * 0.12 + x * x / (size * size) * bend) * size); }
  g.computeVertexNormals(); return g;
}
function crumpledBox(sx, sy, sz, seed) {
  const g = new THREE.BoxGeometry(sx, sy, sz, 4, 4, 4), p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i), k = hash(seed + Math.round(x * 50) * 7 + Math.round(y * 50) * 13 + Math.round(z * 50) * 17) - 0.5;
    p.setXYZ(i, x * (1 + k * 0.25), y * (1 + k * 0.3), z * (1 + k * 0.35));
  }
  g.computeVertexNormals(); return g;
}
function trussMesh(s, mat) {
  const g = new THREE.Group(), L = Math.max(...s), ax = s.indexOf(L), dims = s.filter((_, i) => i !== ax), [A, B] = dims, t = 0.18;
  const along = ['x', 'y', 'z'][ax], others = ['x', 'y', 'z'].filter(a => a !== along);
  const vec = (a, b, c) => { const v = new THREE.Vector3(); v[along] = a; v[others[0]] = b; v[others[1]] = c; return v; };
  const bar = (p0, p1) => { const d = p1.clone().sub(p0), l = d.length(); const m = new THREE.Mesh(new THREE.BoxGeometry(t, l, t), mat); m.position.copy(p0).add(p1).multiplyScalar(0.5); m.quaternion.setFromUnitVectors(Y3, d.normalize()); g.add(m); };
  for (const [b, c] of [[-A / 2, -B / 2], [A / 2, -B / 2], [-A / 2, B / 2], [A / 2, B / 2]]) bar(vec(-L / 2, b, c), vec(L / 2, b, c));
  const bays = Math.max(1, Math.round(L / 3));
  for (let k = 0; k <= bays; k++) {
    const x = -L / 2 + L * k / bays;
    bar(vec(x, -A / 2, -B / 2), vec(x, A / 2, -B / 2)); bar(vec(x, -A / 2, B / 2), vec(x, A / 2, B / 2)); bar(vec(x, -A / 2, -B / 2), vec(x, -A / 2, B / 2)); bar(vec(x, A / 2, -B / 2), vec(x, A / 2, B / 2));
    if (k < bays) { const x2 = -L / 2 + L * (k + 1) / bays; bar(vec(x, -A / 2, -B / 2), vec(x2, A / 2, -B / 2)); bar(vec(x, -A / 2, B / 2), vec(x2, A / 2, B / 2)); bar(vec(x, -A / 2, -B / 2), vec(x2, -A / 2, B / 2)); }
  }
  return g;
}

export function buildModel(shape) {
  const M = materials(), g = new THREE.Group(); g.userData.panels = [];
  const mat = n => M[n] || M.grey;
  for (const p of shape.parts) {
    let m = null;
    const c = new THREE.Vector3(...(p.c || [0, 0, 0]));
    if (p.t === 'box') {
      const geo = p.crumple ? crumpledBox(...p.s, p.seed || 1) : new THREE.BoxGeometry(...p.s);
      const f = p.faces || {};
      m = new THREE.Mesh(geo, ['px', 'nx', 'py', 'ny', 'pz', 'nz'].map(k => mat(f[k] || p.m)));
      if (p.door) { m.geometry.translate(0, 0, 0); }
    } else if (p.t === 'truss') { m = trussMesh(p.s, mat('truss')); }
    else if (p.t === 'cyl') {
      m = new THREE.Mesh(new THREE.CylinderGeometry(p.r, p.r, p.l, p.hex ? 6 : 28, p.torn ? 6 : 1, false), mat(p.m)); orientAxis(m, p.ax);
      if (p.torn) { const pp = m.geometry.attributes.position; for (let i = 0; i < pp.count; i++) { const y = pp.getY(i); if (y > p.l * 0.2) { const k = hash((p.seed || 1) + i * 0.37); pp.setY(i, y - k * p.l * 0.5); pp.setX(i, pp.getX(i) * (1 + (k - 0.5) * 0.3)); } } m.geometry.computeVertexNormals(); }
    } else if (p.t === 'cone') { m = new THREE.Mesh(new THREE.CylinderGeometry(p.r2, p.r1, p.l, 28, 1, true), mat(p.m)); orientAxis(m, p.ax); }
    else if (p.t === 'sphere') m = new THREE.Mesh(new THREE.SphereGeometry(p.r, 32, 16), mat(p.m));
    else if (p.t === 'dish') {
      m = new THREE.Mesh(new THREE.SphereGeometry(p.r * 1.4, 24, 8, 0, 6.283, 0, 0.8), mat(p.m));
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), new THREE.Vector3(...p.n)); c.add(new THREE.Vector3(...p.n).multiplyScalar(p.r * 1.4 * 0.7));
    } else if (p.t === 'shard') {
      m = new THREE.Mesh(jaggedPlate(p.s, p.seed || 1, 0.4), mat(p.m));
      m.quaternion.setFromEuler(new THREE.Euler(hash(p.seed) * 6, hash(p.seed + 1) * 6, hash(p.seed + 2) * 6));
    } else if (p.t === 'panel') {
      const th = Math.max(0.02, Math.min(0.08, p.wb * 0.01));
      let geo;
      if (p.torn) { geo = jaggedPlate(Math.max(p.wa, p.wb), p.seed || 3, 0.3); geo.rotateY(Math.PI / 2); }
      else if (p.disc) { geo = new THREE.CylinderGeometry(p.wa / 2, p.wa / 2, th, 32); geo.rotateZ(Math.PI / 2); }
      else geo = new THREE.BoxGeometry(th, p.wa, p.wb);
      // local frame: x = normal, y = hinge axis A (wa), z = across (wb)
      const ms = p.torn || p.disc ? mat(p.front) : [mat(p.front), mat(p.back), mat('grey'), mat('grey'), mat('grey'), mat('grey')];
      if (!p.torn && !p.disc && p.wb > 3) {
        // the cell blanket texture repeats every ~1 m
        const fm = mat(p.front).clone(); if (fm.map) { fm.map = fm.map.clone(); fm.map.repeat.set(p.wb / 2, p.wa / 2); fm.map.needsUpdate = true; } ms[0] = fm;
      }
      m = new THREE.Mesh(geo, ms);
      const holder = new THREE.Group(); holder.add(m);
      if (p.grid && !p.torn) {
        // central mast between the two blankets of a big wing
        const mast = new THREE.Mesh(new THREE.BoxGeometry(0.3, p.wa, 0.3), mat('alu')); holder.add(mast);
      }
      g.add(holder); g.userData.panels.push({ p, obj: holder });
      continue;
    }
    if (!m) continue;
    m.position.copy(c); g.add(m);
  }
  g.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  poseModel(g, [1, 0, 0]);
  return g;
}
const _n = new THREE.Vector3(), _A = new THREE.Vector3(), _B = new THREE.Vector3(), _m4 = new THREE.Matrix4();
// sb: Sun direction in the body frame. Rotates every panel like the facet model does.
export function poseModel(g, sb) {
  const s = new THREE.Vector3(...sb).normalize();
  for (const { p, obj } of g.userData.panels) {
    const a0 = new THREE.Vector3(...p.a), n0 = new THREE.Vector3(...p.n0);
    if (p.track === 2) {
      const gim = new THREE.Vector3(...p.g);
      _A.copy(gim).cross(s); if (_A.lengthSq() < 1e-8) _A.copy(a0); _A.normalize(); if (_A.dot(a0) < 0) _A.negate();
      _n.copy(s);
      const piv = new THREE.Vector3(...p.piv);
      obj.position.copy(piv).addScaledVector(_A, p.off);
    } else if (p.track === 1) {
      _A.copy(a0); _n.copy(s).addScaledVector(a0, -s.dot(a0)); if (_n.lengthSq() < 1e-8) _n.copy(n0); _n.normalize();
      obj.position.set(...p.c);
    } else { _n.copy(n0).normalize(); _A.copy(a0).addScaledVector(_n, -a0.dot(_n)).normalize(); obj.position.set(...p.c); }
    if (p.lift) obj.position.addScaledVector(_n, p.lift);
    _B.copy(_n).cross(_A);
    _m4.makeBasis(_n, _A, _B); obj.quaternion.setFromRotationMatrix(_m4);
  }
}
export function disposeModel(g) { g.traverse(o => { if (o.geometry) o.geometry.dispose(); }); }
