// Catalogue: loads data/catalog.json (rebuilt every 2 hours from CelesTrak by tools/buildcatalog.cjs / the GitHub
// workflow), classifies every object, and refreshes single objects straight from CelesTrak on demand.
import { classify, regime } from './purpose.js';

export async function loadCatalog(onProgress) {
  const r = await fetch('data/catalog.json', { cache: 'no-cache' });
  if (!r.ok) throw new Error('catalog ' + r.status);
  const j = await r.json();
  const F = j.fields, ix = Object.fromEntries(F.map((k, i) => [k, i]));
  const objs = new Array(j.rows.length);
  j.rows.forEach((w, k) => {
    const o = {
      idx: k, id: w[ix.id], name: w[ix.name], cospar: w[ix.cospar], epoch: w[ix.epoch], n: w[ix.n], e: w[ix.e], i: w[ix.i], raan: w[ix.raan], argp: w[ix.argp], M: w[ix.M],
      bstar: w[ix.bstar], ndot: w[ix.ndot], type: w[ix.type], ops: w[ix.ops], owner: w[ix.owner], launch: w[ix.launch], rcs: w[ix.rcs], mag: w[ix.mag], s1: w[ix.s1], s2: w[ix.s2], s3: w[ix.s3], note: w[ix.note],
    };
    const c = classify(o); o.purpose = c.purpose; o.operator = c.operator; o.cls = c.cls;
    o.nameU = o.name.toUpperCase();
    objs[k] = o;
  });
  return { built: j.built, source: j.source, objs };
}
export function elementsArray(objs) {
  const E = new Float64Array(objs.length * 9);
  objs.forEach((o, i) => E.set([o.epoch, o.n, o.e, o.i, o.raan, o.argp, o.M, o.bstar || 0, o.ndot || 0], i * 9));
  return E;
}
// metadata the worker needs to rebuild shapes (plain data only)
export function metaOf(o) { return { id: o.id, name: o.name, cls: o.cls, n: o.n, e: o.e, i: o.i, ops: o.ops, launch: o.launch, type: o.type, rcs: o.rcs, mag: o.mag, s1: o.s1, s2: o.s2, s3: o.s3 }; }
export { regime };

// Fresh elements for one object straight from CelesTrak (OMM JSON, full catalogue number). CelesTrak answers the
// same query only once per 2 hours, so the time of each request is remembered.
export async function refreshFromCelesTrak(o) {
  const key = 'ct_' + o.id, last = +(localStorage.getItem(key) || 0);
  if (Date.now() - last < 2 * 3600e3) return { skipped: true, next: last + 2 * 3600e3 };
  try {
    const r = await fetch(`https://celestrak.org/NORAD/elements/gp.php?CATNR=${o.id}&FORMAT=json`);
    localStorage.setItem(key, String(Date.now()));
    const t = await r.text();
    if (!t.startsWith('[')) return { error: t.slice(0, 80) };
    const a = JSON.parse(t)[0]; if (!a) return { error: 'no data' };
    const ep = Date.parse(a.EPOCH + 'Z');
    if (ep <= o.epoch) return { same: true };
    Object.assign(o, { epoch: ep, n: +a.MEAN_MOTION, e: +a.ECCENTRICITY, i: +a.INCLINATION, raan: +a.RA_OF_ASC_NODE, argp: +a.ARG_OF_PERICENTER, M: +a.MEAN_ANOMALY, bstar: +a.BSTAR, ndot: +a.MEAN_MOTION_DOT });
    return { updated: true };
  } catch (e) { return { error: e.message }; }
}
// rough 1-sigma position uncertainty (km) from the age of the elements: LEO drag errors grow fastest
export function uncertaintyKm(o, ms) {
  const days = Math.abs(ms - o.epoch) / 864e5;
  const leo = o.n > 11, low = o.n > 15.3;
  // typical SGP4 + GP element errors: ~1 km at epoch, growing ~1-3 km/day along track in LEO (faster when low and dragged)
  const rate = o.n > 15.6 ? 4 : low ? 2 : leo ? 1.2 : o.n > 1.5 ? 0.5 : 0.3;
  return 1 + rate * days + (o.n > 15.6 ? 0.6 * days * days : low ? 0.15 * days * days : leo ? 0.03 * days * days : 0);
}
