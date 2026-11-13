// Reference frames and small orbit maths shared by the page and the prediction worker (no dependencies).
// TEME (SGP4's frame) ~ true equator, mean equinox of date. ECEF = TEME rotated by GMST about z (polar motion
// ignored, < 15 m). World/topocentric frame used by the renderers: x east, y up, z south.
export const RE = 6378.137, F_WGS = 1 / 298.257223563, E2 = F_WGS * (2 - F_WGS), MU = 398600.4418, AU = 149597870.7;
export const DEG = Math.PI / 180;

export function jdOf(ms) { return ms / 864e5 + 2440587.5; }
export function gmst(ms) {
  const jd = jdOf(ms), T = (jd - 2451545.0) / 36525;
  let g = 67310.54841 + (876600 * 3600 + 8640184.812866) * T + 0.093104 * T * T - 6.2e-6 * T * T * T;
  g = ((g % 86400) / 240) * DEG; return ((g % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
}
// Sun: geocentric unit vector (TEME ~ of-date equatorial) and distance (km). Low-precision (~0.01 deg) series,
// plenty for shadows and glints whose own spread is ~1 deg.
export function sunTEME(ms, out = [0, 0, 0]) {
  const n = jdOf(ms) - 2451545.0;
  const L = (280.460 + 0.9856474 * n) * DEG, g = (357.528 + 0.9856003 * n) * DEG;
  const lam = L + (1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * DEG;
  const eps = (23.439 - 0.0000004 * n) * DEG;
  const R = (1.00014 - 0.01671 * Math.cos(g) - 0.00014 * Math.cos(2 * g)) * AU;
  out[0] = Math.cos(lam); out[1] = Math.cos(eps) * Math.sin(lam); out[2] = Math.sin(eps) * Math.sin(lam);
  out.dist = R; return out;
}
// Moon: low-precision geocentric position (km), of-date equatorial (~0.3 deg), for lighting in the space view
export function moonTEME(ms) {
  const T = (jdOf(ms) - 2451545.0) / 36525;
  const Lp = (218.316 + 481267.881 * T) * DEG, M = (134.963 + 477198.867 * T) * DEG, F = (93.272 + 483202.018 * T) * DEG;
  const D = (297.850 + 445267.115 * T) * DEG, Ms = (357.529 + 35999.050 * T) * DEG;
  const lon = Lp + (6.289 * Math.sin(M) + 1.274 * Math.sin(2 * D - M) + 0.658 * Math.sin(2 * D) + 0.214 * Math.sin(2 * M) - 0.186 * Math.sin(Ms)) * DEG;
  const lat = (5.128 * Math.sin(F)) * DEG, dist = 385001 - 20905 * Math.cos(M);
  const eps = 23.439 * DEG, x = Math.cos(lat) * Math.cos(lon), y = Math.cos(lat) * Math.sin(lon), z = Math.sin(lat);
  return [dist * x, dist * (Math.cos(eps) * y - Math.sin(eps) * z), dist * (Math.sin(eps) * y + Math.cos(eps) * z)];
}
export function geodeticToECEF(latDeg, lonDeg, hKm) {
  const la = latDeg * DEG, lo = lonDeg * DEG, s = Math.sin(la), N = RE / Math.sqrt(1 - E2 * s * s);
  return [(N + hKm) * Math.cos(la) * Math.cos(lo), (N + hKm) * Math.cos(la) * Math.sin(lo), (N * (1 - E2) + hKm) * s];
}
export function ecefToGeodetic(x, y, z) {
  const lon = Math.atan2(y, x), p = Math.hypot(x, y);
  let lat = Math.atan2(z, p * (1 - E2)), h = 0;
  for (let i = 0; i < 4; i++) { const s = Math.sin(lat), N = RE / Math.sqrt(1 - E2 * s * s); h = p / Math.cos(lat) - N; lat = Math.atan2(z, p * (1 - E2 * N / (N + h))); }
  return { lat: lat / DEG, lon: lon / DEG, h };
}
// Observer: ECEF position and the ECEF -> world (east, up, south) rotation rows
export function makeObserver(lat, lon, hKm) {
  const la = lat * DEG, lo = lon * DEG, sl = Math.sin(la), cl = Math.cos(la), so = Math.sin(lo), co = Math.cos(lo);
  const E = [-so, co, 0], N = [-sl * co, -sl * so, cl], U = [cl * co, cl * so, sl];
  return { lat, lon, h: hKm, pos: geodeticToECEF(lat, lon, hKm), E, N, U };
}
// TEME vector -> ECEF at sidereal angle g
export function temeToEcef(v, g, out = [0, 0, 0]) {
  const c = Math.cos(g), s = Math.sin(g), x = v[0], y = v[1];
  out[0] = c * x + s * y; out[1] = -s * x + c * y; out[2] = v[2]; return out;
}
export function ecefToTeme(v, g, out = [0, 0, 0]) {
  const c = Math.cos(g), s = Math.sin(g), x = v[0], y = v[1];
  out[0] = c * x - s * y; out[1] = s * x + c * y; out[2] = v[2]; return out;
}
// 3x3 TEME -> world rotation (row-major) for this observer and sidereal angle, plus observer TEME position
export function temeToWorldMatrix(obs, g) {
  const c = Math.cos(g), s = Math.sin(g);
  // ECEF = Rz(-g) TEME: rows of Rz(-g): [c, s, 0], [-s, c, 0], [0, 0, 1]; world rows = (E, U, -N) . ECEF
  const row = a => [a[0] * c - a[1] * s, a[0] * s + a[1] * c, a[2]];
  const e = row(obs.E), u = row(obs.U), n = row(obs.N);
  return [e[0], e[1], e[2], u[0], u[1], u[2], -n[0], -n[1], -n[2]];
}
export function mulM3(m, v, out = [0, 0, 0]) {
  const x = v[0], y = v[1], z = v[2];
  out[0] = m[0] * x + m[1] * y + m[2] * z; out[1] = m[3] * x + m[4] * y + m[5] * z; out[2] = m[6] * x + m[7] * y + m[8] * z; return out;
}
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const len = a => Math.hypot(a[0], a[1], a[2]);
export const norm = a => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

// Two-body propagation from an SGP4 state (r, v) by dt seconds: used to move every object smoothly between the
// worker's exact SGP4 updates. Stores elements once per anchor (Kepler's equation per frame).
export function keplerSetup(r, v) {
  const rx = r[0], ry = r[1], rz = r[2], vx = v[0], vy = v[1], vz = v[2];
  const rm = Math.hypot(rx, ry, rz), v2 = vx * vx + vy * vy + vz * vz, rv = rx * vx + ry * vy + rz * vz;
  const a = 1 / (2 / rm - v2 / MU);
  if (!(a > 0)) return null;
  const n = Math.sqrt(MU / (a * a * a));
  const ec = rv / Math.sqrt(MU * a), es = 1 - rm / a;   // e sinE0 / e cosE0
  const e = Math.hypot(ec, es), E0 = Math.atan2(ec, es);
  // perifocal basis from r, v at E0
  const cE = Math.cos(E0), sE = Math.sin(E0), b = a * Math.sqrt(Math.max(0, 1 - e * e));
  // r = a(cosE - e) P + b sinE Q ; v = n a / (1 - e cosE) * (-sinE * a P + cosE * b Q)/a
  const k = 1 - e * cE;
  // solve P, Q from r and v
  const f1 = a * (cE - e), g1 = b * sE, f2 = -n * a * sE / k, g2 = n * b * cE / k;
  const det = f1 * g2 - g1 * f2;
  const P = [(rx * g2 - vx * g1) / det, (ry * g2 - vy * g1) / det, (rz * g2 - vz * g1) / det];
  const Q = [(vx * f1 - rx * f2) / det, (vy * f1 - ry * f2) / det, (vz * f1 - rz * f2) / det];
  return { a, b, e, n, M0: E0 - e * sE, P, Q, E: E0 };
}
export function keplerAt(k, dt, out, o = 0) {
  const M = k.M0 + k.n * dt; let E = k.E + k.n * dt;   // warm start
  for (let i = 0; i < 6; i++) { const d = (E - k.e * Math.sin(E) - M) / (1 - k.e * Math.cos(E)); E -= d; if (Math.abs(d) < 1e-10) break; }
  const x = k.a * (Math.cos(E) - k.e), y = k.b * Math.sin(E);
  out[o] = k.P[0] * x + k.Q[0] * y; out[o + 1] = k.P[1] * x + k.Q[1] * y; out[o + 2] = k.P[2] * x + k.Q[2] * y;
  return out;
}
