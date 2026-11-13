// Orbit view: the Earth from far away with every tracked object as a dot (inertial TEME frame, km), coloured by
// type, dim in the Earth's shadow; the selected object's orbit; the observer's place.
import * as THREE from '../vendor/three.module.min.js';
import { makeEarth, meterEarth } from './earth.js';
import { gmst, sunTEME, ecefToTeme, DEG } from './frames.js';
import { propagate } from './sgp.js';

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
export class OrbitView {
  constructor(app, renderer) {
    this.app = app; this.r = renderer; this.earth = makeEarth(); this.earth.U.uSteps.value = 10;
    this.cam = new THREE.PerspectiveCamera(45, 1, 10, 2e6); this.cam.up.set(0, 0, 1);
    this.yaw = 30; this.pitch = 25; this.dist = 42000; this.target = new THREE.Vector3();
    const N = app.tracker.N, g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3).setUsage(THREE.DynamicDrawUsage));
    const kind = new Float32Array(N); app.tracker.objs.forEach((o, i) => kind[i] = o.type === 0 ? (o.ops === '+' || o.ops === 'P' || o.ops === 'B' || o.ops === 'X' ? 0 : 1) : o.type === 1 ? 2 : o.type === 2 ? 3 : 4);
    g.setAttribute('kind', new THREE.BufferAttribute(kind, 1));
    g.setAttribute('lit', new THREE.BufferAttribute(new Float32Array(N), 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('show', new THREE.BufferAttribute(new Float32Array(N).fill(1), 1).setUsage(THREE.DynamicDrawUsage));
    this.ptsU = { uCam: { value: new THREE.Vector3() }, uSize: { value: 2 }, uSel: { value: -1 } };
    const m = new THREE.ShaderMaterial({
      uniforms: this.ptsU, transparent: true, depthTest: false, blending: THREE.AdditiveBlending,
      vertexShader: `attribute float kind, lit, show; uniform vec3 uCam; uniform float uSize; out vec3 vC; out float vA;
        void main(){
          vec3 p = position; vec3 d = p - uCam; float L = length(d); d /= L;
          float b = dot(uCam, d), c = dot(uCam, uCam) - 6371.0*6371.0, h = b*b - c;
          bool hid = h > 0.0 && (-b - sqrt(h)) > 0.0 && (-b - sqrt(h)) < L;
          vC = kind < 0.5 ? vec3(0.35, 1.0, 0.55) : kind < 1.5 ? vec3(0.55, 0.75, 1.0) : kind < 2.5 ? vec3(1.0, 0.65, 0.3) : kind < 3.5 ? vec3(1.0, 0.35, 0.35) : vec3(0.8, 0.8, 0.8);
          vA = (hid || show < 0.5 || length(p) < 1.0) ? 0.0 : mix(0.28, 1.0, lit);
          gl_PointSize = uSize; gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: `in vec3 vC; in float vA; void main(){ vec2 q = gl_PointCoord*2.0 - 1.0; float r = dot(q, q); if (r > 1.0 || vA <= 0.0) discard; gl_FragColor = vec4(vC*vA*(1.0 - r*0.6), 1.0); }`,
    });
    this.pts = new THREE.Points(g, m); this.pts.frustumCulled = false;
    this.scene = new THREE.Scene(); this.scene.add(this.pts);
    this.orbitLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffc860, transparent: true, opacity: 0.85 }));
    this.orbitLine.frustumCulled = false; this.scene.add(this.orbitLine);
    this.selMark = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffd080 })); this.scene.add(this.selMark);
    this.obsMark = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), new THREE.MeshBasicMaterial({ color: 0xff6040 })); this.scene.add(this.obsMark);
    // stars behind
    this.bg = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ size: 1, sizeAttenuation: false, color: 0x3a4255 }));
    const sp = []; for (let k = 0; k < 2500; k++) { const u = Math.random() * 2 - 1, t = Math.random() * 6.283, q = Math.sqrt(1 - u * u); sp.push(q * Math.cos(t) * 1e6, q * Math.sin(t) * 1e6, u * 1e6); }
    this.bg.geometry.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3)); this.bgScene = new THREE.Scene(); this.bgScene.add(this.bg);
  }
  frame(dt, ms, w, h, dpr) {
    const app = this.app, T = app.tracker, E = this.earth.U;
    if (!this.aimed) { const s0 = sunTEME(ms); this.yaw = Math.atan2(s0[1], s0[0]) / DEG + 35; this.pitch = 20; this.aimed = true; }
    const cam = this.cam, cp = Math.cos(this.pitch * DEG), d = new THREE.Vector3(cp * Math.cos(this.yaw * DEG), cp * Math.sin(this.yaw * DEG), Math.sin(this.pitch * DEG));
    if (this.follow && app.sel >= 0) this.target.lerp(new THREE.Vector3(T.pos[app.sel * 3], T.pos[app.sel * 3 + 1], T.pos[app.sel * 3 + 2]), 1 - Math.exp(-dt * 4)); else this.target.multiplyScalar(Math.exp(-dt * 4));
    cam.position.copy(this.target).addScaledVector(d, this.dist); cam.lookAt(this.target); cam.aspect = w / h; cam.near = Math.max(1, this.dist * 0.01); cam.far = this.dist + 2e6; cam.updateProjectionMatrix(); cam.updateMatrixWorld();
    const s = sunTEME(ms);
    E.uCam.value.copy(cam.position); E.uInvPV.value.copy(cam.projectionMatrixInverse).premultiply(cam.matrixWorld);
    E.uSun.value.set(s[0], s[1], s[2]); E.uG.value = gmst(ms); E.uTime.value = (ms / 1000) % 1e5;
    if ((this.fn = (this.fn || 0) + 1) % 8 === 1) { const m = meterEarth(this.r, this.earth, cam); if (m) this.la = m.La; }
    this.adapt = Math.exp((Math.log(this.adapt || 3000) * 0.85 + Math.log(Math.max(this.la || 3000, 2e-3)) * 0.15));
    E.uExposure.value = Math.min(0.8 / this.adapt, 3) * Math.pow(2, app.ev);
    E.uMoonE.value = 0.1;
    // dots
    const g = this.pts.geometry, P = g.attributes.position.array, Lt = g.attributes.lit.array, S = g.attributes.show.array, f = app.filter;
    for (let i = 0; i < T.N; i++) {
      P[i * 3] = T.pos[i * 3]; P[i * 3 + 1] = T.pos[i * 3 + 1]; P[i * 3 + 2] = T.pos[i * 3 + 2];
      Lt[i] = T.litAll ? T.litAll[i] : 1; S[i] = f && !f(i) ? 0 : 1;
    }
    g.attributes.position.needsUpdate = true; g.attributes.lit.needsUpdate = true; g.attributes.show.needsUpdate = true;
    this.ptsU.uCam.value.copy(cam.position); this.ptsU.uSize.value = clamp(2.2 * dpr * Math.sqrt(42000 / this.dist), 1.5 * dpr, 6 * dpr);
    const sc = this.dist / 900;
    if (app.sel >= 0) { this.selMark.visible = true; this.selMark.position.set(T.pos[app.sel * 3], T.pos[app.sel * 3 + 1], T.pos[app.sel * 3 + 2]); this.selMark.scale.setScalar(sc * 2.2); } else this.selMark.visible = false;
    this.obsMark.position.set(...ecefToTeme(app.obs.pos, gmst(ms))); this.obsMark.scale.setScalar(sc * 1.6);
    if (app.sel !== this.orbitFor || Math.abs(ms - (this.orbitT || 0)) > 60e3) this.makeOrbit(ms);
    const R = this.r;
    R.setRenderTarget(app.post.rt); R.setClearColor(0, 1); R.clear();
    R.render(this.bgScene, cam);
    R.render(this.earth.scene, cam);
    R.render(this.scene, cam);
    app.post.final.mat.uniforms.uScot.value = 0;
    app.post.finish();
    const ov = app.overlay; ov.begin(w, h); const c = ov.ctx;
    c.font = '11px system-ui, sans-serif'; c.textAlign = 'left';
    const leg = [['Active payload', '#5f8'], ['Inactive payload', '#8bf'], ['Rocket body', '#fa5'], ['Debris', '#f66'], ['Unknown', '#ccc']];
    leg.forEach(([t, col], k) => { c.fillStyle = col; c.fillRect(12, 70 + k * 16, 8, 8); c.fillStyle = 'rgba(220,230,255,0.85)'; c.fillText(t, 26, 78 + k * 16); });
    ov.end();
  }
  makeOrbit(ms) {
    const T = this.app.tracker, i = this.app.sel; this.orbitFor = i; this.orbitT = ms;
    if (i < 0 || !T.selRec) { this.orbitLine.visible = false; return; }
    const st = new Float64Array(6), pts = [], per = 1440 / T.objs[i].n * 60e3;
    for (let k = 0; k <= 240; k++) if (propagate(T.selRec, ms + per * (k / 240 - 0.5), st)) pts.push(st[0], st[1], st[2]);
    this.orbitLine.geometry.dispose(); this.orbitLine.geometry = new THREE.BufferGeometry(); this.orbitLine.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3)); this.orbitLine.visible = true;
  }
  pick(x, y, w, h) {
    const T = this.app.tracker, v = new THREE.Vector3(); let best = -1, bd = 18;
    for (let i = 0; i < T.N; i++) {
      if (this.app.filter && !this.app.filter(i)) continue;
      v.set(T.pos[i * 3], T.pos[i * 3 + 1], T.pos[i * 3 + 2]).project(this.cam); if (v.z > 1) continue;
      const px = (v.x * 0.5 + 0.5) * w, py = (0.5 - v.y * 0.5) * h, d = Math.hypot(px - x, py - y); if (d < bd) { bd = d; best = i; }
    }
    return best;
  }
}
