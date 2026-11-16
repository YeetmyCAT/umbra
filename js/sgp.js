// SGP4/SDP4 from OMM (CCSDS Orbit Mean-elements Message) records, never from TLE text.
// TLEs have two "Y2K" limits: a 5-digit catalogue number (CelesTrak's catalogue is past 100,000 and those objects
// have no TLE at all) and a 2-digit epoch year. The OMM values are kept with their full catalogue number; the
// satellite.js initialiser only accepts TLE-shaped text, so the numbers are written into fixed columns with a
// placeholder catalogue number (it is only a label, not part of the orbit maths) and the epoch handed over as
// day-of-year of its own year.
const SAT = () => globalThis.satellite;
const pad = (s, n) => (s + ' '.repeat(n)).slice(0, n);
function put(arr, col, str) { for (let i = 0; i < str.length; i++) arr[col + i] = str[i]; }
// "+.12345-3" style: sign, 5 mantissa digits (implied leading decimal point, first digit non-zero), exponent
function expField(v) {
  if (!v || !Number.isFinite(v)) return ' 00000+0';
  const s = v < 0 ? '-' : ' ', a = Math.abs(v);
  let e = Math.floor(Math.log10(a)) + 1, m = Math.round(a / Math.pow(10, e) * 1e5);
  if (m >= 100000) { m = 10000; e++; }
  if (e > 9 || e < -9) return ' 00000+0';
  return s + String(m).padStart(5, '0') + (e < 0 ? '-' : '+') + Math.abs(e);
}
export function ommToSatrec(o) {
  // o: { epoch (ms), n (rev/day), e, i, raan, argp, M (deg), bstar, ndot }
  const d = new Date(o.epoch), y = d.getUTCFullYear();
  const doy = (o.epoch - Date.UTC(y, 0, 1)) / 864e5 + 1;
  const l1 = Array(69).fill(' '), l2 = Array(69).fill(' ');
  put(l1, 0, '1 00001U 00000A   ');
  put(l1, 18, String(y % 100).padStart(2, '0'));
  put(l1, 20, doy.toFixed(8).padStart(12, '0'));
  const nd = Math.max(-0.99999999, Math.min(0.99999999, o.ndot || 0));
  put(l1, 33, (nd < 0 ? '-' : ' ') + Math.abs(nd).toFixed(8).slice(1));
  put(l1, 44, ' 00000+0');                // nddot: negligible, and satellite.js v5 misparses negative values
  put(l1, 53, expField(o.bstar));
  put(l1, 62, '0  999'); l1[68] = '0';
  put(l2, 0, '2 00001 ');
  put(l2, 8, o.i.toFixed(4).padStart(8, ' '));
  put(l2, 17, (((o.raan % 360) + 360) % 360).toFixed(4).padStart(8, ' '));
  put(l2, 26, Math.min(9999999, Math.round(o.e * 1e7)).toString().padStart(7, '0'));
  put(l2, 34, (((o.argp % 360) + 360) % 360).toFixed(4).padStart(8, ' '));
  put(l2, 43, (((o.M % 360) + 360) % 360).toFixed(4).padStart(8, ' '));
  put(l2, 52, o.n.toFixed(8).padStart(11, ' '));
  const rec = SAT().twoline2satrec(l1.join(''), l2.join(''));
  // the real epoch: satellite.js rebuilds it from the 2-digit year; correct it for epochs after 2056
  if (y >= 2057) { rec.epochyr = y % 100; }
  rec.epochMs = o.epoch;
  rec.omm = { epoch: o.epoch, n: o.n, e: o.e, i: o.i, raan: o.raan, argp: o.argp, M: o.M };
  // farthest it can honestly get: drag only lowers an orbit, so anything well past today's apogee is SGP4 breaking
  // down far from the epoch (it gave Starlinks millions of km away)
  const a = Math.cbrt(398600.4418 / Math.pow(o.n * 2 * Math.PI / 86400, 2));
  rec.rMax = a * (1 + o.e) * 1.2 + 500;
  return rec;
}
const DAY = 1440, BACK0 = 30 * DAY, BACK1 = 60 * DAY;   // minutes
function raw(rec, t, out, k) {
  const r = SAT().sgp4(rec, t);
  if (!r || !r.position || rec.error) { rec.error = 0; return false; }
  const p = r.position, v = r.velocity;
  if (!Number.isFinite(p.x)) return false;
  const rm = Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z);
  if (rm < 6371 + 78 || rm > rec.rMax) return false;   // below 78 km it has burned up
  out[k] = p.x; out[k + 1] = p.y; out[k + 2] = p.z; out[k + 3] = v.x; out[k + 4] = v.y; out[k + 5] = v.z;
  return true;
}
const tmp = new Float64Array(6);
// TEME position (km) and velocity (km/s) at unix ms; null if SGP4 fails (decayed or bad elements)
// Once it has decayed it stays decayed (SGP4 can return numbers again later, but they mean nothing).
// Long before the epoch, drag run backwards raises the orbit without limit, so from 60 days back the orbit is computed
// without drag (blended in from 30 days back, so nothing jumps).
export function propagate(rec, ms, out, k = 0) {
  const t = (ms - rec.epochMs) / 60000;
  if (rec.dead != null && t >= rec.dead) return false;
  if (t < -BACK0) {
    const b = rec.back || (rec.back = ommToSatrec({ ...rec.omm, bstar: 0, ndot: 0 }));
    if (!raw(b, t, out, k)) return false;
    if (t > -BACK1 && raw(rec, t, tmp, 0)) {
      const x = (t + BACK1) / (BACK1 - BACK0), w = x * x * (3 - 2 * x);   // 1 at 30 days back, 0 at 60
      for (let j = 0; j < 6; j++) out[k + j] += (tmp[j] - out[k + j]) * w;
    }
    return true;
  }
  if (!raw(rec, t, out, k)) { if (t > 0) rec.dead = Math.min(rec.dead ?? Infinity, t); return false; }
  return true;
}
// when an object that has decayed by ms burned up (unix ms), or null: the FIRST time it dipped below 78 km (near the
// end SGP4 dips below and climbs back for several orbits; the first dip is the one that counts). Steps forward from
// the epoch: coarse while the orbit's lowest point is well above 78 km, 20 s steps near the end.
export function decayTime(rec, ms) {
  const st = new Float64Array(6); let t = rec.epochMs;
  if (ms <= t || !propagate(rec, t, st)) return null;
  for (let n = 0; n < 200000 && t < ms; n++) {
    const rm = Math.hypot(st[0], st[1], st[2]), v2 = st[3] * st[3] + st[4] * st[4] + st[5] * st[5], a = 1 / (2 / rm - v2 / 398600.4418);
    const hx = st[1] * st[5] - st[2] * st[4], hy = st[2] * st[3] - st[0] * st[5], hz = st[0] * st[4] - st[1] * st[3];
    const ex = a * (1 - Math.sqrt(Math.max(0, 1 - (hx * hx + hy * hy + hz * hz) / (398600.4418 * a)))) - 6371 - 78;   // lowest point above 78 km
    const prev = t; t += ex > 40 ? Math.min(864e5, (ex - 30) * 240e3) : 20e3;
    if (!propagate(rec, t, st)) {   // refine to a second (1 s before the returned time it is still in orbit)
      let lo = prev, hi = t; while (hi - lo > 500) { const m = (lo + hi) / 2; if (propagate(rec, m, st)) lo = m; else hi = m; }
      return hi;
    }
  }
  return null;
}
