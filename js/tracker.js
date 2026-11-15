// Live state of every object: exact SGP4 states from the worker ("anchors"), moved to the current instant each frame
// with two-body (Kepler) motion, then turned into sky direction, sunlight and magnitude for the observer.
// The selected object is propagated with full SGP4 every frame.
import { MU, temeToWorldMatrix, ecefToTeme, gmst, sunTEME, mulM3, DEG } from './frames.js';
import { ommToSatrec, propagate } from './sgp.js';
import { sunlight, facetsIntensity, magFromI, bodyFrame, earthshine, facetsEarthshine } from './light.js';
import { stdMag, look, obsAt, extinction, sphereMag } from './sight.js';
import { shapeFor } from './shapes.js';
import { elementsArray, metaOf } from './catalog.js';

export class Tracker {
  constructor(objs) {
    this.objs = objs; const N = this.N = objs.length;
    this.anchorT = 0; this.haveAnchor = false;
    this.pos = new Float64Array(N * 3); this.vel = new Float64Array(N * 3);
    this.dir = new Float32Array(N * 3); this.alt = new Float32Array(N); this.az = new Float32Array(N); this.range = new Float32Array(N);
    this.mag = new Float32Array(N).fill(99); this.light = new Float32Array(N * 3); this.lit = new Float32Array(N);
    this.std = new Float32Array(N); objs.forEach((o, i) => this.std[i] = stdMag(o));
    this.seq = 0; this.pending = false; this.latency = 150;
    this.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    this.ready = new Promise(res => {
      this.worker.onmessage = e => {
        const m = e.data;
        if (m.cmd === 'ready') res();
        else if (m.cmd === 'prop') this.onProp(m);
      };
    });
    this.worker.postMessage({ cmd: 'init', els: elementsArray(objs) });
    this.sel = -1; this.selRec = null;
    this.shapes = new Array(N);
    this.ctx = {};
  }
  updateElements(list) { this.worker.postMessage({ cmd: 'update', list: list.map(o => ({ idx: o.idx, el: o })) }); if (this.sel >= 0 && list.some(o => o.idx === this.sel)) this.select(this.sel); }
  // Ask the worker for exact SGP4 states at both ends of a short segment starting when the answer will arrive.
  // Between the two, objects follow a cubic Hermite curve through both states (positions and velocities match
  // exactly at the ends), which stays within metres of SGP4; past either end, a two-body orbit continues from that
  // end with the same position and velocity. Motion is therefore smooth (no kinks) at any time rate.
  request(simMs, rate) {
    if (this.pending) return;
    const g = this.seg;
    if (g && this.haveAnchor && !this.noBlend) {
      const h = g.t1 - g.t0, prog = h !== 0 ? (simMs - g.t0) / h : (simMs === g.t0 && rate === 0 ? 0 : 9);
      if (prog > -0.05 && prog < 0.45 && (h === 0 ? rate === 0 : Math.sign(h) === Math.sign(rate))) return;
    }
    this.pending = true; this.reqAt = performance.now();
    const t = simMs + rate * this.latency, span = Math.sign(rate) * Math.min(Math.abs(rate) * 600, 120000);
    const spare = this.spare || null; this.spare = null;
    this.worker.postMessage({ cmd: 'prop', t, t2: t + span, seq: ++this.seq, recycle: spare }, spare ? [spare.buffer] : []);
  }
  onProp(m) {
    this.pending = false; this.latency = this.latency * 0.7 + (performance.now() - this.reqAt) * 0.3;
    const N = this.N, S = m.buf, ok = m.ok, old = this.seg;
    const pool = this.kPool || (this.kPool = []);
    const ng = { t0: m.t, t1: m.t2 ?? m.t, S, ok, K0: pool.pop() || new Float64Array(N * 12), K1: pool.pop() || new Float64Array(N * 12) };
    for (let i = 0; i < N; i++) {
      if (!ok[i]) continue;
      const j = i * 12;
      if (!kepFrom(ng.K0, j, S, j) || !kepFrom(ng.K1, j, S, j + 6)) ok[i] = 0;
    }
    // what is on screen now (old segment plus its fading offset) and the new segment differ by metres at most:
    // keep that as an offset that fades out over ~0.4 s, so nothing ever jumps
    if (!this.corr) this.corr = new Float64Array(N * 3);
    const blend = old && this.haveAnchor && !this.noBlend && this.lastSim != null, a = [0, 0, 0], b = [0, 0, 0], v = [0, 0, 0];
    this.noBlend = false;
    if (!blend) this.corr.fill(0);
    else {
      const t = this.lastSim, cw = this.corrW || 0, C = this.corr;
      for (let i = 0; i < N; i++) {
        const c = i * 3;
        if (!ok[i] || !old.ok[i]) { C[c] = C[c + 1] = C[c + 2] = 0; continue; }
        evalSeg(old, i, t, a, v); evalSeg(ng, i, t, b, v);
        const ex = a[0] + C[c] * cw - b[0], ey = a[1] + C[c + 1] * cw - b[1], ez = a[2] + C[c + 2] * cw - b[2];
        if (ex * ex + ey * ey + ez * ez < 4e4) { C[c] = ex; C[c + 1] = ey; C[c + 2] = ez; } else C[c] = C[c + 1] = C[c + 2] = 0;
      }
    }
    if (old) { pool.push(old.K0, old.K1); this.spare = old.S; }
    // vehicles docked to a station share its orbit and position (their own catalogue entries are kept but drawn as
    // part of the station)
    if (!this.stations) { this.stations = this.objs.filter(o => o.cls === 'iss' || o.cls === 'css').map(o => o.idx); this.docked = new Int32Array(N).fill(-1); }
    this.docked.fill(-1);
    for (const si of this.stations) {
      if (!ok[si]) continue;
      const sx = S[si * 12], sy = S[si * 12 + 1], sz = S[si * 12 + 2], sn = this.objs[si].n;
      for (let i = 0; i < N; i++) {
        if (i === si || !ok[i] || Math.abs(this.objs[i].n - sn) > 0.08) continue;
        const dx = S[i * 12] - sx, dy = S[i * 12 + 1] - sy, dz = S[i * 12 + 2] - sz;
        if (dx * dx + dy * dy + dz * dz < 9) this.docked[i] = si;
      }
    }
    this.seg = ng;
    this.anchorT = m.t; this.haveAnchor = true; this.corrT = performance.now(); this.corrW = 1;
  }
  select(i) {
    // newer elements for the same object: glide from the old prediction to the new one over 3 s instead of jumping
    this.selOld = i >= 0 && i === this.sel && this.selRec ? this.selRec : null; this.selOldT = performance.now();
    this.sel = i;
    if (i < 0) { this.selRec = null; return; }
    const o = this.objs[i];
    try { this.selRec = ommToSatrec(o); } catch { this.selRec = null; }
  }
  // exact state of the selected object (SGP4), blended after an element update
  selState(ms, st) {
    if (!propagate(this.selRec, ms, st)) return false;
    if (this.selOld) {
      const w = 1 - (performance.now() - this.selOldT) / 3000;
      if (w <= 0) this.selOld = null;
      else { const o = new Float64Array(6); if (propagate(this.selOld, ms, o)) { const f = w * w * (3 - 2 * w); for (let j = 0; j < 6; j++) st[j] += (o[j] - st[j]) * f; } }
    }
    return true;
  }
  shape(i) { return this.shapes[i] || (this.shapes[i] = shapeFor(this.objs[i])); }
  // Move everything to simMs and evaluate it for the observer. Light-weight for objects below the horizon.
  update(simMs, obs, opts = {}) {
    if (!this.haveAnchor) return false;
    const ctx = obsAt(obs, simMs, this.ctx), M = ctx.M, o0 = ctx.o, s = ctx.s;
    const dt = (simMs - this.anchorT) / 1000, g = this.seg, P = this.pos, V = this.vel, N = this.N;
    this.lastSim = simMs;
    this.corrW = this.corrT ? Math.exp(-(performance.now() - this.corrT) / 400) : 0;
    const cw = this.corrW > 0.003 ? this.corrW : 0, C = this.corr;
    this.anchorAge = dt;
    const slice = (this.frameN = (this.frameN || 0) + 1) % 3;
    const minAlt = opts.minAlt ?? -2, doMag = opts.mags !== false, L = [1, 1, 1], st = new Float64Array(6);
    const r = [0, 0, 0], v = [0, 0, 0], ob = [0, 0, 0], down = [0, 0, 0], sb = [0, 0, 0];
    const lazy = opts.lazy && Math.abs(opts.rate || 1) <= 120, fq = this.frameN & 3;
    for (let i = 0; i < N; i++) {
      const k = i * 12;
      // well below the horizon and invisible: refresh every 4th frame only (it can't rise that fast)
      if (lazy && this.alt[i] < -15 && ((i & 3) !== fq) && i !== this.sel) continue;
      if (i === this.sel && this.selRec && this.selState(simMs, st)) {
        r[0] = st[0]; r[1] = st[1]; r[2] = st[2]; v[0] = st[3]; v[1] = st[4]; v[2] = st[5];
      } else {
        if (!g.ok[i]) { this.alt[i] = -90; this.mag[i] = 99; continue; }
        evalSeg(g, i, simMs, r, v);
        if (cw) { r[0] += C[i * 3] * cw; r[1] += C[i * 3 + 1] * cw; r[2] += C[i * 3 + 2] * cw; }
      }
      P[i * 3] = r[0]; P[i * 3 + 1] = r[1]; P[i * 3 + 2] = r[2]; V[i * 3] = v[0]; V[i * 3 + 1] = v[1]; V[i * 3 + 2] = v[2];
      if (opts.posOnly) continue;
      const dx = r[0] - o0[0], dy = r[1] - o0[1], dz = r[2] - o0[2], rg = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const wx = (M[0] * dx + M[1] * dy + M[2] * dz) / rg, wy = (M[3] * dx + M[4] * dy + M[5] * dz) / rg, wz = (M[6] * dx + M[7] * dy + M[8] * dz) / rg;
      this.dir[i * 3] = wx; this.dir[i * 3 + 1] = wy; this.dir[i * 3 + 2] = wz;
      const alt = Math.asin(Math.max(-1, Math.min(1, wy))) / DEG; this.alt[i] = alt; this.range[i] = rg;
      if (alt < minAlt || (this.docked && this.docked[i] >= 0 && i !== this.sel)) { this.mag[i] = 99; if (this.magOK) this.magOK[i] = 0; continue; }
      let az = Math.atan2(wx, -wz) / DEG; this.az[i] = az < 0 ? az + 360 : az;
      // brightness is refreshed for a third of the objects each frame (20 times a second each); the selected one always
      if (i !== this.sel && i % 3 !== slice && this.magOK && this.magOK[i]) continue;
      sunlight(r, s, ctx.sd, L);
      this.light[i * 3] = L[0]; this.light[i * 3 + 1] = L[1]; this.light[i * 3 + 2] = L[2]; this.lit[i] = L.f;
      const Lv = 0.2126 * L[0] + 0.7152 * L[1] + 0.0722 * L[2];
      const es = earthshine(r, s);
      if (!this.magOK) this.magOK = new Uint8Array(N);
      this.magOK[i] = 1;
      if ((Lv <= 1e-5 && es < 2e-4) || !doMag) { this.mag[i] = 99; continue; }
      ob[0] = -dx / rg; ob[1] = -dy / rg; ob[2] = -dz / rg;
      const rm = Math.sqrt(r[0] * r[0] + r[1] * r[1] + r[2] * r[2]); down[0] = -r[0] / rm; down[1] = -r[1] / rm; down[2] = -r[2] / rm;
      const phi = Math.acos(Math.max(-1, Math.min(1, ob[0] * s[0] + ob[1] * s[1] + ob[2] * s[2])));
      const o = this.objs[i];
      if (o.cls !== 'payload' || i === this.sel) {
        const sh = this.shape(i);
        const B = bodyFrame(sh.att, r, v, s, simMs, o.id, sh.Bt || (sh.Bt = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }));
        sb[0] = B.x[0] * s[0] + B.x[1] * s[1] + B.x[2] * s[2]; sb[1] = B.y[0] * s[0] + B.y[1] * s[1] + B.y[2] * s[2]; sb[2] = B.z[0] * s[0] + B.z[1] * s[1] + B.z[2] * s[2];
        let I = facetsIntensity(sh.facets, B, s, ob) * Lv + facetsEarthshine(sh.facets, B, down, ob, sb, es);
        I *= sh.calK;
        if (sh.known !== 'exact') { if (sh.cal == null || sh.calFor !== i) { sh.cal = Math.pow(10, -0.4 * (this.std[i] - modelStdCached(sh))); sh.calFor = i; } I *= sh.cal; }
        this.mag[i] = magFromI(I, rg, 1);
      } else this.mag[i] = sphereMag(this.std[i], rg, phi, Lv, es, ob, down);
    }
    return true;
  }
  // full detail for one object (the info card)
  detail(i, simMs, obs) {
    const o = this.objs[i], st = new Float64Array(6);
    let r, v;
    if (i === this.sel && this.selRec && this.selState(simMs, st)) { r = [st[0], st[1], st[2]]; v = [st[3], st[4], st[5]]; }
    else { r = [this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]]; v = [this.vel[i * 3], this.vel[i * 3 + 1], this.vel[i * 3 + 2]]; }
    const ctx = obsAt(obs, simMs, {});
    const res = look(ctx, r, v, o, this.shape(i), {});
    res.r = r; res.v = v; res.ctx = ctx; res.magExt = res.mag + extinction(res.alt);
    return res;
  }
}
import { modelStd } from './sight.js';
function modelStdCached(sh) { return modelStd(sh); }

// two-body orbit through the state at S[o..o+5] (km, km/s): a, b, e, n, M0, P(3), Q(3) at K[k..k+10]; false if not elliptic
function kepFrom(K, k, S, o) {
  const rx = S[o], ry = S[o + 1], rz = S[o + 2], vx = S[o + 3], vy = S[o + 4], vz = S[o + 5];
  const rm = Math.sqrt(rx * rx + ry * ry + rz * rz), v2 = vx * vx + vy * vy + vz * vz, rv = rx * vx + ry * vy + rz * vz;
  const a = 1 / (2 / rm - v2 / MU);
  if (!(a > 0) || a > 5e5) return false;
  const n = Math.sqrt(MU / (a * a * a)), ec = rv / Math.sqrt(MU * a), es = 1 - rm / a, e = Math.min(0.999, Math.sqrt(ec * ec + es * es)), E0 = Math.atan2(ec, es);
  const cE = Math.cos(E0), sE = Math.sin(E0), bb = a * Math.sqrt(1 - e * e), kk = 1 - e * cE;
  const f1 = a * (cE - e), g1 = bb * sE, f2 = -n * a * sE / kk, g2 = n * bb * cE / kk, det = f1 * g2 - g1 * f2;
  K[k] = a; K[k + 1] = bb; K[k + 2] = e; K[k + 3] = n; K[k + 4] = E0 - e * sE;
  K[k + 5] = (rx * g2 - vx * g1) / det; K[k + 6] = (ry * g2 - vy * g1) / det; K[k + 7] = (rz * g2 - vz * g1) / det;
  K[k + 8] = (vx * f1 - rx * f2) / det; K[k + 9] = (vy * f1 - ry * f2) / det; K[k + 10] = (vz * f1 - rz * f2) / det;
  return true;
}
function kepAt(K, k, dt, r, v) {
  const a = K[k], b = K[k + 1], e = K[k + 2], n = K[k + 3], Mm = K[k + 4] + n * dt;
  let E = Mm + e * Math.sin(Mm);
  for (let it = 0; it < 12; it++) { const d = (E - e * Math.sin(E) - Mm) / (1 - e * Math.cos(E)); E -= d; if (d < 1e-12 && d > -1e-12) break; }
  const cE = Math.cos(E), sE = Math.sin(E), x = a * (cE - e), y = b * sE, f = n * a / (1 - e * cE), vxp = -f * sE, vyp = f * Math.sqrt(1 - e * e) * cE;
  r[0] = K[k + 5] * x + K[k + 8] * y; r[1] = K[k + 6] * x + K[k + 9] * y; r[2] = K[k + 7] * x + K[k + 10] * y;
  v[0] = K[k + 5] * vxp + K[k + 8] * vyp; v[1] = K[k + 6] * vxp + K[k + 9] * vyp; v[2] = K[k + 7] * vxp + K[k + 10] * vyp;
}
// position and velocity of object i at sim time t (ms) on segment g: Hermite inside, two-body from the nearer end outside
function evalSeg(g, i, t, r, v) {
  const S = g.S, j = i * 12, h = (g.t1 - g.t0) / 1000, s = h !== 0 ? (t - g.t0) / 1000 / h : -1;
  if (h !== 0 && s >= 0 && s <= 1) {
    const s2 = s * s, s3 = s2 * s, h00 = 2 * s3 - 3 * s2 + 1, h10 = (s3 - 2 * s2 + s) * h, h01 = 3 * s2 - 2 * s3, h11 = (s3 - s2) * h;
    const d00 = (6 * s2 - 6 * s) / h, d10 = 3 * s2 - 4 * s + 1, d01 = (6 * s - 6 * s2) / h, d11 = 3 * s2 - 2 * s;
    for (let c = 0; c < 3; c++) {
      const p0 = S[j + c], v0 = S[j + 3 + c], p1 = S[j + 6 + c], v1 = S[j + 9 + c];
      r[c] = h00 * p0 + h10 * v0 + h01 * p1 + h11 * v1; v[c] = d00 * p0 + d10 * v0 + d01 * p1 + d11 * v1;
    }
  } else if (h !== 0 && s > 1) kepAt(g.K1, j, (t - g.t1) / 1000, r, v);
  else kepAt(g.K0, j, (t - g.t0) / 1000, r, v);
}
