// How one object looks from one observer at one instant: direction, range, sunlight, phase and magnitude.
// Shared by the live views and the prediction worker so predictions and what you see always agree.
import { gmst, sunTEME, temeToWorldMatrix, mulM3, ecefToTeme, DEG, norm, cross } from './frames.js';
import { sunlight, facetsIntensity, magFromI, magSphere, bodyFrame, stdMagFromArea, hash, earthshine, facetsEarthshine, spherePhase, SUN_MAG } from './light.js';

// Observer context for a time: TEME position, TEME->world matrix, Sun.
export function obsAt(obs, ms, ctx = {}) {
  const g = gmst(ms);
  ctx.ms = ms; ctx.g = g;
  ctx.M = temeToWorldMatrix(obs, g);
  ctx.o = ecefToTeme(obs.pos, g);
  ctx.s = sunTEME(ms); ctx.sd = ctx.s.dist;
  const sw = mulM3(ctx.M, ctx.s); ctx.sunAlt = Math.asin(Math.max(-1, Math.min(1, sw[1]))) / DEG;
  return ctx;
}
// standard magnitude used when an object has no facet model
export function stdMag(o) {
  if (o.mag != null) return o.mag;
  if (o.s1) return stdMagFromArea(o.s1 * (o.s2 || o.s1 * 0.6));
  if (o.rcs != null) return stdMagFromArea(Math.max(o.rcs, 0.0005) * 1.3);
  return o.type === 2 ? 11 : o.type === 1 ? 5.5 : 7;
}
const _w = [0, 0, 0], _L = [1, 1, 1];
// r, v TEME (km, km/s). shape optional (facet model). Returns res {x,y,z (world unit), alt, az, range, L (RGB sunlight), lit, phase, mag}
export function look(ctx, r, v, o, shape, res = {}) {
  const dx = r[0] - ctx.o[0], dy = r[1] - ctx.o[1], dz = r[2] - ctx.o[2], rg = Math.hypot(dx, dy, dz);
  const d = [dx / rg, dy / rg, dz / rg];
  mulM3(ctx.M, d, _w);
  res.x = _w[0]; res.y = _w[1]; res.z = _w[2]; res.range = rg;
  res.alt = Math.asin(Math.max(-1, Math.min(1, _w[1]))) / DEG;
  let az = Math.atan2(_w[0], -_w[2]) / DEG; res.az = az < 0 ? az + 360 : az;
  const L = sunlight(r, ctx.s, ctx.sd, res.Lc || (res.Lc = [1, 1, 1]));
  res.lit = L.f; const Lv = 0.2126 * L[0] + 0.7152 * L[1] + 0.0722 * L[2]; res.Lv = Lv;
  const ob = [-d[0], -d[1], -d[2]];   // satellite -> observer
  const cphi = ob[0] * ctx.s[0] + ob[1] * ctx.s[1] + ob[2] * ctx.s[2];
  res.phase = Math.acos(Math.max(-1, Math.min(1, cphi)));
  const es = earthshine(r, ctx.s); res.es = es;
  if (Lv <= 1e-6 && es < 1e-5) { res.mag = 99; return res; }
  const rm = Math.hypot(r[0], r[1], r[2]), down = [-r[0] / rm, -r[1] / rm, -r[2] / rm];
  if (shape && shape.facets && shape.facets.length) {
    const B = bodyFrame(shape.att, r, v, ctx.s, ctx.ms, o.id, res.B);
    res.B = B;
    const sb = [B.x[0] * ctx.s[0] + B.x[1] * ctx.s[1] + B.x[2] * ctx.s[2], B.y[0] * ctx.s[0] + B.y[1] * ctx.s[1] + B.y[2] * ctx.s[2], B.z[0] * ctx.s[0] + B.z[1] * ctx.s[1] + B.z[2] * ctx.s[2]];
    let I = facetsIntensity(shape.facets, B, ctx.s, ob) * Lv + facetsEarthshine(shape.facets, B, down, ob, sb, es);
    // shapes that are only typical of their class keep their light curve but take the observed brightness level
    I *= shape.calK || 1;
    if (shape.known !== 'exact') I *= Math.pow(10, -0.4 * (stdMag(o) - modelStd(shape)));
    res.I = I; res.mag = magFromI(I, rg, 1);
  } else res.mag = sphereMag(stdMag(o), rg, res.phase, Lv, es, ob, down);
  return res;
}
// diffuse sphere lit by the Sun (phase phi) and by earthshine from below
export function sphereMag(std, rg, phi, Lv, es, ob, down) {
  const pe = Math.acos(Math.max(-1, Math.min(1, -(ob[0] * down[0] + ob[1] * down[1] + ob[2] * down[2]))));
  const F = spherePhase(phi) * Lv + spherePhase(pe) * es * 0.6;
  if (F <= 1e-7) return 99;
  return std + 5 * Math.log10(rg / 1000) - 2.5 * Math.log10(F);
}
// the facet model's own standard magnitude: averaged over random attitudes at 1000 km and 90 deg phase
export function modelStd(shape) {
  if (shape.std != null) return shape.std;
  let I = 0; const N = 300;
  for (let k = 0; k < N; k++) {
    const u = hash(k * 1.1) * 2 - 1, t = hash(k * 2.3) * 6.2832, q = Math.sqrt(1 - u * u);
    const s = [q * Math.cos(t), q * Math.sin(t), u];
    const p = norm(cross(s, [hash(k * 3.7) - 0.5, hash(k * 5.1) - 0.5, hash(k * 7.9) - 0.5]));
    I += facetsIntensity(shape.facets, { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }, s, p);
  }
  shape.std = magFromI(I / N, 1000, 1);
  return shape.std;
}
// atmospheric extinction (mag) at apparent altitude (deg) for a typical clear sky (k = 0.25 mag/airmass)
export function extinction(altDeg) {
  const h = Math.max(altDeg, -1) * DEG, X = 1 / (Math.sin(Math.max(h, 0)) + 0.025 * Math.exp(-11 * Math.sin(Math.max(h, 0))));
  return 0.25 * Math.min(X, 40);
}
