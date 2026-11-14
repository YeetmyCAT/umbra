// Eclipses from geometry alone: they happen wherever and whenever the real Sun, Moon and Earth line up (no lists).
//  * Solar: the fraction of the Sun's disc the Moon covers for an observer, and GLSL that cuts the Moon's (slightly
//    jagged, for Baily's beads) limb out of the solar disc, adds the corona and chromosphere, and darkens the Earth
//    in the Moon's umbra and penumbra seen from orbit.
//  * Lunar: where the Earth's umbra and penumbra fall on the Moon as seen by an observer, their brightness and the
//    red colour of sunlight bent through the Earth's atmosphere into the umbra.
const A = () => window.Astronomy;
const AU = 149597870.7, RS = 696000, RE = 6371, RM = 1737.4;
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = a => Math.hypot(a[0], a[1], a[2]), scl = (a, k) => [a[0] * k, a[1] * k, a[2] * k], nrm = a => scl(a, 1 / (len(a) || 1));

// precise geocentric Sun and Moon (km) in the true equator and equinox of date (= TEME to arcseconds)
let _c = { ms: NaN };
export function sunMoonTEME(ms) {
  if (Math.abs(ms - _c.ms) < 20) return _c;
  const t = A().MakeTime(new Date(ms)), rot = A().Rotation_EQJ_EQD(t);
  const tr = v => { const r = A().RotateVector(rot, v); return [r.x * AU, r.y * AU, r.z * AU]; };
  _c = { ms, sun: tr(A().GeoVector('Sun', t, true)), moon: tr(A().GeoMoon(t)) };
  return _c;
}

// Fraction of the solar disc's area hidden by the Moon (uniform disc; good to a few % against limb darkening).
// sunDir/moonDir unit vectors from the observer, distances in km.
export function sunCovered(sunDir, sunDist, moonDir, moonDist) {
  const rs = Math.asin(RS / sunDist), rm = Math.asin(RM / moonDist);
  const c = Math.min(1, Math.max(-1, dot(sunDir, moonDir))), d = len([sunDir[1] * moonDir[2] - sunDir[2] * moonDir[1], sunDir[2] * moonDir[0] - sunDir[0] * moonDir[2], sunDir[0] * moonDir[1] - sunDir[1] * moonDir[0]]);
  if (c < 0) return 0;
  return discOverlap(1, rm / rs, d / rs);
}
// area of disc 1 (radius r1) covered by disc 2 (radius r2) at centre distance d, as a fraction of disc 1
export function discOverlap(r1, r2, d) {
  if (d >= r1 + r2) return 0;
  if (d <= Math.abs(r2 - r1)) return Math.min(1, (r2 * r2) / (r1 * r1));
  const a1 = Math.acos(Math.max(-1, Math.min(1, (d * d + r1 * r1 - r2 * r2) / (2 * d * r1)))), a2 = Math.acos(Math.max(-1, Math.min(1, (d * d + r2 * r2 - r1 * r1) / (2 * d * r2))));
  const k = Math.sqrt(Math.max(0, (-d + r1 + r2) * (d + r1 - r2) * (d - r1 + r2) * (d + r1 + r2)));
  return (r1 * r1 * a1 + r2 * r2 * a2 - 0.5 * k) / (Math.PI * r1 * r1);
}

// Earth's shadow on the Moon seen from an observer at the origin. sun, moon, earthC: positions (km) relative to the
// observer, any common frame. Returns the shadow axis direction at the Moon's distance and the angular radii of the
// umbra and penumbra (the atmosphere widens the shadow ~2 %), plus the Moon's mean brightness factor and colour.
export function lunarShadow(sun, moon, earthC) {
  const ax = nrm(sub(earthC, sun)), D = dot(sub(moon, earthC), ax);
  if (D <= 0) return null;
  const C = [earthC[0] + ax[0] * D, earthC[1] + ax[1] * D, earthC[2] + ax[2] * D], dc = len(C), sd = len(sub(earthC, sun));
  const ru = RE * 1.02 - D * (RS - RE * 1.02) / sd, rp = RE * 1.02 + D * (RS + RE * 1.02) / sd;
  const dir = scl(C, 1 / dc), umb = Math.max(ru, 0) / dc, pen = rp / dc;
  // mean over the lunar disc of the shading below (19 sample points)
  const md = nrm(moon), rm = Math.asin(RM / len(moon));
  const e1 = nrm(Math.abs(md[2]) < 0.9 ? [md[1], -md[0], 0] : [0, md[2], -md[1]]), e2 =[md[1] * e1[2] - md[2] * e1[1], md[2] * e1[0] - md[0] * e1[2], md[0] * e1[1] - md[1] * e1[0]];
  let s = 0, red = 0, n = 0;
  for (const [x, y] of DISC19) {
    const p = nrm([md[0] + (e1[0] * x + e2[0] * y) * rm, md[1] + (e1[1] * x + e2[1] * y) * rm, md[2] + (e1[2] * x + e2[2] * y) * rm]);
    const a = Math.acos(Math.max(-1, Math.min(1, dot(p, dir)))), f = shadeAt(a, umb, pen);
    s += f.k; red += f.red * f.k; n++;
  }
  const mean = s / n;
  return { dir, umb, pen, mean, red: mean > 0 ? red / s : 0, depth: 1 - mean };
}
const DISC19 = [[0, 0], ...Array.from({ length: 6 }, (_, i) => [0.5 * Math.cos(i * Math.PI / 3), 0.5 * Math.sin(i * Math.PI / 3)]), ...Array.from({ length: 12 }, (_, i) => [0.9 * Math.cos(i * Math.PI / 6), 0.9 * Math.sin(i * Math.PI / 6)])];
// brightness factor at angular distance a from the shadow axis (same law as the GLSL below); red: 0..1 umbral colour
export function shadeAt(a, umb, pen) {
  if (a >= pen) return { k: 1, red: 0 };
  if (a > umb) { const x = (a - umb) / (pen - umb); return { k: 0.0025 + 0.9975 * Math.pow(x, 1.15), red: Math.max(0, 1 - x * 6) * 0.5 }; }
  const u = a / Math.max(umb, 1e-9);
  return { k: 2.5e-4 + 1.8e-3 * Math.pow(u, 4), red: 1 };
}

// Eclipse uniforms of the Earth seen from orbit (earth.js): the Moon's position for its shadow, and moonlight dimmed
// and very faintly reddened while the Moon is in the Earth's shadow. smp from sunMoonTEME; moonE: normal moonlight (lux).
export function setEarthEclipse(E, smp, moonE) {
  const S = smp.sun, M = smp.moon, sd = len(S), md = len(M);
  E.uMoonP.value.set(M[0], M[1], M[2]); E.uSunDist.value = sd; E.uMoon.value.set(M[0] / md, M[1] / md, M[2] / md);
  E.uEclOn.value = dot(S, M) / (sd * md) > Math.cos(1.7 * Math.PI / 180) ? 1 : 0;
  const ls = lunarShadow(S, M, [0, 0, 0]), f = ls ? ls.mean : 1, deep = ls ? ls.depth : 0;
  E.uMoonE.value = moonE * f; E.uMoonTint.value.set(1, 1 - 0.07 * deep, 1 - 0.12 * deep);
  return ls;
}
// GLSL for the Moon shader: shading of a point on the lunar disc by the Earth's shadow (uLunAx = axis direction,
// uLunR = (umbra, penumbra) angular radii; uLunR.y = 0 when there is no eclipse)
export const LUNAR_GLSL = /* glsl */`
uniform vec3 uLunAx; uniform vec2 uLunR;
vec3 lunarShade(vec3 p){
  if (uLunR.y <= 0.0) return vec3(1.0);
  float a = atan(length(cross(p, uLunAx)), dot(p, uLunAx));
  if (a >= uLunR.y) return vec3(1.0);
  // light bent through the Earth's atmosphere: deep red in the umbra, a faint blue-turquoise fringe at its edge where
  // the light crossed the ozone layer high up
  vec3 umbraCol = vec3(2.2, 0.62, 0.22);
  if (a > uLunR.x) {
    float x = (a - uLunR.x)/(uLunR.y - uLunR.x), k = 0.0025 + 0.9975*pow(x, 1.15);
    vec3 tint = mix(vec3(1.0), umbraCol, clamp(1.0 - x*6.0, 0.0, 1.0)*0.5);
    tint = mix(tint, vec3(0.75, 1.0, 1.25), exp(-pow((x - 0.02)/0.02, 2.0))*0.35);
    return tint*k;
  }
  float u = a/max(uLunR.x, 1e-9);
  return umbraCol*(2.5e-4 + 1.8e-3*pow(u, 4.0));
}`;

// GLSL for a background pass showing the Sun: occultation by the Moon (with a lunar limb profile of valleys a couple
// of arcseconds deep, so the last light breaks into Baily's beads), the inner corona and the chromosphere.
// Needs uMoonDir, uMoonRadius (apparent) and uMoonOcc (1 = test against the Moon).
export const SOLAR_GLSL = /* glsl */`
uniform float uMoonOcc; uniform vec4 uOcc1, uOcc2;   // Mercury / Venus silhouettes in front of the Sun (dir, radius)
float ecH(float x){ return fract(sin(x*127.1)*43758.5453); }
float ecN(float x){ float i = floor(x), f = fract(x); f = f*f*(3.0 - 2.0*f); return mix(ecH(i), ecH(i + 1.0), f); }
// 1 where this view direction is NOT blocked by the Moon (or a planet in transit), 0 where it is
float notMoon(vec3 d, vec3 mH, vec3 mV){
  float vis = 1.0;
  if (uMoonOcc > 0.5) {
    vec3 m = normalize(uMoonDir);
    vec2 q = vec2(dot(d, mH), dot(d, mV)); float c = dot(d, m);
    if (c > 0.0) {
      float r = atan(length(q), c), th = atan(q.y, q.x);
      // limb profile: mountains and valleys up to ~2.5 arcsec (the real profile varies the same way)
      float v = pow(ecN(th*57.0), 3.0)*0.55 + pow(ecN(th*181.0 + 7.0), 5.0)*0.6 + pow(ecN(th*523.0 + 3.0), 6.0)*0.3;
      float Rl = uMoonRadius*(1.0 - 0.0036*v);
      vis = smoothstep(Rl*0.99992, Rl*1.00008, r);
    }
  }
  for (int i = 0; i < 2; i++) {
    vec4 o = i == 0 ? uOcc1 : uOcc2;
    if (o.w > 0.0) { float r = atan(length(cross(d, o.xyz)), dot(d, o.xyz)); vis *= smoothstep(o.w*0.97, o.w*1.03, r); }
  }
  return vis;
}
// corona and chromosphere around the Sun (r in solar radii, th position angle); relative to the disc-centre radiance
float corona(float r, float th){
  if (r < 1.0) return 0.0;
  // Baumbach's K+F corona, with streamers (brighter toward the solar equator, rays from the poles)
  float base = 1.0e-6*(0.0532/pow(r, 2.5) + 1.425/pow(r, 7.0) + 2.565/pow(r, 17.0));
  float eq = 0.55 + 0.45*pow(abs(cos(th)), 2.0);
  float st = 0.6 + 0.9*pow(ecN(th*9.5 + 2.0), 2.0) + 0.5*pow(ecN(th*31.0 + 5.0), 3.0)*smoothstep(1.0, 1.6, r);
  float rays = 0.85 + 0.3*ecN(th*140.0);
  return base*eq*st*rays;
}
vec3 chromo(float r, float th){
  if (r < 1.0) return vec3(0.0);
  float x = r - 1.0;
  float c = 1.5e-5*exp(-x/0.0025);
  // prominences: a few pink loops reaching ~3 % of a radius
  float pr = pow(ecN(th*40.0 + 11.0), 8.0)*6.0e-5*exp(-x/0.012);
  return vec3(1.0, 0.25, 0.38)*(c + pr);
}`;
