// View from orbit: the selected satellite's model with the Earth below, from a chase camera or from on board.
// Frames: TEME km for the Earth and other objects, metres around the satellite for its model; stars and planets
// rotated from J2000 into the true equator of date (~TEME).
import * as THREE from '../vendor/three.module.min.js';
import { makeEarth } from './earth.js';
import { makeStars, makeMoon, makePlanets, milkyWayPhoto, makeFaintStars, starMaterial } from './sky.js';
import { buildModel, poseModel, disposeModel } from './models3d.js';
import { gmst, sunTEME, moonTEME, DEG } from './frames.js';
import { propagate } from './sgp.js';
import { sunlight, earthshine, bodyFrame, facetsIntensity, magFromI, spherePhase } from './light.js';
import { EQ2GAL } from './astro.js';

const clamp = (x, a, b) => Math.max(a, Math.min(b, x)), lerp = (a, b, t) => a + (b - a) * t;
const A = () => window.Astronomy;

export class SpaceView {
  constructor(app, renderer, assets) {
    this.app = app; this.r = renderer;
    this.earth = makeEarth();
    this.cam = new THREE.PerspectiveCamera(60, 1, 0.1, 1e6); this.cam.up.set(0, 0, 1);
    this.yaw = 200; this.pitch = 12; this.dist = 3; this.fov = 60; this.onboard = false;
    const U = this.U = {
      uSkyLUT: { value: blackTex() }, uSkyLUTLow: { value: blackTex() }, uExposure: { value: 1 }, uSunDir: { value: new THREE.Vector3() }, uMoonDir: { value: new THREE.Vector3() },
      uSunE: { value: new THREE.Vector3(1.27e5, 1.25e5, 1.2e5) }, uMoonE: { value: new THREE.Vector3() }, uAOD: { value: 0 }, uTime: { value: 0 }, uRefrK: { value: 0 }, uSunSquish: { value: 1 }, uMoonSquish: { value: 1 },
      uNight: { value: 0 }, uSnow: { value: 0 }, uWet: { value: 0 }, uVisKm: { value: 100 }, uOvercast: { value: 0 }, uFlash: { value: new THREE.Vector4() }, uNoAtm: { value: 1 },
      uEqToWorld: { value: new THREE.Matrix3() }, uMW: { value: milkyWayPhoto() }, uGal: { value: new THREE.Matrix3().set(...EQ2GAL) }, uInvProjView: { value: new THREE.Matrix4() }, uCamPos: { value: new THREE.Vector3() },
    };
    this.sky = new THREE.Scene();
    this.sky.add(this.bgMesh());
    this.stars = makeStars(U, assets.stars); this.sky.add(this.stars);
    makeFaintStars(U).then(p => this.sky.add(p)).catch(() => { });
    this.planets = makePlanets(U); this.sky.add(this.planets);
    this.moon = makeMoon(U); this.sky.add(this.moon);
    // other satellites seen from here
    const MAX = 4000, g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX * 3), 3)); g.setAttribute('mag', new THREE.BufferAttribute(new Float32Array(MAX), 1)); g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(MAX * 3).fill(1), 3));
    g.setDrawRange(0, 0); this.others = new THREE.Points(g, starMaterial(U, false)); this.others.frustumCulled = false; this.MAX = MAX;
    this.oScene = new THREE.Scene(); this.oScene.add(this.others);
    // model
    this.mScene = new THREE.Scene();
    this.sunL = new THREE.DirectionalLight(0xffffff, 1); this.sunL.castShadow = true; this.sunL.shadow.mapSize.set(2048, 2048); this.sunL.shadow.bias = -0.0005;
    this.esL = new THREE.DirectionalLight(0xbcd4ff, 0); this.amb = new THREE.AmbientLight(0x6a7a90, 0);
    this.mScene.add(this.sunL, this.sunL.target, this.esL, this.esL.target, this.amb);
    this.adapt = 100; this.measureRT = new THREE.WebGLRenderTarget(48, 32, { type: THREE.HalfFloatType });
    this.mBuf = new Uint16Array(48 * 32 * 4);
  }
  bgMesh() {
    // black sky, Milky Way photo and the Sun's limb-darkened disc
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    const m = new THREE.ShaderMaterial({
      uniforms: this.U, depthTest: false, depthWrite: false,
      vertexShader: `out vec3 vDir; uniform mat4 uInvProjView; uniform vec3 uCamPos; void main(){ vec4 w = uInvProjView * vec4(position.xy, 0.5, 1.0); vDir = w.xyz/w.w - uCamPos; gl_Position = vec4(position.xy, 1.0, 1.0); }`,
      fragmentShader: `in vec3 vDir; uniform sampler2D uMW; uniform mat3 uEqToWorld, uGal; uniform vec3 uSunDir, uSunE; uniform float uExposure;
        void main(){ vec3 d = normalize(vDir);
          vec3 g = uGal * (transpose(uEqToWorld) * d); float gl = atan(g.y, g.x), gb = asin(clamp(g.z, -1.0, 1.0));
          vec2 uv = vec2(0.5 - gl/6.2831853, 0.5 + gb/3.14159265); vec2 gx = dFdx(uv), gy = dFdy(uv); gx.x -= floor(gx.x + 0.5); gy.x -= floor(gy.x + 0.5);
          vec3 mw = textureGrad(uMW, uv, gx, gy).rgb; mw *= mw;
          vec3 col = mw*1.3e-3*1.25*uExposure;
          float r = acos(clamp(dot(d, uSunDir), -1.0, 1.0)), R = 0.00465;
          if (r < R) { float mu = sqrt(1.0 - (r/R)*(r/R)); col += uSunE*2.15e4*(0.4 + 0.6*mu)*uExposure; }
          // faint zodiacal-free solar corona glow in the eye/lens
          col += uSunE*uExposure*2.0e-7/(pow(r/R, 2.5) + 0.2);
          gl_FragColor = vec4(min(col, vec3(3.0e4)), 1.0); }`,
    });
    const mesh = new THREE.Mesh(g, m); mesh.frustumCulled = false; mesh.renderOrder = -100; return mesh;
  }
  // J2000 -> true equator of date (TEME within arcseconds)
  eqToTeme(ms) {
    const rot = A().Rotation_EQJ_EQD(A().MakeTime(new Date(ms))), r = rot.rot;   // column-major rot[i][j]
    return [r[0][0], r[1][0], r[2][0], r[0][1], r[1][1], r[2][1], r[0][2], r[1][2], r[2][2]];
  }
  frame(dt, ms, w, h, dpr) {
    const app = this.app, T = app.tracker, i = app.sel, U = this.U, E = this.earth.U;
    if (i < 0) return false;
    // exact state of the satellite
    const st = new Float64Array(6);
    if (!T.selRec || !propagate(T.selRec, ms, st)) return false;
    const r = [st[0], st[1], st[2]], v = [st[3], st[4], st[5]];
    const rv = new THREE.Vector3(...r), up = rv.clone().normalize(), vel = new THREE.Vector3(...v);
    const fwd = vel.clone().addScaledVector(up, -vel.dot(up)).normalize(), right = fwd.clone().cross(up);
    const s = sunTEME(ms), sun = new THREE.Vector3(s[0], s[1], s[2]);
    const mp = moonTEME(ms), moonV = new THREE.Vector3(...mp).sub(rv), moonD = moonV.length(); moonV.normalize();
    // model
    if (this.modelIdx !== i) {
      if (this.model) { this.mScene.remove(this.model); disposeModel(this.model); }
      this.modelIdx = i; this.shape = T.shape(i); this.model = buildModel(this.shape); this.mScene.add(this.model);
      this.dist = Math.max(0.12, this.shape.size * 1.8);
      const sc = this.sunL.shadow.camera, z = this.shape.size * 0.6; sc.left = sc.bottom = -z; sc.right = sc.top = z; sc.near = 0.1; sc.far = this.shape.size * 4; sc.updateProjectionMatrix();
    }
    const B = bodyFrame(this.shape.att, r, v, s, ms, T.objs[i].id);
    this.model.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(...B.x), new THREE.Vector3(...B.y), new THREE.Vector3(...B.z)));
    this.model.position.set(0, 0, 0);
    poseModel(this.model, [B.x[0] * s[0] + B.x[1] * s[1] + B.x[2] * s[2], B.y[0] * s[0] + B.y[1] * s[1] + B.y[2] * s[2], B.z[0] * s[0] + B.z[1] * s[1] + B.z[2] * s[2]]);
    // camera: chase (orbits the model in its local horizon frame) or on board (looking out from the satellite)
    const cy = Math.cos(this.yaw * DEG), sy = Math.sin(this.yaw * DEG), cp = Math.cos(this.pitch * DEG), sp = Math.sin(this.pitch * DEG);
    const dirL = fwd.clone().multiplyScalar(cp * cy).addScaledVector(right, cp * sy).addScaledVector(up, sp);
    const cam = this.cam; cam.fov = this.fov; cam.aspect = w / h; cam.up.copy(up);
    if (this.onboard) { cam.position.set(0, 0, 0).addScaledVector(up, this.shape.size * 0.05); cam.lookAt(dirL.clone().multiplyScalar(-1e3)); cam.near = 0.05; cam.far = 1e7; }
    else { cam.position.copy(dirL).multiplyScalar(this.dist); cam.lookAt(0, 0, 0); cam.near = Math.max(0.05, this.dist - this.shape.size * 1.2); cam.far = this.dist + this.shape.size * 3; }
    if (cam.near >= cam.far) cam.near = cam.far * 0.01;
    cam.updateProjectionMatrix(); cam.updateMatrixWorld();
    // sky camera (direction only) and Earth camera (km, TEME)
    const skyCam = this.skyCam || (this.skyCam = new THREE.PerspectiveCamera());
    skyCam.copy(cam); skyCam.position.set(0, 0, 0); skyCam.near = 0.1; skyCam.far = 1e7; skyCam.updateProjectionMatrix(); skyCam.updateMatrixWorld();
    const camKm = rv.clone().addScaledVector(cam.position, 1e-3);
    E.uCam.value.copy(camKm); E.uInvPV.value.copy(skyCam.projectionMatrixInverse).premultiply(skyCam.matrixWorld);
    // the inverse projection gives directions around the origin; the shader adds uCam back, so shift the matrix
    E.uInvPV.value.premultiply(new THREE.Matrix4().makeTranslation(camKm.x, camKm.y, camKm.z));
    E.uSun.value.copy(sun); E.uMoon.value.copy(new THREE.Vector3(...mp).normalize()); E.uG.value = gmst(ms); E.uTime.value = (ms / 1000) % 1e5;
    E.uMoonE.value = Math.pow(10, -0.4 * (this.app.moonMag + 13.99)) || 0.1;
    // sky uniforms
    const eq = this.eqToTeme(ms); U.uEqToWorld.value.set(...eq);
    U.uSunDir.value.copy(sun); U.uMoonDir.value.copy(moonV);
    U.uInvProjView.value.copy(skyCam.projectionMatrixInverse).premultiply(skyCam.matrixWorld); U.uCamPos.value.set(0, 0, 0);
    U.uMoonE.value.set(1, 0.94, 0.86).multiplyScalar(E.uMoonE.value);
    const ml = sun.clone().multiplyScalar(1.496e8).sub(new THREE.Vector3(...mp)).normalize(); U.uMoonLight.value.copy(ml);
    U.uMoonRadius.value = Math.atan(1737.4 / moonD); U.uMoonLum.value = 2900; U.uMoonGain.value = 1; U.uMoonAvg.value = 2900 * 0.3;
    if (this.app.planetsTEME) { const P = this.planets.geometry.attributes.position.array, M = this.planets.geometry.attributes.mag.array; this.app.planetsTEME.forEach((p, k) => { P.set(p.v, k * 3); M[k] = p.mag; }); this.planets.geometry.attributes.position.needsUpdate = true; this.planets.geometry.attributes.mag.needsUpdate = true; }
    // exposure: measured from the Earth in view (log average), plus the sunlit model when it fills the view
    if ((this.fn = (this.fn || 0) + 1) % 6 === 1) this.measure();
    const L = sunlight(r, s, s.dist, [1, 1, 1]), Lv = 0.2126 * L[0] + 0.7152 * L[1] + 0.0722 * L[2];
    let La = Math.max(this.earthLa || 1e-3, 2e-4);
    if (!this.onboard) La = Math.max(La, Lv * 1.27e5 * 0.6 / Math.PI * 0.35 * clamp(this.shape.size / this.dist, 0.15, 1));
    if (dot3(sun, skyDir(skyCam)) > Math.cos(cam.fov * DEG * 0.6)) La = Math.max(La, 3000);
    this.adapt = Math.exp(lerp(Math.log(this.adapt), Math.log(La), 1 - Math.exp(-dt * 2.5)));
    // camera-like exposure (photographs from orbit): mid-tones of what is lit map to ~0.8
    let Ex = 0.8 / this.adapt * Math.pow(2, app.ev);
    Ex = Math.min(Ex, 3 * Math.pow(2, app.ev));   // night side: exposed for the city lights, like a long ISS exposure
    U.uExposure.value = Ex; E.uExposure.value = Ex;
    const pxRad = (cam.fov * DEG) / (h * dpr); U.uPxSr.value = pxRad * pxRad; U.uPxScale.value = dpr; U.uZoomGain.value = clamp(2.2 * Math.log10(60 / cam.fov), 0, 3); U.uTime.value = performance.now() / 1000;
    app.post.final.mat.uniforms.uScot.value = 0;
    // lights on the model
    const es = earthshine(r, s);
    this.sunL.position.copy(sun).multiplyScalar(this.shape.size * 2); this.sunL.target.position.set(0, 0, 0);
    this.sunL.color.setRGB(L[0] / Math.max(Lv, 1e-6), L[1] / Math.max(Lv, 1e-6), L[2] / Math.max(Lv, 1e-6)); this.sunL.intensity = 1.27e5 * Lv * Ex;
    this.esL.position.copy(up).multiplyScalar(-this.shape.size * 2); this.esL.target.position.set(0, 0, 0); this.esL.intensity = 1.27e5 * es * Ex * 0.8;
    this.amb.intensity = 1.27e5 * Ex * (es * 0.15 + 2e-8);
    // other satellites near this one (within 3000 km), with their brightness as seen from here
    this.updateOthers(ms, rv, sun, s);
    // render
    const R = this.r;
    R.setRenderTarget(app.post.rt); R.setClearColor(0, 1); R.clear();
    R.render(this.sky, skyCam);
    R.render(this.oScene, skyCam);
    R.render(this.earth.scene, skyCam);
    R.clearDepth(); R.render(this.mScene, cam);
    app.post.finish();
    this.drawOverlay(w, h, ms, r, v, up, skyCam);
    return true;
  }
  measure() {
    const R = this.r, o = R.getRenderTarget(), E = this.earth.U, ex = E.uExposure.value;
    E.uExposure.value = 1; E.uSteps.value = 8;
    R.setRenderTarget(this.measureRT); R.setClearColor(0, 1); R.clear(); R.render(this.earth.scene, this.skyCam || this.cam);
    E.uSteps.value = 14; E.uExposure.value = ex;
    try { R.readRenderTargetPixels(this.measureRT, 0, 0, 48, 32, this.mBuf); } catch { R.setRenderTarget(o); return; }
    R.setRenderTarget(o);
    const h2f = THREE.DataUtils.fromHalfFloat; let s = 0, n = 0, cover = 0;
    // the eye adapts to what is lit in view (black space does not count), more so the more of the view it fills
    const lit = [];
    for (let k = 0; k < 48 * 32; k++) { const L = 0.2126 * h2f(this.mBuf[k * 4]) + 0.7152 * h2f(this.mBuf[k * 4 + 1]) + 0.0722 * h2f(this.mBuf[k * 4 + 2]); if (L > 2e-4) { cover++; s += Math.log(L); n++; lit.push(L); } }
    this.earthCover = cover / (48 * 32);
    lit.sort((a, b) => a - b);
    const p95 = lit.length ? lit[Math.floor(lit.length * 0.95)] : 1e-3;
    // like a camera: keep the bright clouds and sunlit limb from clipping, but let a mostly-dark view brighten
    this.earthLa = n ? Math.max(Math.exp(s / n), p95 * 0.4) * (0.35 + 0.65 * Math.sqrt(this.earthCover)) : 1e-3;
  }
  updateOthers(ms, rv, sun, s) {
    const T = this.app.tracker, g = this.others.geometry, P = g.attributes.position.array, M = g.attributes.mag.array, C = g.attributes.color.array;
    let k = 0; const self = this.app.sel, L = [1, 1, 1];
    for (let i = 0; i < T.N && k < this.MAX; i++) {
      if (i === self) continue;
      const dx = T.pos[i * 3] - rv.x, dy = T.pos[i * 3 + 1] - rv.y, dz = T.pos[i * 3 + 2] - rv.z, d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > 9e6 || d2 < 1e-6) continue;
      const rg = Math.sqrt(d2), r = [T.pos[i * 3], T.pos[i * 3 + 1], T.pos[i * 3 + 2]];
      sunlight(r, s, s.dist, L); const Lv = 0.2126 * L[0] + 0.7152 * L[1] + 0.0722 * L[2]; if (Lv < 1e-3) continue;
      // hidden behind the Earth?
      const ux = dx / rg, uy = dy / rg, uz = dz / rg, b = rv.x * ux + rv.y * uy + rv.z * uz, c = rv.lengthSq() - 6371 * 6371, disc = b * b - c;
      if (disc > 0 && -b - Math.sqrt(disc) > 0 && -b - Math.sqrt(disc) < rg) continue;
      const cphi = -(ux * s[0] + uy * s[1] + uz * s[2]), phi = Math.acos(clamp(cphi, -1, 1));
      const std = T.std[i];
      M[k] = std + 5 * Math.log10(rg / 1000) - 2.5 * Math.log10(Math.max(spherePhase(phi) * Lv, 1e-6));
      P[k * 3] = ux; P[k * 3 + 1] = uy; P[k * 3 + 2] = uz; C[k * 3] = L[0] / Lv; C[k * 3 + 1] = L[1] / Lv; C[k * 3 + 2] = L[2] / Lv; k++;
    }
    g.setDrawRange(0, k); g.attributes.position.needsUpdate = true; g.attributes.mag.needsUpdate = true; g.attributes.color.needsUpdate = true;
  }
  drawOverlay(w, h, ms, r, v, up, skyCam) {
    const ov = this.app.overlay, g = ov.ctx; ov.begin(w, h);
    // ground track direction marker: nadir point label and the terminator note
    const alt = Math.hypot(...r) - 6371, spd = Math.hypot(...v);
    g.font = '12px system-ui, sans-serif'; g.fillStyle = 'rgba(200,220,255,0.85)'; g.textAlign = 'left';
    const L = sunlight(r, sunTEME(ms), sunTEME(ms).dist, [1, 1, 1]);
    const state = L.f <= 0 ? "In the Earth's shadow" : L.f < 0.999 ? `Penumbra: ${(L.f * 100).toFixed(0)} % of the Sun visible` : (L[2] < 0.8 ? 'Sunlight through the atmosphere (reddened)' : 'Full sunlight');
    g.fillText(`Altitude ${alt.toFixed(0)} km · ${spd.toFixed(2)} km/s · ${state}`, 12, h - 12 - (this.app.ui.bottomInset || 0));
    ov.end();
  }
}
function blackTex() { const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1); t.needsUpdate = true; return t; }
function skyDir(c) { return new THREE.Vector3(0, 0, -1).applyQuaternion(c.quaternion); }
function dot3(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
