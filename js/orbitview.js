// Orbit view: the Earth from far away with every tracked object as a dot (inertial TEME frame, km), coloured by
// type, dim in the Earth's shadow; the selected object's orbit; the observer's place.
import * as THREE from '../vendor/three.module.min.js';
import { makeEarth, meterEarth } from './earth.js';
import { gmst, sunTEME, ecefToTeme, DEG } from './frames.js';
import { sunMoonTEME, setEarthEclipse } from './eclipse.js';
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
    this.makeSunMoon();
  }
  // The Sun (a limb-darkened disc in its true direction: it is so far that only the direction matters) and the Moon
  // (a real-size sphere at its true geocentric position, lit by the Sun, near side toward the Earth, and darkened and
  // reddened by the Earth's shadow during a lunar eclipse)
  makeSunMoon() {
    this.sunU = { uExp: { value: 1 } };
    this.sunMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
      uniforms: this.sunU, depthTest: false, depthWrite: false, transparent: true, blending: THREE.AdditiveBlending,
      vertexShader: 'out vec2 vQ; void main(){ vQ = position.xy*1.04; gl_Position = projectionMatrix*modelViewMatrix*vec4(position, 1.0); }',
      fragmentShader: `in vec2 vQ; uniform float uExp;
        void main(){ float r2 = dot(vQ, vQ); if (r2 > 1.0) discard; float mu = sqrt(1.0 - r2);
          vec3 L = vec3(1.0, 0.985, 0.95)*1.27e5*2.15e4*(0.4 + 0.6*mu)*smoothstep(1.0, 0.96, r2);
          gl_FragColor = vec4(min(L*uExp, vec3(3.0e4)), 1.0); }`,
    }));
    this.sunMesh.frustumCulled = false; this.sunMesh.renderOrder = 5; this.bgScene.add(this.sunMesh);
    const tex = new THREE.TextureLoader().load('data/moon.jpg', t => { t.wrapS = THREE.RepeatWrapping; t.needsUpdate = true; this.moonU.uOK.value = 1; });
    this.moonU = { uS: { value: new THREE.Vector3(1, 0, 0) }, uMap: { value: tex }, uOK: { value: 0 }, uExp: { value: 1 }, uC: { value: new THREE.Vector3() } };
    this.moonMesh = new THREE.Mesh(new THREE.SphereGeometry(1737.4, 64, 32), new THREE.ShaderMaterial({
      uniforms: this.moonU, depthTest: false, depthWrite: false,
      vertexShader: 'out vec3 vN, vP; void main(){ vN = normalize(mat3(modelMatrix)*normal); vec4 w = modelMatrix*vec4(position, 1.0); vP = w.xyz; gl_Position = projectionMatrix*viewMatrix*w; }',
      fragmentShader: `in vec3 vN, vP; uniform vec3 uS, uC; uniform sampler2D uMap; uniform float uOK, uExp;
        void main(){
          vec3 n = normalize(vN);
          vec3 ex = normalize(-uC), ey = normalize(cross(vec3(0.0, 0.0, 1.0), ex)), ez = cross(ex, ey);
          float lon = atan(dot(n, ey), dot(n, ex)), lat = asin(clamp(dot(n, ez), -1.0, 1.0));
          float gm = texture(uMap, vec2(0.5 + lon/6.2831853, 0.5 + lat/3.14159265)).r;
          float alb = uOK > 0.5 ? 0.12*pow(gm, 1.3)/0.4224 : 0.12;
          float ci = max(dot(n, uS), 0.0), ce = max(dot(n, normalize(cameraPosition - vP)), 0.0);
          float ls = ci > 0.0 ? 2.0*ci/(ci + ce + 1e-4) : 0.0;   // Lommel-Seeliger, as in the sky view
          // the Earth's shadow (same law as the Sky view's lunar eclipse)
          float D = -dot(vP, uS), k = 1.0; vec3 tint = vec3(1.0), red = vec3(2.2, 0.62, 0.22);
          if (D > 0.0) {
            float rho = length(vP + uS*D), ru = 6498.4 - D*(696000.0 - 6498.4)/1.496e8, rp = 6498.4 + D*(696000.0 + 6498.4)/1.496e8;
            if (rho < rp) {
              if (rho > ru) { float x = (rho - ru)/(rp - ru); k = 0.0025 + 0.9975*pow(x, 1.15); tint = mix(vec3(1.0), red, clamp(1.0 - x*6.0, 0.0, 1.0)*0.5); }
              else { float u = rho/max(ru, 1.0); k = 2.5e-4 + 1.8e-3*pow(u, 4.0); tint = red; }
            }
          }
          vec3 L = vec3(1.0, 0.96, 0.9)*1.27e5*alb/3.14159265*ls*k*tint;
          gl_FragColor = vec4(min(L*uExp, vec3(3.0e4)), 1.0);
        }`,
    }));
    this.moonMesh.frustumCulled = false; this.moonScene = new THREE.Scene(); this.moonScene.add(this.moonMesh);
  }
  frame(dt, ms, w, h, dpr) {
    const app = this.app, T = app.tracker, E = this.earth.U;
    if (!this.aimed) { const s0 = sunTEME(ms); this.yaw = Math.atan2(s0[1], s0[0]) / DEG + 35; this.pitch = 20; this.aimed = true; }
    const cam = this.cam, cp = Math.cos(this.pitch * DEG), d = new THREE.Vector3(cp * Math.cos(this.yaw * DEG), cp * Math.sin(this.yaw * DEG), Math.sin(this.pitch * DEG));
    if (this.follow && app.sel >= 0) this.target.lerp(new THREE.Vector3(T.pos[app.sel * 3], T.pos[app.sel * 3 + 1], T.pos[app.sel * 3 + 2]), 1 - Math.exp(-dt * 4)); else this.target.multiplyScalar(Math.exp(-dt * 4));
    cam.position.copy(this.target).addScaledVector(d, this.dist); cam.lookAt(this.target); cam.aspect = w / h; cam.near = Math.max(1, this.dist * 0.01); cam.far = this.dist + 2e6; cam.updateProjectionMatrix(); cam.updateMatrixWorld();
    const s = sunTEME(ms);
    E.uCam.value.copy(cam.position); E.uInvPV.value.copy(cam.projectionMatrixInverse).premultiply(cam.matrixWorld.clone().setPosition(0, 0, 0));
    E.uSun.value.set(s[0], s[1], s[2]); E.uG.value = gmst(ms); E.uTime.value = (ms / 1000) % 1e5;
    if ((this.fn = (this.fn || 0) + 1) % 8 === 1) { const m = meterEarth(this.r, this.earth, cam); if (m) this.la = m.La; }
    this.adapt = Math.exp((Math.log(this.adapt || 3000) * 0.85 + Math.log(Math.max(this.la || 3000, 2e-3)) * 0.15));
    E.uExposure.value = Math.min(0.8 / this.adapt, 3) * Math.pow(2, app.ev);
    let smp = null;
    try { smp = sunMoonTEME(ms); E.uSun.value.set(...smp.sun).normalize(); setEarthEclipse(E, smp, Math.pow(10, -0.4 * (app.moonMag + 13.99)) || 0.1); } catch { E.uMoonE.value = 0.1; }
    const sDir = E.uSun.value.clone().normalize();
    {   // Sun: a disc 0.53 deg across, a million km out along its direction (well inside the far plane)
      const sd = smp ? Math.hypot(...smp.sun) : 1.496e8, R = Math.atan(696000 / sd) * 1e6;
      this.sunMesh.position.copy(cam.position).addScaledVector(sDir, 1e6); this.sunMesh.quaternion.copy(cam.quaternion); this.sunMesh.scale.setScalar(R);
      this.sunU.uExp.value = E.uExposure.value;
    }
    if (smp) {
      this.moonMesh.position.set(...smp.moon); this.moonU.uC.value.set(...smp.moon); this.moonU.uS.value.copy(sDir); this.moonU.uExp.value = E.uExposure.value;
    }
    // dots
    const g = this.pts.geometry, P = g.attributes.position.array, Lt = g.attributes.lit.array, S = g.attributes.show.array, f = app.filter;
    for (let i = 0; i < T.N; i++) {
      P[i * 3] = T.pos[i * 3]; P[i * 3 + 1] = T.pos[i * 3 + 1]; P[i * 3 + 2] = T.pos[i * 3 + 2];
      // decayed (orbit no longer computable) or below 78 km: burned up, not shown (it used to sit frozen in place)
      const gone = (T.seg && !T.seg.ok[i]) || P[i * 3] * P[i * 3] + P[i * 3 + 1] * P[i * 3 + 1] + P[i * 3 + 2] * P[i * 3 + 2] < 6449 * 6449;
      Lt[i] = T.litAll ? T.litAll[i] : 1; S[i] = gone || (f && !f(i)) ? 0 : 1;
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
    // the Moon in front of the Earth only when it is nearer to the camera than the Earth is
    const moonFirst = cam.position.distanceTo(this.moonMesh.position) > cam.position.length();
    if (moonFirst) R.render(this.moonScene, cam);
    R.render(this.earth.scene, cam);
    if (!moonFirst) R.render(this.moonScene, cam);
    R.render(this.scene, cam);
    // the eye's glare around the Sun when the Earth does not hide it (its limb and air included)
    const sunHidden = (() => { const c = cam.position, b = c.dot(sDir); return b < 0 && c.clone().addScaledVector(sDir, -b).length() < 6371 + 60; })();
    const sv = cam.position.clone().addScaledVector(sDir, 1e6).applyMatrix4(cam.matrixWorldInverse);
    if (!sunHidden && sv.z < 0) { sv.applyMatrix4(cam.projectionMatrix); const W = app.post.rt.width, H = app.post.rt.height; app.post.sunStar([(sv.x * 0.5 + 0.5) * W, (sv.y * 0.5 + 0.5) * H], [0.5, 0.49, 0.47], Math.min(W, H) * 0.16); }
    app.post.final.mat.uniforms.uScot.value = 0;
    app.post.finish();
    const ov = app.overlay; ov.begin(w, h); const c = ov.ctx;
    c.font = '11px system-ui, sans-serif'; c.textAlign = 'left';
    const leg = [['Active payload', '#5f8'], ['Inactive payload', '#8bf'], ['Rocket body', '#fa5'], ['Debris', '#f66'], ['Unknown', '#ccc']];
    leg.forEach(([t, col], k) => { c.fillStyle = col; c.fillRect(12, 70 + k * 16, 8, 8); c.fillStyle = 'rgba(220,230,255,0.85)'; c.fillText(t, 26, 78 + k * 16); });
    // labels for the Sun and the Moon (only when not behind the Earth)
    c.font = '12px system-ui, sans-serif'; c.fillStyle = 'rgba(255,225,170,0.9)';
    const hiddenBy = (p) => { const cp = cam.position, dx = p.x - cp.x, dy = p.y - cp.y, dz = p.z - cp.z, L = Math.hypot(dx, dy, dz), b = (cp.x * dx + cp.y * dy + cp.z * dz) / L, cc = cp.lengthSq() - 6371 * 6371, di = b * b - cc; return di > 0 && -b - Math.sqrt(di) > 0 && -b - Math.sqrt(di) < L; };
    for (const [name, p] of [['Sun', cam.position.clone().addScaledVector(sDir, 1e6)], ['Moon', this.moonMesh.position]]) {
      if (hiddenBy(p)) continue; const v = p.clone().project(cam); if (v.z > 1 || Math.abs(v.x) > 1.1 || Math.abs(v.y) > 1.1) continue;
      c.fillText(name, (v.x * 0.5 + 0.5) * w + 8, (0.5 - v.y * 0.5) * h - 8);
    }
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
      const px = T.pos[i * 3], py = T.pos[i * 3 + 1], pz = T.pos[i * 3 + 2];
      // hidden behind the Earth from the camera: not pickable (the dot isn't drawn either)
      const cp = this.cam.position, dx = px - cp.x, dy = py - cp.y, dz = pz - cp.z, L = Math.hypot(dx, dy, dz);
      const b = (cp.x * dx + cp.y * dy + cp.z * dz) / L, c = cp.lengthSq() - 6371 * 6371, disc = b * b - c;
      if (disc > 0 && -b - Math.sqrt(disc) > 0 && -b - Math.sqrt(disc) < L) continue;
      v.set(px, py, pz).project(this.cam); if (v.z > 1) continue;
      const sx = (v.x * 0.5 + 0.5) * w, sy = (0.5 - v.y * 0.5) * h, d = Math.hypot(sx - x, sy - y); if (d < bd) { bd = d; best = i; }
    }
    return best;
  }
}
