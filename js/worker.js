// Background worker: SGP4/SDP4 for the whole catalogue, pass predictions and the flare/glint search.
// Started twice by the page: one instance keeps every object's position fresh, the other runs long searches.
import '../vendor/satellite.min.js';
import '../vendor/astronomy.browser.min.js';
import { ommToSatrec, propagate } from './sgp.js';
import { makeObserver, DEG } from './frames.js';
import { obsAt, look, extinction } from './sight.js';
import { shapeFor } from './shapes.js';
import { sunlight as sunlightFn } from './light.js';

let recs = [], meta = [];
const st = new Float64Array(6);
onmessage = e => {
  const m = e.data;
  if (m.cmd === 'init') {
    const E = m.els, N = E.length / 9; recs = new Array(N);
    for (let i = 0; i < N; i++) {
      const k = i * 9;
      try { recs[i] = ommToSatrec({ epoch: E[k], n: E[k + 1], e: E[k + 2], i: E[k + 3], raan: E[k + 4], argp: E[k + 5], M: E[k + 6], bstar: E[k + 7], ndot: E[k + 8] }); }
      catch { recs[i] = null; }
    }
    meta = m.meta || [];
    postMessage({ cmd: 'ready', n: N });
  } else if (m.cmd === 'update') {   // fresher elements for some objects (live CelesTrak refresh)
    for (const u of m.list) { try { recs[u.idx] = ommToSatrec(u.el); } catch { } }
  } else if (m.cmd === 'prop') {
    const N = recs.length, buf = new Float32Array(N * 6), ok = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      const r = recs[i]; if (!r) continue;
      if (propagate(r, m.t, st)) { ok[i] = 1; for (let j = 0; j < 6; j++) buf[i * 6 + j] = st[j]; }
    }
    postMessage({ cmd: 'prop', t: m.t, buf, ok, seq: m.seq }, [buf.buffer, ok.buffer]);
  } else if (m.cmd === 'passes') postMessage({ cmd: 'passes', idx: m.idx, req: m.req, passes: passes(m) });
  else if (m.cmd === 'flares') flares(m);
  else if (m.cmd === 'transits') transits(m);
  else if (m.cmd === 'conjunctions') conjunctions(m);
  else if (m.cmd === 'track') postMessage({ cmd: 'track', idx: m.idx, req: m.req, pts: track(m) });
};

function objAt(i, ms, o, shape, obs, ctx, res) {
  if (!propagate(recs[i], ms, st)) return null;
  const r = [st[0], st[1], st[2]], v = [st[3], st[4], st[5]];
  obsAt(obs, ms, ctx);
  return look(ctx, r, v, o, shape, res);
}

// Passes of one object over [t0, t0 + days]: rise/culmination/set, and the part where it is sunlit while the sky
// is dark enough, with the brightest magnitude (facet model, extinction included).
function passes(m) {
  const i = m.idx, o = m.meta, obs = makeObserver(m.obs.lat, m.obs.lon, m.obs.h), shape = shapeFor(o), ctx = {}, res = {};
  if (!recs[i]) return [];
  const period = 1440 / o.n * 60e3, step = Math.max(10e3, Math.min(120e3, period / 120)), out = [];
  const t1 = m.t0 + m.days * 864e5;
  let prev = null, cur = null;
  const altAt = t => { const r = objAt(i, t, o, null, obs, ctx, res); return r ? r.alt : -90; };
  const refine = (a, b, up) => { for (let k = 0; k < 18; k++) { const c = (a + b) / 2; ((altAt(c) > 0) === up ? (b = c) : (a = c)); } return (a + b) / 2; };
  for (let t = m.t0; t <= t1 && out.length < (m.max || 40); t += step) {
    const a = altAt(t);
    if (prev != null) {
      if (prev <= 0 && a > 0) cur = { rise: refine(t - step, t, true) };
      if (cur && prev > 0 && a <= 0) { cur.set = refine(t - step, t, false); detail(cur); out.push(cur); cur = null; }
    } else if (a > 0) cur = { rise: m.t0, risingBefore: true };
    prev = a;
  }
  if (cur) { cur.set = t1; detail(cur); out.push(cur); }
  function detail(p) {
    const n = Math.max(20, Math.min(400, Math.round((p.set - p.rise) / 5e3)));
    p.maxAlt = -90; p.best = 99; p.visStart = null; p.visEnd = null; p.track = [];
    for (let k = 0; k <= n; k++) {
      const t = p.rise + (p.set - p.rise) * k / n, r = objAt(i, t, o, shape, obs, ctx, res);
      if (!r) continue;
      if (r.alt > p.maxAlt) { p.maxAlt = r.alt; p.tMax = t; p.azMax = r.az; }
      const mag = r.mag + extinction(r.alt);
      const vis = r.Lv > 0.02 && ctx.sunAlt < -4 && r.alt > 0;
      if (vis) { if (p.visStart == null) { p.visStart = t; p.azVis0 = r.az; p.altVis0 = r.alt; } p.visEnd = t; p.azVis1 = r.az; p.altVis1 = r.alt; if (mag < p.best) { p.best = mag; p.tBest = t; } }
      if (k % Math.max(1, Math.round(n / 40)) === 0) p.track.push([t, r.alt, r.az, vis ? mag : 99]);
      if (k === 0) { p.azRise = r.az; } if (k === n) p.azSet = r.az;
      p.sunAlt = ctx.sunAlt;
    }
    p.visible = p.visStart != null;
  }
  return out;
}

// Flare / glint search: for each candidate, find when it is above the horizon, then scan at a fine step and report
// moments when the facet model is much brighter than its diffuse level (a specular reflection off a flat surface).
function flares(m) {
  const obs = makeObserver(m.obs.lat, m.obs.lon, m.obs.h), ctx = {}, res = {}, out = [];
  const t0 = m.t0, t1 = m.t0 + m.hours * 3600e3;
  // only scan while the sky is dark enough to see anything fainter than the brightest flares (Sun below -4 deg)
  const dark = []; { let cur = null; for (let t = t0; t <= t1; t += 60e3) { obsAt(obs, t, ctx); const d = ctx.sunAlt < -4; if (d && !cur) cur = [t, t]; if (d) cur[1] = t + 60e3; if (!d && cur) { dark.push(cur); cur = null; } } if (cur) dark.push(cur); }
  const nextDark = t => { for (const w of dark) { if (t < w[0]) return w[0]; if (t <= w[1]) return t; } return Infinity; };
  // naked-eye limit from the Sun's depression (clear sky, no Moon): ~1 at -6, ~4.5 at -12, ~6.3 when fully dark
  const limAt = sa => sa > -4 ? -3 : sa > -18 ? Math.min(6.3, 1 + (-sa - 6) * 0.42) : 6.3;
  m.list.forEach((c, ci) => {
    const i = c.idx, o = c.meta, shape = shapeFor(o); if (!recs[i]) return;
    const geo = o.n < 1.2;
    if (geo) {
      // slow movers: sample once a minute through the dark hours, then refine each strong dip
      const S = [];
      for (const w of dark) for (let t = Math.max(w[0], t0); t <= Math.min(w[1], t1); t += 60e3) { const q = objAt(i, t, o, shape, obs, ctx, res); S.push(q && q.alt > 8 && q.Lv > 0.02 ? { t, mag: q.mag + extinction(q.alt), alt: q.alt, az: q.az, sunAlt: ctx.sunAlt, Lv: q.Lv, range: q.range } : null); }
      const mags = S.filter(Boolean).map(q => q.mag).sort((a, b) => a - b), med = mags.length ? mags[mags.length >> 1] : 99;
      for (let k = 1; k < S.length - 1; k++) {
        const q = S[k]; if (!q || med - q.mag < 2.5) continue;
        if ((S[k - 1] && S[k - 1].mag < q.mag) || (S[k + 1] && S[k + 1].mag <= q.mag)) continue;   // local minimum only
        let best = q;
        for (let u = q.t - 60e3; u <= q.t + 60e3; u += 5e3) { const z = objAt(i, u, o, shape, obs, ctx, res); if (z && z.alt > 8 && z.Lv > 0.02) { const mg = z.mag + extinction(z.alt); if (mg < best.mag) best = { t: u, mag: mg, alt: z.alt, az: z.az, sunAlt: ctx.sunAlt, Lv: z.Lv, range: z.range }; } }
        if (best.mag > Math.min(m.limit, limAt(best.sunAlt) - 0.3)) continue;
        let a = best.t, b = best.t;
        while (a > best.t - 3600e3) { const z = objAt(i, a - 15e3, o, shape, obs, ctx, res); if (!z || z.mag + extinction(z.alt) > best.mag + 1) break; a -= 15e3; }
        while (b < best.t + 3600e3) { const z = objAt(i, b + 15e3, o, shape, obs, ctx, res); if (!z || z.mag + extinction(z.alt) > best.mag + 1) break; b += 15e3; }
        out.push({ idx: i, id: o.id, name: o.name, ...best, base: med, dur: Math.max(15, (b - a) / 1000), model: shape.label });
      }
      if (ci % 20 === 0) postMessage({ cmd: 'flareProgress', req: m.req, done: ci + 1, of: m.list.length, found: out.length });
      return;
    }
    const coarse = 45e3, fine = 1e3;
    let t = nextDark(t0);
    while (t < t1) {
      const nt = nextDark(t); if (nt !== t) { t = nt; continue; }
      const r = objAt(i, t, o, null, obs, ctx, res);
      if (r && r.alt > (geo ? 5 : -5) && r.Lv > 0) {
        // fine scan over this coarse step
        let best = null, base = 99;
        for (let u = t - coarse; u <= t + coarse; u += fine) {
          const q = objAt(i, u, o, shape, obs, ctx, res);
          if (!q || q.alt < 3 || q.Lv <= 0.02) continue;
          const mag = q.mag + extinction(q.alt);
          if (!best || mag < best.mag) best = { t: u, mag, alt: q.alt, az: q.az, sunAlt: ctx.sunAlt, Lv: q.Lv, range: q.range };
          base = Math.min(base, mag + 0); // track
        }
        if (best) {
          // diffuse level at the same moment: the model with specular terms left out is approximated by the median
          // of the scan; a flare stands at least 2 magnitudes above it
          const samples = [];
          for (let u = best.t - 120 * fine; u <= best.t + 120 * fine; u += 20 * fine) { const q = objAt(i, u, o, shape, obs, ctx, res); if (q && q.alt > 0 && q.Lv > 0.02) samples.push(q.mag + extinction(q.alt)); }
          samples.sort((a, b) => a - b);
          const med = samples.length ? samples[samples.length >> 1] : best.mag + 3;
          if (med - best.mag > 2.0 && best.mag < Math.min(m.limit, limAt(best.sunAlt) - 0.3) && best.alt > 8) {
            // flare width: time the brightness stays within 1 mag of the peak
            let a = best.t, b = best.t;
            for (; a > best.t - 600 * fine; a -= fine / 2) { const q = objAt(i, a, o, shape, obs, ctx, res); if (!q || q.mag + extinction(q.alt) > best.mag + 1) break; }
            for (; b < best.t + 600 * fine; b += fine / 2) { const q = objAt(i, b, o, shape, obs, ctx, res); if (!q || q.mag + extinction(q.alt) > best.mag + 1) break; }
            // a flare is a short, strong spike; slow brightenings over a pass are ordinary phase changes
            if ((b - a) / 1000 < (geo ? 600 : 15) && med - best.mag > 2.5) out.push({ idx: i, id: o.id, name: o.name, ...best, base: med, dur: (b - a) / 1000, model: shape.label });
          }
        }
        t += coarse * 2;
      } else t += coarse;
    }
    if (ci % 20 === 0) postMessage({ cmd: 'flareProgress', req: m.req, done: ci + 1, of: m.list.length, found: out.length });
  });
  // merge duplicates (same object within a few minutes)
  out.sort((a, b) => a.t - b.t);
  const merged = [];
  for (const f of out) { const p = merged.find(q => q.id === f.id && Math.abs(q.t - f.t) < 300e3); if (!p) merged.push(f); else if (f.mag < p.mag) Object.assign(p, f); }
  postMessage({ cmd: 'flares', req: m.req, list: merged });
}
// orbit track (TEME positions) for drawing
function track(m) {
  const pts = [], i = m.idx; if (!recs[i]) return pts;
  for (let k = 0; k <= m.n; k++) { const t = m.t0 + (m.t1 - m.t0) * k / m.n; if (propagate(recs[i], t, st)) pts.push(t, st[0], st[1], st[2]); }
  return pts;
}

// Transits of the Sun and the Moon: the satellite's silhouette crossing the disc as seen from the observer.
// Directions are topocentric, of date (astronomy-engine for the Sun and Moon, SGP4 for the satellite, both in the
// true-equator frame). Reports the closest approach and how far (km) the observer would need to move for a centre line.
function transits(m) {
  const A = self.Astronomy, ob = new A.Observer(m.obs.lat, m.obs.lon, m.obs.h * 1000), obs = makeObserver(m.obs.lat, m.obs.lon, m.obs.h), ctx = {}, out = [];
  const bodyDir = (name, t) => { const eq = A.Equator(name, new Date(t), ob, true, true), ra = eq.ra * 15 * DEG, de = eq.dec * DEG; return { v: [Math.cos(de) * Math.cos(ra), Math.cos(de) * Math.sin(ra), Math.sin(de)], dist: eq.dist * 149597870.7 }; };
  const satDir = (i, t) => { if (!propagate(recs[i], t, st)) return null; obsAt(obs, t, ctx); const d = [st[0] - ctx.o[0], st[1] - ctx.o[1], st[2] - ctx.o[2]], r = Math.hypot(...d); return { v: d.map(x => x / r), r }; };
  const sep = (a, b) => Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
  m.list.forEach((c, ci) => {
    const ps = passes({ idx: c.idx, meta: c.meta, obs: m.obs, t0: m.t0, days: m.days, max: 200 });
    for (const p of ps) for (const body of ['Sun', 'Moon', 'Venus', 'Jupiter', 'Mars', 'Saturn', 'Mercury']) {
      const b0 = bodyDir(body, p.tMax || p.rise);
      // body must be up
      obsAt(obs, p.tMax || p.rise, ctx);
      const bw = [ctx.M[3] * b0.v[0] + ctx.M[4] * b0.v[1] + ctx.M[5] * b0.v[2]];
      if (bw[0] < -0.01) continue;
      let best = null;
      for (let t = p.rise; t <= p.set; t += 2000) { const sd = satDir(c.idx, t); if (!sd) continue; const bd = bodyDir(body, t), a = sep(sd.v, bd.v); if (!best || a < best.a) best = { t, a }; }
      const planet = body !== 'Sun' && body !== 'Moon';
      if (!best || best.a > (planet ? 1.5 : 3) * DEG) continue;
      for (let t = best.t - 2500; t <= best.t + 2500; t += 25) { const sd = satDir(c.idx, t); if (!sd) continue; const bd = bodyDir(body, t), a = sep(sd.v, bd.v); if (a < best.a) best = { t, a, r: sd.r, bd }; }
      if (!best.bd) continue;
      const rad = Math.asin(({ Sun: 696000, Moon: 1737.4, Mercury: 2439.7, Venus: 6051.8, Mars: 3396.2, Jupiter: 71492, Saturn: 60268 })[body] / best.bd.dist);
      if (best.a > rad + (planet ? 0.05 : 0.6) * DEG) continue;
      const satRad = shapeFor(c.meta).size / 2000 / best.r;   // the satellite's own angular radius: the discs touch at rad + satRad
      // time spent inside the disc
      let dur = 0; if (best.a < rad) { let a0 = best.t, a1 = best.t; while (a0 > best.t - 20000) { const sd = satDir(c.idx, a0 - 10); if (!sd || sep(sd.v, bodyDir(body, a0 - 10).v) > rad) break; a0 -= 10; } while (a1 < best.t + 20000) { const sd = satDir(c.idx, a1 + 10); if (!sd || sep(sd.v, bodyDir(body, a1 + 10).v) > rad) break; a1 += 10; } dur = (a1 - a0) / 1000; }
      out.push({ idx: c.idx, id: c.meta.id, name: c.meta.name, body, t: best.t, sepDeg: best.a / DEG, radDeg: rad / DEG, inside: best.a < rad + satRad, planet, dur, rangeKm: best.r, missKm: Math.max(0, best.a - rad) * best.r, centreKm: best.a * best.r, sizeArcsec: (shapeFor(c.meta).size / 1000 / best.r) / DEG * 3600 });
    }
    postMessage({ cmd: 'transitProgress', req: m.req, done: ci + 1, of: m.list.length });
  });
  out.sort((a, b) => a.t - b.t);
  postMessage({ cmd: 'transits', req: m.req, list: out });
}

// Satellite-satellite conjunctions: moments when another object passes (very nearly) in front of or behind the
// selected one as seen from the observer. Coarse pass over the whole catalogue finds objects anywhere near the line
// of sight, then candidates are followed at 2 s and refined at 0.05 s.
function conjunctions(m) {
  const i0 = m.idx, o0 = m.meta, obs = makeObserver(m.obs.lat, m.obs.lon, m.obs.h), ctx = {}, N = recs.length, out = [];
  const ps = passes({ idx: i0, meta: o0, obs: m.obs, t0: m.t0, days: m.days, max: 30 }).filter(p => p.maxAlt > 8);
  const dirAt = (i, t, outv) => { if (!propagate(recs[i], t, st)) return -1; if (ctx.ms !== t) obsAt(obs, t, ctx); const dx = st[0] - ctx.o[0], dy = st[1] - ctx.o[1], dz = st[2] - ctx.o[2], r = Math.hypot(dx, dy, dz); outv[0] = dx / r; outv[1] = dy / r; outv[2] = dz / r; outv.r = r; outv.lit = outv.wantLit ? sunlightF([st[0], st[1], st[2]], ctx) : 1; return r; };
  const u0 = [0, 0, 0], u1 = [0, 0, 0];
  ps.forEach((p, pi) => {
    const a = Math.max(p.rise, m.t0), b = p.set; if (b <= a) return;
    // 1) coarse: every object, every 30 s; keep those within 25 deg of the selected object's direction at any step
    const cand = new Set(), skip = new Set();
    for (let t = a; t <= b; t += 30e3) {
      if (dirAt(i0, t, u0) < 0) continue;
      const r0x = u0[0] * u0.r, r0y = u0[1] * u0.r, r0z = u0[2] * u0.r;
      for (let i = 0; i < N; i++) {
        if (i === i0 || !recs[i] || skip.has(i)) continue;
        if (meta[i] && (meta[i].id === o0.id || (o0.cospar && meta[i].cospar === o0.cospar))) { skip.add(i); continue; }   // itself (duplicate entries), or the same object under another name
        if (dirAt(i, t, u1) < 0) continue;
        // docked vehicles and anything flying in formation with it (within 20 km) are not separate events
        const dx = u1[0] * u1.r - r0x, dy = u1[1] * u1.r - r0y, dz = u1[2] * u1.r - r0z;
        if (dx * dx + dy * dy + dz * dz < 400) { cand.delete(i); skip.add(i); continue; }
        if (u0[0] * u1[0] + u0[1] * u1[1] + u0[2] * u1[2] > 0.906) cand.add(i);
      }
    }
    // 2) fine: candidates every 2 s, closest approach between steps from the change in relative direction
    for (const i of cand) {
      let prev = null;
      for (let t = a; t <= b; t += 2e3) {
        if (dirAt(i0, t, u0) < 0 || dirAt(i, t, u1) < 0) { prev = null; continue; }
        const rel = [u1[0] - u0[0], u1[1] - u0[1], u1[2] - u0[2]];
        if (prev) {
          const d = [rel[0] - prev[0], rel[1] - prev[1], rel[2] - prev[2]], dd = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
          const f = dd > 0 ? Math.max(0, Math.min(1, -(prev[0] * d[0] + prev[1] * d[1] + prev[2] * d[2]) / dd)) : 0;
          const mx = prev[0] + d[0] * f, my = prev[1] + d[1] * f, mz = prev[2] + d[2] * f, sep = Math.hypot(mx, my, mz);
          if (sep < 0.4 * DEG) {
            // 3) refine around the interpolated minimum
            let best = null; u0.wantLit = u1.wantLit = true;
            for (let tt = t - 2e3 + f * 2e3 - 1500; tt <= t - 2e3 + f * 2e3 + 1500; tt += 50) {
              if (dirAt(i0, tt, u0) < 0) continue; const r0 = u0.r, l0 = u0.lit; if (dirAt(i, tt, u1) < 0) continue;
              const ss = Math.acos(Math.max(-1, Math.min(1, u0[0] * u1[0] + u0[1] * u1[1] + u0[2] * u1[2])));
              if (!best || ss < best.sep) best = { t: tt, sep: ss, r0, r1: u1.r, lit0: l0, lit1: u1.lit, alt: Math.asin(Math.max(-1, Math.min(1, ctx.M[3] * u0[0] + ctx.M[4] * u0[1] + ctx.M[5] * u0[2]))) / DEG };
            }
            if (best && best.alt > 3) {
              const s0 = shapeFor(o0).size, s1 = shapeFor(meta[i] || { id: i, cls: 'debris', type: 2, rcs: 0.1 }).size;
              const ang0 = s0 / 2000 / best.r0, ang1 = s1 / 2000 / best.r1;
              u0.wantLit = u1.wantLit = false;
              out.push({ t: best.t, idx: i, sepDeg: best.sep / DEG, sepArcsec: best.sep / DEG * 3600, front: best.r1 < best.r0 ? 'other' : 'selected', occult: best.sep < ang0 + ang1, r0: best.r0, r1: best.r1, lit0: best.lit0 > 0.02, lit1: best.lit1 > 0.02, alt: best.alt, size0: ang0 * 2 / DEG * 3600, size1: ang1 * 2 / DEG * 3600 });
            }
          }
        }
        prev = rel;
      }
    }
    postMessage({ cmd: 'conjProgress', req: m.req, done: pi + 1, of: ps.length, found: out.length });
  });
  // one entry per object per pass (the closest)
  out.sort((x, y) => x.sepDeg - y.sepDeg);
  const seen = new Set(), list = [];
  for (const e of out) { const k = e.idx + ':' + Math.round(e.t / 600e3); if (seen.has(k)) continue; seen.add(k); list.push(e); if (list.length >= 60) break; }
  list.sort((x, y) => x.t - y.t);
  postMessage({ cmd: 'conjunctions', req: m.req, list, passes: ps.length });
}
function sunlightF(r, ctx) { const L = [1, 1, 1]; sunlightFn(r, ctx.s, ctx.sd, L); return L.f; }
