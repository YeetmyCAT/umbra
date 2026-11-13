// Umbra: satellite planetarium. Wires the catalogue, the tracker, the three views and the interface together.
import * as THREE from '../vendor/three.module.min.js';
import { loadCatalog, metaOf, refreshFromCelesTrak, uncertaintyKm, regime } from './catalog.js';
import { Tracker } from './tracker.js';
import { Clock, rateLabel } from './clock.js';
import { Post } from './post.js';
import { GroundView, extinctionMag } from './groundview.js';
import { SpaceView } from './spaceview.js';
import { OrbitView } from './orbitview.js';
import { makeObserver, gmst, DEG, sunTEME } from './frames.js';
import { STATUS, TYPES } from './purpose.js';
import { auroraGrid, kpNow, synthAurora, MAG_AXIS } from './earth.js';
import { sunMoon } from './astro.js';

const $ = id => document.getElementById(id);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const fmtT = (ms, sec = true) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', ...(sec ? { second: '2-digit' } : {}) });
const fmtD = ms => new Date(ms).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
const compass = az => ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][Math.round(az / 22.5) % 16];
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function toast(msg, ms = 3500) { const d = document.createElement('div'); d.className = 'toast'; d.textContent = msg; document.body.appendChild(d); setTimeout(() => d.remove(), ms); }
function progress(msg, f) { $('lmsg').textContent = msg; if (f != null) $('lprog').style.width = (f * 100).toFixed(0) + '%'; }

// iPhone home-screen apps report a shorter innerHeight than the screen under the status bar
function fixAppHeight() { const h = navigator.standalone ? screen.height : innerHeight; document.documentElement.style.setProperty('--appH', h + 'px'); }
fixAppHeight(); addEventListener('resize', fixAppHeight);

const app = window.UM = {
  clock: new Clock(), sel: -1, mode: 'sky', ev: 0, filter: null, gyro: { on: false },
  settings: { lines: true, grid: false, labels: true, labelMag: 4, shadowed: false, aurora: true },
  ui: {},
};
try { Object.assign(app.settings, JSON.parse(localStorage.getItem('um_set') || '{}')); } catch { }
const saveSet = () => { try { localStorage.setItem('um_set', JSON.stringify(app.settings)); } catch { } };

// ---------- overlay canvas ----------
const ovc = $('ov');
app.overlay = {
  ctx: ovc.getContext('2d'),
  begin(w, h) { const d = devicePixelRatio || 1; if (ovc.width !== Math.round(w * d) || ovc.height !== Math.round(h * d)) { ovc.width = Math.round(w * d); ovc.height = Math.round(h * d); } this.ctx.setTransform(d, 0, 0, d, 0, 0); this.ctx.clearRect(0, 0, w, h); },
  end() { },
};

// ---------- place ----------
function setPlace(p, save = true) {
  app.place = p; app.obs = makeObserver(p.lat, p.lon, (p.h || 0) / 1000);
  $('placeTxt').textContent = `${p.name || 'Custom place'} · ${Math.abs(p.lat).toFixed(3)}°${p.lat >= 0 ? 'N' : 'S'} ${Math.abs(p.lon).toFixed(3)}°${p.lon >= 0 ? 'E' : 'W'}`;
  if (app.ground) app.ground.setPlace(app.obs);
  if (save) try { localStorage.setItem('um_place', JSON.stringify(p)); } catch { }
  app.passCache = null;
}
async function elevationAt(lat, lon) { try { const r = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lon}`); const j = await r.json(); return j.elevation && j.elevation[0] != null ? j.elevation[0] : 0; } catch { return 0; } }
function gpsPlace() {
  return new Promise(res => {
    if (!navigator.geolocation) return res(null);
    navigator.geolocation.getCurrentPosition(async p => res({ lat: p.coords.latitude, lon: p.coords.longitude, h: p.coords.altitude ?? await elevationAt(p.coords.latitude, p.coords.longitude), name: 'My location' }), () => res(null), { enableHighAccuracy: true, timeout: 12000, maximumAge: 600000 });
  });
}

// ---------- boot ----------
async function boot() {
  progress('Loading star catalogue…', 0.05);
  const [stars, lines] = await Promise.all([fetch('data/stars.json').then(r => r.json()), fetch('data/constlines.json').then(r => r.json()).catch(() => null)]);
  progress('Loading every tracked object in orbit…', 0.2);
  const cat = await loadCatalog(); app.cat = cat;
  progress(`Starting SGP4 for ${cat.objs.length.toLocaleString()} objects…`, 0.55);
  const T = app.tracker = new Tracker(cat.objs);
  // a second worker for searches (passes, flares, transits) so positions never stall
  app.search = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  const { elementsArray } = await import('./catalog.js');
  app.search.postMessage({ cmd: 'init', els: elementsArray(cat.objs) });
  app.search.onmessage = onSearchMsg;
  let p = null; try { p = JSON.parse(localStorage.getItem('um_place') || 'null'); } catch { }
  setPlace(p || { lat: 51.4779, lon: -0.0015, h: 46, name: 'Greenwich' }, !!p);
  if (!p) gpsPlace().then(g => { if (g) setPlace(g); });
  await T.ready;
  progress('Building the sky…', 0.75);
  const canvas = $('gl');
  const R = app.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', alpha: false });
  R.shadowMap.enabled = true; R.shadowMap.type = THREE.PCFSoftShadowMap; R.autoClear = false;
  app.post = new Post(R);
  app.dpr = Math.min(devicePixelRatio || 1, 2);
  app.ground = new GroundView(app, R, { stars, lines }); app.ground.setPlace(app.obs);
  app.space = new SpaceView(app, R, { stars });
  app.orbit = new OrbitView(app, R);
  T.request(app.clock.now(), app.clock.rate);
  bindUI(); bindInput();
  aurora();
  progress('Ready', 1);
  setTimeout(() => { $('loading').style.opacity = 0; setTimeout(() => $('loading').remove(), 600); }, 150);
  const sel = new URLSearchParams(location.search).get('sat'); if (sel) { const o = cat.objs.find(o => String(o.id) === sel); if (o) select(o.idx, true); }
  setInterval(checkCatalog, 30 * 60e3);
  requestAnimationFrame(loop);
}
// newer catalogue (rebuilt every 2 hours on the server): reload elements without a page reload
async function checkCatalog(manual) {
  try {
    const r = await fetch('data/catalog.json', { cache: 'no-cache', method: 'HEAD' });
    const lm = Date.parse(r.headers.get('last-modified') || '');
    if (manual || (lm && lm > app.cat.built + 60e3)) {
      const c = await loadCatalog();
      if (c.built > app.cat.built) {
        const byId = new Map(app.cat.objs.map(o => [o.id, o])), upd = [];
        for (const o of c.objs) { const old = byId.get(o.id); if (old && o.epoch > old.epoch) { Object.assign(old, { epoch: o.epoch, n: o.n, e: o.e, i: o.i, raan: o.raan, argp: o.argp, M: o.M, bstar: o.bstar, ndot: o.ndot }); upd.push(old); } }
        app.tracker.updateElements(upd); app.search.postMessage({ cmd: 'update', list: upd.map(o => ({ idx: o.idx, el: o })) });
        app.cat.built = c.built; toast(`Updated orbits for ${upd.length.toLocaleString()} objects`);
      } else if (manual) toast('Orbital elements are already the newest available');
    }
  } catch { if (manual) toast('Could not check for new elements'); }
  updateCatInfo();
}
function updateCatInfo() {
  const c = app.cat; if (!c) return;
  const age = (Date.now() - c.built) / 3600e3;
  $('catInfo').textContent = `${c.objs.length.toLocaleString()} objects with public orbits · catalogue built ${age < 1 ? Math.round(age * 60) + ' min' : age.toFixed(1) + ' h'} ago (${c.source}). Refreshed every 2 hours, the same cadence as CelesTrak's updates; selecting an object also asks CelesTrak for its newest elements.`;
}
async function aurora() {
  const kp = await kpNow(); app.kp = kp ?? 2.5;
  const g = await auroraGrid();
  const grid = g ? g.grid : synthAurora(app.kp, MAG_AXIS); app.auroraSrc = g ? g.src : `Kp ${app.kp.toFixed(1)} oval`;
  for (const v of [app.space, app.orbit]) { v.earth.setAurora(grid); v.earth.U.uKp.value = app.kp; v.earth.U.uMagAxis.value.set(...MAG_AXIS); }
  setTimeout(aurora, 15 * 60e3);
}

// ---------- frame loop ----------
let last = performance.now(), lastUI = 0, lastPath = 0, lastPl = 0;
function loop() {
  requestAnimationFrame(loop);
  const now = performance.now(), dt = Math.min(0.1, (now - last) / 1000); last = now;
  const ms = app.clock.now(), T = app.tracker;
  const w = innerWidth, h = document.getElementById('stage').clientHeight || innerHeight, dpr = app.dpr;
  const R = app.renderer;
  if (R.domElement.width !== Math.floor(w * dpr) || R.domElement.height !== Math.floor(h * dpr)) { R.setPixelRatio(dpr); R.setSize(w, h, false); }
  app.post.size(Math.floor(w * dpr), Math.floor(h * dpr));
  if (app.clock.jumped) { T.haveAnchor = T.haveAnchor && Math.abs(ms - T.anchorT) < 6 * 3600e3; T.pending = false; }
  T.request(ms, app.clock.rate);
  T.update(ms, app.obs, { mags: app.mode === 'sky', posOnly: app.mode !== 'sky', lazy: app.mode === 'sky', rate: app.clock.rate });
  if (app.mode === 'orbit') litAll(ms);
  if (now - lastPl > 2000) { lastPl = now; planetsTEME(ms); }
  if (app.mode === 'sky') { if (now - lastPath > 1000 || app.clock.jumped) { lastPath = now; app.ground.updatePath(ms); } app.ground.frame(dt, ms, w, h, dpr); }
  else if (app.mode === 'space') { if (!app.space.frame(dt, ms, w, h, dpr)) setMode('sky'); }
  else app.orbit.frame(dt, ms, w, h, dpr);
  app.clock.jumped = false;
  // adaptive resolution: if frames stay slow (phones at 3x pixel density), render fewer pixels
  app.ft = app.ft == null ? dt : app.ft * 0.97 + dt * 0.03;
  if (now - (app.qAt || 0) > 2500) { app.qAt = now; if (app.ft > 0.036 && app.dpr > 1) app.dpr = Math.max(1, app.dpr - 0.25); else if (app.ft < 0.019 && app.dpr < Math.min(devicePixelRatio || 1, 2)) app.dpr = Math.min(Math.min(devicePixelRatio || 1, 2), app.dpr + 0.25); }
  if (now - lastUI > 250) { lastUI = now; uiTick(ms); }
}
function litAll(ms) {
  const T = app.tracker, s = sunTEME(ms); if (!T.litAll) T.litAll = new Float32Array(T.N);
  for (let i = 0; i < T.N; i++) { const x = T.pos[i * 3], y = T.pos[i * 3 + 1], z = T.pos[i * 3 + 2], d = x * s[0] + y * s[1] + z * s[2]; T.litAll[i] = d > 0 || (x * x + y * y + z * z - d * d) > 6378 * 6378 ? 1 : 0; }
}
function planetsTEME(ms) {
  const A = window.Astronomy, t = A.MakeTime(new Date(ms)), rot = A.Rotation_EQJ_EQD(t);
  app.planetsTEME = ['Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune'].map(p => {
    const v = A.RotateVector(rot, A.GeoVector(p, t, true)), l = Math.hypot(v.x, v.y, v.z); let mag = 6; try { mag = A.Illumination(p, t).mag; } catch { }
    return { v: [v.x / l, v.y / l, v.z / l], mag };
  });
  try { app.moonMag = A.Illumination('Moon', t).mag; } catch { app.moonMag = -10; }
}

// ---------- selection & info card ----------
setTimeout(() => { app.select = select; app.setMode = setMode; app.ask = ask; });
function select(i, center) {
  const T = app.tracker; app.sel = i; T.select(i); app.ground.path = null;
  $('card').classList.toggle('hidden', i < 0); $('cMore').classList.add('hidden'); $('bMore').classList.remove('on');
  app.passCache = null;
  if (i < 0) { app.ground.lock = false; return; }
  const o = T.objs[i];
  $('cName').textContent = o.name;
  $('cSub').textContent = `${TYPES[o.type]} · NORAD ${o.id}${o.cospar ? ' · ' + o.cospar : ''}`;
  if (center) { app.ground.lock = true; }
  $('bLock').classList.toggle('on', app.ground.lock);
  // ask CelesTrak for the newest elements of this object (allowed once per 2 h per object)
  refreshFromCelesTrak(o).then(r => { if (r.updated) { T.updateElements([o]); app.search.postMessage({ cmd: 'update', list: [{ idx: o.idx, el: o }] }); toast(`Newer orbit for ${o.name} from CelesTrak`); } });
  try { history.replaceState(null, '', '?sat=' + o.id); } catch { }
}
function sunState(d) {
  const L = d.Lc || [1, 1, 1];
  if (d.lit <= 0) return d.es > 0.003 ? "Earth's shadow (faint earthshine)" : "In Earth's shadow";
  if (d.lit < 0.995) return `Penumbra ${(d.lit * 100).toFixed(0)} %`;
  if (L[2] < 0.75 * L[0]) return 'Sunlit, reddened (sunrise/sunset on it)';
  return 'Sunlit';
}
function updateCard(ms) {
  const i = app.sel; if (i < 0) return;
  const T = app.tracker, o = T.objs[i], d = T.detail(i, ms, app.obs);
  const hKm = Math.hypot(...d.r) - 6371, sizeAs = T.shape(i).size / 1000 / d.range / DEG * 3600;
  const unc = uncertaintyKm(o, ms);
  const mag = d.mag < 50 ? (d.mag + (d.alt > 0 ? extinctionMag(d.alt) : 0)).toFixed(1) : '—';
  $('cLive').innerHTML = [
    ['Magnitude', mag], ['Altitude', d.alt.toFixed(1) + '°'], ['Azimuth', d.az.toFixed(1) + '° ' + compass(d.az)],
    ['Range', d.range < 1e4 ? d.range.toFixed(0) + ' km' : (d.range / 1000).toFixed(1) + 'k km'], ['Height', hKm.toFixed(0) + ' km'], ['Sun', sunState(d)],
    ['Angular size', sizeAs >= 1 ? sizeAs.toFixed(1) + '″' : (sizeAs * 1000).toFixed(0) + ' mas'], ['Elements', ageTxt(o, ms)], ['Position ±', unc < 10 ? unc.toFixed(1) + ' km' : unc.toFixed(0) + ' km'],
  ].map(([k, v]) => `<div>${k}<b>${esc(v)}</b></div>`).join('');
  $('bLock').classList.toggle('on', app.ground.lock);
}
function ageTxt(o, ms) { const d = (ms - o.epoch) / 864e5; return Math.abs(d) < 1 ? (d * 24).toFixed(1) + ' h old' : d.toFixed(1) + ' d old'; }
function details() {
  const i = app.sel, T = app.tracker, o = T.objs[i], sh = T.shape(i), rg = regime(o), per = 1440 / o.n;
  const tumbleNote = sh.att.mode === 'tumble' ? `Tumbling: expect a flash or brightness swing every ~${Math.round((sh.att.period || 4 + 200 * Math.pow(((Math.sin(o.id * 1.31 * 127.1 + 311.7) * 43758.5453) % 1 + 1) % 1, 2)) / 2)} s (spin estimated; real spin rates are rarely published)` : null;
  const att = { lvlh: 'Earth-pointing (local vertical / local horizontal)', yawsteer: 'Earth-pointing with yaw steering (GNSS)', geo: 'Earth-pointing, arrays turn once a day', inertial: 'Inertially pointed (target unknown, estimated)', tumble: 'Tumbling (uncontrolled), spin estimated' }[sh.att.mode] || sh.att.mode;
  const rows = [
    ['Purpose', o.purpose], ['Operator', o.operator || o.owner || '—'], ['Status', o.type === 0 ? (STATUS[o.ops] || 'Unknown') : (o.type === 2 ? 'Debris' : o.type === 1 ? 'Spent stage' : 'Unknown')], ['Owner (country/org)', o.owner || '—'], ['Launched', o.launch || '—'],
    ['Orbit', rg.name], ['Perigee × apogee', `${rg.hp.toFixed(0)} × ${rg.ha.toFixed(0)} km`], ['Inclination', o.i.toFixed(2) + '°'], ['Period', per < 120 ? per.toFixed(1) + ' min' : (per / 60).toFixed(2) + ' h'], ['Eccentricity', o.e.toFixed(5)],
    ['Radar cross section', o.rcs != null ? o.rcs + ' m²' : '—'], ['Standard magnitude', o.mag != null ? o.mag.toFixed(1) + ' (McCants)' : 'estimated from size'],
    ['3D model', `${sh.label} — ${sh.known === 'exact' ? 'real shape' : sh.known === 'class' ? 'typical of its class' : sh.known === 'debris' ? 'fragment of its estimated size' : 'no information: generic'}`], ['Size', sh.size.toFixed(sh.size < 1 ? 2 : 1) + ' m'], ['Attitude', att],
    ['Element epoch', new Date(o.epoch).toISOString().replace('T', ' ').slice(0, 19) + ' UTC'],
  ];
  if (tumbleNote) rows.push(['Flashing', tumbleNote]);
  if (o.note) rows.push(['Notes', o.note]);
  if (T.docked && T.docked[i] >= 0) rows.unshift(['Docked', 'Attached to ' + T.objs[T.docked[i]].name + ' (drawn as part of it)']);
  let html = '<table>' + rows.map(([k, v]) => `<tr><td>${k}</td><td>${esc(v)}</td></tr>`).join('') + '</table>';
  html += '<h4>Upcoming passes</h4><div id="passList" class="note">Computing…</div>';
  $('cMore').innerHTML = html;
  requestPasses();
}
// ---------- searches in the second worker ----------
let reqN = 0; const pending = new Map();
function ask(msg) { return new Promise(res => { const req = ++reqN; pending.set(req, res); app.search.postMessage({ ...msg, req }); }); }
function onSearchMsg(e) {
  const m = e.data;
  if (m.cmd === 'flareProgress' || m.cmd === 'transitProgress') { $('evInfo').textContent = `Searching… ${m.done} of ${m.of}${m.found != null ? ` · ${m.found} found` : ''}`; return; }
  const r = pending.get(m.req); if (r) { pending.delete(m.req); r(m); }
}
async function requestPasses() {
  const i = app.sel, o = app.tracker.objs[i], ms = app.clock.now();
  const days = o.n > 6 ? 10 : 3;
  const m = await ask({ cmd: 'passes', idx: i, meta: metaOf(o), obs: { lat: app.place.lat, lon: app.place.lon, h: (app.place.h || 0) / 1000 }, t0: ms - 600e3, days, max: 30 });
  if (app.sel !== i || !$('passList')) return;
  const ps = m.passes.filter(p => p.set > ms - 300e3);
  if (o.n < 1.5) { $('passList').innerHTML = ps.length && ps[0].risingBefore && ps[0].set >= ms + days * 864e5 - 1e3 ? 'Always above your horizon (high or geosynchronous orbit).' : ps.length ? ps.map(passRow).join('') : 'Never rises at this place.'; return; }
  $('passList').innerHTML = ps.length ? ps.map(passRow).join('') : `No passes in the next ${days} days.`;
  $('passList').querySelectorAll('.item').forEach((el, k) => el.onclick = () => { const p = ps[k]; app.clock.set((p.visStart || p.rise) - 30e3); app.clock.setRate(1); app.ground.lock = true; setMode('sky'); });
}
function passRow(p) {
  const vis = p.visible ? `<span class="m">${p.best < 50 ? p.best.toFixed(1) : '—'}</span>` : '<span class="m dim">not lit</span>';
  return `<div class="item"><span class="n">${fmtD(p.rise)} ${fmtT(p.rise, false)} → ${fmtT(p.set, false)}</span>${vis}<span class="s">rises ${compass(p.azRise)}, max ${p.maxAlt.toFixed(0)}° ${compass(p.azMax)}, sets ${compass(p.azSet)}${p.visible ? ` · visible ${fmtT(p.visStart, false)}–${fmtT(p.visEnd, false)}` : p.sunAlt > -4 ? ' · daylight' : " · in Earth's shadow"}</span></div>`;
}
const obsMsg = () => ({ lat: app.place.lat, lon: app.place.lon, h: (app.place.h || 0) / 1000 });
async function flareSearch(kind) {
  const T = app.tracker, objs = T.objs, ms = app.clock.now();
  let list, hours;
  if (kind === 'geo') { list = objs.filter(o => o.cls === 'geo' && o.type === 0 && o.n > 0.95 && o.n < 1.05 && o.ops !== '-' && o.ops !== 'D'); hours = 24; $('evInfo').textContent = 'GEO glints: sun-tracking arrays reflect sunlight back toward the anti-solar point; strongest within a few weeks of the equinoxes, just outside the Earth\'s shadow.'; }
  else { list = objs.filter(o => o.type === 0 && o.ops !== '-' && o.ops !== 'D' && ['iss', 'css', 'hst', 'iridiumnext', ...($('eStar').checked ? ['starlink'] : []), 'gps', 'galileo', 'glonass', 'beidou', 'oneweb', 'bluebird', 'kuiper', 'qianfan'].includes(o.cls) && T.docked[o.idx] < 0); hours = 12; $('evInfo').textContent = 'Specular flares from flat surfaces (arrays, mirror radiators, antennas, rocket stages), from each object\'s shape and attitude model.'; }
  $('evList').innerHTML = '';
  const m = await ask({ cmd: 'flares', list: list.map(o => ({ idx: o.idx, meta: metaOf(o) })), obs: obsMsg(), t0: ms, hours, limit: 5.5 });
  const L = m.list.slice(0, 400);
  $('evInfo').textContent = `${m.list.length} flare${m.list.length === 1 ? '' : 's'} you could see (dark enough sky, above 8°) in the next ${hours} h (${list.length.toLocaleString()} objects checked). Tracked times are good to a few seconds if the elements are fresh; tumbling objects' timing is a model estimate.`;
  $('evList').innerHTML = L.map(f => `<div class="item" data-i="${f.idx}" data-t="${f.t}"><span class="n">${esc(f.name)}</span><span class="m">${f.mag.toFixed(1)}</span><span class="s">${fmtD(f.t)} ${fmtT(f.t)} · ${f.alt.toFixed(0)}° ${compass(f.az)} · +${(f.base - f.mag).toFixed(1)} mag over normal · ${f.dur.toFixed(f.dur < 10 ? 1 : 0)} s · ${esc(f.model)}</span></div>`).join('') || '<div class="note">None found.</div>';
  bindEventItems();
}
async function transitSearch() {
  const T = app.tracker, ms = app.clock.now();
  const list = T.objs.filter(o => o.cls === 'iss' || o.cls === 'css' || o.cls === 'hst' || o.idx === app.sel);
  $('evInfo').textContent = 'Searching for Sun and Moon transits over 14 days…'; $('evList').innerHTML = '';
  const m = await ask({ cmd: 'transits', list: list.map(o => ({ idx: o.idx, meta: metaOf(o) })), obs: obsMsg(), t0: ms, days: 14 });
  $('evInfo').textContent = `${m.list.length} transit${m.list.length === 1 ? '' : 's'} or near misses (within 0.6°) in 14 days for ${list.map(o => o.name).join(', ')}. Near misses say how far to travel for a central crossing.`;
  $('evList').innerHTML = m.list.map(t => `<div class="item" data-i="${t.idx}" data-t="${t.t}"><span class="n">${t.body === 'Sun' ? '☀' : '☾'} ${esc(t.name)} ${t.inside ? 'crosses the ' + t.body : 'misses the ' + t.body}</span><span class="m">${t.inside ? t.dur.toFixed(2) + ' s' : t.missKm.toFixed(0) + ' km'}</span><span class="s">${fmtD(t.t)} ${fmtT(t.t)} · ${t.sizeArcsec.toFixed(0)}″ silhouette · range ${t.rangeKm.toFixed(0)} km · ${t.inside ? 'centre line ' + t.centreKm.toFixed(1) + ' km away' : 'move ~' + t.centreKm.toFixed(0) + ' km for a central crossing'}</span></div>`).join('') || '<div class="note">None in this period.</div>';
  bindEventItems();
}
async function brightPasses() {
  const T = app.tracker, ms = app.clock.now();
  const list = T.objs.filter(o => o.type !== 2 && o.n > 6 && ((o.mag != null && o.mag < 3.0) || ['iss', 'css', 'hst'].includes(o.cls))).slice(0, 160);
  $('evInfo').textContent = `Checking ${list.length} of the brightest objects for the next 2 days…`; $('evList').innerHTML = '';
  const out = [];
  for (const o of list) { const m = await ask({ cmd: 'passes', idx: o.idx, meta: metaOf(o), obs: obsMsg(), t0: ms, days: 2, max: 12 }); for (const p of m.passes) if (p.visible && p.best < 2.5) out.push({ o, p }); }
  out.sort((a, b) => a.p.visStart - b.p.visStart);
  $('evInfo').textContent = `${out.length} passes brighter than mag 2.5 in the next 2 days.`;
  $('evList').innerHTML = out.map(({ o, p }) => `<div class="item" data-i="${o.idx}" data-t="${p.visStart - 20e3}"><span class="n">${esc(o.name)}</span><span class="m">${p.best.toFixed(1)}</span><span class="s">${fmtD(p.visStart)} ${fmtT(p.visStart, false)}–${fmtT(p.visEnd, false)} · max ${p.maxAlt.toFixed(0)}° ${compass(p.azMax)} · from ${compass(p.azVis0)} to ${compass(p.azVis1)}</span></div>`).join('');
  bindEventItems();
}
function bindEventItems() {
  $('evList').querySelectorAll('.item').forEach(el => el.onclick = () => { const i = +el.dataset.i, t = +el.dataset.t; app.clock.set(t - 15e3); app.clock.setRate(1); select(i, true); setMode('sky'); app.ground.fov = Math.min(app.ground.fov, 60); if (innerWidth < 640) $('panel').classList.add('hidden'); });
}

// ---------- visible list / search ----------
const FILTERS = {
  all: null, bright: i => app.tracker.mag[i] < 3.5,
  stations: i => ['iss', 'css', 'dockedmodule', 'dragon', 'soyuz', 'cygnus', 'tianzhou'].includes(app.tracker.objs[i].cls),
  starlink: i => app.tracker.objs[i].cls === 'starlink', sci: i => ['hst', 'science'].includes(app.tracker.objs[i].cls),
  nav: i => ['gps', 'glonass', 'galileo', 'beidou'].includes(app.tracker.objs[i].cls), geo: i => { const o = app.tracker.objs[i]; return o.n > 0.9 && o.n < 1.1; },
  rb: i => app.tracker.objs[i].type === 1, debris: i => app.tracker.objs[i].type === 2,
};
function visibleList() {
  const T = app.tracker, g = app.ground, lim = g.limitMag ? g.limitMag() : 6, out = [];
  for (let i = 0; i < T.N; i++) {
    if (T.alt[i] < 0) continue; if (app.filter && !app.filter(i)) continue;
    const m = T.mag[i] < 50 ? T.mag[i] + extinctionMag(T.alt[i]) : 99;
    if (m > lim + 2 && !app.settings.shadowed) continue;
    out.push([m, i]);
  }
  out.sort((a, b) => a[0] - b[0]);
  $('visCount').textContent = `${out.length.toLocaleString()} above the horizon${app.settings.shadowed ? '' : ' and lit'} · naked-eye limit ${lim.toFixed(1)}`;
  const html = out.slice(0, 250).map(([m, i]) => { const o = T.objs[i]; return `<div class="item${i === app.sel ? ' sel' : ''}" data-i="${i}"><span class="n">${esc(o.name)}</span><span class="m${m > 50 ? ' dim' : ''}">${m < 50 ? m.toFixed(1) : 'shadow'}</span><span class="s">${T.alt[i].toFixed(0)}° ${compass(T.az[i])} · ${T.range[i].toFixed(0)} km · ${esc(o.purpose)}</span></div>`; }).join('');
  $('visList').innerHTML = html;
}
function findList(q) {
  q = q.trim().toUpperCase(); if (!q) { $('findList').innerHTML = ''; return; }
  const T = app.tracker, out = [];
  for (const o of T.objs) { if (String(o.id) === q || o.cospar === q || o.nameU.includes(q)) out.push(o); if (out.length > 150) break; }
  out.sort((a, b) => (a.nameU.startsWith(q) ? 0 : 1) - (b.nameU.startsWith(q) ? 0 : 1));
  $('findList').innerHTML = out.map(o => `<div class="item" data-i="${o.idx}"><span class="n">${esc(o.name)}</span><span class="m dim">${o.id}</span><span class="s">${TYPES[o.type]} · ${esc(o.purpose)} · ${T.alt[o.idx] > 0 ? 'up now ' + T.alt[o.idx].toFixed(0) + '°' : 'below horizon'}</span></div>`).join('') || '<div class="note">No match.</div>';
}

// ---------- UI ----------
function setMode(m) {
  if (m === 'space' && app.sel < 0) { toast('Select a satellite first (tap it in the sky or pick one from the list)'); return; }
  app.mode = m; document.querySelectorAll('#modeSeg button').forEach(b => b.classList.toggle('on', b.dataset.mode === m));
  $('gyroBtn').style.visibility = m === 'sky' ? 'visible' : 'hidden';
}
function uiTick(ms) {
  const d = new Date(ms);
  $('timeTxt').textContent = `${d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
  $('rate').textContent = rateLabel(app.clock.rate); $('tPlay').textContent = app.clock.rate === 0 ? '▶' : '⏸';
  $('tNow').style.opacity = app.clock.live() ? 0.45 : 1;
  updateCard(ms);
  if (!$('panel').classList.contains('hidden') && !$('tab-vis').classList.contains('hidden') && (app.uiN = (app.uiN || 0) + 1) % 4 === 0) visibleList();
}
function bindUI() {
  document.querySelectorAll('#modeSeg button').forEach(b => b.onclick = () => setMode(b.dataset.mode));
  $('tSlow').onclick = () => app.clock.step(-1); $('tFast').onclick = () => app.clock.step(1);
  $('tPlay').onclick = () => app.clock.setRate(app.clock.rate === 0 ? 1 : 0); $('tNow').onclick = () => app.clock.toNow();
  $('listBtn').onclick = () => { $('panel').classList.toggle('hidden'); visibleList(); };
  $('pClose').onclick = () => $('panel').classList.add('hidden');
  document.querySelectorAll('#tabs button[data-tab]').forEach(b => b.onclick = () => { document.querySelectorAll('#tabs button[data-tab]').forEach(x => x.classList.toggle('on', x === b)); document.querySelectorAll('.tab').forEach(t => t.classList.toggle('hidden', t.id !== 'tab-' + b.dataset.tab)); if (b.dataset.tab === 'vis') visibleList(); if (b.dataset.tab === 'find') $('q').focus(); if (b.dataset.tab === 'set') updateCatInfo(); });
  document.querySelectorAll('#filters button').forEach(b => b.onclick = () => { document.querySelectorAll('#filters button').forEach(x => x.classList.toggle('on', x === b)); app.filter = FILTERS[b.dataset.f]; visibleList(); });
  const listClick = e => { const it = e.target.closest('.item'); if (!it || it.dataset.i == null) return; select(+it.dataset.i, true); if (innerWidth < 640) $('panel').classList.add('hidden'); };
  $('visList').onclick = listClick; $('findList').onclick = listClick;
  $('q').oninput = () => findList($('q').value);
  $('showShadow').checked = app.settings.shadowed; $('showShadow').onchange = () => { app.settings.shadowed = $('showShadow').checked; saveSet(); visibleList(); };
  document.querySelector('.cardHead > div').onclick = () => $('card').classList.toggle('mini');
  $('cClose').onclick = () => { select(-1); if (app.mode === 'space') setMode('sky'); try { history.replaceState(null, '', location.pathname); } catch { } };
  $('bLock').onclick = () => { app.ground.lock = !app.ground.lock; $('bLock').classList.toggle('on', app.ground.lock); if (app.mode !== 'sky') setMode('sky'); };
  $('bZoom').onclick = () => { // zoom so the object fills ~40 % of the view (its true angular size)
    const T = app.tracker, i = app.sel; if (i < 0) return; setMode('sky'); app.ground.lock = true;
    const ang = T.shape(i).size / 1000 / T.range[i] / DEG; app.ground.fov = clamp(ang / 0.35, 0.0015, 75); };
  $('bSpace').onclick = () => setMode('space');
  $('bPasses').onclick = () => { $('cMore').classList.remove('hidden'); $('bMore').classList.add('on'); details(); setTimeout(() => $('passList') && $('passList').scrollIntoView({ block: 'nearest' }), 50); };
  $('bMore').onclick = () => { const h = !$('cMore').classList.contains('hidden'); $('cMore').classList.toggle('hidden', h); $('bMore').classList.toggle('on', !h); if (!h) details(); };
  $('eFlares').onclick = () => flareSearch('all'); $('eGeo').onclick = () => flareSearch('geo'); $('eTransits').onclick = transitSearch; $('eBright').onclick = brightPasses;
  // settings
  const S = app.settings, bindChk = (id, k) => { $(id).checked = S[k]; $(id).onchange = () => { S[k] = $(id).checked; saveSet(); }; };
  bindChk('sLines', 'lines'); bindChk('sGrid', 'grid'); bindChk('sLabels', 'labels');
  $('sAurora').checked = S.aurora; $('sAurora').onchange = () => { S.aurora = $('sAurora').checked; saveSet(); app.space.earth.U.uAurOn.value = app.orbit.earth.U.uAurOn.value = S.aurora ? 1 : 0; };
  $('sLabelMag').value = S.labelMag; $('sLabelMagV').textContent = S.labelMag; $('sLabelMag').oninput = () => { S.labelMag = +$('sLabelMag').value; $('sLabelMagV').textContent = S.labelMag; saveSet(); };
  $('sEv').oninput = () => { app.ev = app.ground.ev = +$('sEv').value; $('sEvV').textContent = app.ev; };
  $('sRefresh').onclick = () => checkCatalog(true);
  app.gyro.cal = +(localStorage.getItem('um_gyrocal') || 0);
  const showCal = () => { $('sCalV').textContent = (app.gyro.cal > 0 ? '+' : '') + app.gyro.cal.toFixed(1) + '°'; };
  $('sCal').value = app.gyro.cal; showCal();
  $('sCal').oninput = () => { app.gyro.cal = +$('sCal').value; showCal(); try { localStorage.setItem('um_gyrocal', app.gyro.cal); } catch { } };
  $('sCal0').onclick = () => { app.gyro.cal = 0; $('sCal').value = 0; showCal(); try { localStorage.setItem('um_gyrocal', 0); } catch { } };
  $('placeBtn').onclick = placeDialog; $('timeBtn').onclick = timeDialog;
  $('gyroBtn').onclick = toggleGyro;
}
function modal(html) { $('sheet').innerHTML = html; $('modal').classList.remove('hidden'); $('modal').onclick = e => { if (e.target.id === 'modal') closeModal(); }; }
function closeModal() { $('modal').classList.add('hidden'); if (app.map) { app.map.remove(); app.map = null; } }
function placeDialog() {
  const p = app.place;
  modal(`<h3>Location</h3>
    <div class="rowf"><input type="search" id="pq" placeholder="Search a place"><button class="btn" id="pgo">Search</button><button class="btn" id="pgps">⌖ GPS</button></div>
    <div id="pres"></div><div id="map"></div>
    <div class="rowf">Lat <input type="number" id="plat" step="0.0001" value="${p.lat.toFixed(5)}"> Lon <input type="number" id="plon" step="0.0001" value="${p.lon.toFixed(5)}"> Height m <input type="number" id="ph" step="1" value="${Math.round(p.h || 0)}"></div>
    <div class="rowf"><input type="text" id="pname" value="${esc(p.name || '')}" placeholder="Name"><button class="btn on" id="pok">Use this place</button><button class="btn" id="pcancel">Cancel</button></div>
    <div class="note">Tap the map to pick any spot on Earth. Height comes from a terrain model when you pick on the map.</div>`);
  const m = app.map = L.map('map', { worldCopyJump: true }).setView([p.lat, p.lon], 5);
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', { maxZoom: 16, attribution: 'Esri' }).addTo(m);
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}', { maxZoom: 16 }).addTo(m);
  const mk = L.circleMarker([p.lat, p.lon], { radius: 7, color: '#ffc65a' }).addTo(m);
  const put = async (lat, lon, name, h) => { $('plat').value = lat.toFixed(5); $('plon').value = (((lon + 540) % 360) - 180).toFixed(5); mk.setLatLng([lat, lon]); if (name != null) $('pname').value = name; $('ph').value = Math.round(h ?? await elevationAt(lat, lon)); };
  m.on('click', e => put(e.latlng.lat, e.latlng.lng, 'Picked on map'));
  const search = async () => { const q = $('pq').value.trim(); if (!q) return; try { const r = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=6&q=' + encodeURIComponent(q)); const j = await r.json(); $('pres').innerHTML = j.map((x, k) => `<div class="res" data-k="${k}">${esc(x.display_name)}</div>`).join('') || '<div class="note">Nothing found.</div>'; $('pres').querySelectorAll('.res').forEach(el => el.onclick = () => { const x = j[+el.dataset.k]; put(+x.lat, +x.lon, x.display_name.split(',')[0]); m.setView([+x.lat, +x.lon], 10); $('pres').innerHTML = ''; }); } catch { $('pres').textContent = 'Search failed.'; } };
  $('pgo').onclick = search; $('pq').onkeydown = e => { if (e.key === 'Enter') search(); };
  $('pgps').onclick = async () => { const g = await gpsPlace(); if (g) { put(g.lat, g.lon, 'My location', g.h); m.setView([g.lat, g.lon], 11); } else toast('Location unavailable'); };
  $('pok').onclick = () => { setPlace({ lat: +$('plat').value, lon: +$('plon').value, h: +$('ph').value, name: $('pname').value || 'Custom place' }); closeModal(); };
  $('pcancel').onclick = closeModal;
  setTimeout(() => m.invalidateSize(), 50);
}
function timeDialog() {
  const d = new Date(app.clock.now()), pad = n => String(n).padStart(2, '0');
  const loc = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  modal(`<h3>Date and time</h3><div class="rowf"><input type="datetime-local" id="dt" value="${loc}" step="60"></div>
    <div class="rowf"><button class="btn" data-j="-86400">−1 day</button><button class="btn" data-j="-3600">−1 h</button><button class="btn" data-j="3600">+1 h</button><button class="btn" data-j="86400">+1 day</button><button class="btn" data-j="604800">+1 week</button><button class="btn" id="dusk">Tonight at dusk</button></div>
    <div class="rowf"><button class="btn on" id="dok">Go</button><button class="btn" id="dnow">Now</button><button class="btn" id="dcancel">Cancel</button></div>
    <div class="note">Times are shown in this device's time zone. Any date works; predictions far from the elements' epoch get less certain (the info card shows the expected position error).</div>`);
  $('sheet').querySelectorAll('[data-j]').forEach(b => b.onclick = () => { app.clock.set(app.clock.now() + +b.dataset.j * 1000); closeModal(); });
  $('dusk').onclick = () => { const A = window.Astronomy, ob = new A.Observer(app.place.lat, app.place.lon, app.place.h || 0); const t = A.SearchAltitude('Sun', ob, -1, new Date(app.clock.now() - 6 * 3600e3), 2, -8); if (t) app.clock.set(t.date.getTime()); closeModal(); };
  $('dok').onclick = () => { const v = $('dt').value; if (v) app.clock.set(new Date(v).getTime()); closeModal(); };
  $('dnow').onclick = () => { app.clock.toNow(); closeModal(); }; $('dcancel').onclick = closeModal;
}

// ---------- gyroscope / compass ----------
async function toggleGyro() {
  const G = app.gyro;
  if (G.on) { G.on = false; $('gyroBtn').classList.remove('on'); return; }
  try { if (typeof DeviceOrientationEvent !== 'undefined' && DeviceOrientationEvent.requestPermission) { const r = await DeviceOrientationEvent.requestPermission(); if (r !== 'granted') { toast('Motion access was declined'); return; } } } catch { toast('Motion sensors are not available'); return; }
  if (!G.bound) {
    G.bound = true; G.off = null;
    const euler = new THREE.Euler(), q0 = new THREE.Quaternion(), q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5)), zee = new THREE.Vector3(0, 0, 1);
    const fwd = new THREE.Vector3();
    const build = (alpha, e) => {
      const orient = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
      euler.set(e.beta * DEG, alpha * DEG, -e.gamma * DEG, 'YXZ');
      return new THREE.Quaternion().setFromEuler(euler).multiply(q1).multiply(q0.setFromAxisAngle(zee, -orient * DEG));
    };
    const handle = (e, absolute) => {
      if (e.alpha == null || e.beta == null) return;
      if (absolute) G.absSeen = true; else if (G.absSeen && e.webkitCompassHeading == null) return;
      let alpha = e.alpha;
      if (e.webkitCompassHeading != null) {
        // iOS: alpha is relative; the compass heading anchors it to north. The heading is only trusted while the phone
        // looks roughly at the horizon (pointing up or down the compass has no meaning and jumps); in between, the
        // last good offset is kept, so moving past the zenith no longer spins the view.
        const raw = build(e.alpha + (G.off || 0), e); fwd.set(0, 0, -1).applyQuaternion(raw);
        const pitch = Math.asin(clamp(fwd.y, -1, 1)) / DEG;
        const acc = e.webkitCompassAccuracy;
        if (Math.abs(pitch) < 50 && acc != null && acc >= 0 && acc < 30) {
          const off = (360 - e.webkitCompassHeading) - e.alpha;
          G.off = G.off == null ? off : G.off + ((((off - G.off) % 360) + 540) % 360 - 180) * 0.02;
        }
        alpha += G.off || 0;
      }
      const q = build(alpha + G.cal, e);
      // smoothing that follows quick turns but removes the sensor's small jitter when holding still
      if (!G.q) G.q = q;
      else { const ang = G.q.angleTo(q); G.q.slerp(q, clamp(ang / 0.06, 0.06, 0.7)); }
    };
    addEventListener('deviceorientationabsolute', e => handle(e, true));
    addEventListener('deviceorientation', e => handle(e, !!e.absolute));
  }
  G.on = true; $('gyroBtn').classList.add('on'); app.ground.lock = false;
  toast('Point your phone at the sky. If it is turned, set the compass correction in Settings (line it up with the Moon or a bright star).', 5000);
}

// ---------- pointer input ----------
function bindInput() {
  const el = $('gl'); const pts = new Map(); let drag = null, pinch = null;
  el.addEventListener('pointerdown', e => {
    el.setPointerCapture(e.pointerId); pts.set(e.pointerId, [e.clientX, e.clientY]);
    drag = { x: e.clientX, y: e.clientY, t: performance.now(), moved: false, yaw: viewYaw(), pitch: viewPitch(), cal: app.gyro.cal || 0 };
    if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), v: zoomVal() }; drag = null; }
  });
  el.addEventListener('pointermove', e => {
    if (!pts.has(e.pointerId)) return; pts.set(e.pointerId, [e.clientX, e.clientY]);
    if (pts.size === 2 && pinch) { const [a, b] = [...pts.values()]; setZoom(pinch.v * pinch.d / Math.max(10, Math.hypot(a[0] - b[0], a[1] - b[1]))); return; }
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y; if (Math.abs(dx) + Math.abs(dy) > 5) drag.moved = true; if (!drag.moved) return;
    if (app.mode === 'sky') {
      const k = app.ground.fov / el.clientHeight;
      if (app.gyro.on) return;   // the phone steers; compass correction is a slider in Settings
      app.ground.lock = false; app.ground.yaw = (drag.yaw - dx * k + 360) % 360; app.ground.pitch = clamp(drag.pitch + dy * k, -89, 89.9);
    } else if (app.mode === 'space') { const s = app.space, k = (s.onboard ? s.fov : 160) / el.clientHeight; s.yaw = drag.yaw - dx * k * (s.onboard ? -1 : 1); s.pitch = clamp(drag.pitch + dy * k * (s.onboard ? -1 : 1), -89, 89); }
    else { const o = app.orbit, k = 180 / el.clientHeight; o.yaw = drag.yaw - dx * k; o.pitch = clamp(drag.pitch + dy * k, -89, 89); }
  });
  const up = e => {
    if (drag && !drag.moved && performance.now() - drag.t < 450) {
      const r = el.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
      if (app.mode === 'sky') { const i = app.ground.pick(x, y, r.width, r.height); if (i >= 0) select(i, false); }
      else if (app.mode === 'orbit') { const i = app.orbit.pick(x, y, r.width, r.height); if (i >= 0) select(i, false); }
    }
    pts.delete(e.pointerId); if (pts.size < 2) pinch = null; drag = null;
  };
  el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  el.addEventListener('wheel', e => { e.preventDefault(); setZoom(zoomVal() * Math.exp(e.deltaY * 0.0012)); }, { passive: false });
  el.addEventListener('dblclick', () => { if (app.mode === 'space') { app.space.onboard = !app.space.onboard; toast(app.space.onboard ? 'On board: looking out from the satellite' : 'Chase camera'); } if (app.mode === 'orbit') app.orbit.follow = !app.orbit.follow; });
  addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT') return;
    if (e.key === ' ') app.clock.setRate(app.clock.rate === 0 ? 1 : 0); else if (e.key === 'l') app.clock.step(1); else if (e.key === 'j') app.clock.step(-1); else if (e.key === 'k') app.clock.toNow();
    else if (e.key === 'Escape') select(-1); else if (e.key === 'o' && app.mode === 'space') app.space.onboard = !app.space.onboard;
  });
}
const viewYaw = () => app.mode === 'sky' ? app.ground.yaw : app.mode === 'space' ? app.space.yaw : app.orbit.yaw;
const viewPitch = () => app.mode === 'sky' ? app.ground.pitch : app.mode === 'space' ? app.space.pitch : app.orbit.pitch;
const zoomVal = () => app.mode === 'sky' ? app.ground.fov : app.mode === 'space' ? (app.space.onboard ? app.space.fov : app.space.dist) : app.orbit.dist;
function setZoom(v) {
  if (app.mode === 'sky') app.ground.fov = clamp(v, 0.0015, 120);
  else if (app.mode === 'space') { if (app.space.onboard) app.space.fov = clamp(v, 5, 110); else app.space.dist = clamp(v, (app.space.shape?.size || 2) * 0.6, 5e5); }
  else app.orbit.dist = clamp(v, 7500, 900000);
}

if ('serviceWorker' in navigator && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') navigator.serviceWorker.register('sw.js').catch(() => { });
boot().catch(e => { console.error(e); progress('Could not start: ' + e.message); });
