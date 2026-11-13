// Ground view: the sky from a place on Earth (SkyScout's physically based sky, stars to V 10.5, Milky Way, Sun,
// Moon, planets) with every satellite as a point source of its real brightness and colour, and the selected one as
// a real-size 3D model once the zoom makes it more than a pixel or two across.
import * as THREE from '../vendor/three.module.min.js';
import { makeSkyLUT, makeSkyBackground, makeStars, makePlanets, makeMoon, makeMoonGlare, milkyWayPhoto, makeFaintStars, makeGaiaStars, starMaterial } from './sky.js';
import { refrUniform, COMMON } from './glsl.js';
import { sunMoon, planets as planetPos, altAzToVec, eqjToWorld, observer as astroObserver, EQ2GAL, OBLIQ, refraction } from './astro.js';
import { buildModel, poseModel, disposeModel } from './models3d.js';
import { mulM3, DEG } from './frames.js';
import { propagate } from './sgp.js';
import { obsAt } from './sight.js';
import { earthshine } from './light.js';

const NAT_SKY = 1.71e-4;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x)), lerp = (a, b, t) => a + (b - a) * t, smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const lum2mag = L => 12.583 - 2.5 * Math.log10(L);

function moonPhaseGain(a) {
  const key = Math.round(clamp(a, 0, 179));
  const ls = al => { const r = al * DEG, lx = Math.sin(r), lz = Math.cos(r), N = 48; let s = 0; for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { const x = (i + 0.5) / N * 2 - 1, y = (j + 0.5) / N * 2 - 1, r2 = x * x + y * y; if (r2 >= 1) continue; const ce = Math.sqrt(1 - r2), ci = x * lx + ce * lz; if (ci > 0) s += ci / (ci + ce); } return s; };
  const real = Math.pow(10, -0.4 * (0.026 * key + 4e-9 * key ** 4)), s0 = ls(0), sa = ls(key);
  return { gain: real / Math.max(sa / s0, 1e-6), lsMean: sa / s0 * 0.5 };
}
const mgCache = new Map();
const moonGain = a => { const k = Math.round(clamp(a, 0, 179)); if (!mgCache.has(k)) mgCache.set(k, moonPhaseGain(k)); return mgCache.get(k); };

export class GroundView {
  constructor(app, renderer, assets) {
    this.app = app; this.r = renderer; this.assets = assets;
    this.yaw = 180; this.pitch = 30; this.fov = 75;
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.1, 2e7); this.camera.rotation.order = 'YXZ';
    const U = this.U = {
      uSkyLUT: { value: null }, uSkyLUTLow: { value: null }, uExposure: { value: 1 }, uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
      uSunE: { value: new THREE.Vector3() }, uMoonE: { value: new THREE.Vector3() }, uAOD: { value: 0.1 }, uTime: { value: 0 }, uRefrK: refrUniform, uSunSquish: { value: 1 }, uMoonSquish: { value: 1 }, uNight: { value: 0 },
      uSnow: { value: 0 }, uWet: { value: 0 }, uVisKm: { value: 60 }, uOvercast: { value: 0 }, uFlash: { value: new THREE.Vector4() }, uNoAtm: { value: 0 },
    };
    this.lut = makeSkyLUT(renderer, U); U.uSkyLUT.value = this.lut.rt.texture; U.uSkyLUTLow.value = this.lut.rtLow.texture;
    const S = this.scene = new THREE.Scene();
    this.bg = makeSkyBackground(U, milkyWayPhoto()); S.add(this.bg);
    this.stars = makeStars(U, assets.stars); S.add(this.stars);
    makeFaintStars(U).then(p => { this.faint = p; S.add(p); }).catch(() => { });
    this.planets = makePlanets(U); S.add(this.planets);
    this.moon = makeMoon(U); S.add(this.moon);
    this.glare = makeMoonGlare(U); S.add(this.glare);
    // ground: a flat grass field to a true 0 deg horizon, lit by the Sun, the Moon and the sky, fading into haze
    const gmat = new THREE.ShaderMaterial({
      uniforms: U, depthWrite: false, side: THREE.BackSide,   // seen from inside the half-sphere
      vertexShader: `out vec3 vD; void main(){ vD = position; vec4 p = projectionMatrix * viewMatrix * vec4(position + cameraPosition, 1.0); gl_Position = p.xyww; }`,
      fragmentShader: COMMON + `in vec3 vD;
        float gn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0 - 2.0*f); return mix(mix(hash12(i), hash12(i + vec2(1,0)), f.x), mix(hash12(i + vec2(0,1)), hash12(i + vec2(1,1)), f.x), f.y); }
        void main(){
          vec3 d = normalize(vD); if (d.y > 0.0) discard;
          float dist = 1.7/max(-d.y, 1e-5);
          vec2 P = d.xz*dist;
          float fw = length(fwidth(P));
          // grass at several scales; scales finer than a pixel fade to their average (no shimmer)
          float g = 0.5, amp = 0.5, sc = 0.03, tot = 0.0;
          for (int i = 0; i < 6; i++) {
            float vis = 1.0 - smoothstep(0.3, 1.0, fw*2.0/sc);
            g += (gn(P/sc + float(i)*17.3) - 0.5)*amp*vis; tot += amp; sc *= 3.1; amp *= 0.8;
          }
          float patches = gn(P/40.0)*0.6 + gn(P/9.0)*0.4;
          vec3 alb = mix(vec3(0.030, 0.055, 0.016), vec3(0.075, 0.095, 0.032), clamp(g + 0.35*(patches - 0.5), 0.0, 1.0));   // grass
          alb = mix(alb, vec3(0.10, 0.09, 0.05), smoothstep(0.62, 0.8, patches)*0.4);                                        // drier patches
          // light: direct Sun and Moon (through the air), skylight from the whole dome
          vec3 Ed = (uSunE*max(uSunDir.y, 0.0)*directT(uSunDir.y) + uMoonE*max(uMoonDir.y, 0.0)*directT(uMoonDir.y))*uExposure;
          // skylight: the dome averaged (zenith and four directions 30 deg up), so the Sun's glow counts only its share
          vec2 sa = normalize(vec2(uSunDir.x, uSunDir.z) + 1e-5);
          vec3 sky = (skyL(vec3(0.0, 1.0, 0.0)) + skyL(vec3(sa.x*0.866, 0.5, sa.y*0.866)) + skyL(vec3(-sa.x*0.866, 0.5, -sa.y*0.866))
                    + skyL(vec3(-sa.y*0.866, 0.5, sa.x*0.866)) + skyL(vec3(sa.y*0.866, 0.5, -sa.x*0.866)))*0.2;
          vec3 c = alb/PI*Ed + alb*sky;
          // aerial perspective: blend toward the sky just above the horizon with distance
          vec3 hz = skyL(normalize(vec3(d.x, 0.002, d.z)));
          float k = 1.0 - exp(-dist/12000.0);
          gl_FragColor = vec4(min(mix(c, hz, k), vec3(3.0e4)), 1.0);
        }`,
    });
    const gm = new THREE.Mesh(new THREE.SphereGeometry(1000, 48, 24, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), gmat); gm.frustumCulled = false; gm.renderOrder = 50; S.add(gm);
    // satellites: compacted list of what is above the horizon and sunlit, updated each frame
    const MAXV = 12000;
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAXV * 3), 3).setUsage(THREE.DynamicDrawUsage));
    sg.setAttribute('mag', new THREE.BufferAttribute(new Float32Array(MAXV), 1).setUsage(THREE.DynamicDrawUsage));
    sg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(MAXV * 3), 3).setUsage(THREE.DynamicDrawUsage));
    sg.setDrawRange(0, 0);
    this.satPts = new THREE.Points(sg, starMaterial(U, false)); this.satPts.frustumCulled = false; this.satPts.renderOrder = -50; S.add(this.satPts);
    this.MAXV = MAXV; this.visIdx = new Int32Array(MAXV);
    // the selected satellite's 3D model
    this.mScene = new THREE.Scene();
    this.sunL = new THREE.DirectionalLight(0xffffff, 1); this.sunL.castShadow = true; this.sunL.shadow.mapSize.set(1024, 1024);
    this.esL = new THREE.DirectionalLight(0xcfe0ff, 0); this.amb = new THREE.AmbientLight(0x8090a0, 0);
    this.mScene.add(this.sunL, this.sunL.target, this.esL, this.esL.target, this.amb);
    this.mCam = new THREE.PerspectiveCamera(); this.mCam.rotation.order = 'YXZ';
    this.adaptL = 1; this.ev = 0; this.lock = false; this.gaia = [];
    this.overlay = app.overlay;
  }
  setPlace(obs) { this.obs = obs; this.lastAstro = 0; }
  // Sun, Moon, planets and the sky's rotation for this time (astronomy-engine)
  astro(ms) {
    const date = new Date(ms), { lat, lon, h } = this.obs, U = this.U;
    const sm = sunMoon(date, lat, lon, h * 1000); this.sm = sm;
    const k = refrUniform.value, lift = a => refraction(a, k), squish = a => Math.max(0.3, Math.min(1, 1 + (lift(a + 0.1) - lift(a - 0.1)) / 0.2));
    const sv = altAzToVec(sm.sun.alt + lift(sm.sun.alt), sm.sun.az), mv = altAzToVec(sm.moon.alt + lift(sm.moon.alt), sm.moon.az);
    U.uSunDir.value.set(...sv); U.uMoonDir.value.set(...mv); U.uSunSquish.value = squish(sm.sun.alt); U.uMoonSquish.value = squish(sm.moon.alt);
    U.uSunE.value.set(1.0, 0.985, 0.95).multiplyScalar(1.27e5);
    U.uMoonE.value.set(1.0, 0.94, 0.86).multiplyScalar(Math.pow(10, -0.4 * (sm.moonMag + 13.99)));
    const ml = new THREE.Vector3(...sv).multiplyScalar(1.496e8).sub(new THREE.Vector3(...mv).multiplyScalar(sm.moonDistKm)).normalize();
    U.uMoonLight.value.copy(ml); U.uMoonRadius.value = Math.atan(1737.4 / sm.moonDistKm); U.uMoonLum.value = 2900;
    const pa = Math.acos(clamp(-ml.dot(new THREE.Vector3(...mv)), -1, 1)) / DEG, md = moonGain(pa), bE = Math.PI - pa * DEG;
    U.uMoonGain.value = md.gain; U.uMoonAvg.value = 2900 * (md.gain * 2 * md.lsMean + 1.32e-4 * (Math.sin(bE) + (Math.PI - bE) * Math.cos(bE)) / Math.PI);
    const m = eqjToWorld(date, astroObserver(lat, lon, h * 1000)); this.eqm = m;
    U.uEqToWorld.value.set(...m); U.uGal.value.set(...EQ2GAL);
    const ce = Math.cos(OBLIQ), se = Math.sin(OBLIQ);
    U.uEclip.value.copy(new THREE.Matrix3().set(1, 0, 0, 0, ce, se, 0, -se, ce).multiply(new THREE.Matrix3().set(...m).transpose()));
    const pl = planetPos(date, lat, lon, h * 1000); this.pl = pl;
    const P = this.planets.geometry.attributes.position.array, M = this.planets.geometry.attributes.mag.array;
    pl.forEach((p, i) => { P.set(altAzToVec(p.alt, p.az), i * 3); M[i] = p.mag; });
    this.planets.geometry.attributes.position.needsUpdate = true; this.planets.geometry.attributes.mag.needsUpdate = true;
    // twilight fill in the Earth's shadow (as SkyScout)
    const sa = sm.sun.alt; U.uTwAmb.value = sa < 1 && sa > -19 ? 105 * Math.pow(10, 0.354 * sa) * smooth(1, -1.5, sa) : 0;
  }
  adaptation() {
    const sunAlt = this.sm.sun.alt, moonAlt = this.sm.moon.alt;
    let La = sunAlt > 0 ? 300 + 6000 * Math.pow(Math.sin(sunAlt * DEG), 0.8) : 300 * Math.pow(10, sunAlt * 0.33);
    if (moonAlt > 0) La += 2.6e-3 * Math.pow(this.sm.moonFrac, 1.5) * Math.pow(Math.sin(moonAlt * DEG), 0.5);
    return La + NAT_SKY;
  }
  measureSky() {
    const rt = this.lut.rt, W = rt.width, H = rt.height;
    if (!this.lutBuf) this.lutBuf = new Uint16Array(W * H * 4);
    try { this.r.readRenderTargetPixels(rt, 0, 0, W, H, this.lutBuf); } catch { return; }
    const E = this.lutExposure || this.U.uExposure.value, b = this.lutBuf, h2f = THREE.DataUtils.fromHalfFloat;
    let s = 0, n = 0;
    for (let j = Math.floor(H * 0.6); j < Math.floor(H * 0.92); j += 3) for (let i = 0; i < W; i += 8) { const k = (j * W + i) * 4, L = (0.2126 * h2f(b[k]) + 0.7152 * h2f(b[k + 1]) + 0.0722 * h2f(b[k + 2])) / E; if (L > 0) { s += Math.log(L); n++; } }
    if (n) this.skyLa = Math.exp(s / n) * 1.6;
  }
  // limiting magnitude (naked eye, plus binocular/telescope gain when zoomed) from the adapted sky brightness
  limitMag() { const sqm = lum2mag(Math.max(this.adaptL, 1e-5)); return 7.93 - 5 * Math.log10(Math.pow(10, 4.316 - sqm / 5) + 1) + this.U.uZoomGain.value; }

  frame(dt, ms, w, h, dpr) {
    const U = this.U, cam = this.camera, app = this.app, T = app.tracker;
    if (!this.sm || Math.abs(ms - this.lastAstro) > (app.clock.rate === 1 ? 1000 : 50) || app.clock.jumped) { this.astro(ms); this.lastAstro = ms; }
    U.uTime.value = performance.now() / 1000;
    // where to look: gyroscope, lock on the selected satellite, or touch
    const sel = app.sel;
    if (this.lock && sel >= 0 && !app.gyro.on && T.alt[sel] > -5) {
      const d = new THREE.Vector3(T.dir[sel * 3], T.dir[sel * 3 + 1], T.dir[sel * 3 + 2]);
      const yaw = Math.atan2(d.x, -d.z) / DEG, pitch = Math.asin(clamp(d.y, -1, 1)) / DEG;
      const tp = pitch + refraction(pitch, refrUniform.value);
      let dy = ((yaw - this.yaw + 540) % 360) - 180, dp = tp - this.pitch;
      // swing over to it when first locked, then stay exactly on it at any time rate
      if (!this.locked || Math.hypot(dy * Math.cos(tp * DEG), dp) > 2) { const k = 1 - Math.exp(-dt * 8); this.yaw = (this.yaw + dy * k + 360) % 360; this.pitch += dp * k; this.locked = Math.hypot(dy * Math.cos(tp * DEG), dp) < 0.5; }
      else { this.yaw = (yaw + 360) % 360; this.pitch = tp; }
    }
    if (!this.lock) this.locked = false;
    cam.fov = this.fov; cam.aspect = w / h; cam.updateProjectionMatrix();
    if (app.gyro.on && app.gyro.q) { cam.quaternion.copy(app.gyro.q); const f = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion); this.yaw = (Math.atan2(f.x, -f.z) / DEG + 360) % 360; this.pitch = Math.asin(clamp(f.y, -1, 1)) / DEG; }
    else cam.rotation.set(this.pitch * DEG, -this.yaw * DEG, 0);
    cam.position.set(0, 0, 0); cam.updateMatrixWorld();
    // exposure: eye adaptation, from the measured sky in daylight and twilight
    let La = this.adaptation();
    if (this.sm.sun.alt > -8) { if (!this.lutBuf || (this.frameN = (this.frameN || 0) + 1) % 15 === 0) this.measureSky(); if (this.skyLa) La = lerp(La, this.skyLa, smooth(-8, -2, this.sm.sun.alt)); }
    this.adaptL = Math.exp(lerp(Math.log(this.adaptL), Math.log(La), 1 - Math.exp(-dt * 3)));
    if (!isFinite(this.adaptL) || this.adaptL <= 0) this.adaptL = La;
    let E = 0.0922 / Math.pow(this.adaptL, 0.72) * Math.pow(2, this.ev);
    E *= lerp(1, 0.4, smooth(0, -3.3, Math.log10(this.adaptL)));
    // zoomed onto the Sun (transit watching): expose for its disc like a camera, so limb darkening and a satellite's
    // silhouette show instead of a white blur
    {
      const sv = U.uSunDir.value, f = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion), ang = Math.acos(clamp(f.dot(sv), -1, 1)) / DEG;
      const ext = this.extinctionRGB(this.sm.sun.alt), Tl = 0.2126 * ext[0] + 0.7152 * ext[1] + 0.0722 * ext[2];
      const w = sv.y > -0.01 ? smooth(6, 1.5, cam.fov) * smooth(cam.fov * 0.9, cam.fov * 0.35, ang) : 0;
      this.sunW = w;
      if (w > 0) E = Math.exp(lerp(Math.log(E), Math.log(1.8 / (1.27e5 * 2.15e4 * Math.max(Tl, 1e-6))), w));
    }
    U.uExposure.value = E;
    app.post.final.mat.uniforms.uScot.value = smooth(0.004, 0.0002, this.adaptL) * 0.45 * (1 - (this.sunW || 0));
    const pxRad = (cam.fov * DEG) / (h * dpr);
    U.uPxSr.value = pxRad * pxRad; U.uPxScale.value = dpr;
    U.uZoomGain.value = clamp(2.2 * Math.log10(75 / cam.fov), 0, 4.2);
    U.uMoonGlare.value = smooth(8, 25, cam.fov);
    U.uInvProjView.value.copy(cam.projectionMatrixInverse).premultiply(cam.matrixWorld); U.uCamPos.value.copy(cam.position);
    // deep Gaia stars only when zoomed in (they are below the naked-eye limit anyway)
    if (cam.fov < 40 && !this.gaiaLoading) { this.gaiaLoading = true; for (const f of ['data/gaia1.bin', 'data/gaia2.bin']) makeGaiaStars(U, f).then(p => { this.gaia.push(p); this.scene.add(p); }).catch(() => { }); }
    // satellites
    this.updateSats(ms);
    this.updateModel(ms, w, h, dpr);
    const r = this.r;
    this.lut.render(); this.lutExposure = U.uExposure.value;
    r.setRenderTarget(app.post.rt); r.setClearColor(0, 1); r.clear();
    r.render(this.scene, cam);
    if (this.model && this.model.visible) { r.clearDepth(); r.render(this.mScene, this.mCam); }
    app.post.finish();
    this.drawOverlay(ms, w, h);
  }
  updateSats(ms) {
    const app = this.app, T = app.tracker, N = T.N, f = app.filter, lim = this.limitMag() + 1.5;
    const g = this.satPts.geometry, P = g.attributes.position.array, M = g.attributes.mag.array, C = g.attributes.color.array;
    let k = 0;
    for (let i = 0; i < N && k < this.MAXV; i++) {
      if (T.alt[i] < -1.5 || T.mag[i] > lim + 2) continue;
      if (f && !f(i)) continue;
      if (i === app.sel && this.modelFade > 0.95) continue;
      const Lr = T.light[i * 3], Lg = T.light[i * 3 + 1], Lb = T.light[i * 3 + 2], Lv = 0.2126 * Lr + 0.7152 * Lg + 0.0722 * Lb;
      P[k * 3] = T.dir[i * 3]; P[k * 3 + 1] = T.dir[i * 3 + 1]; P[k * 3 + 2] = T.dir[i * 3 + 2];
      let m = T.mag[i];
      if (i === app.sel && this.modelFade) m += -2.5 * Math.log10(Math.max(1e-4, 1 - this.modelFade));
      M[k] = m;
      // colour of the light falling on it (reddened at the shadow's edge; earthshine is bluish white)
      const n = Lv > 1e-4 ? 1 / Lv : 0;
      C[k * 3] = Lv > 1e-4 ? Lr * n : 0.85; C[k * 3 + 1] = Lv > 1e-4 ? Lg * n : 0.92; C[k * 3 + 2] = Lv > 1e-4 ? Lb * n : 1.05;
      this.visIdx[k] = i; k++;
    }
    g.setDrawRange(0, k); this.nVis = k;
    g.attributes.position.needsUpdate = true; g.attributes.mag.needsUpdate = true; g.attributes.color.needsUpdate = true;
  }
  // the selected satellite as a model at its true distance and size, lit by the Sun (reddened in the penumbra),
  // by earthshine from below, and turned to its real attitude with its arrays tracking the Sun
  updateModel(ms, w, h, dpr) {
    const app = this.app, T = app.tracker, i = app.sel;
    if (this.modelIdx !== i) {
      if (this.model) { this.mScene.remove(this.model); disposeModel(this.model); this.model = null; }
      this.modelIdx = i;
      if (i >= 0) { this.shape = T.shape(i); this.model = buildModel(this.shape); this.model.visible = false; this.mScene.add(this.model); }
    }
    this.modelFade = 0;
    if (!this.model) return;
    const range = T.range[i], size = this.shape.size, px = (size / 1000 / range) / (this.camera.fov * DEG / (h * dpr));
    this.modelPx = px;
    if (T.alt[i] < -2 || px < 2) { this.model.visible = false; return; }
    this.model.visible = true;
    this.modelFade = smooth(2, 5, px);
    const det = T.detail(i, ms, this.obs), ctx = det.ctx;
    const B = det.B || { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }, Mw = ctx.M;
    const bx = mulM3(Mw, B.x), by = mulM3(Mw, B.y), bz = mulM3(Mw, B.z);
    const m4 = new THREE.Matrix4().makeBasis(new THREE.Vector3(...bx), new THREE.Vector3(...by), new THREE.Vector3(...bz));
    this.model.quaternion.setFromRotationMatrix(m4);
    const dir = new THREE.Vector3(det.x, det.y, det.z);
    // refraction lifts it like a star
    const alt = Math.asin(clamp(dir.y, -1, 1)) / DEG, lift = refraction(alt, refrUniform.value) * DEG;
    if (lift > 0) { const hz = Math.hypot(dir.x, dir.z); const na = Math.asin(clamp(dir.y, -1, 1)) + lift; dir.set(dir.x / hz * Math.cos(na), Math.sin(na), dir.z / hz * Math.cos(na)); }
    // A 32-bit float can't place a 20 m object 2000 km away to better than ~1/80000 of the distance, which jitters
    // and z-fights its surfaces. So the model is drawn at its true size only ~40 sizes from its own camera, and that
    // camera's projection is shrunk about the object's screen position by D/range: same angular size, same place,
    // full precision (the view is so nearly orthographic that the perspective difference is invisible).
    const D = Math.max(size * 40, 60), Rm = range * 1000, sizeS = size;
    this.model.scale.setScalar(1);
    this.model.position.copy(dir).multiplyScalar(D);
    const cN = dir.clone().project(this.camera), kz = D / Rm;
    const sb = [B.x[0] * ctx.s[0] + B.x[1] * ctx.s[1] + B.x[2] * ctx.s[2], B.y[0] * ctx.s[0] + B.y[1] * ctx.s[1] + B.y[2] * ctx.s[2], B.z[0] * ctx.s[0] + B.z[1] * ctx.s[1] + B.z[2] * ctx.s[2]];
    poseModel(this.model, sb);
    // lighting: exposure local to the model (a camera on a telescope would expose for it)
    const kM = Math.min(this.U.uExposure.value, 2.2 / (1.27e5 * 0.75 / Math.PI)) * Math.pow(2, this.ev);
    const sw = mulM3(Mw, ctx.s), Lc = det.Lc || [1, 1, 1];
    this.sunL.position.set(...sw).multiplyScalar(-1).add(this.model.position); // light comes from the Sun: position = target + sunDir
    this.sunL.position.copy(this.model.position).add(new THREE.Vector3(...sw).multiplyScalar(sizeS * 2));
    this.sunL.target.position.copy(this.model.position);
    const ext = this.extinctionRGB(alt);
    this.sunL.color.setRGB(Lc[0] * ext[0], Lc[1] * ext[1], Lc[2] * ext[2]); this.sunL.intensity = 1.27e5 * kM;
    const sc = this.sunL.shadow.camera; sc.left = sc.bottom = -sizeS * 0.6; sc.right = sc.top = sizeS * 0.6; sc.near = sizeS * 0.01; sc.far = sizeS * 4; sc.updateProjectionMatrix();
    const r = det.r, rl = Math.hypot(...r), down = mulM3(Mw, [-r[0] / rl, -r[1] / rl, -r[2] / rl]);
    this.esL.position.copy(this.model.position).add(new THREE.Vector3(...down).multiplyScalar(-sizeS * 2)); this.esL.target.position.copy(this.model.position);
    this.esL.intensity = 1.27e5 * kM * earthshine(r, ctx.s) * 0.8; this.esL.color.setRGB(0.75 * ext[0], 0.85 * ext[1], 1.0 * ext[2]);
    this.amb.intensity = 0.002 * 1.27e5 * kM;
    // camera with depth range just around the model
    this.mCam.copy(this.camera); this.mCam.near = D - sizeS * 0.8; this.mCam.far = D + sizeS * 0.8; this.mCam.updateProjectionMatrix();
    const A = new THREE.Matrix4().set(kz, 0, 0, (1 - kz) * cN.x, 0, kz, 0, (1 - kz) * cN.y, 0, 0, 1, 0, 0, 0, 0, 1);
    this.mCam.projectionMatrix.premultiply(A); this.mCam.projectionMatrixInverse.copy(this.mCam.projectionMatrix).invert();
    this.mCam.position.set(0, 0, 0); this.mCam.updateMatrixWorld();
    // the model stays opaque (no transparency sorting between its parts); the point of light fades out instead
  }
  extinctionRGB(alt) { const s = Math.sin(Math.max(alt, 0) * DEG), X = Math.min(40, 1 / (s + 0.025 * Math.exp(-11 * s))); return [0.1, 0.17, 0.33].map(t => Math.exp(-(t + 0.1) * X)); }

  project(d, w, h) {
    const v = new THREE.Vector3(...d).applyMatrix4(this.camera.matrixWorldInverse);
    if (v.z >= 0) return null;
    v.applyMatrix4(this.camera.projectionMatrix);
    return [(v.x * 0.5 + 0.5) * w, (0.5 - v.y * 0.5) * h, Math.abs(v.x) < 1.05 && Math.abs(v.y) < 1.05];
  }
  liftDir(d) { const alt = Math.asin(clamp(d[1], -1, 1)) / DEG; const l = refraction(alt, refrUniform.value); if (alt < -2 || l <= 0) return d; const hz = Math.hypot(d[0], d[2]) || 1, na = (alt + l) * DEG; return [d[0] / hz * Math.cos(na), Math.sin(na), d[2] / hz * Math.cos(na)]; }
  drawOverlay(ms, w, h) {
    const ov = this.overlay, g = ov.ctx, app = this.app, T = app.tracker, set = app.settings;
    ov.begin(w, h);
    const night = this.sm.sun.alt < -6, dayK = smooth(2, -10, this.sm.sun.alt);
    const col = night ? 'rgba(150,180,255,' : 'rgba(40,60,110,';
    g.globalAlpha = 0.35 + 0.65 * dayK;
    // alt-az grid
    if (set.grid) {
      g.lineWidth = 1; g.strokeStyle = col + '0.18)';
      for (let alt = 0; alt < 90; alt += 15) { g.beginPath(); let pen = false; for (let az = 0; az <= 360; az += 3) { const p = this.project(altAzToVec(alt, az), w, h); if (!p) { pen = false; continue; } pen ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]); pen = true; } g.stroke(); }
      for (let az = 0; az < 360; az += 30) { g.beginPath(); let pen = false; for (let alt = 0; alt <= 90; alt += 3) { const p = this.project(altAzToVec(alt, az), w, h); if (!p) { pen = false; continue; } pen ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]); pen = true; } g.stroke(); }
    }
    // constellation lines
    if (set.lines && this.assets.lines) {
      const m = this.eqm; g.strokeStyle = col + '0.28)'; g.lineWidth = 1;
      for (const line of this.assets.lines) {
        g.beginPath(); let pen = false;
        for (const [ra, de] of line) {
          const a = ra * DEG, d = de * DEG, e = [Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d)];
          const wv = this.liftDir([m[0] * e[0] + m[1] * e[1] + m[2] * e[2], m[3] * e[0] + m[4] * e[1] + m[5] * e[2], m[6] * e[0] + m[7] * e[1] + m[8] * e[2]]);
          const p = wv[1] > -0.02 ? this.project(wv, w, h) : null;
          if (!p) { pen = false; continue; } pen ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]); pen = true;
        }
        g.stroke();
      }
    }
    g.globalAlpha = 1;
    // horizon and compass points
    g.font = '600 13px system-ui, sans-serif'; g.textAlign = 'center';
    for (const [lab, az] of [['N', 0], ['NE', 45], ['E', 90], ['SE', 135], ['S', 180], ['SW', 225], ['W', 270], ['NW', 315]]) {
      const p = this.project(altAzToVec(0, az), w, h); if (!p || !p[2]) continue;
      g.fillStyle = lab.length === 1 ? 'rgba(255,120,90,0.95)' : 'rgba(220,200,180,0.7)'; g.fillText(lab, p[0], p[1] - 6);
    }
    // planets, Sun, Moon labels
    g.font = '12px system-ui, sans-serif'; g.textAlign = 'left';
    const lab = (t, alt, az, c) => { if (alt < -1) return; const p = this.project(altAzToVec(alt + refraction(alt, refrUniform.value), az), w, h); if (!p || !p[2]) return; g.fillStyle = c; g.fillText(t, p[0] + 8, p[1] - 6); };
    if (set.labels) { for (const p of this.pl) lab(p.name, p.alt, p.az, 'rgba(255,220,170,0.85)'); lab('Moon', this.sm.moon.alt, this.sm.moon.az, 'rgba(255,240,220,0.85)'); lab('Sun', this.sm.sun.alt, this.sm.sun.az, 'rgba(255,230,150,0.9)'); }
    // satellites: labels for the brightest, faint markers for objects up but in the Earth's shadow
    const lim = this.limitMag();
    if (set.shadowed) {
      g.strokeStyle = 'rgba(120,140,180,0.35)'; g.lineWidth = 1;
      for (let i = 0; i < T.N; i++) { if (T.alt[i] < 0 || T.mag[i] < 90) continue; if (app.filter && !app.filter(i)) continue; const p = this.project(this.liftDir([T.dir[i * 3], T.dir[i * 3 + 1], T.dir[i * 3 + 2]]), w, h); if (!p || !p[2]) continue; g.beginPath(); g.arc(p[0], p[1], 2.5, 0, 6.283); g.stroke(); }
    }
    if (set.labels) {
      g.font = '11px system-ui, sans-serif';
      const cand = [];
      for (let k = 0; k < this.nVis; k++) { const i = this.visIdx[k], m = T.mag[i] + extinctionMag(T.alt[i]); if (i !== app.sel && m < Math.min(lim, set.labelMag)) cand.push([m, i]); }
      cand.sort((a, b) => a[0] - b[0]);
      const placed = [];
      for (const [m, i] of cand.slice(0, 60)) {
        const p = this.project(this.liftDir([T.dir[i * 3], T.dir[i * 3 + 1], T.dir[i * 3 + 2]]), w, h); if (!p || !p[2]) continue;
        if (placed.some(q => Math.abs(q[0] - p[0]) < 70 && Math.abs(q[1] - p[1]) < 14)) continue; placed.push(p);
        g.fillStyle = 'rgba(160,220,255,0.85)'; g.fillText(`${T.objs[i].name}  ${m.toFixed(1)}`, p[0] + 7, p[1] + 12);
      }
    }
    // selected: reticle, path for the next and last few minutes, and an arrow when off screen
    const i = app.sel;
    if (i >= 0 && T.alt[i] > -30) {
      if (this.path && this.path.length) {
        g.lineWidth = 1.5;
        let prev = null;
        for (const q of this.path) {
          const p = q.alt > -1 ? this.project(this.liftDir(q.d), w, h) : null;
          if (p && prev) { g.strokeStyle = q.lit ? 'rgba(255,210,120,0.55)' : 'rgba(140,150,180,0.35)'; g.setLineDash(q.lit ? [] : [4, 4]); g.beginPath(); g.moveTo(prev[0], prev[1]); g.lineTo(p[0], p[1]); g.stroke(); }
          if (p && q.tick) { g.fillStyle = 'rgba(255,220,160,0.7)'; g.fillText(q.tick, p[0] + 5, p[1] - 4); }
          prev = p;
        }
        g.setLineDash([]);
      }
      const p = this.project(this.liftDir([T.dir[i * 3], T.dir[i * 3 + 1], T.dir[i * 3 + 2]]), w, h);
      const rr = Math.max(14, (this.modelPx || 0) * 0.5 / (window.devicePixelRatio || 1) + 8);
      if (p && p[2]) {
        g.strokeStyle = 'rgba(255,200,90,0.95)'; g.lineWidth = 1.5;
        for (let k = 0; k < 4; k++) { g.beginPath(); g.arc(p[0], p[1], rr, k * Math.PI / 2 + 0.25, k * Math.PI / 2 + 1.32); g.stroke(); }
        g.fillStyle = 'rgba(255,215,140,1)'; g.font = '600 12px system-ui, sans-serif'; g.fillText(T.objs[i].name, p[0] + rr + 4, p[1] - rr * 0.6);
      } else if (T.alt[i] > -1) {
        // arrow toward it from the screen centre
        const v = new THREE.Vector3(T.dir[i * 3], T.dir[i * 3 + 1], T.dir[i * 3 + 2]).applyMatrix4(this.camera.matrixWorldInverse);
        const a = Math.atan2(-v.y, v.x), cx = w / 2 + Math.cos(a) * Math.min(w, h) * 0.38, cy = h / 2 + Math.sin(a) * Math.min(w, h) * 0.38;
        g.save(); g.translate(cx, cy); g.rotate(a); g.fillStyle = 'rgba(255,200,90,0.9)'; g.beginPath(); g.moveTo(16, 0); g.lineTo(-8, -9); g.lineTo(-8, 9); g.fill(); g.restore();
        g.fillStyle = 'rgba(255,215,140,1)'; g.font = '600 12px system-ui, sans-serif'; g.textAlign = 'center'; g.fillText(T.objs[i].name, cx, cy + 24); g.textAlign = 'left';
      }
    }
    ov.end();
  }
  // path of the selected object across the sky: SGP4 every 15 s over -6..+14 minutes
  updatePath(ms) {
    const app = this.app, T = app.tracker, i = app.sel; this.path = null;
    if (i < 0 || !T.selRec) return;
    const st = new Float64Array(6), out = [], ctx = {};
    const period = 1440 / T.objs[i].n, span = Math.min(period * 0.3, 20) * 60e3, step = Math.max(5e3, span / 60);
    for (let t = ms - span * 0.35; t <= ms + span; t += step) {
      if (!propagate(T.selRec, t, st)) continue;
      obsAt(this.obs, t, ctx);
      const d = [st[0] - ctx.o[0], st[1] - ctx.o[1], st[2] - ctx.o[2]], rg = Math.hypot(...d), wv = mulM3(ctx.M, [d[0] / rg, d[1] / rg, d[2] / rg]);
      const lit = sunlitFrac([st[0], st[1], st[2]], ctx);
      const rel = Math.round((t - ms) / 60e3);
      out.push({ d: wv, alt: Math.asin(clamp(wv[1], -1, 1)) / DEG, lit: lit > 0.05, tick: Math.abs((t - ms) % 60e3) < step / 2 && rel % 2 === 0 && rel !== 0 ? (rel > 0 ? '+' : '') + rel + 'm' : '' });
    }
    this.path = out;
  }
  // pick: nearest satellite (or planet/Moon/Sun) to a screen point
  pick(x, y, w, h) {
    const T = this.app.tracker; let best = -1, bd = 26;
    for (let k = 0; k < this.nVis; k++) { const i = this.visIdx[k]; const p = this.project(this.liftDir([T.dir[i * 3], T.dir[i * 3 + 1], T.dir[i * 3 + 2]]), w, h); if (!p) continue; const d = Math.hypot(p[0] - x, p[1] - y) - Math.max(0, 6 - T.mag[i]) * 1.5; if (d < bd) { bd = d; best = i; } }
    if (this.app.settings.shadowed && best < 0) for (let i = 0; i < T.N; i++) { if (T.alt[i] < 0 || T.mag[i] < 90) continue; const p = this.project(this.liftDir([T.dir[i * 3], T.dir[i * 3 + 1], T.dir[i * 3 + 2]]), w, h); if (!p) continue; const d = Math.hypot(p[0] - x, p[1] - y); if (d < bd) { bd = d; best = i; } }
    return best;
  }
}
import { sunlight } from './light.js';
function sunlitFrac(r, ctx) { return sunlight(r, ctx.s, ctx.sd, [0, 0, 0]).f; }
export function extinctionMag(alt) { const s = Math.sin(Math.max(alt, 0) * DEG), X = Math.min(40, 1 / (s + 0.025 * Math.exp(-11 * s))); return 0.25 * X; }
