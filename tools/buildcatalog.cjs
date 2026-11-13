// Builds data/catalog.json: every tracked object in Earth orbit that has public orbital elements.
//  - Orbital elements (OMM/GP, the modern TLE): CelesTrak. There is no single "everything" feed without a Space-Track
//    login, so the union of several CelesTrak queries is used (active payloads, every "DEB", "R/B" and other names).
//  - Catalogue facts (object type, owner, launch, operational status, radar cross section): CelesTrak SATCAT.
//  - Standard magnitudes and dimensions: Mike McCants' quicksat.mag (intrinsic magnitude at 1000 km, half lit).
// CelesTrak refuses the same query more than once every 2 hours (it answers "GP data has not updated"), so every
// response is cached in tools/cache and reused while it is younger than 2 hours.
//   node tools/buildcatalog.js            (uses the cache when it is fresh)
//   node tools/buildcatalog.js --offline  (only the cache)
const fs = require('fs'), path = require('path'), zlib = require('zlib'), { execSync } = require('child_process');
const ROOT = path.join(__dirname, '..'), CACHE = path.join(__dirname, 'cache'), OUT = path.join(ROOT, 'data', 'catalog.json');
fs.mkdirSync(CACHE, { recursive: true });
const offline = process.argv.includes('--offline');
const UA = { 'User-Agent': 'umbra-satellite-planetarium/1.0 (catalog builder)' };

const GP = ['GROUP=active', 'NAME=DEB', 'NAME=R/B', 'NAME=%20', 'NAME=-', 'NAME=1', 'NAME=O', 'NAME=2', 'NAME=A', 'NAME=E', 'NAME=S', 'GROUP=analyst'];
const key = q => q.replace(/[^A-Za-z0-9]+/g, '_');

async function cached(name, url, maxAgeH, binary) {
  const f = path.join(CACHE, name);
  const age = fs.existsSync(f) ? (Date.now() - fs.statSync(f).mtimeMs) / 3600e3 : 1e9;
  if (offline || age < maxAgeH) return fs.existsSync(f) ? fs.readFileSync(f) : null;
  try {
    const r = await fetch(url, { headers: UA });
    const b = Buffer.from(await r.arrayBuffer());
    const head = b.subarray(0, 200).toString();
    if (!r.ok || /has not updated|Invalid query|No GP data/i.test(head)) {
      console.log('  keep cache for', name, '(', r.status, head.split('\n')[0].slice(0, 70), ')');
      return fs.existsSync(f) ? fs.readFileSync(f) : null;
    }
    fs.writeFileSync(f, b); return b;
  } catch (e) { console.log('  fetch failed', name, e.message); return fs.existsSync(f) ? fs.readFileSync(f) : null; }
}

function csv(text) {
  const L = text.replace(/\r/g, '').trim().split('\n'), h = splitCSV(L[0]);
  return L.slice(1).map(l => { const v = splitCSV(l), o = {}; h.forEach((k, i) => o[k] = v[i]); return o; });
}
function splitCSV(l) { const out = []; let cur = '', q = false; for (const c of l) { if (c === '"') q = !q; else if (c === ',' && !q) { out.push(cur); cur = ''; } else cur += c; } out.push(cur); return out; }

(async () => {
  const gp = new Map();
  for (const q of GP) {
    const b = await cached('gp_' + key(q) + '.csv', `https://celestrak.org/NORAD/elements/gp.php?${q}&FORMAT=csv`, 2);
    if (!b) { console.log('no data for', q); continue; }
    let rows = []; try { rows = csv(b.toString()); } catch { }
    let n = 0; for (const r of rows) { if (!r.NORAD_CAT_ID || !r.MEAN_MOTION) continue; const id = +r.NORAD_CAT_ID, o = gp.get(id); if (!o || o.EPOCH < r.EPOCH) { gp.set(id, r); n++; } }
    console.log(q.padEnd(16), rows.length, 'rows', n, 'new/updated');
    await new Promise(r => setTimeout(r, 1500));   // be gentle with CelesTrak
  }
  const sc = new Map();
  const scb = await cached('satcat.csv', 'https://celestrak.org/pub/satcat.csv', 20);
  if (scb) for (const r of csv(scb.toString())) sc.set(+r.NORAD_CAT_ID, r);
  // McCants quicksat.mag (fixed-width): id, intl desig, name, std mag, sizes (m), RCS, comments
  const qs = new Map();
  let qtxt = null;
  const qz = await cached('qsmag.zip', 'https://www.mmccants.org/programs/qsmag.zip', 24 * 7);
  if (qz) { try { const d = path.join(CACHE, 'qs'); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'q.zip'), qz); execSync('unzip -o -q q.zip', { cwd: d }); qtxt = fs.readFileSync(path.join(d, 'quicksat.mag'), 'latin1'); } catch (e) { console.log('qsmag unzip failed', e.message); } }
  if (qtxt) for (const l of qtxt.split(/\r?\n/).slice(1)) {
    const id = +l.slice(0, 5); if (!id) continue;
    const num = s => { const v = parseFloat(s); return Number.isFinite(v) ? v : null; };
    qs.set(id, { mag: num(l.slice(33, 38)), s1: num(l.slice(38, 43)), s2: num(l.slice(43, 47)), s3: num(l.slice(47, 51)), note: l.slice(56).trim() });
  }
  console.log('GP objects', gp.size, 'SATCAT', sc.size, 'quicksat', qs.size);
  const F = ['id', 'name', 'cospar', 'epoch', 'n', 'e', 'i', 'raan', 'argp', 'M', 'bstar', 'ndot', 'nddot', 'type', 'ops', 'owner', 'launch', 'rcs', 'mag', 's1', 's2', 's3', 'note'];
  const rows = [];
  for (const [id, r] of gp) {
    const s = sc.get(id) || {}, q = qs.get(id) || {};
    if (s.DECAY_DATE) continue;
    if (s.ORBIT_CENTER && s.ORBIT_CENTER !== 'EA') continue;
    const n = +r.MEAN_MOTION; if (!(n > 0.05)) continue;
    const ep = Date.parse(r.EPOCH + 'Z');
    const typ = { PAY: 0, 'R/B': 1, DEB: 2, UNK: 3 }[s.OBJECT_TYPE] ?? (/ DEB/.test(r.OBJECT_NAME) ? 2 : / R\/B/.test(r.OBJECT_NAME) ? 1 : 3);
    const f6 = v => +(+v).toPrecision(9);
    rows.push([id, r.OBJECT_NAME, r.OBJECT_ID, ep, f6(n), f6(r.ECCENTRICITY), f6(r.INCLINATION), f6(r.RA_OF_ASC_NODE), f6(r.ARG_OF_PERICENTER), f6(r.MEAN_ANOMALY),
      +(+r.BSTAR).toPrecision(6), +(+r.MEAN_MOTION_DOT).toPrecision(6), +(+r.MEAN_MOTION_DDOT).toPrecision(6),
      typ, s.OPS_STATUS_CODE || '', s.OWNER || '', s.LAUNCH_DATE || '', s.RCS ? +s.RCS : null, q.mag ?? null, q.s1 ?? null, q.s2 ?? null, q.s3 ?? null, q.note || '']);
  }
  rows.sort((a, b) => a[0] - b[0]);
  const out = JSON.stringify({ built: Date.now(), source: 'CelesTrak GP + SATCAT, McCants quicksat.mag', fields: F, rows });
  fs.writeFileSync(OUT, out);
  console.log('wrote', OUT, rows.length, 'objects', (out.length / 1e6).toFixed(2), 'MB,', (zlib.gzipSync(out).length / 1e6).toFixed(2), 'MB gzipped');
  const byType = [0, 0, 0, 0]; rows.forEach(r => byType[r[13]]++); console.log('payload, rocket body, debris, unknown:', byType.join(', '));
})();
