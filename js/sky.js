// Physically based sky (adapted from SkyScout): single + approximate multiple scattering of sunlight and moonlight
// (Rayleigh, Mie, ozone, Earth's shadow); then stars, planets, Milky Way, Moon. No airglow, aurora or light pollution.
import * as THREE from '../vendor/three.module.min.js';
import { COMMON, REFR } from './glsl.js';
import { SOLAR_GLSL, LUNAR_GLSL } from './eclipse.js';
// eclipse uniforms shared by the Sun, the Moon and the sky (defaults: nothing in front of the Sun, no lunar eclipse)
export function eclipseUniforms(U) {
  if (U.uMoonOcc) return;
  Object.assign(U, { uMoonOcc: { value: 0 }, uOcc1: { value: new THREE.Vector4() }, uOcc2: { value: new THREE.Vector4() }, uSunDiscK: { value: 1 }, uLunAx: { value: new THREE.Vector3(0, 0, 1) }, uLunR: { value: new THREE.Vector2() } });
  if (!U.uMoonRadius) U.uMoonRadius = { value: 0.0045 };
}

const FSQ = new THREE.BufferGeometry();
FSQ.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));

export function makeSkyLUT(renderer, U) {
  const rt = new THREE.WebGLRenderTarget(256, 128, { type: THREE.HalfFloatType, magFilter: THREE.LinearFilter, minFilter: THREE.LinearFilter, depthBuffer: false });
  rt.texture.wrapS = THREE.RepeatWrapping;
  const mat = new THREE.ShaderMaterial({
    uniforms: U, depthTest: false, depthWrite: false,
    vertexShader: `out vec2 vUv; void main(){ vUv = position.xy*0.5+0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: REFR + /* glsl */`
      #define PI 3.14159265
      in vec2 vUv;
      uniform vec3 uSunDir, uMoonDir, uSunE, uMoonE;
      uniform float uAOD, uObsKm, uExposure, uNatSky, uLPScale, uTime;
      uniform sampler2D uLPSky; uniform float uHasLP;
      uniform float uAGT;   // simulated time for airglow motion (s, wrapped)
      uniform float uNoNat; // 1: leave out light from beyond the clouds (airglow, zodiacal light, starlight)
      uniform float uTwAmb; // twilight skylight in Earth's shadow (cd/m2 at the zenith), set from the sun's depression
      float agHash(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
      float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
        return mix(mix(agHash(i), agHash(i+vec2(1,0)), f.x), mix(agHash(i+vec2(0,1)), agHash(i+vec2(1,1)), f.x), f.y); }
      float fbm3(vec2 p){ float s = 0.0, a = 0.5; for (int i = 0; i < 3; i++){ s += a*vnoise(p); p = p*2.03 + 17.1; a *= 0.5; } return s/0.875; }
      uniform mat3 uEclip; // world -> ecliptic frame (for zodiacal light)
      const float Rg = 6360.0, Rt = 6460.0;
      const vec3 bR = vec3(5.802e-3, 13.558e-3, 33.1e-3);
      const vec3 bO = vec3(0.650e-3, 1.881e-3, 0.085e-3);
      vec2 rs(vec3 ro, vec3 rd, float r){ float b = dot(ro, rd), c = dot(ro, ro) - r*r, d = b*b - c; if (d < 0.0) return vec2(-1.0); d = sqrt(d); return vec2(-b-d, -b+d); }
      vec3 dens(float h){ return vec3(exp(-h/8.0), exp(-h/1.2), max(0.0, 1.0 - abs(h-25.0)/15.0)); }
      vec3 ext(vec3 d){ float bM = uAOD/1.2; return bR*d.x + vec3(bM*1.11)*d.y + bO*d.z; }
      // transmittance from p toward the light; 0 inside Earth's shadow (soft edge)
      vec3 lightT(vec3 p, vec3 l){
        float g = rs(p, l, Rg).x;
        float r = length(p), mu = dot(p, l)/r;
        // soft shadow: how far the ray grazes below the ground
        float grazing = r*sqrt(max(0.0, 1.0 - mu*mu)) - Rg;
        float vis = mu > 0.0 ? 1.0 : smoothstep(-0.5, 2.0, grazing);
        if (vis <= 0.0) return vec3(0.0);
        float t1 = rs(p, l, Rt).y; vec3 od = vec3(0.0); float dt = t1/8.0;
        for (int i = 0; i < 8; i++){ vec3 q = p + l*dt*(float(i)+0.5); od += dens(length(q)-Rg)*dt; }
        return exp(-ext(od))*vis;
      }
      float pR(float c){ return 3.0/(16.0*PI)*(1.0+c*c); }
      float pM(float c){ float g = 0.76; return 3.0/(8.0*PI)*((1.0-g*g)*(1.0+c*c))/((2.0+g*g)*pow(1.0+g*g-2.0*g*c, 1.5)); }
      vec3 lpSky(vec3 d){
        float az = atan(d.x, -d.z); if (az < 0.0) az += 2.0*PI;
        float h = max(asin(clamp(d.y,-1.0,1.0)), 0.0);
        vec2 e = texture(uLPSky, vec2(az/(2.0*PI), sqrt(h/(0.5*PI)))).rg;
        return pow(vec3(10.0), vec3(e.r*7.0 - 8.0)) * uHasLP;
      }
      void main(){
        float az = vUv.x*2.0*PI; float s = vUv.y*2.0 - 1.0; float h = max(sign(s)*s*s*0.5*PI, 0.004);
        vec3 rd = vec3(cos(h)*sin(az), sin(h), -cos(h)*cos(az));
        vec3 ro = vec3(0.0, Rg + uObsKm, 0.0);
        vec2 top = rs(ro, rd, Rt); vec2 gr = rs(ro, rd, Rg);
        float tMax = top.y; bool ground = gr.x > 0.0; if (ground) tMax = gr.x;
        tMax = min(tMax, 1200.0);   // a horizontal ray leaves the atmosphere ~1130 km away; twilight glow near the horizon comes from that far, sunlit air
        vec3 L = vec3(0.0), T = vec3(1.0);
        float cs = dot(rd, uSunDir), cm = dot(rd, uMoonDir);
        float bM = uAOD/1.2;
        const int N = 28;
        float prev = 0.0;
        for (int i = 1; i <= N; i++){
          float t = tMax * pow(float(i)/float(N), 2.0);
          float dt = t - prev; float tm = (t + prev)*0.5; prev = t;
          vec3 p = ro + rd*tm; float hh = length(p) - Rg;
          vec3 d = dens(hh);
          vec3 sR = bR*d.x, sM = vec3(bM*d.y);
          vec3 Ts = lightT(p, uSunDir), Tm = lightT(p, uMoonDir);
          vec3 S = (sR*pR(cs) + sM*pM(cs))*Ts*uSunE + (sR*pR(cm) + sM*pM(cm))*Tm*uMoonE;
          // cheap multiple scattering: isotropic, from the light that reaches this point and the lit sky above it
          S += (sR + sM) * (Ts*uSunE + Tm*uMoonE) * 0.11 / (4.0*PI);
          vec3 stepT = exp(-ext(d)*dt);
          L += T * S * (1.0 - stepT) / max(ext(d), vec3(1e-7));
          T *= stepT;
        }
        // natural night-sky background (diffuse starlight scattered by the air; no airglow, zodiacal light or light
        // pollution in this app)
        float hp = max(asin(clamp(rd.y, -1.0, 1.0)), 0.0);
        float X = 1.0/(sin(hp) + 0.025*exp(-11.0*sin(hp)));
        vec3 nat = vec3(0.9, 0.95, 1.0) * uNatSky * 0.35 * exp(-0.25*min(X, 30.0));
        // Twilight: air inside Earth's shadow is still lit by light scattered from the bright twilight sky, so the
        // shadow side and the zenith stay a modest fraction of the glow instead of going black. Bluish (ozone),
        // somewhat brighter low down and toward the sun; zero in daylight and at night.
        vec3 tw = vec3(0.0);
        if (uTwAmb > 0.0) {
          float sh2 = sin(max(h, 0.0));
          float fh = pow(1.25/(sh2 + 0.25), 0.6);
          vec2 sz = normalize(vec2(uSunDir.x, uSunDir.z) + 1e-5), rz = normalize(vec2(rd.x, rd.z) + 1e-5);
          float fa = 1.0 + 0.35*dot(sz, rz)*(1.0 - sh2);
          tw = vec3(0.55, 0.85, 1.38) * uTwAmb * fh * fa * exp(-0.05*min(X, 30.0));
        }
        vec3 col = L + nat*(1.0 - uNoNat) + tw;
        if (ground) col = col * 0.6 + T * vec3(0.05) * (uSunE * max(uSunDir.y, 0.0) + uMoonE*max(uMoonDir.y,0.0)) / PI * 0.0;
        gl_FragColor = vec4(min(col * uExposure, vec3(60000.0)), 1.0);
      }`,
  });
  Object.assign(U, {
    uAGT: { value: 0 }, uNoNat: { value: 0 }, uTwAmb: { value: 0 }, uObsKm: { value: 0 }, uNatSky: { value: 1.71e-4 }, uLPScale: { value: 1 }, uLPSky: { value: null }, uHasLP: { value: 0 },
    uEclip: { value: new THREE.Matrix3() },
  });
  const scene = new THREE.Scene(), cam = new THREE.Camera();
  const mesh = new THREE.Mesh(FSQ, mat); mesh.frustumCulled = false; scene.add(mesh);
  // a small second copy without the light from beyond the clouds: the haze in front of a cloud is lower air,
  // so it must not carry airglow waves or zodiacal light onto the cloud
  const rtLow = new THREE.WebGLRenderTarget(128, 64, { type: THREE.HalfFloatType, magFilter: THREE.LinearFilter, minFilter: THREE.LinearFilter, depthBuffer: false });
  rtLow.texture.wrapS = THREE.RepeatWrapping;
  return { rt, rtLow, render() {
    const o = renderer.getRenderTarget(); renderer.setRenderTarget(rt); renderer.render(scene, cam);
    U.uNoNat.value = 1; renderer.setRenderTarget(rtLow); renderer.render(scene, cam); U.uNoNat.value = 0;
    renderer.setRenderTarget(o);
  } };
}


// Sunspots and faculae from a real 360 deg map of the solar surface (SDO/HMI synoptic magnetogram of Carrington
// rotation 2287, mid-2024 near solar maximum; tools/sunmap.py). It is wrapped on the Sun about its true axis (J2000
// RA 286.13, Dec 63.87) and turned with the IAU prime meridian W = 84.176 + 14.1844 d deg, so spots cross the disc
// from the east limb to the west limb in ~13.5 days at any date. n: surface normal (J2000), mu: cos of the view angle.
export const SUNSPOTS = /* glsl */`
uniform sampler2D uSunMap; uniform float uSunW;
float sunspots(vec3 n, float mu){
  const vec3 P = vec3(0.12266, -0.42330, 0.89765);
  vec3 Q = normalize(cross(vec3(0.0, 0.0, 1.0), P)), S = cross(P, Q);   // Q: ascending node of the solar equator
  float lat = asin(clamp(dot(n, P), -1.0, 1.0));
  float L = atan(dot(n, S), dot(n, Q)) - uSunW;
  vec2 uv = vec2(fract(L/6.2831853), 0.5 + lat/3.14159265);
  vec2 m = texture(uSunMap, uv).rg;
  // faculae: bright plage that shows mainly toward the limb
  return m.r * (1.0 + m.g*0.28*pow(1.0 - mu, 1.5));
}`;
let sunTex = null;
export function sunMapTexture(THREE_) {
  if (sunTex) return sunTex;
  sunTex = new THREE.TextureLoader().load('data/sun-map.png'); sunTex.colorSpace = THREE.NoColorSpace; sunTex.wrapS = THREE.RepeatWrapping; sunTex.anisotropy = 8;
  return sunTex;
}
// IAU solar prime meridian angle (radians, wrapped) at unix ms
export function sunPrimeMeridian(ms) { const d = (ms - 946728000000) / 864e5; return (((84.176 + 14.1844 * d) % 360) + 360) % 360 * Math.PI / 180; }

// Light-pollution sky texture from the worker output (log-encoded, uniform in sqrt-altitude).
export function lpSkyTexture(lp) {
  const W = lp.nAz, H = 32, data = new Uint8Array(W * H * 4);
  const enc = L => Math.max(0, Math.min(255, Math.round((Math.log10(Math.max(L, 1e-8)) + 8) / 7 * 255)));
  const sampleAlt = (arr, a, altDeg) => {
    const al = lp.alts; let k = 0; while (k < al.length - 2 && al[k + 1] < altDeg) k++;
    const f = Math.max(0, Math.min(1, (altDeg - al[k]) / (al[k + 1] - al[k])));
    const v0 = arr[a * al.length + k], v1 = arr[a * al.length + k + 1];
    return Math.exp(Math.log(Math.max(v0, 1e-9)) * (1 - f) + Math.log(Math.max(v1, 1e-9)) * f);
  };
  for (let j = 0; j < H; j++) {
    const alt = (j / (H - 1)) ** 2 * 90;
    for (let i = 0; i < W; i++) {
      const k = (j * W + i) * 4;
      data[k] = enc(sampleAlt(lp.clear, i, alt)); data[k + 1] = enc(sampleAlt(lp.cloud, i, alt)); data[k + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
  t.wrapS = THREE.RepeatWrapping; t.magFilter = t.minFilter = THREE.LinearFilter; t.needsUpdate = true;
  return t;
}

// Background: sky LUT + sun disc + Milky Way. Drawn first, at the far plane.
export function makeSkyBackground(U, mwTex) {
  Object.assign(U, { uViewport: { value: new THREE.Vector2() }, uSunW: { value: 0 }, uSunMap: { value: sunMapTexture() }, uMW: { value: mwTex }, uEqToWorld: { value: new THREE.Matrix3() }, uGal: { value: new THREE.Matrix3() }, uInvProjView: { value: new THREE.Matrix4() }, uCamPos: { value: new THREE.Vector3() }, uMWScale: { value: 1 },
    uAurora: { value: new THREE.Vector4() }, uAurP: { value: (() => { const t = new THREE.DataTexture(new Uint8Array(4), 1, 1); t.needsUpdate = true; return t; })() }, uENU: { value: new THREE.Matrix3() }, uObsECEF: { value: new THREE.Vector3(0, 0, 6371) }, uMagAxis: { value: new THREE.Vector3(0, 0, 1) } });
  eclipseUniforms(U);
  const mat = new THREE.ShaderMaterial({
    uniforms: U, depthTest: false, depthWrite: false,
    vertexShader: `out vec3 vDir; uniform mat4 uInvProjView; uniform vec3 uCamPos;
      void main(){ vec4 w = uInvProjView * vec4(position.xy, 0.5, 1.0); vDir = w.xyz/w.w - uCamPos; gl_Position = vec4(position.xy, 1.0, 1.0); }`,
    fragmentShader: COMMON + /* glsl */`
      in vec3 vDir; uniform sampler2D uMW; uniform mat3 uEqToWorld, uGal; uniform float uMWScale, uSunSquish, uSunDiscK, uMoonRadius;
      ${SUNSPOTS}
      ${SOLAR_GLSL}
      uniform vec2 uViewport; uniform mat4 uInvProjView; uniform vec3 uCamPos;
      void main(){
        // the view direction from this pixel's exact screen position: an interpolated direction is too coarse when
        // zoomed onto the Sun (its surface would be sampled in steps)
        vec3 d = normalize(vDir);
        if (uViewport.x > 0.0) { vec4 wp = uInvProjView * vec4(gl_FragCoord.xy/uViewport*2.0 - 1.0, 0.5, 1.0); d = normalize(wp.xyz/wp.w - uCamPos); }
        vec3 dT = refrTrue(d);     // where this line of sight points without the atmosphere's bending
        vec3 col = skyL(d);
        float sh = d.y;
        // Sun disc with limb darkening, reddened by extinction; squashed vertically near the horizon (refraction
        // lifts its lower edge more than its upper edge)
        vec3 sV = vec3(0.0, 1.0, 0.0) - uSunDir*uSunDir.y; sV = dot(sV, sV) > 1e-8 ? normalize(sV) : vec3(1.0, 0.0, 0.0);
        vec3 sH = cross(uSunDir, sV);
        float r = atan(length(vec2(dot(d, sH), dot(d, sV)/uSunSquish)), dot(d, uSunDir));
        float R = 0.00465;
        // the Moon (and Mercury or Venus in transit) in front of the Sun
        vec3 mF = normalize(uMoonDir), mV = vec3(0.0, 1.0, 0.0) - mF*mF.y; mV = dot(mV, mV) > 1e-8 ? normalize(mV) : vec3(1.0, 0.0, 0.0);
        float occ = r < R*14.0 ? notMoon(d, cross(mF, mV), mV) : 1.0;
        if (r < R*14.0 && sh > -0.02) {
          // corona and chromosphere: always there, a millionth of the disc, so only seen when the Moon covers it all
          float rr = r/R, th = atan(dot(d, sV), dot(d, sH));
          col += uSunE*uSunDiscK*2.15e4*(vec3(1.0, 0.97, 0.93)*corona(rr, th) + chromo(rr, th))*directT(uSunDir.y)*uExposure*occ*smoothstep(-0.02, 0.0, sh);
        }
        if (r < R*1.6 && sh > -0.02) {
          float mu = sqrt(max(0.0, 1.0 - (r/R)*(r/R)));
          float limb = r < R ? (0.4 + 0.6*mu) : 0.0;
          if (r < R) {   // the point on the solar surface this ray sees -> sunspots
            vec2 uv = vec2(dot(d, sH), dot(d, sV)/uSunSquish)/R;
            vec3 nW = normalize(sH*uv.x + sV*uv.y - uSunDir*sqrt(max(0.0, 1.0 - dot(uv, uv))));
            limb *= sunspots(transpose(uEqToWorld)*nW, mu);
          }
          col += uSunE * uSunDiscK * 2.15e4 * limb * occ * directT(uSunDir.y) * uExposure * smoothstep(-0.02, 0.0, sh);
        }
        // Milky Way from an all-sky photograph (ESO/S. Brunier), stars removed, mapped in galactic coordinates
        // (coordinates and their screen derivatives outside the branch, where derivatives are well defined)
        vec3 mwE = transpose(uEqToWorld) * dT;
        vec3 g = uGal * mwE; float gl = atan(g.y, g.x), gb = asin(clamp(g.z,-1.0,1.0));
        // longitude wraps from 1 to 0 at l = 180 deg: take the mip-level gradients across the wrap, or that pixel
        // column picks the blurriest level and draws a thin seam through the sky
        vec2 mwUV = vec2(0.5 - gl/(2.0*PI), 0.5 + gb/PI);
        vec2 gx = dFdx(mwUV), gy = dFdy(mwUV); gx.x -= floor(gx.x + 0.5); gy.x -= floor(gy.x + 0.5);
        if (sh > -0.05) {
          vec3 mw = textureGrad(uMW, mwUV, gx, gy).rgb; mw *= mw;   // stored sqrt-encoded
          vec3 T = directT(max(sh, 0.0));
          col += mw * 1.3e-3 * uMWScale * uExposure * T * smoothstep(-0.05, 0.03, sh);
        }
        gl_FragColor = vec4(min(col, vec3(3.0e4)), 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(FSQ, mat); mesh.frustumCulled = false; mesh.renderOrder = -100;
  return mesh;
}

// Milky Way photograph (galactic coordinates), see tools/milkyway.py
export function milkyWayPhoto() {
  const t = new THREE.TextureLoader().load('data/milkyway.jpg');
  t.colorSpace = THREE.NoColorSpace; t.wrapS = THREE.RepeatWrapping; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.anisotropy = 4;
  return t;
}
// Milky Way brightness map from contour polygons (equirectangular RA/Dec), blurred.
export function milkyWayTexture(levels) {
  const W = 2048, H = 1024, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
  const lv = [0.18, 0.2, 0.22, 0.2, 0.2];
  levels.forEach((L, li) => {
    g.filter = `blur(${[6, 4, 3, 2, 2][li] || 2}px)`;
    g.fillStyle = `rgba(255,255,255,${lv[li] || 0.2})`;
    for (const ring of L.polys) {
      // unwrap RA so rings crossing 0h stay continuous, then draw at three offsets
      const pts = []; let prev = null;
      for (const [ra, dec] of ring) { let r = ra; if (prev != null) { while (r - prev > 180) r -= 360; while (prev - r > 180) r += 360; } pts.push([r, dec]); prev = r; }
      for (const off of [-360, 0, 360]) {
        g.beginPath();
        pts.forEach(([r, d], i) => { const x = (r + off) / 360 * W, y = (d + 90) / 180 * H; i ? g.lineTo(x, y) : g.moveTo(x, y); });
        g.closePath(); g.fill('evenodd');
      }
    }
  });
  g.filter = 'none';
  const t = new THREE.CanvasTexture(cv); t.wrapS = THREE.RepeatWrapping; t.colorSpace = THREE.NoColorSpace; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

// Stars and planets as PSF splats; extinction, scintillation, and fading by local sky brightness (limiting magnitude).
export function makeStars(U, starData) {
  const s = starData.s, n = s.length / 4;
  const pos = new Float32Array(n * 3), mag = new Float32Array(n), col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const ra = s[i * 4] * Math.PI / 180, de = s[i * 4 + 1] * Math.PI / 180;
    pos[i * 3] = Math.cos(de) * Math.cos(ra); pos[i * 3 + 1] = Math.cos(de) * Math.sin(ra); pos[i * 3 + 2] = Math.sin(de);
    mag[i] = s[i * 4 + 2];
    const c = bvToRGB(s[i * 4 + 3]); col.set(c, i * 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setAttribute('mag', new THREE.BufferAttribute(mag, 1)); geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const mat = starMaterial(U, true);
  const pts = new THREE.Points(geo, mat); pts.frustumCulled = false; pts.renderOrder = -90;
  return pts;
}
export function makePlanets(U) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(7 * 3), 3));
  geo.setAttribute('mag', new THREE.BufferAttribute(new Float32Array(7), 1));
  const c = [[0.9, 0.85, 0.8], [1, 0.98, 0.9], [1, 0.6, 0.4], [1, 0.92, 0.82], [1, 0.9, 0.7], [0.75, 0.9, 1], [0.6, 0.75, 1]];
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(c.flat()), 3));
  const pts = new THREE.Points(geo, starMaterial(U, false)); pts.frustumCulled = false; pts.renderOrder = -89;
  return pts;
}
export function starMaterial(U, eq) {
  if (!U.uNoAtm) U.uNoAtm = { value: 0 };
  if (!U.uPxSr) Object.assign(U, { uPxSr: { value: 1e-6 }, uPxScale: { value: 1 }, uSeeing: { value: 1 }, uZoomGain: { value: 0 } });
  return new THREE.ShaderMaterial({
    uniforms: U, transparent: true, depthTest: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: '#include <common>\n' + COMMON + /* glsl */`
      attribute float mag; attribute vec3 color; uniform mat3 uEqToWorld; uniform float uPxSr, uPxScale, uSeeing, uZoomGain;
      out vec3 vCol; out float vSize;
      #include <logdepthbuf_pars_vertex>
      void main(){
        vec3 d = ${eq ? 'uEqToWorld * position' : 'position'};
        // refraction lift near the horizon (points of light: raised, not reshaped)
        if (uNoAtm < 0.5) d = refrApparent(d);
        float m = mag;
        vec3 T = directT(d.y);
        // local sky brightness -> naked-eye limiting magnitude (Schaefer); stars fade as the sky brightens
        vec3 sky = skyL(d) / uExposure; float Ls = max(dot(sky, vec3(0.2126,0.7152,0.0722)), 1e-6);
        float sqm = 12.583 - 2.5*log(Ls)/log(10.0);
        float lim = 7.93 - 5.0*log(pow(10.0, 4.316 - sqm/5.0) + 1.0)/log(10.0) + uZoomGain;
        float mObs = m - 2.5*log(max(dot(T, vec3(0.2126,0.7152,0.0722)), 1e-5))/log(10.0);
        float vis = smoothstep(lim + 0.4, lim - 0.9, mObs) * (uNoAtm > 0.5 ? 1.0 : smoothstep(-0.03, 0.01, d.y));
        float E = 2.54e-6 * pow(10.0, -0.4*m); // lux
        // scintillation (stars only: planets, satellites and meteors are extended or not twinkling): random flicker
        // of a few percent overhead, growing with the air mass toward the horizon
        ${eq ? `float sd = fract(position.x*91.7 + position.z*53.1)*100.0;
        float X = 1.0/(max(d.y, 0.0) + 0.025*exp(-11.0*max(d.y, 0.0)) + 0.0001);
        float sig = min(0.03*pow(min(X, 30.0), 1.25), 0.3) * (1.0 - uNoAtm);
        float tw = 1.0 + sig*1.6*(vnoise(vec2(uTime*9.0 + sd, sd*0.37)) + vnoise(vec2(uTime*17.0 - sd, sd*1.3)) - 1.0);` : 'float tw = 1.0;'}
        float size = (2.6 + max(0.0, 2.5 - m)*1.4) * uPxScale * uSeeing;
        float area = 3.1416*size*size*0.25;
        vCol = color * T * E / (uPxSr*area) * uExposure * vis * tw * 9.0;   // the eye integrates point sources better than a pixel does
        vSize = size;
        gl_PointSize = size;
        vec4 mv = viewMatrix * vec4(d*1.0e6 + cameraPosition, 1.0);
        gl_Position = projectionMatrix * mv;
        #include <logdepthbuf_vertex>
        if (vis <= 0.001) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      }`,
    fragmentShader: /* glsl */`
      in vec3 vCol; in float vSize;
      #include <logdepthbuf_pars_fragment>
      void main(){
        #include <logdepthbuf_fragment>
        vec2 p = gl_PointCoord*2.0-1.0; float r2 = dot(p,p); if (r2 > 1.0) discard;
        float g = exp(-r2*4.0); gl_FragColor = vec4(min(vCol * g * 1.6, vec3(3.0e4)), 1.0);
      }`,
  });
}
// Rough blackbody colour from B-V.
export function bvToRGB(bv) {
  bv = Math.max(-0.4, Math.min(2, bv));
  const t = 4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62));
  const k = t / 100; let r, g, b;
  r = k <= 66 ? 255 : 329.7 * Math.pow(k - 60, -0.1332);
  g = k <= 66 ? 99.47 * Math.log(k) - 161.1 : 288.1 * Math.pow(k - 60, -0.0755);
  b = k >= 66 ? 255 : k <= 19 ? 0 : 138.5 * Math.log(k - 10) - 305;
  const c = [r, g, b].map(v => Math.max(0, Math.min(255, v)) / 255);
  const l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  // desaturate: the eye sees star colours only weakly
  return c.map(v => (v / l) * 0.55 + 0.45);
}

// Moon: lit sphere with procedural maria, correct phase from the true Sun direction, earthshine, extinction.
export function makeMoon(U) {
  eclipseUniforms(U);
  Object.assign(U, { uMoonLight: { value: new THREE.Vector3() }, uMoonRadius: { value: 0.0045 }, uMoonLum: { value: 2500 }, uMoonGain: { value: 1 }, uMoonAvg: { value: 0 }, uMoonCam: { value: 0 }, uMoonMapOK: { value: 0 }, uMoonCap: { value: 3.5 }, uLunAvg: { value: new THREE.Vector3(1, 1, 1) } });
  // real albedo map: NASA LRO (SVS CGI Moon Kit, public domain), reduced to 512x256 greyscale (30 KB)
  U.uMoonMap = { value: new THREE.TextureLoader().load('data/moon.jpg', t => { t.wrapS = THREE.RepeatWrapping; t.needsUpdate = true; U.uMoonMapOK.value = 1; }) };
  const geo = new THREE.PlaneGeometry(2, 2);
  const mat = new THREE.ShaderMaterial({
    uniforms: U, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */`
      #include <common>
      uniform vec3 uMoonDir; uniform float uMoonRadius, uPxSr, uMoonCam, uMoonSquish; uniform mat3 uEqToWorld; out vec2 vP; out float vQ;
      #include <logdepthbuf_pars_vertex>
      void main(){
        vP = position.xy;
        // at least ~1.5 px across so the Moon can't fall between pixels; a camera also gets room for the glare
        // around an overexposed Moon (vQ = quad size / true size)
        float Rq = max(uMoonRadius, 1.5*sqrt(uPxSr)) * mix(1.0, 7.0, uMoonCam); vQ = Rq/uMoonRadius;
        vec3 f = normalize(uMoonDir), pole = normalize(uEqToWorld * vec3(0.0, -0.3978, 0.9175)), up0 = abs(dot(pole, f)) > 0.999 ? vec3(1,0,0) : pole;   // lunar north ~ ecliptic pole
        // r = screen right, u = up: the quad faces the camera (it was wound away from it and culled, and mirrored)
        vec3 r = normalize(cross(f, up0)), u = cross(r, f);
        float s = tan(Rq) * 1.0e6 * 1.02;
        vec3 o = (r*position.x + u*position.y)*s;
        // refraction squashes the disc vertically near the horizon
        vec3 vt = vec3(0.0, 1.0, 0.0) - f*f.y; vt = dot(vt, vt) > 1e-8 ? normalize(vt) : r;
        o -= vt*dot(o, vt)*(1.0 - uMoonSquish);
        vec3 w = cameraPosition + f*1.0e6 + o;
        gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: COMMON + /* glsl */`
      in vec2 vP; in float vQ; uniform vec3 uMoonLight, uLunAvg; uniform float uMoonLum, uMoonGain, uMoonAvg, uPxSr, uMoonRadius, uMoonCam, uMoonMapOK, uMoonCap; uniform mat3 uEqToWorld; uniform sampler2D uMoonMap;
      ${LUNAR_GLSL}
      #include <logdepthbuf_pars_fragment>
      void main(){
        #include <logdepthbuf_fragment>
        if (dot(vP, vP) > 1.0) discard;
        vec3 f = normalize(uMoonDir), pole = normalize(uEqToWorld * vec3(0.0, -0.3978, 0.9175)), up0 = abs(dot(pole, f)) > 0.999 ? vec3(1,0,0) : pole;   // lunar north ~ ecliptic pole
        vec3 T = directT(uMoonDir.y);
        vec2 q = vP*vQ; float r2 = dot(q, q);
        vec3 det = vec3(0.0);
        if (r2 <= 1.0) {
        vec3 rr = normalize(cross(f, up0)), uu = cross(rr, f);
        vec3 n = normalize(rr*q.x + uu*q.y - f*sqrt(1.0 - r2)); // surface normal facing us
        float ci = dot(n, uMoonLight), ce = sqrt(1.0 - r2);
        // albedo from the real lunar map: near side toward us (selenographic latitude/longitude on the disc);
        // grey^1.3 makes highlands ~2.5x the maria, scaled so the near-side mean albedo stays 0.12
        float slat = asin(clamp(q.y, -1.0, 1.0)), slon = atan(q.x, sqrt(1.0 - r2));
        float gm = texture(uMoonMap, vec2(0.5 + slon/(2.0*PI), 0.5 + slat/PI)).r;
        float alb = uMoonMapOK > 0.5 ? 0.12*pow(gm, 1.3)/0.4224 : 0.12;
        float ls = ci > 0.0 ? ci/(ci + ce) : 0.0;          // Lommel-Seeliger
        float L = uMoonLum * uMoonGain * alb/0.12 * ls * 2.0;   // sunlit part follows the phase curve; earthshine doesn't
        // earthshine follows the Earth's phase seen from the Moon (Lambert sphere): strong for a crescent Moon, faint
        // by the quarter, effectively gone at gibbous
        float bE = PI - acos(clamp(dot(uMoonLight, -f), -1.0, 1.0));
        float earthshine = uMoonLum * 1.32e-4 * alb/0.12 * (sin(bE) + (PI - bE)*cos(bE))/PI;
        // a lunar eclipse: the Earth's penumbra and red umbra on this point of the disc (earthshine is gone too: the
        // Earth then shows the Moon its night side)
        vec3 lsh = lunarShade(normalize(f + (rr*q.x + uu*q.y)*uMoonRadius));
        det = vec3(1.0, 0.95, 0.88) * (L + earthshine*min(lsh.g, 1.0)) * lsh * T * uExposure * smoothstep(1.0, 0.96, r2);
        }
        // only a few pixels across: shade the disc evenly with its mean brightness for this phase (spread over at
        // least ~1.5 px), so its whole light reaches the image; a thin crescent no longer falls between pixel samples
        float Rs = max(uMoonRadius, 1.5*sqrt(uPxSr)), ks = uMoonRadius/Rs;
        vec2 qs = q*ks;
        vec3 avg = dot(qs, qs) <= 1.0 ? vec3(1.0, 0.95, 0.88) * uMoonAvg * uLunAvg * ks*ks * T * uExposure : vec3(0.0);
        // the even disc only below ~2 px radius: from there up the true phase shape shows (a crescent is a crescent)
        float w = smoothstep(1.0, 2.2, uMoonRadius/sqrt(uPxSr));
        vec3 c = mix(avg, det, w);
        // the eye's wide dynamic range: the disc is only slightly overexposed (sunlit surface just past white,
        // maria still visible); a camera exposing for the night sky blows it out
        float peak = mix(uMoonAvg*ks*ks, uMoonLum*uMoonGain, w) * dot(T, vec3(0.2126, 0.7152, 0.0722)) * uExposure;
        // in a lunar eclipse the eye adapts to the dimmed disc: deep in the umbra the copper-red Moon stands out clearly
        // (instead of being squashed as if it were still a full Moon); a sunlit sliver left at the edge stays blown out
        peak *= clamp(uLunAvg.r*1.6, 1.0e-6, 1.0);
        c *= mix(min(1.0, uMoonCap/max(peak, 1e-6)), 1.0, uMoonCam);
        // camera: glare from lens and sensor around the overexposed Moon, scaled by its total light
        if (uMoonCam > 0.0) {
          // fades in exactly as the disc's soft limb fades out, so there is no dark ring between them
          float d = max(length(q), 1.0), under = 1.0 - smoothstep(1.0, 0.96, min(r2, 1.0));
          c += vec3(1.0, 0.95, 0.88) * uMoonAvg * T * uExposure * 0.02 * exp(-(d - 1.0)*1.2)/(d*d) * uMoonCam * under;
        }
        gl_FragColor = vec4(min(c * max(uNoAtm, step(-0.012, uMoonDir.y)), vec3(3.0e4)), 1.0);   // the opaque ground hides it at the horizon
      }`,
  });
  const m = new THREE.Mesh(geo, mat); m.frustumCulled = false; m.renderOrder = -80;
  return m;
}

// Glare around the Moon, over everything in view (it happens in the eye or the lens, not the sky). Eye: the
// Stiles-Holladay disability-glare law, L = 10 E / theta^2 (cd/m^2, E in lux at the eye, theta in degrees), so even a
// crescent lifts the whole sky a little and a full Moon a lot. Camera: lens and sensor flare, stronger and wider.
export function makeMoonGlare(U) {
  // uLunGlow: colour and extra strength of the glare during a lunar eclipse (red like the Moon, and weaker relative to
  // the disc the deeper the eclipse, so the disc itself stands out at totality)
  Object.assign(U, { uMoonVis: { value: 1 }, uMoonGlare: { value: 1 }, uLunGlow: { value: new THREE.Vector3(1, 0.96, 0.9) } });
  const mat = new THREE.ShaderMaterial({
    uniforms: U, transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: `out vec3 vDir; uniform mat4 uInvProjView; uniform vec3 uCamPos;
      void main(){ vec4 w = uInvProjView * vec4(position.xy, 0.5, 1.0); vDir = w.xyz/w.w - uCamPos; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: COMMON + /* glsl */`
      in vec3 vDir; uniform float uMoonCam, uMoonVis, uMoonGlare, uMoonRadius; uniform vec3 uLunGlow;
      void main(){
        vec3 d = normalize(vDir), m = normalize(uMoonDir);
        float th = max(acos(clamp(dot(d, m), -1.0, 1.0)), uMoonRadius*1.3) * 57.29578;   // degrees from the Moon
        float E = dot(uMoonE * directT(max(m.y, 0.0)), vec3(0.2126, 0.7152, 0.0722)) * smoothstep(-0.01, 0.01, m.y) * uMoonVis;
        float L = mix(10.0*E/(th*th), 60.0*E/pow(th, 1.6), uMoonCam) * uMoonGlare;
        gl_FragColor = vec4(uLunGlow * min(L*uExposure, 3.0e4), 1.0);
      }`,
  });
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const m = new THREE.Mesh(geo, mat); m.frustumCulled = false; m.renderOrder = 900;
  return m;
}

// Faint stars (6.6 < V <= 8) loaded on demand; they only show when zoomed in under dark skies.
export async function makeFaintStars(U) {
  const buf = await (await fetch('data/stars8.bin')).arrayBuffer(), dv = new DataView(buf), n = buf.byteLength / 6;
  const pos = new Float32Array(n * 3), mag = new Float32Array(n), col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const ra = dv.getUint16(i * 6, true) / 65535 * 2 * Math.PI, de = dv.getInt16(i * 6 + 2, true) / 32767 * Math.PI / 2;
    pos[i * 3] = Math.cos(de) * Math.cos(ra); pos[i * 3 + 1] = Math.cos(de) * Math.sin(ra); pos[i * 3 + 2] = Math.sin(de);
    mag[i] = dv.getUint8(i * 6 + 4) / 20; col.set(bvToRGB(dv.getInt8(i * 6 + 5) / 50), i * 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setAttribute('mag', new THREE.BufferAttribute(mag, 1)); geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const pts = new THREE.Points(geo, starMaterial(U, true)); pts.frustumCulled = false; pts.renderOrder = -91;
  return pts;
}

// Deep stars from Gaia DR3 (8 < V <= 10.5, tools/prepgaia.cjs): 8-byte records, ~1.3 arcsec precision.
export async function makeGaiaStars(U, file) {
  const buf = await (await fetch(file)).arrayBuffer(), dv = new DataView(buf), n = buf.byteLength / 8;
  const pos = new Float32Array(n * 3), mag = new Float32Array(n), col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const o = i * 8, raw = dv.getUint8(o) | (dv.getUint8(o + 1) << 8) | (dv.getUint8(o + 2) << 16);
    let d = dv.getUint8(o + 3) | (dv.getUint8(o + 4) << 8) | (dv.getUint8(o + 5) << 16); if (d & 0x800000) d -= 0x1000000;
    const ra = raw / 16777215 * 2 * Math.PI, de = d / 8388607 * Math.PI / 2;
    pos[i * 3] = Math.cos(de) * Math.cos(ra); pos[i * 3 + 1] = Math.cos(de) * Math.sin(ra); pos[i * 3 + 2] = Math.sin(de);
    mag[i] = dv.getUint8(o + 6) / 20; col.set(bvToRGB(dv.getInt8(o + 7) / 50), i * 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setAttribute('mag', new THREE.BufferAttribute(mag, 1)); geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const pts = new THREE.Points(geo, starMaterial(U, true)); pts.frustumCulled = false; pts.renderOrder = -92;
  return pts;
}
