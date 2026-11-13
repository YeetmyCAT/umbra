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
    this.K = new Float64Array(N * 12);       // a, b, e, n, M0, P(3), Q(3), valid
    this.anchorT = 0; this.haveAnchor = false;
    this.Ml = new Float64Array(N).fill(NaN); this.El = new Float64Array(N);
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
  // ask the worker for exact states at the time the answer will be needed
  request(simMs, rate) {
    if (this.pending) return;
    this.pending = true; this.reqAt = performance.now();
    const t = simMs + rate * this.latency;
    this.worker.postMessage({ cmd: 'prop', t, seq: ++this.seq });
  }
  onProp(m) {
    this.pending = false; this.latency = this.latency * 0.7 + (performance.now() - this.reqAt) * 0.3;
    const b = m.buf, ok = m.ok, K = this.K, N = this.N;
    // Between exact SGP4 updates objects move on two-body orbits, which drift from SGP4 by up to a few km at high
    // time rates. Rather than letting them jump when a new update lands, the difference is kept as an offset that
    // fades out over ~0.4 s (it never applies after a time jump).
    if (!this.corr) this.corr = new Float32Array(N * 3);
    const blend = this.haveAnchor && !this.noBlend, dtOld = (m.t - this.anchorT) / 1000, tmp = [0, 0, 0];
    this.noBlend = false;
    if (!blend) this.corr.fill(0);
    for (let i = 0; i < N; i++) {
      const k = i * 12;
      if (!ok[i]) { K[k + 11] = 0; continue; }
      const j = i * 6, rx = b[j], ry = b[j + 1], rz = b[j + 2], vx = b[j + 3], vy = b[j + 4], vz = b[j + 5];
      if (blend && K[k + 11]) {
        this.kepler(k, dtOld, tmp, NaN);
        const c = i * 3, cw = this.corrW;
        const ex = tmp[0] + this.corr[c] * cw - rx, ey = tmp[1] + this.corr[c + 1] * cw - ry, ez = tmp[2] + this.corr[c + 2] * cw - rz;
        if (ex * ex + ey * ey + ez * ez < 4e4) { this.corr[c] = ex; this.corr[c + 1] = ey; this.corr[c + 2] = ez; } else { this.corr[c] = this.corr[c + 1] = this.corr[c + 2] = 0; }
      }
      const rm = Math.sqrt(rx * rx + ry * ry + rz * rz), v2 = vx * vx + vy * vy + vz * vz, rv = rx * vx + ry * vy + rz * vz;
      const a = 1 / (2 / rm - v2 / MU);
      if (!(a > 0) || a > 5e5) { K[k + 11] = 0; continue; }
      const n = Math.sqrt(MU / (a * a * a)), ec = rv / Math.sqrt(MU * a), es = 1 - rm / a, e = Math.min(0.999, Math.sqrt(ec * ec + es * es)), E0 = Math.atan2(ec, es);
      const cE = Math.cos(E0), sE = Math.sin(E0), bb = a * Math.sqrt(1 - e * e), kk = 1 - e * cE;
      const f1 = a * (cE - e), g1 = bb * sE, f2 = -n * a * sE / kk, g2 = n * bb * cE / kk, det = f1 * g2 - g1 * f2;
      K[k] = a; K[k + 1] = bb; K[k + 2] = e; K[k + 3] = n; K[k + 4] = E0 - e * sE;
      K[k + 5] = (rx * g2 - vx * g1) / det; K[k + 6] = (ry * g2 - vy * g1) / det; K[k + 7] = (rz * g2 - vz * g1) / det;
      K[k + 8] = (vx * f1 - rx * f2) / det; K[k + 9] = (vy * f1 - ry * f2) / det; K[k + 10] = (vz * f1 - rz * f2) / det; K[k + 11] = 1;
    }
    // vehicles docked to a station share its orbit and position (their own catalogue entries are kept but drawn as
    // part of the station)
    if (!this.stations) { this.stations = this.objs.filter(o => o.cls === 'iss' || o.cls === 'css').map(o => o.idx); this.docked = new Int32Array(N).fill(-1); }
    this.docked.fill(-1);
    for (const si of this.stations) {
      if (!ok[si]) continue;
      const sx = b[si * 6], sy = b[si * 6 + 1], sz = b[si * 6 + 2], sn = this.objs[si].n;
      for (let i = 0; i < N; i++) {
        if (i === si || !ok[i] || Math.abs(this.objs[i].n - sn) > 0.08) continue;
        const dx = b[i * 6] - sx, dy = b[i * 6 + 1] - sy, dz = b[i * 6 + 2] - sz;
        if (dx * dx + dy * dy + dz * dz < 9) this.docked[i] = si;
      }
    }
    this.Ml.fill(NaN);
    this.anchorT = m.t; this.haveAnchor = true; this.corrT = performance.now(); this.corrW = 1;
  }
  decayCorr() { const w = this.corrW || 0; if (w < 1) for (let i = 0; i < this.corr.length; i++) this.corr[i] *= w; }
  // position on the stored two-body orbit (no warm start)
  kepler(k, dt, out) {
    const K = this.K, a = K[k], b = K[k + 1], e = K[k + 2], n = K[k + 3], Mm = K[k + 4] + n * dt;
    let E = Mm + e * Math.sin(Mm);
    for (let it = 0; it < 8; it++) { const d = (E - e * Math.sin(E) - Mm) / (1 - e * Math.cos(E)); E -= d; if (Math.abs(d) < 1e-10) break; }
    const x = a * (Math.cos(E) - e), y = b * Math.sin(E);
    out[0] = K[k + 5] * x + K[k + 8] * y; out[1] = K[k + 6] * x + K[k + 9] * y; out[2] = K[k + 7] * x + K[k + 10] * y;
    return out;
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
    const dt = (simMs - this.anchorT) / 1000, K = this.K, P = this.pos, V = this.vel, N = this.N;
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
        if (!K[k + 11]) { this.alt[i] = -90; this.mag[i] = 99; continue; }
        const a = K[k], b = K[k + 1], e = K[k + 2], n = K[k + 3], Mm = K[k + 4] + n * dt;
        // warm start from last frame's solution: usually one or two Newton steps
        const Ml = this.Ml[i], El = this.El[i];
        let E = Ml === Ml && Math.abs(Mm - Ml) < 0.5 ? El + (Mm - Ml) / (1 - e * Math.cos(El)) : Mm + e * Math.sin(Mm);
        for (let it = 0; it < 6; it++) { const d = (E - e * Math.sin(E) - Mm) / (1 - e * Math.cos(E)); E -= d; if (d < 1e-10 && d > -1e-10) break; }
        this.Ml[i] = Mm; this.El[i] = E;
        const cE = Math.cos(E), sE = Math.sin(E), x = a * (cE - e), y = b * sE, f = n * a / (1 - e * cE);
        r[0] = K[k + 5] * x + K[k + 8] * y; r[1] = K[k + 6] * x + K[k + 9] * y; r[2] = K[k + 7] * x + K[k + 10] * y;
        const vxp = -f * sE, vyp = f * Math.sqrt(1 - e * e) * cE;
        v[0] = K[k + 5] * vxp + K[k + 8] * vyp; v[1] = K[k + 6] * vxp + K[k + 9] * vyp; v[2] = K[k + 7] * vxp + K[k + 10] * vyp;
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
