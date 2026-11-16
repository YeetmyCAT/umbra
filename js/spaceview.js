// View from orbit: the selected satellite's model with the Earth below, from a chase camera (fixed 60 deg field).
// Frames: TEME km for the Earth and other objects, metres around the satellite for its model; stars and planets
// rotated from J2000 into the true equator of date (~TEME).
import * as THREE from '../vendor/three.module.min.js';
import { makeEarth } from './earth.js';
import { makeStars, makeMoon, makePlanets, milkyWayPhoto, makeFaintStars, starMaterial, SUNSPOTS, sunMapTexture, sunPrimeMeridian, eclipseUniforms } from './sky.js';
import { SOLAR_GLSL, sunMoonTEME, sunCovered, lunarShadow, setEarthEclipse, litCentroid, starEclipse } from './eclipse.js';
import { buildModel, poseModel, disposeModel } from './models3d.js';
import { gmst, sunTEME, moonTEME, DEG } from './frames.js';
import { propagate, decayTime } from './sgp.js';
import { sunlight, earthshine, bodyFrame, facetsIntensity, magFromI, spherePhase } from './light.js';
import { EQ2GAL } from './astro.js';
import { moonGain } from './groundview.js';

const clamp = (x, a, b) => Math.max(a, Math.min(b, x)), lerp = (a, b, t) => a + (b - a) * t;
const A = () => window.Astronomy;

export class SpaceView {
  constructor(app, renderer, assets) {
    this.app = app; this.r = renderer;
    this.earth = makeEarth();
    this.cam = new THREE.PerspectiveCamera(60, 1, 0.1, 1e6); this.cam.up.set(0, 0, 1);
    this.yaw = 200; this.pitch = 12; this.dist = 3; this.fov = 60;
    const U = this.U = {
      uSkyLUT: { value: blackTex() }, uSkyLUTLow: { value: blackTex() }, uExposure: { value: 1 }, uSunDir: { value: new THREE.Vector3() }, uMoonDir: { value: new THREE.Vector3() },
      uSunE: { value: new THREE.Vector3(1.27e5, 1.25e5, 1.2e5) }, uMoonE: { value: new THREE.Vector3() }, uAOD: { value: 0 }, uTime: { value: 0 }, uRefrK: { value: 0 }, uSunSquish: { value: 1 }, uMoonSquish: { value: 1 },
      uNight: { value: 0 }, uSnow: { value: 0 }, uWet: { value: 0 }, uVisKm: { value: 100 }, uOvercast: { value: 0 }, uFlash: { value: new THREE.Vector4() }, uNoAtm: { value: 1 },
      uCamKm: { value: new THREE.Vector3() }, uViewport: { value: new THREE.Vector2() }, uSunW: { value: 0 }, uSunMap: { value: sunMapTexture() }, uEqToWorld: { value: new THREE.Matrix3() }, uMW: { value: milkyWayPhoto() }, uGal: { value: new THREE.Matrix3().set(...EQ2GAL) }, uInvProjView: { value: new THREE.Matrix4() }, uCamPos: { value: new THREE.Vector3() },
    };
    eclipseUniforms(U);
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
      fragmentShader: `in vec3 vDir; uniform sampler2D uMW; uniform mat3 uEqToWorld, uGal; uniform vec3 uSunDir, uSunE, uMoonDir; uniform float uExposure, uMoonRadius;
        ${SUNSPOTS}
        ${SOLAR_GLSL}
        uniform vec2 uViewport; uniform mat4 uInvProjView; uniform vec3 uCamKm;
        void main(){ vec3 d = normalize(vDir);
          if (uViewport.x > 0.0) { vec4 wp = uInvProjView * vec4(gl_FragCoord.xy/uViewport*2.0 - 1.0, 0.5, 1.0); d = normalize(wp.xyz/wp.w); }
          vec3 g = uGal * (transpose(uEqToWorld) * d); float gl = atan(g.y, g.x), gb = asin(clamp(g.z, -1.0, 1.0));
          vec2 uv = vec2(0.5 - gl/6.2831853, 0.5 + gb/3.14159265); vec2 gx = dFdx(uv), gy = dFdy(uv); gx.x -= floor(gx.x + 0.5); gy.x -= floor(gy.x + 0.5);
          vec3 mw = textureGrad(uMW, uv, gx, gy).rgb; mw *= mw;
          vec3 col = mw*1.3e-3*1.25*uExposure;
          float r = atan(length(cross(d, uSunDir)), dot(d, uSunDir)), R = 0.00465;
          vec3 mF = normalize(uMoonDir), mH = normalize(cross(mF, abs(mF.z) < 0.9 ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0)));
          float occ = r < R*14.0 ? notMoon(d, mH, cross(mH, mF)) : 1.0;
          if (r < R) { float mu = sqrt(1.0 - (r/R)*(r/R)); vec3 Tsun = vec3(1.0); { float b = dot(uCamKm, d); if (b < 0.0) { float hg = length(uCamKm - d*b) - 6371.0; if (hg < 0.0) Tsun = vec3(0.0); else if (hg < 150.0) { float xr = exp(-hg/8.0)*70.8, xa = exp(-hg/1.2)*182.9; Tsun = exp(-(vec3(0.10, 0.17, 0.33)*xr + vec3(0.12, 0.13, 0.14)*xa)) / (1.0 + 6.0*exp(-hg/8.0)); } } } vec3 sH = normalize(cross(uSunDir, abs(uSunDir.z) < 0.9 ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0))), sV = cross(sH, uSunDir); vec2 uv = vec2(dot(d, sH), dot(d, sV))/R; vec3 nW = normalize(sH*uv.x + sV*uv.y - uSunDir*sqrt(max(0.0, 1.0 - dot(uv, uv)))); col += uSunE*Tsun*2.15e4*(0.4 + 0.6*mu)*sunspots(transpose(uEqToWorld)*nW, mu)*uExposure*occ; }
          // corona and chromosphere (a millionth of the disc: they show when the Moon covers the Sun)
          // only when the Moon is at the Sun (a real solar eclipse), not when the Sun is behind the Earth
          if (uMoonOcc > 0.5 && r < R*14.0) { vec3 sH2 = normalize(cross(uSunDir, vec3(0.0, 0.0, 1.0))); float th = atan(dot(d, cross(sH2, uSunDir)), dot(d, sH2)); col += uSunE*2.15e4*(vec3(1.0, 0.97, 0.93)*corona(r/R, th) + chromo(r/R, th))*uExposure*occ; }
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
    // re-entry: orange plasma from ~120 km; below 78 km (where re-entering debris typically breaks up and burns away)
    // the orbit ends. The view then stays where it burned up for 20 minutes of simulated time, and then closes.
    this.why = this.blocked(ms); if (this.why) return false;
    const okState = !!(T.selRec && T.selState(ms, st));
    if (!okState && !T.selState(this.burnT - 1000, st)) return false;
    const r = [st[0], st[1], st[2]], v = [st[3], st[4], st[5]];
    const hKm = Math.hypot(r[0], r[1], r[2]) - 6371;
    this.gone = !okState; this.burn = this.gone ? 0 : Math.min(1, Math.max(0, (120 - hKm) / 42));
    const rv = new THREE.Vector3(...r), up = rv.clone().normalize(), vel = new THREE.Vector3(...v);
    const fwd = vel.clone().addScaledVector(up, -vel.dot(up)).normalize(), right = fwd.clone().cross(up);
    // precise Sun and Moon (astronomy-engine): eclipses and the Moon's shadow on the Earth fall in the right place
    const smp = sunMoonTEME(ms), sDist = Math.hypot(...smp.sun), s = [smp.sun[0] / sDist, smp.sun[1] / sDist, smp.sun[2] / sDist]; s.dist = sDist;
    const sun = new THREE.Vector3(s[0], s[1], s[2]);
    const mp = smp.moon, moonV = new THREE.Vector3(...mp).sub(rv), moonD = moonV.length(); moonV.normalize();
    // model
    if (this.modelIdx !== i) {
      if (this.model) { this.mScene.remove(this.model); disposeModel(this.model); }
      this.modelIdx = i; this.shape = T.shape(i); this.model = buildModel(this.shape); this.mScene.add(this.model);
      this.dist = Math.max(0.12, this.shape.size * 1.8);
      const sc = this.sunL.shadow.camera, z = this.shape.size * 0.6; sc.left = sc.bottom = -z; sc.right = sc.top = z; sc.near = 0.1; sc.far = this.shape.size * 4; sc.updateProjectionMatrix();
      this.sunL.shadow.normalBias = this.shape.size / 2048 * 2.5;
    }
    this.model.visible = !this.gone;
    const B = bodyFrame(this.shape.att, r, v, s, ms, T.objs[i].id);
    this.model.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(...B.x), new THREE.Vector3(...B.y), new THREE.Vector3(...B.z)));
    this.model.position.set(0, 0, 0);
    poseModel(this.model, [B.x[0] * s[0] + B.x[1] * s[1] + B.x[2] * s[2], B.y[0] * s[0] + B.y[1] * s[1] + B.y[2] * s[2], B.z[0] * s[0] + B.z[1] * s[1] + B.z[2] * s[2]]);
    // camera: chase (orbits the model in its local horizon frame) at a fixed, natural field of view
    const cy = Math.cos(this.yaw * DEG), sy = Math.sin(this.yaw * DEG), cp = Math.cos(this.pitch * DEG), sp = Math.sin(this.pitch * DEG);
    const dirL = fwd.clone().multiplyScalar(cp * cy).addScaledVector(right, cp * sy).addScaledVector(up, sp);
    this.fov = 60; const cam = this.cam; cam.fov = this.fov; cam.aspect = w / h; cam.up.copy(up);
    cam.position.copy(dirL).multiplyScalar(this.dist); cam.lookAt(0, 0, 0);
    {
      // depth range fitted tightly around the model's parts (their bounding spheres), so the depth buffer resolves
      // millimetres and thin panels never show their back faces through the front (z-fighting)
      this.model.updateMatrixWorld(true);
      let nr = Infinity, fr = 0; const bs = this._bs || (this._bs = new THREE.Sphere());
      this.model.traverse(o => {
        if (!o.isMesh) return;
        if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
        bs.copy(o.geometry.boundingSphere).applyMatrix4(o.matrixWorld);
        const dc = bs.center.distanceTo(cam.position); nr = Math.min(nr, dc - bs.radius); fr = Math.max(fr, dc + bs.radius);
      });
      if (!isFinite(nr)) { nr = this.dist - this.shape.size; fr = this.dist + this.shape.size * 3; }
      cam.far = fr * 1.01 + 0.01; cam.near = Math.max(nr * 0.98, cam.far * 2e-4, 0.005);
    }
    cam.updateProjectionMatrix(); cam.updateMatrixWorld();
    // sky camera (direction only) and Earth camera (km, TEME)
    const skyCam = this.skyCam || (this.skyCam = new THREE.PerspectiveCamera());
    skyCam.copy(cam); skyCam.position.set(0, 0, 0); skyCam.near = 0.1; skyCam.far = 1e7; skyCam.updateProjectionMatrix(); skyCam.updateMatrixWorld();
    const camKm = rv.clone().addScaledVector(cam.position, 1e-3);
    // ray directions from a rotation-only matrix (skyCam sits at the origin); the camera position is separate, so no
    // large numbers cancel in float32 (that made the Earth jitter, worst from GEO)
    E.uCam.value.copy(camKm); E.uInvPV.value.copy(skyCam.projectionMatrixInverse).premultiply(skyCam.matrixWorld);
    E.uSun.value.copy(sun); E.uG.value = gmst(ms); E.uTime.value = (ms / 1000) % 1e5;
    setEarthEclipse(E, smp, Math.pow(10, -0.4 * (this.app.moonMag + 13.99)) || 0.1);
    // eclipses seen from here: the Earth's shadow on the Moon, and how much of the Sun the Moon covers
    const rel = (a) => [a[0] - r[0], a[1] - r[1], a[2] - r[2]];
    const ls = lunarShadow(rel(smp.sun), rel(mp), [-r[0], -r[1], -r[2]]);
    if (ls && ls.depth > 1e-4) { U.uLunAx.value.set(...ls.dir); U.uLunR.value.set(ls.umb, ls.pen); U.uLunAvg.value.set(1, 1 - 0.7 * ls.red, 1 - 0.85 * ls.red).multiplyScalar(ls.mean); }
    else { U.uLunR.value.set(0, 0); U.uLunAvg.value.set(1, 1, 1); }
    const sRel = rel(smp.sun), sRelD = Math.hypot(...sRel), sDirSat = [sRel[0] / sRelD, sRel[1] / sRelD, sRel[2] / sRelD];
    const cover = sunCovered(sDirSat, sRelD, [moonV.x, moonV.y, moonV.z], moonD), open1 = 1 - cover;
    U.uMoonOcc.value = dot3(moonV, sun) > Math.cos(2 * DEG) ? 1 : 0; this.sunOpen = open1;
    this.sunLitOff = null;   // the glare comes from the crescent that is left
    if (cover > 1e-5 && open1 > 0) { const c = litCentroid(sDirSat, Math.asin(696000 / sRelD), [moonV.x, moonV.y, moonV.z], Math.asin(1737.4 / moonD)); this.sunLitOff = [c[0] - sDirSat[0], c[1] - sDirSat[1], c[2] - sDirSat[2]]; }
    U.uMoonCap.value = 1.3;   // like the eye: bright but not blown out into a glowing ball
    // sky uniforms
    const eq = this.eqToTeme(ms); U.uEqToWorld.value.set(...eq); U.uSunW.value = sunPrimeMeridian(ms);
    U.uSunDir.value.copy(sun); U.uMoonDir.value.copy(moonV);
    U.uInvProjView.value.copy(skyCam.projectionMatrixInverse).premultiply(skyCam.matrixWorld); U.uCamPos.value.set(0, 0, 0); U.uViewport.value.set(app.post.rt.width, app.post.rt.height);
    U.uMoonE.value.set(1, 0.94, 0.86).multiplyScalar(E.uMoonE.value);
    const ml = sun.clone().multiplyScalar(1.496e8).sub(new THREE.Vector3(...mp)).normalize(); U.uMoonLight.value.copy(ml);
    U.uMoonRadius.value = Math.atan(1737.4 / moonD); U.uMoonLum.value = 2900;
    {   // phase seen from here (sunlit part and earthshine), as in the ground view
      const pa = Math.acos(clamp(-ml.dot(moonV), -1, 1)) / DEG, md = moonGain(pa), bE = Math.PI - pa * DEG;
      U.uMoonGain.value = md.gain; U.uMoonAvg.value = 2900 * (md.gain * 2 * md.lsMean + 1.32e-4 * (Math.sin(bE) + (Math.PI - bE) * Math.cos(bE)) / Math.PI);
    }
    if (this.app.planetsTEME) { const P = this.planets.geometry.attributes.position.array, M = this.planets.geometry.attributes.mag.array; this.app.planetsTEME.forEach((p, k) => { P.set(p.v, k * 3); M[k] = p.mag; }); this.planets.geometry.attributes.position.needsUpdate = true; this.planets.geometry.attributes.mag.needsUpdate = true; }
    // exposure: measured from the Earth in view (log average), plus the sunlit model when it fills the view
    if ((this.fn = (this.fn || 0) + 1) % 6 === 1) this.measure();
    const L = sunlight(r, s, s.dist, [1, 1, 1]), Lv = 0.2126 * L[0] + 0.7152 * L[1] + 0.0722 * L[2];
    let La = Math.max(this.earthLa || 1e-3, 2e-4);
    La = Math.max(La, Lv * 1.27e5 * 0.6 / Math.PI * 0.35 * clamp(this.shape.size / this.dist, 0.15, 1));
    // (only when the Sun is really there: not when it is behind the Earth, which is straight down in the night view)
    if (Lv > 0 && dot3(sun, skyDir(skyCam)) > Math.cos(cam.fov * DEG * 0.6)) La = Math.max(La, 3000 * Lv * Math.max(open1, 2e-4));   // eclipsed Sun: exposure opens for the corona
    // adjusts to the dark more slowly (~2.5 s) than to light, so a sunrise or sunset stays visible instead of blowing out
    this.adapt = Math.exp(lerp(Math.log(this.adapt), Math.log(La), 1 - Math.exp(-dt * (La > this.adapt ? 2.5 : 0.4))));
    // camera-like exposure (photographs from orbit): mid-tones of what is lit map to ~0.8
    let Ex = 0.8 / this.adapt * Math.pow(2, app.ev);
    Ex = Math.min(Ex, 3 * Math.pow(2, app.ev));   // night side: exposed for the city lights, like a long ISS exposure
    U.uExposure.value = Ex; E.uExposure.value = Ex;
    const pxRad = (cam.fov * DEG) / (h * dpr); U.uPxSr.value = pxRad * pxRad; U.uPxScale.value = dpr; U.uZoomGain.value = clamp(2.2 * Math.log10(60 / cam.fov), 0, 3); U.uTime.value = performance.now() / 1000;
    app.post.final.mat.uniforms.uScot.value = 0;
    // lights on the model
    const es = earthshine(r, s);
    this.sunL.position.copy(sun).multiplyScalar(this.shape.size * 2); this.sunL.target.position.set(0, 0, 0);
    this.sunL.color.setRGB(L[0] / Math.max(Lv, 1e-6), L[1] / Math.max(Lv, 1e-6), L[2] / Math.max(Lv, 1e-6)); this.sunL.intensity = 1.27e5 * Lv * Ex * open1;
    this.esL.position.copy(up).multiplyScalar(-this.shape.size * 2); this.esL.target.position.set(0, 0, 0); this.esL.intensity = 1.27e5 * es * Ex * 0.8;
    this.amb.intensity = 1.27e5 * Ex * (es * 0.15 + 2e-8);
    {   // re-entry plasma: an orange glow around the body, growing as it sinks into denser air
      if (!this.plasma) {
        const c = document.createElement('canvas'); c.width = c.height = 256; const g2 = c.getContext('2d'), gr = g2.createRadialGradient(128, 128, 0, 128, 128, 128);
        for (let k = 0; k <= 16; k++) { const x = k / 16; gr.addColorStop(x, `rgba(255,255,255,${Math.exp(-x * x * 9) * (1 - x)})`); } g2.fillStyle = gr; g2.fillRect(0, 0, 256, 256);
        this.plasma = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
        this.mScene.add(this.plasma);
      }
      const pf = this.burn || 0; this.plasma.visible = pf > 0.001;
      if (this.plasma.visible) {
        if (this.plasmaFor !== this.model) { this.plasmaFor = this.model; const bs = new THREE.Box3().setFromObject(this.model).getBoundingSphere(new THREE.Sphere()); this.plasmaR = bs.radius || this.shape.size * 0.5; }
        // the glow sits just behind the whole model (as seen from the camera), so it never covers any part of it
        const off = this.plasmaR * 1.05, k = (this.dist + off) / this.dist;
        const L = 3.0 * pf * pf; this.plasma.material.color.setRGB(1.0 * L, 0.45 * L, 0.12 * L); this.plasma.scale.setScalar(this.plasmaR * (2.2 + 1.2 * pf) * k);
        this.plasma.position.copy(cam.position).normalize().multiplyScalar(-off);
        if (cam.far < this.dist + off * 1.02) { cam.far = this.dist + off * 1.02; cam.updateProjectionMatrix(); }
      }
    }
    // other satellites near this one (within 3000 km), with their brightness as seen from here
    this.updateOthers(ms, rv, sun, s);
    // render
    const R = this.r;
    R.setRenderTarget(app.post.rt); R.setClearColor(0, 1); R.clear();
    R.render(this.sky, skyCam);
    R.render(this.oScene, skyCam);
    R.render(this.earth.scene, skyCam);
    R.clearDepth(); R.render(this.mScene, cam);
    {
      // the Sun seen from the camera: hidden part (Earth) and the colour of the air its light crosses on the way
      const ck = [camKm.x, camKm.y, camKm.z], Lc = sunlight(ck, s, s.dist, [1, 1, 1]), f = Lc.f;
      const tint = f > 1e-4 ? [Lc[0] / f, Lc[1] / f, Lc[2] / f] : [0, 0, 0];
      U.uSunE.value.set(1.27e5, 1.25e5, 1.2e5); U.uCamKm.value.copy(camKm);   // the disc is dimmed per pixel in the shader
      const v = sun.clone(); if (this.sunLitOff) v.add(new THREE.Vector3(...this.sunLitOff)).normalize();
      v.applyMatrix4(skyCam.matrixWorldInverse);
      const se = starEclipse(open1, cam.fov);
      if (f > 0 && v.z < 0 && se.k > 0) {
        v.applyMatrix4(skyCam.projectionMatrix);
        const W = app.post.rt.width, H = app.post.rt.height, Tl = 0.2126 * tint[0] + 0.7152 * tint[1] + 0.0722 * tint[2];
        if (!this.ray) this.ray = new THREE.Raycaster();
        const sd = sun.clone(), e1 = new THREE.Vector3().crossVectors(sd, Math.abs(sd.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0)).normalize(), e2 = new THREE.Vector3().crossVectors(sd, e1);
        let open = 0, tot = 0;
        for (let q = -1; q < 8; q++) {
          const a = q * Math.PI / 4, o = q < 0 ? 0 : 0.0042, dir = sd.clone().addScaledVector(e1, Math.cos(a) * o).addScaledVector(e2, Math.sin(a) * o).normalize();
          this.ray.set(cam.position, dir); this.ray.far = 1e5;
          const w = q < 0 ? 2 : 1; tot += w; if (!this.ray.intersectObject(this.model, true).length) open += w;
        }
        const blockF = open / tot * se.k;
        const k = f * blockF * clamp((this.fov - 3) / 7, 0, 1) * clamp(Tl * 15, 0, 1) * 0.55 / Math.max(Tl, 1e-4);
        app.post.sunStar([(v.x * 0.5 + 0.5) * W, (v.y * 0.5 + 0.5) * H], [tint[0] * k, tint[1] * k, tint[2] * k], Math.min(W, H) * 0.16 * se.s, 0, 1);
      }
    }
    app.post.finish();
    this.drawOverlay(w, h, ms, r, v, up, skyCam);
    return true;
  }
  // why the selected object can't be shown from here at ms (null if it can)
  blocked(ms) {
    const T = this.app.tracker, i = T.sel, rec = T.selRec;
    if (i < 0 || !rec) return null;
    const name = T.objs[i].name;
    if (ms < T.born[i]) return `${name} had not been launched yet on this date`;
    if (propagate(rec, ms, new Float64Array(6))) return null;
    if (this.burnFor !== rec) { this.burnFor = rec; this.burnT = decayTime(rec, ms); }
    if (this.burnT == null || ms < this.burnT || ms > this.burnT + 1200e3) return `${name} has burned up on reentry`;
    return null;
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
      if (i === self || T.gone(i)) continue;
      const dx = T.pos[i * 3] - rv.x, dy = T.pos[i * 3 + 1] - rv.y, dz = T.pos[i * 3 + 2] - rv.z, d2 = dx * dx + dy * dy + dz * dz;
      // nothing within 25 km: that is a docked vehicle or a co-moving object whose own (older) elements put it a few
      // km off, which would blow up as a giant white disc from the inverse-square law
      if (d2 > 9e6 || d2 < 625) continue;
      const rg = Math.sqrt(d2), r = [T.pos[i * 3], T.pos[i * 3 + 1], T.pos[i * 3 + 2]];
      sunlight(r, s, s.dist, L); const Lv = 0.2126 * L[0] + 0.7152 * L[1] + 0.0722 * L[2]; if (Lv < 1e-3) continue;
      // hidden behind the Earth?
      const ux = dx / rg, uy = dy / rg, uz = dz / rg, b = rv.x * ux + rv.y * uy + rv.z * uz, c = rv.lengthSq() - 6371 * 6371, disc = b * b - c;
      if (disc > 0 && -b - Math.sqrt(disc) > 0 && -b - Math.sqrt(disc) < rg) continue;
      const cphi = -(ux * s[0] + uy * s[1] + uz * s[2]), phi = Math.acos(clamp(cphi, -1, 1));
      const std = T.std[i];
      M[k] = Math.max(-4.5, std + 5 * Math.log10(rg / 1000) - 2.5 * Math.log10(Math.max(spherePhase(phi) * Lv, 1e-6)));   // never brighter than Venus
      P[k * 3] = ux; P[k * 3 + 1] = uy; P[k * 3 + 2] = uz; C[k * 3] = L[0] / Lv; C[k * 3 + 1] = L[1] / Lv; C[k * 3 + 2] = L[2] / Lv; k++;
    }
    g.setDrawRange(0, k); g.attributes.position.needsUpdate = true; g.attributes.mag.needsUpdate = true; g.attributes.color.needsUpdate = true;
  }
  drawOverlay(w, h, ms, r, v, up, skyCam) {
    const ov = this.app.overlay, g = ov.ctx; ov.begin(w, h);
    if (this.gone) { g.font = '600 16px system-ui, sans-serif'; g.textAlign = 'center'; g.fillStyle = 'rgba(255,190,120,0.95)'; g.fillText('Burned up on reentry', w / 2, h * 0.42); g.textAlign = 'left'; }
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
