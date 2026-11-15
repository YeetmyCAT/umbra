// The Earth seen from orbit: one full-screen ray-traced pass (km, TEME frame, Earth at the origin).
//  * Surface: NASA Blue Marble (day), Black Marble city lights (night), a real cloud snapshot with cloud shadows,
//    ocean sun glint (Cox-Munk wave slopes) from a water mask.
//  * Atmosphere: Rayleigh + Mie + ozone single scattering along the view ray, sunlight attenuated by an analytic
//    Chapman optical depth and the Earth's shadow, plus a cheap multiple-scattering term. Gives the thin blue limb,
//    the reddened terminator and twilight arcs.
//  * Aurora: emission between 95 and 320 km where NOAA's OVATION nowcast (or a Kp-based oval) gives a chance of
//    aurora: green (557.7 nm) low, red (630 nm) on top, folded curtains that drift.
// Brightness in cd/m^2 like the rest of the app, multiplied by uExposure.
import * as THREE from '../vendor/three.module.min.js';

const FSQ = new THREE.BufferGeometry();
FSQ.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));

export function makeEarth() {
  const L = new THREE.TextureLoader();
  const tex = (f, srgb) => { const t = L.load(f); t.colorSpace = THREE.NoColorSpace; t.wrapS = THREE.RepeatWrapping; t.anisotropy = 8; t.minFilter = THREE.LinearMipmapLinearFilter; return t; };
  const aur = new THREE.DataTexture(new Uint8Array(360 * 181), 360, 181, THREE.RedFormat); aur.wrapS = THREE.RepeatWrapping; aur.magFilter = aur.minFilter = THREE.LinearFilter; aur.needsUpdate = true;
  const U = {
    uDay: { value: tex('data/earth-day.jpg') }, uNight: { value: tex('data/earth-lights.jpg') }, uAux: { value: tex('data/earth-aux.jpg') },
    uAur: { value: aur }, uAurOn: { value: 1 }, uKp: { value: 3 }, uMagAxis: { value: new THREE.Vector3(0, 0, 1) },
    uCam: { value: new THREE.Vector3() }, uInvPV: { value: new THREE.Matrix4() }, uSun: { value: new THREE.Vector3(1, 0, 0) }, uMoon: { value: new THREE.Vector3(0, 1, 0) },
    uSunE: { value: 1.27e5 }, uMoonE: { value: 0.1 }, uMoonTint: { value: new THREE.Vector3(1, 1, 1) }, uMoonP: { value: new THREE.Vector3(0, 384000, 0) }, uSunDist: { value: 1.496e8 }, uEclOn: { value: 0 }, uG: { value: 0 }, uExposure: { value: 1e-4 }, uTime: { value: 0 }, uSteps: { value: 14 },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms: U, depthTest: false, depthWrite: false, transparent: true,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    vertexShader: `out vec3 vRay; uniform mat4 uInvPV; uniform vec3 uCam;
      void main(){ vec4 w = uInvPV * vec4(position.xy, 0.5, 1.0); vRay = w.xyz/w.w; /* uInvPV is rotation-only: camera at the origin */ gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: /* glsl */`
      precision highp float;
      #define PI 3.14159265
      in vec3 vRay;
      uniform sampler2D uDay, uNight, uAux, uAur; uniform float uAurOn, uKp; uniform vec3 uMagAxis;
      uniform vec3 uCam, uSun, uMoon, uMoonTint, uMoonP; uniform float uSunE, uMoonE, uG, uExposure, uTime, uSteps, uSunDist, uEclOn;
      vec3 mE;   // moonlight (lux), dimmed and faintly reddened during a lunar eclipse
      const float R = 6371.0, RT = 6471.0, HR = 8.0, HM = 1.2;
      const vec3 bR = vec3(5.802e-3, 13.558e-3, 33.1e-3), bO = vec3(0.650e-3, 1.881e-3, 0.085e-3);
      const float bM = 3.0e-3, bMe = 3.6e-3;
      vec2 sph(vec3 o, vec3 d, float r){ float b = dot(o, d), c = dot(o, o) - r*r, h = b*b - c; if (h < 0.0) return vec2(1e9, -1e9); h = sqrt(h); return vec2(-b - h, -b + h); }
      float hash(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y)*p3.z); }
      float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0 - 2.0*f); return mix(mix(hash(i), hash(i + vec2(1,0)), f.x), mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), f.x), f.y); }
      // Chapman optical-depth function (Schuler): column in scale heights from radius-ratio X, height h (both / H)
      float chap(float X, float h, float mu){
        float c = sqrt(X + h);
        if (mu >= 0.0) return c/(c*mu + 1.0)*exp(-h);
        float x0 = sqrt(1.0 - mu*mu)*(X + h), c0 = sqrt(x0);
        return 2.0*c0*exp(X - x0) - c/(1.0 - c*mu)*exp(-h);
      }
      // sunlight transmittance at point p (km) toward unit l, zero in the Earth's shadow (soft edge ~ the Sun's disc)
      vec3 sunT(vec3 p, vec3 l){
        float r = length(p), mu = dot(p, l)/r, h = r - R;
        // the Sun sets behind the horizon as seen from this point: fade across its disc (+-0.27 deg, plus a little
        // for refraction) around the geometric horizon's depression, continuous everywhere (no hard terminator line)
        float mh = -sqrt(max(0.0, 1.0 - (R/r)*(R/r)));
        float vis = smoothstep(mh - 0.0075, mh + 0.0055, mu);
        if (vis <= 0.0) return vec3(0.0);
        float cr = chap(R/HR, max(h, 0.0)/HR, mu)*HR, cm = chap(R/HM, max(h, 0.0)/HM, mu)*HM;
        float co = cr*0.35*exp(-abs(h - 25.0)/30.0) + cr*0.1;
        return exp(-(bR*cr + vec3(bMe)*cm + bO*co))*vis;
      }
      // a solar eclipse: the fraction of the Sun's disc still visible from p past the Moon (umbra = 0, penumbra between)
      float solarVis(vec3 p){
        if (uEclOn < 0.5) return 1.0;
        vec3 m = uMoonP - p; float dm = length(m); vec3 mu = m/dm;
        if (dot(mu, uSun) <= 0.0) return 1.0;
        float rs = 696000.0/uSunDist, r2 = (1737.4/dm)/rs, dd = length(cross(mu, uSun))/rs;
        if (dd >= 1.0 + r2) return 1.0;
        if (dd <= abs(r2 - 1.0)) return 1.0 - min(1.0, r2*r2);
        float a1 = acos(clamp((dd*dd + 1.0 - r2*r2)/(2.0*dd), -1.0, 1.0)), a2 = acos(clamp((dd*dd + r2*r2 - 1.0)/(2.0*dd*r2), -1.0, 1.0));
        float k = sqrt(max(0.0, (-dd + 1.0 + r2)*(dd + 1.0 - r2)*(dd - 1.0 + r2)*(dd + 1.0 + r2)));
        return clamp(1.0 - (a1 + r2*r2*a2 - 0.5*k)/PI, 0.0, 1.0);
      }
      vec3 sunTS(vec3 p){ return sunT(p, uSun)*solarVis(p); }
      vec2 llUV(vec3 n){   // TEME surface normal -> texture uv (rotating Earth)
        float c = cos(uG), s = sin(uG);
        vec3 e = vec3(c*n.x + s*n.y, -s*n.x + c*n.y, n.z);
        return vec2(atan(e.y, e.x)/(2.0*PI) + 0.5, asin(clamp(e.z, -1.0, 1.0))/PI + 0.5);
      }
      vec3 ecef(vec3 n){ float c = cos(uG), s = sin(uG); return vec3(c*n.x + s*n.y, -s*n.x + c*n.y, n.z); }
      float pR(float c){ return 3.0/(16.0*PI)*(1.0 + c*c); }
      float pM(float c){ float g = 0.76; return 3.0/(8.0*PI)*((1.0 - g*g)*(1.0 + c*c))/((2.0 + g*g)*pow(1.0 + g*g - 2.0*g*c, 1.5)); }
      // chance of aurora (0..1) at a point above the Earth
      float aurP(vec3 p){ vec3 e = normalize(ecef(p)); float lo = atan(e.y, e.x)*57.29578, la = asin(e.z)*57.29578;
        return texture(uAur, vec2(fract((lo + 0.5)/360.0), (la + 90.5)/181.0)).r; }
      void main(){
        vec3 d = normalize(vRay), o = uCam;
        mE = uMoonE*uMoonTint;
        vec2 ta = sph(o, d, RT), tg = sph(o, d, R);
        bool ground = tg.x > 0.0 && tg.x < 1e8;
        if (ta.y <= 0.0 || ta.x > 1e8) { gl_FragColor = vec4(0.0); return; }
        float t0 = max(ta.x, 0.0), t1 = ground ? tg.x : ta.y;
        float cs = dot(d, uSun), cmn = dot(d, uMoon);
        // ---- view-ray scattering ----
        vec3 Ls = vec3(0.0), T = vec3(1.0);
        int N = int(uSteps);
        float seg = t1 - t0;
        // where the air is densest along this ray: the tangent point for rays skimming the limb, the far end for rays
        // that reach the ground; samples crowd there (quadratically), so the glow fades smoothly with no stepped edge
        float tm = clamp(-dot(o, d), t0, t1); if (ground) tm = t1;
        float hA = tm - t0, hB = t1 - tm;
        for (int i = 0; i < 24; i++) {
          if (i >= N) break;
          float v0 = float(i)/float(N), v1 = float(i + 1)/float(N), a, b;
          if (ground) { a = t1 - seg*(1.0 - v0)*(1.0 - v0); b = t1 - seg*(1.0 - v1)*(1.0 - v1); }
          else { float u0 = v0*2.0 - 1.0, u1 = v1*2.0 - 1.0; a = u0 < 0.0 ? tm - hA*u0*u0 : tm + hB*u0*u0; b = u1 < 0.0 ? tm - hA*u1*u1 : tm + hB*u1*u1; }
          float dt = b - a;
          vec3 p = o + d*(0.5*(a + b)); float h = length(p) - R;
          float dr = exp(-h/HR), dm = exp(-h/HM), dz = max(0.0, 1.0 - abs(h - 25.0)/15.0);
          vec3 ext = bR*dr + vec3(bMe)*dm + bO*dz;
          vec3 Tp = sunTS(p), Tq = sunT(p, uMoon);
          vec3 S = (bR*dr*pR(cs) + vec3(bM*dm)*pM(cs))*Tp*uSunE + (bR*dr*pR(cmn) + vec3(bM*dm)*pM(cmn))*Tq*mE;
          S += (bR*dr + vec3(bM*dm))*(Tp*uSunE + Tq*mE)*0.06/(4.0*PI);
          vec3 st = exp(-ext*dt);
          Ls += T*S*(1.0 - st)/max(ext, vec3(1e-7));
          T *= st;
        }
        // ---- aurora (emission, night side) ----
        vec3 aur = vec3(0.0);
        if (uAurOn > 0.5) {
          vec2 ah = sph(o, d, R + 320.0), al = sph(o, d, R + 95.0);
          float a0 = max(ah.x, 0.0), a1 = ah.y; if (ground) a1 = min(a1, al.x > 0.0 ? al.x : a1);
          if (a1 > a0 && ah.x < 1e8) {
            float dt = (a1 - a0)/12.0;
            for (int i = 0; i < 12; i++) {
              vec3 p = o + d*(a0 + (float(i) + hash(gl_FragCoord.xy + float(i)))*dt); float h = length(p) - R;
              if (h < 95.0) continue;
              vec3 n = normalize(p); float night = smoothstep(0.05, -0.15, dot(n, uSun));
              if (night <= 0.0) continue;
              float pr = aurP(p); if (pr < 0.04) continue;
              vec3 m = normalize(cross(uMagAxis, vec3(0.0, 0.0, 1.0)) + 1e-4), q = cross(uMagAxis, m);
              vec3 e = ecef(n); float mlon = atan(dot(e, q), dot(e, m)), mlat = asin(clamp(dot(e, uMagAxis), -1.0, 1.0));
              float act = clamp((uKp - 2.0)/5.0, 0.15, 1.4);
              float fold = vn(vec2(mlon*6.0 + uTime*0.0004*(1.0 + 3.0*act), 1.7))*0.8 + vn(vec2(mlon*23.0 - uTime*0.0011, 4.1))*0.2;
              // curtains: a few folded, broken arcs inside the oval (irregular spacing), plus diffuse glow between them
              float q1 = vn(vec2(mlat*55.0 + (fold - 0.5)*14.0, mlon*2.5 + 3.0));
              float q2 = vn(vec2(mlat*120.0 + fold*9.0, mlon*7.0 - uTime*0.0003));
              float arcs = smoothstep(0.58, 0.9, q1)*(0.6 + 0.8*q2);
              float seg = smoothstep(0.25, 0.6, vn(vec2(mlon*9.0 + fold*3.0, mlat*20.0)));
              float curtain = 0.18 + 2.4*arcs*seg;
              float rays = 0.6 + 0.8*smoothstep(0.35, 0.8, vn(vec2(mlon*340.0 - uTime*0.01, h*0.01)));
              float green = smoothstep(95.0, 108.0, h)*exp(-max(h - 110.0, 0.0)/45.0), red = exp(-pow((h - 240.0)/60.0, 2.0))*(0.08 + 0.3*smoothstep(4.0, 7.0, uKp));
              float kR = 0.6*pow(pr*10.0, 1.9)*(1.0 + max(uKp - 5.0, 0.0)*0.6);
              aur += (vec3(0.15, 1.0, 0.35)*green + vec3(1.0, 0.18, 0.3)*red)*kR*curtain*rays*night*dt/40.0;
            }
            aur *= 1.9e-4;
          }
        }
        // a bright display tops out near ~100 kR; long grazing paths can't exceed that look (soft ceiling)
        { float al = dot(aur, vec3(0.2126, 0.7152, 0.0722)); aur *= 1.0/(1.0 + al/0.02); }
        // ---- airglow: O(1S) 557.7 nm green layer ~95 km (~250 R overhead) and O(1D) 630 nm red ~250 km (~60 R),
        // seen as a thin band along the night limb; weak gravity-wave banding. Volume emission integrated along the ray.
        vec3 ag = vec3(0.0);
        {
          float jit = hash(gl_FragCoord.xy + 7.0);
          // green: only where the ray is inside the 80-112 km shell (one or two segments)
          vec2 so = sph(o, d, R + 112.0), si = sph(o, d, R + 80.0);
          if (so.x < 1e8 && so.y > 0.0) {
            float tEnd = ground ? tg.x : so.y;
            for (int sgm = 0; sgm < 2; sgm++) {
              float s0 = sgm == 0 ? max(so.x, 0.0) : (si.x < 1e8 ? si.y : 1e9);
              float s1 = sgm == 0 ? (si.x < 1e8 && si.x > 0.0 ? si.x : tEnd) : tEnd;
              if (s1 <= s0) continue;
              float dt = (s1 - s0)/24.0;
              for (int i = 0; i < 24; i++) {
                vec3 p = o + d*(s0 + (float(i) + jit)*dt); float h = length(p) - R;
                vec3 e = ecef(normalize(p));
                float wav = 0.85 + 0.3*vn(vec2(atan(e.y, e.x)*180.0 + uTime*0.0004, asin(e.z)*90.0));
                ag += vec3(0.45, 1.0, 0.35)*exp(-pow((h - 95.0)/4.5, 2.0))*(0.25/8.0)*wav*dt;   // ~250 R overhead
              }
            }
          }
          // red 630 nm: a broad layer, plain steps are fine
          vec2 sr = sph(o, d, R + 330.0);
          if (sr.x < 1e8 && sr.y > 0.0) {
            float r0 = max(sr.x, 0.0), r1 = ground ? tg.x : sr.y, dt = (r1 - r0)/16.0;
            for (int i = 0; i < 16; i++) { float h = length(o + d*(r0 + (float(i) + jit)*dt)) - R; ag += vec3(1.0, 0.22, 0.18)*exp(-pow((h - 250.0)/45.0, 2.0))*(0.06/80.0)*dt; }
          }
          ag *= 1.9e-4 * (ground ? 0.08 : 1.0);   // kR -> cd/m^2; seen against the night Earth it hardly shows, only above the limb
        }
        vec3 col = Ls + aur + ag;
        float alpha = 1.0 - dot(T, vec3(0.3333));
        if (ground) {
          vec3 p = o + d*tg.x, n = normalize(p);
          vec2 uv = llUV(n);
          // gradients across the longitude wrap (no seam)
          vec2 gx = dFdx(uv), gy = dFdy(uv); gx.x -= floor(gx.x + 0.5); gy.x -= floor(gy.x + 0.5);
          vec3 alb = pow(textureGrad(uDay, uv, gx, gy).rgb, vec3(2.2));
          vec3 aux = textureGrad(uAux, uv, gx, gy).rgb;
          float water = smoothstep(0.35, 0.75, aux.g);
          float mus = dot(n, uSun), mum = dot(n, uMoon), muv = max(dot(n, -d), 0.02);
          vec3 Tsun = sunTS(p + n*0.05), Tmoon = sunT(p + n*0.05, uMoon);
          // clouds: a thin layer ~8 km up; their shadows fall where the sunward ray crosses the layer
          vec3 pc = o + d*max(sph(o, d, R + 8.0).x, 0.0); vec2 uvc = llUV(normalize(pc));
          float cl = smoothstep(0.18, 0.75, textureGrad(uAux, uvc, gx, gy).r);
          vec3 ps = p + uSun*(8.0/max(mus, 0.08)); float sh = smoothstep(0.18, 0.75, texture(uAux, llUV(normalize(ps))).r);
          vec3 Edir = uSunE*Tsun*max(mus, 0.0) + mE*Tmoon*max(mum, 0.0);
          float sv = solarVis(p + n*0.05);   // skylight follows the eclipse too
          vec3 sky = (uSunE*smoothstep(-0.2, 0.3, mus)*vec3(0.12, 0.16, 0.25)*min(sv, 1.0) + mE*smoothstep(-0.2, 0.3, mum)*vec3(0.12, 0.16, 0.25))*0.25;   // skylight
          vec3 surf = alb/PI*(Edir*(1.0 - 0.65*sh) + sky);
          // ocean: darker, with the Sun's glint spread by wave slopes (Cox-Munk, ~6 m/s wind)
          if (water > 0.01) {
            vec3 hv = normalize(uSun - d); float nh = max(dot(n, hv), 1e-3), tan2 = (1.0 - nh*nh)/(nh*nh);
            float s2 = 0.032, P = exp(-tan2/s2)/(PI*s2*nh*nh*nh*nh);
            float F = 0.02 + 0.98*pow(1.0 - max(dot(hv, -d), 0.0), 5.0);
            vec3 glint = uSunE*Tsun*F*min(P/(4.0*max(muv, 0.08)), 60.0)*smoothstep(-0.01, 0.06, mus);
            vec3 hm = normalize(uMoon - d); float nm2 = max(dot(n, hm), 1e-3), tm2 = (1.0 - nm2*nm2)/(nm2*nm2);
            glint += mE*Tmoon*F*min(exp(-tm2/s2)/(PI*s2*pow(nm2, 4.0))/(4.0*max(muv, 0.08)), 60.0)*smoothstep(-0.01, 0.06, mum);
            surf = mix(surf, surf*0.8 + glint*(1.0 - sh*0.8), water);
          }
          // city lights (extracted from NASA Black Marble): ~4 cd/m^2 for a bright city core, dimmed and blurred by clouds
          float lt = pow(textureGrad(uNight, uv, gx, gy).r, 2.0);
          // finer than the 10 km texture: street-grid speckle, fading out when the texels are small on screen
          float fine = smoothstep(0.0, 1.0, 1.0 - 2000.0*length(gx));
          lt *= mix(1.0, 0.25 + 1.5*vn(uv*vec2(36000.0, 18000.0))*vn(uv*vec2(9000.0, 4500.0) + 3.1), fine);
          vec3 lights = vec3(lt)*vec3(1.0, 0.76, 0.45)*4.0*smoothstep(0.08, -0.12, mus);
          vec3 cloudCol = vec3(0.78)/PI*(Edir + sky*1.5) + lights*0.12;
          surf = mix(surf + lights, cloudCol, cl);
          col = Ls + aur + ag + T*surf;
          alpha = 1.0;
        }
        gl_FragColor = vec4(min(col*uExposure, vec3(3.0e4)), alpha);
      }`,
  });
  const mesh = new THREE.Mesh(FSQ, mat); mesh.frustumCulled = false;
  const scene = new THREE.Scene(); scene.add(mesh);
  return { U, scene, mesh, setAurora(grid) { const t = U.uAur.value; t.image.data.set(grid); t.needsUpdate = true; } };
}

// Chance-of-aurora grid (360 x 181, 0..255 = 0..100 %): NOAA SWPC OVATION nowcast, or an oval built from Kp.
export async function auroraGrid() {
  try {
    const r = await fetch('https://services.swpc.noaa.gov/json/ovation_aurora_latest.json');
    const j = await r.json(), g = new Uint8Array(360 * 181);
    for (const [lon, lat, p] of j.coordinates) { const x = ((Math.round(lon) % 360) + 360) % 360, y = Math.round(lat) + 90; if (y >= 0 && y <= 180) g[y * 360 + x] = Math.min(255, p * 2.55); }
    return { grid: g, src: 'NOAA OVATION ' + (j['Forecast Time'] || j['Observation Time'] || '') };
  } catch { return null; }
}
export async function kpNow() {
  try { const r = await fetch('https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json'); const j = await r.json(); const last = j[j.length - 1]; return +(Array.isArray(last) ? last[1] : last.Kp ?? last.kp); } catch { return null; }
}
// fallback oval when NOAA is unreachable: ring around the geomagnetic pole whose latitude depends on Kp
export function synthAurora(kp, magAxisEcef) {
  const g = new Uint8Array(360 * 181), lat0 = 67 - 2.2 * kp, w = 3 + 0.8 * kp;
  for (let y = 0; y <= 180; y++) for (let x = 0; x < 360; x++) {
    const la = (y - 90) * Math.PI / 180, lo = x * Math.PI / 180, e = [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
    const ml = Math.abs(Math.asin(e[0] * magAxisEcef[0] + e[1] * magAxisEcef[1] + e[2] * magAxisEcef[2])) * 180 / Math.PI;
    g[y * 360 + x] = Math.round(255 * Math.min(1, 0.12 * (1 + kp / 3)) * Math.exp(-Math.pow((ml - lat0) / w, 2)));
  }
  return g;
}
// IGRF-2025 dipole axis (geomagnetic north pole ~80.8 N, 72.7 W), Earth-fixed
export const MAG_AXIS = (() => { const la = 80.8 * Math.PI / 180, lo = -72.7 * Math.PI / 180; return [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)]; })();

// Camera-like metering of the Earth in view: renders the globe small at unit exposure and returns the adapting
// luminance (log-average of what is lit, kept from clipping the brightest clouds, weighted by how much it fills).
const _mt = {};
export function meterEarth(renderer, earth, cam) {
  if (!_mt.rt) { _mt.rt = new THREE.WebGLRenderTarget(48, 32, { type: THREE.HalfFloatType }); _mt.buf = new Uint16Array(48 * 32 * 4); }
  const U = earth.U, ex = U.uExposure.value, st = U.uSteps.value, o = renderer.getRenderTarget();
  U.uExposure.value = 1; U.uSteps.value = 8;
  renderer.setRenderTarget(_mt.rt); renderer.setClearColor(0, 1); renderer.clear(); renderer.render(earth.scene, cam);
  U.uExposure.value = ex; U.uSteps.value = st;
  try { renderer.readRenderTargetPixels(_mt.rt, 0, 0, 48, 32, _mt.buf); } catch { renderer.setRenderTarget(o); return null; }
  renderer.setRenderTarget(o);
  const h2f = THREE.DataUtils.fromHalfFloat, lit = []; let s = 0;
  for (let k = 0; k < 48 * 32; k++) { const b = _mt.buf, L = 0.2126 * h2f(b[k * 4]) + 0.7152 * h2f(b[k * 4 + 1]) + 0.0722 * h2f(b[k * 4 + 2]); if (L > 2e-4) { lit.push(L); s += Math.log(L); } }
  if (!lit.length) return { La: 1e-3, cover: 0 };
  lit.sort((a, b) => a - b);
  const cover = lit.length / (48 * 32), p95 = lit[Math.floor(lit.length * 0.95)];
  return { La: Math.max(Math.exp(s / lit.length), p95 * 0.4) * (0.35 + 0.65 * Math.sqrt(cover)), cover };
}
