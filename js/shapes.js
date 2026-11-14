// Shape library: one description per spacecraft type, used both for the 3D model and for the facet photometry
// (flares come from the same surfaces that are drawn). Body frame for attitude-controlled spacecraft:
// x = along-track (forward), y = negative orbit normal (starboard), z = nadir (down). Metres.
// Part kinds: box, cyl (axis 'x'|'y'|'z'), cone (frustum), sphere, dish, panel (solar array), truss.
// A panel: c = centre, a = hinge/rotation axis, n0 = normal at rest, wa x wb size (along a, across), track 0 fixed,
// 1 = turns about a to face the Sun, 2 = two-axis (L = g x sun, normal = sun), g = primary gimbal, piv/off for 2.
import { MAT, hash } from './light.js';

const X = [1, 0, 0], Y = [0, 1, 0], Z = [0, 0, 1], NX = [-1, 0, 0], NY = [0, -1, 0], NZ = [0, 0, -1];
const box = (sx, sy, sz, c, m, extra) => ({ t: 'box', s: [sx, sy, sz], c, m, ...extra });
const cyl = (r, l, ax, c, m, extra) => ({ t: 'cyl', r, l, ax, c, m, ...extra });
const cone = (r1, r2, l, ax, c, m, extra) => ({ t: 'cone', r1, r2, l, ax, c, m, ...extra });
const sph = (r, c, m) => ({ t: 'sphere', r, c, m });
const dish = (r, c, n, m = 'white') => ({ t: 'dish', r, c, n, m });
const truss = (sx, sy, sz, c) => ({ t: 'truss', s: [sx, sy, sz], c, m: 'truss' });
const panel = (o) => ({ t: 'panel', front: 'cell', back: 'cellBack', track: 0, ...o });

// ---------------- crewed stations ----------------
function issParts() {
  const P = [];
  // Integrated truss: S0 at the centre above Destiny, out to S6/P6 (109 m)
  P.push(truss(4.6, 13.4, 3.2, [0, 0, -4.6]));
  for (const sg of [1, -1]) {
    P.push(truss(4.0, 16, 3.0, [0, sg * 14.7, -4.6]));
    P.push(truss(3.6, 10, 2.8, [0, sg * 27.5, -4.6]));
    P.push(truss(3.0, 22, 2.6, [0, sg * 44, -4.6]));
    // four solar array wings per side (P4/P6, S4/S6), two-axis Sun tracking (SARJ about the truss + BGA)
    for (const yy of [37.6, 51.0]) for (const zs of [1, -1]) {
      P.push(panel({ c: [0, sg * yy, -4.6 + zs * 20], piv: [0, sg * yy, -4.6], off: zs * 20, a: Z, n0: X, wa: 34.0, wb: 11.6, track: 2, g: Y, front: 'cellGold', back: 'cellBack', grid: 1 }));
      // iROSA roll-out arrays added 2021-2023, mounted over the inner half of the wings
      P.push(panel({ c: [0, sg * yy, -4.6 + zs * 12], piv: [0, sg * yy, -4.6], off: zs * 12, a: Z, n0: X, wa: 18.3, wb: 6.0, track: 2, g: Y, front: 'cell', back: 'cellBackDark', lift: 0.9 }));
    }
    // photovoltaic radiators at P4/S4 and the big heat-rejection radiators on S1/P1 (kept edge-on to the Sun)
    P.push(panel({ c: [0, sg * 37.6, -1.0], a: Y, n0: X, wa: 3.2, wb: 13, track: 0, front: 'white', back: 'white' }));
    for (const k of [0, 1, 2]) P.push(panel({ c: [-2 - k * 1.2, sg * 15.5, 7 + k * 0.4], a: Y, n0: Z, wa: 3.4, wb: 23.3, track: 0, front: 'white', back: 'white', tilt: 0.5 }));
  }
  // US segment and partners (pressurised modules along x)
  P.push(cyl(2.15, 8.5, 'x', [0, 0, 0], 'beta'));                 // Destiny
  P.push(cyl(2.2, 7.2, 'x', [8.6, 0, 0], 'beta'));                // Harmony
  P.push(cyl(1.0, 2.4, 'x', [13.4, 0, 0], 'alu'));                // PMA-2 / IDA
  P.push(cyl(2.2, 6.9, 'y', [8.6, 5.6, 0], 'beta'));              // Columbus
  P.push(cyl(2.2, 11.2, 'y', [8.6, -7.8, 0], 'beta'));            // Kibo JPM
  P.push(box(4.5, 5.0, 3.8, [8.6, -16, 0], 'white'));            // Kibo exposed facility
  P.push(cyl(2.2, 3.0, 'z', [8.6, -9, -3.4], 'beta'));            // Kibo logistics
  P.push(cyl(2.25, 5.5, 'x', [-7, 0, 0], 'beta'));                // Unity
  P.push(cyl(2.2, 6.7, 'y', [-7, -5.6, 0], 'beta'));              // Tranquility
  P.push(cone(1.5, 1.0, 1.5, 'z', [-7, -6.5, 2.9], 'alu'));      // Cupola
  P.push(cyl(2.2, 6.4, 'z', [-7, 0, 4.8], 'beta'));               // Leonardo PMM
  P.push(cyl(2.0, 5.5, 'y', [-7, 4.6, 0], 'beta'));               // Quest airlock
  P.push(box(2.5, 3.5, 2.0, [-7, 2.2, -3.4], 'beta'));            // BEAM
  // Russian segment aft
  P.push(cyl(2.05, 12.6, 'x', [-16.8, 0, 0], 'white'));           // Zarya
  P.push(cyl(2.07, 13.1, 'x', [-29.6, 0, 0], 'white'));           // Zvezda
  P.push(cyl(1.3, 4.0, 'z', [-25, 0, -3.5], 'white'));            // Poisk
  P.push(cyl(2.1, 13, 'z', [-25, 0, 7.5], 'white'));              // Nauka
  P.push(sph(1.7, [-25, 0, 15], 'white'));                        // Prichal
  P.push(cyl(1.0, 6, 'x', [-38.8, 0, 0], 'grey'));                // docked Progress/Soyuz at the aft port
  for (const sg of [1, -1]) {
    P.push(panel({ c: [-31, sg * 9.5, 0], a: Y, n0: NZ, wa: 12.5, wb: 3.4, track: 1, front: 'cell', back: 'cellBack' }));   // Zvezda arrays
    P.push(panel({ c: [-16, sg * 6.5, 0], a: Y, n0: NZ, wa: 8.0, wb: 3.3, track: 1, front: 'cell', back: 'cellBack' }));    // Zarya arrays (retracted remnants)
  }
  return P;
}
function cssParts() {
  const P = [];
  P.push(cyl(2.1, 10.0, 'x', [-3.5, 0, 0], 'white'));    // Tianhe main cabin
  P.push(cyl(1.4, 4.0, 'x', [3.2, 0, 0], 'white'));      // small cabin
  P.push(sph(1.4, [6.2, 0, 0], 'white'));                // node
  P.push(cyl(1.4, 1.5, 'x', [-9.3, 0, 0], 'grey'));      // aft docking
  for (const sg of [1, -1]) {
    P.push(cyl(2.1, 17.9, 'y', [6.2, sg * 10.4, 0], 'white'));   // Wentian (+y) / Mengtian (-y)
    // each lab carries two large flexible arrays at its far end (~27 m each), turning to track the Sun
    for (const xs of [1, -1]) P.push(panel({ c: [6.2 + xs * 15.5, sg * 17.8, 0], piv: [6.2, sg * 17.8, 0], off: xs * 15.5, a: X, n0: NZ, wa: 27, wb: 4.4, track: 2, g: Y, front: 'cellGold', back: 'cellBack', grid: 1 }));
    P.push(panel({ c: [-6.5, sg * 8.0, 0], a: Y, n0: NZ, wa: 12.0, wb: 2.8, track: 1, front: 'cell', back: 'cellBack' }));   // Tianhe arrays
  }
  P.push(cyl(1.45, 9, 'x', [-14.5, 0, 0], 'white'));    // docked Tianzhou
  P.push(cyl(1.4, 8, 'z', [6.2, 0, 5.5], 'white'));      // docked Shenzhou (nadir)
  return P;
}
function hstParts() {
  return [
    cyl(2.13, 4.4, 'x', [-4.4, 0, 0], 'mliSilver'), cyl(1.55, 8.4, 'x', [2.0, 0, 0], 'mliSilver'),
    cyl(1.6, 0.3, 'x', [6.3, 0, 0], 'alu'), box(0.15, 3.2, 3.2, [6.6, 0, -1.6], 'mliSilver', { door: 1 }),
    box(1.0, 0.8, 0.8, [-2, 0, 2.3], 'alu'), dish(0.7, [-1, 2.6, 0], Y, 'white'), dish(0.7, [-1, -2.6, 0], NY, 'white'),
    panel({ c: [-1.6, 4.9, 0], a: Y, n0: Z, wa: 2.6, wb: 7.1, track: 1, front: 'cell', back: 'cellBack' }),
    panel({ c: [-1.6, -4.9, 0], a: Y, n0: Z, wa: 2.6, wb: 7.1, track: 1, front: 'cell', back: 'cellBack' }),
  ];
}
// ---------------- constellations ----------------
function starlinkParts(gen) {
  if (gen === 'v2') return [   // V2 mini: flat chassis, two arrays, mirror film underneath to send sunlight away from Earth
    box(4.1, 2.7, 0.35, [0, 0, 0], 'dark', { faces: { pz: 'mirrorFilm' } }),
    panel({ c: [8.9, 0, -0.3], a: X, n0: NZ, wa: 12.8, wb: 4.1, track: 1, front: 'cell', back: 'cellBackDark' }),
    panel({ c: [-8.9, 0, -0.3], a: X, n0: NZ, wa: 12.8, wb: 4.1, track: 1, front: 'cell', back: 'cellBackDark' }),
  ];
  return [   // v1.0 / v1.5: flat chassis with one long array (v1.5 adds a dark visor along the sides)
    box(2.8, 1.4, 0.3, [0, 0, 0], gen === 'v1' ? 'alu' : 'dark', { faces: { pz: gen === 'v1' ? 'alu' : 'grey' } }),
    panel({ c: [5.6, 0, -0.25], a: X, n0: NZ, wa: 8.1, wb: 2.8, track: 1, front: 'cell', back: 'cellBack' }),
  ];
}
const onewebParts = () => [box(1.0, 1.0, 1.3, [0, 0, 0], 'mliSilver'), dish(0.25, [0, 0, 0.7], Z),
  panel({ c: [0, 1.6, 0], a: Y, n0: NZ, wa: 2.2, wb: 1.0, track: 1 }), panel({ c: [0, -1.6, 0], a: Y, n0: NZ, wa: 2.2, wb: 1.0, track: 1 })];
const kuiperParts = () => [box(1.5, 2.0, 1.0, [0, 0, 0], 'dark'), panel({ c: [0, 4.5, -0.3], a: Y, n0: NZ, wa: 7, wb: 2.2, track: 1 }), panel({ c: [0, -4.5, -0.3], a: Y, n0: NZ, wa: 7, wb: 2.2, track: 1 })];
const qianfanParts = () => [box(1.8, 1.4, 0.6, [0, 0, 0], 'mliGold'), panel({ c: [0, 3.9, 0], a: Y, n0: NZ, wa: 6, wb: 2.0, track: 1 }), panel({ c: [0, -3.9, 0], a: Y, n0: NZ, wa: 6, wb: 2.0, track: 1 })];
const bluebirdParts = () => [box(8, 8, 0.4, [0, 0, 0], 'dark', { faces: { pz: 'grey', nz: 'cell' } }), box(1.2, 1.2, 1.4, [0, 0, -0.9], 'mliGold')];
const iridiumNextParts = () => [box(3.1, 2.4, 1.5, [0, 0, 0], 'mliSilver'), dish(0.4, [1.2, 0, 0.9], Z),
  panel({ c: [0, 3.2, -0.4], a: Y, n0: NZ, wa: 3.4, wb: 1.6, track: 1 }), panel({ c: [0, -3.2, -0.4], a: Y, n0: NZ, wa: 3.4, wb: 1.6, track: 1 })];
function iridium1Parts() {
  // triangular body with three silver-Teflon main mission antennas (the classic Iridium flare mirrors)
  const P = [cyl(0.9, 4.0, 'z', [0, 0, 0], 'mliSilver')];
  for (let k = 0; k < 3; k++) {
    const a = k * 2.0944, n = [Math.cos(a) * Math.cos(0.7), Math.sin(a) * Math.cos(0.7), Math.sin(0.7)];
    P.push(panel({ c: [Math.cos(a) * 1.1, Math.sin(a) * 1.1, 0.8], a: [-Math.sin(a), Math.cos(a), 0], n0: n, wa: 0.86, wb: 1.88, track: 0, front: 'mma', back: 'grey', rot: 0 }));
  }
  P.push(panel({ c: [0, 0, -3.2], a: Z, n0: X, wa: 3.9, wb: 1.0, track: 0 }));
  return P;
}
function gnss(kind) {
  if (kind === 'glonass') return [cyl(0.65, 2.6, 'z', [0, 0, 0], 'mliGold'), box(1, 1, 0.4, [0, 0, 1.4], 'white'),
    panel({ c: [0, 2.8, 0], a: Y, n0: X, wa: 4.0, wb: 1.4, track: 1 }), panel({ c: [0, -2.8, 0], a: Y, n0: X, wa: 4.0, wb: 1.4, track: 1 })];
  const big = kind === 'gps' ? 2.4 : 2.0;
  return [box(big, big, 2.4, [0, 0, 0], 'mliGold'), box(1.2, 1.2, 0.3, [0, 0, 1.35], 'white'),
    panel({ c: [0, 4.4, 0], a: Y, n0: X, wa: 5.2, wb: 2.6, track: 1 }), panel({ c: [0, -4.4, 0], a: Y, n0: X, wa: 5.2, wb: 2.6, track: 1 })];
}
// geostationary communications bus (A2100/SSL-1300 class): Earth deck down, arrays on the north/south faces turning
// once per day about the north-south axis (orbit normal = body y), OSR mirror radiators on the north/south faces
function geoParts(size = 1) {
  const s = size;
  return [box(2.4 * s, 2.6 * s, 3.4 * s, [0, 0, 0], 'mliGold', { faces: { py: 'osr', ny: 'osr' } }),
    dish(1.2 * s, [1.6 * s, 0, 0.6], X), dish(1.2 * s, [-1.6 * s, 0, 0.6], NX), dish(0.6 * s, [0, 0, 1.9 * s], Z),
    panel({ c: [0, 9.5 * s, 0], a: Y, n0: X, wa: 13 * s, wb: 2.4 * s, track: 1 }), panel({ c: [0, -9.5 * s, 0], a: Y, n0: X, wa: 13 * s, wb: 2.4 * s, track: 1 })];
}
const dragonParts = () => [cone(2.0, 0.9, 3.0, 'x', [1.5, 0, 0], 'white'), cyl(2.0, 2.8, 'x', [-1.4, 0, 0], 'cellGold'), box(0.3, 3.4, 0.4, [-1.4, 0, -1.9], 'white')];
const soyuzParts = () => [sph(1.1, [2.4, 0, 0], 'mliGold'), cone(1.1, 1.36, 2.2, 'x', [0.8, 0, 0], 'mliGold'), cyl(1.36, 2.3, 'x', [-1.5, 0, 0], 'mliGold'),
  panel({ c: [-1.5, 3.9, 0], a: Y, n0: NZ, wa: 4.2, wb: 1.3, track: 0 }), panel({ c: [-1.5, -3.9, 0], a: Y, n0: NZ, wa: 4.2, wb: 1.3, track: 0 })];
const cygnusParts = () => [cyl(1.53, 5.0, 'x', [0, 0, 0], 'white'), cyl(1.4, 1.3, 'x', [-3.1, 0, 0], 'mliGold'),
  panel({ c: [-3.1, 3.9, 0], a: Y, n0: NZ, wa: 3.6, wb: 3.6, track: 1, disc: 1 }), panel({ c: [-3.1, -3.9, 0], a: Y, n0: NZ, wa: 3.6, wb: 3.6, track: 1, disc: 1 })];
const tianzhouParts = () => [cyl(1.67, 10.6, 'x', [0, 0, 0], 'white'), panel({ c: [-3, 4.9, 0], a: Y, n0: NZ, wa: 6.5, wb: 1.9, track: 1 }), panel({ c: [-3, -4.9, 0], a: Y, n0: NZ, wa: 6.5, wb: 1.9, track: 1 })];
const envisatParts = () => [box(10, 2.8, 4.5, [0, 0, 0], 'mliGold'), box(10, 1.3, 0.2, [0, 1.6, 2.4], 'grey'), panel({ c: [-11.5, 0, -1.5], a: X, n0: NZ, wa: 14, wb: 5, track: 0 })];
function eoParts(L = 2, W = 1.5, big = 0) {
  return [box(L, W, W * 1.1, [0, 0, 0], 'mliGold'), cyl(0.35 * W, 0.6 * W, 'z', [L * 0.2, 0, W * 0.75], 'dark'), dish(0.25 * W, [-L * 0.3, 0, W * 0.6], Z),
    panel({ c: [-L * 0.1, W * 0.5 + 0.2 + (2.5 + big) / 2, -W * 0.3], a: Y, n0: NZ, wa: 2.5 + big, wb: L * 0.8, track: 1 })];
}
const sarParts = () => [box(1.0, 0.8, 0.8, [0, 0, -0.4], 'mliGold'), panel({ c: [0, 0, 0.1], a: X, n0: Z, wa: 3.2, wb: 1.6, track: 0, front: 'dark', back: 'cellBack' }),
  panel({ c: [0, 1.2, -0.7], a: Y, n0: NZ, wa: 1.2, wb: 0.8, track: 0 })];
function cubeParts(u = 3, wings = 0) {
  const L = 0.1 * (u === 6 ? 3 : u === 12 ? 3 : u), W = u >= 6 ? 0.22 : 0.1, H = u === 12 ? 0.22 : 0.1;
  const P = [box(L + 0.03, W, H, [0, 0, 0], 'alu', { faces: { py: 'cell', ny: 'cell', nz: 'cell' } })];
  if (wings) for (const s of [1, -1]) P.push(panel({ c: [0, s * (W / 2 + L / 2), 0], a: X, n0: NZ, wa: L, wb: L, track: 0 }));
  return P;
}
function genericPayload(o) {
  // no clue at all: a box bus with two solar wings, scaled to the catalogue size
  const L = o.s1 || (o.rcs ? Math.max(0.5, Math.sqrt(o.rcs) * 1.5) : 2), W = o.s2 || L * 0.7;
  return [box(L, W, W, [0, 0, 0], 'mliGold'), dish(W * 0.3, [0, 0, W * 0.55], Z),
    panel({ c: [0, W / 2 + L * 0.7, 0], a: Y, n0: NZ, wa: L * 1.3, wb: L * 0.6, track: 1 }), panel({ c: [0, -(W / 2 + L * 0.7), 0], a: Y, n0: NZ, wa: L * 1.3, wb: L * 0.6, track: 1 })];
}
// ---------------- rocket bodies ----------------
const RB = [   // name pattern -> [length, diameter, finish]
  [/SL-16|ZENIT/, 11.0, 3.9, 'white'], [/SL-8|COSMOS 3M|KOSMOS 3M/, 6.5, 2.4, 'grey'], [/SL-3/, 3.8, 2.6, 'grey'], [/SL-14|TSYKLON/, 2.7, 2.7, 'grey'],
  [/SL-12|PROTON|BREEZE|BRIZ/, 2.6, 4.0, 'white'], [/SL-4|SOYUZ|FREGAT/, 6.7, 2.66, 'grey'], [/SL-6|MOLNIYA/, 2.8, 2.7, 'grey'],
  [/CZ-2C|CZ-2D/, 7.8, 3.35, 'white'], [/CZ-3/, 12.4, 3.0, 'white'], [/CZ-4/, 5.0, 2.9, 'white'], [/CZ-6/, 7.3, 2.25, 'white'], [/CZ-5/, 11.5, 5.0, 'white'], [/CZ-8/, 7.0, 3.35, 'white'],
  [/FALCON 9|F9/, 13.8, 3.66, 'white'], [/CENTAUR/, 12.7, 3.05, 'alu'], [/DELTA 2|DELTA II/, 6.0, 2.4, 'grey'], [/DELTA 4|DCSS/, 12.0, 4.0, 'foam'],
  [/ATLAS/, 12.7, 3.05, 'alu'], [/ARIANE 5/, 4.7, 5.4, 'white'], [/ARIANE 4|ARIANE 1|ARIANE 3/, 11.6, 2.6, 'white'], [/ARIANE 6/, 5.8, 5.4, 'white'],
  [/H-2A|H-IIA|H-2B|H-3|H3/, 10.7, 4.0, 'white'], [/PSLV/, 2.6, 2.8, 'grey'], [/GSLV/, 8.7, 2.8, 'white'], [/ELECTRON/, 2.4, 1.2, 'dark'],
  [/PEGASUS/, 2.2, 1.0, 'grey'], [/MINOTAUR/, 2.6, 1.2, 'grey'], [/TITAN|TRANSTAGE/, 4.6, 3.05, 'grey'], [/THOR|AGENA/, 6.3, 1.5, 'grey'], [/SCOUT/, 1.5, 0.5, 'grey'],
  [/VEGA|AVUM/, 2.0, 2.2, 'grey'], [/KUAIZHOU|KZ-1/, 2.0, 1.4, 'white'], [/CERES|GALACTIC|ZHUQUE|JIELONG|SMART DRAGON/, 3.0, 2.0, 'white'],
];
function rbParts(o) {
  const nm = o.name || ''; let L = o.s1, D = o.s2, fin = 'white';
  for (const [re, l, d, f] of RB) if (re.test(nm)) { L = L || l; D = D || d; fin = f; break; }
  if (!L) { const A = o.rcs ? Math.max(o.rcs, 0.3) : 8; D = Math.sqrt(A / 3) * 1.2; L = D * 2.6; }
  D = D || L / 3;
  const P = [cyl(D / 2, L, 'x', [0, 0, 0], fin), cyl(D * 0.51, L * 0.04, 'x', [L * 0.3, 0, 0], 'dark'), cyl(D * 0.51, L * 0.03, 'x', [-L * 0.25, 0, 0], 'dark'),
    cone(D * 0.42, D * 0.12, D * 0.55, 'x', [-L / 2 - D * 0.27, 0, 0], 'dark'), cyl(D * 0.5, 0.05 * L, 'x', [L / 2, 0, 0], 'alu')];
  return P;
}
// ---------------- debris ----------------
// Procedural fragments: the size comes from the radar cross section (or catalogue size); the look from what broke up.
function debrisParts(o) {
  const seed = o.id, h = k => hash(seed * 1.7 + k * 13.1);
  const A = o.s1 ? o.s1 * (o.s2 || o.s1 * 0.6) : (o.rcs != null ? Math.max(o.rcs, 0.0004) : 0.02);
  const size = Math.sqrt(A);   // m
  const nm = o.name || '', rocket = /R\/B|CZ-|SL-|DELTA|ATLAS|TITAN|THOR|AGENA|PEGASUS|CENTAUR|ARIANE|PSLV|H-2/.test(nm);
  const P = [];
  if (size < 0.06) {
    // bolts, nuts, springs, clamp pieces
    const k = Math.floor(h(1) * 3);
    if (k === 0) { P.push(cyl(size * 0.12, size, 'x', [0, 0, 0], 'alu')); P.push(cyl(size * 0.26, size * 0.18, 'x', [size * 0.5, 0, 0], 'alu', { hex: 1 })); }
    else if (k === 1) { P.push(cyl(size * 0.4, size * 0.3, 'z', [0, 0, 0], 'alu', { hex: 1 })); }
    else P.push(box(size, size * 0.25, size * 0.08, [0, 0, 0], 'alu', { bend: 0.5 }));
    return { parts: P, kind: k === 0 ? 'bolt' : k === 1 ? 'nut' : 'bracket' };
  }
  if (size < 0.4) {
    // torn sheet or MLI shard, sometimes a bit of solar cell
    const n = 2 + Math.floor(h(2) * 3);
    for (let i = 0; i < n; i++) P.push({ t: 'shard', s: size * (0.5 + h(3 + i) * 0.7), c: [(h(10 + i) - 0.5) * size * 0.5, (h(20 + i) - 0.5) * size * 0.5, (h(30 + i) - 0.5) * size * 0.2], m: rocket ? (h(40 + i) < 0.5 ? 'alu' : 'foam') : (h(40 + i) < 0.35 ? 'mliGold' : h(40 + i) < 0.6 ? 'cell' : 'alu'), seed: seed * 3 + i });
    return { parts: P, kind: rocket ? 'torn rocket skin' : 'satellite fragment (panel/MLI shard)' };
  }
  if (size < 2) {
    // broken box structure with a torn panel stub
    P.push(box(size * 0.7, size * 0.5, size * 0.35, [0, 0, 0], rocket ? 'alu' : 'mliGold', { crumple: 1, seed }));
    if (!rocket) P.push(panel({ c: [0, size * 0.55, 0], a: Y, n0: NZ, wa: size * 0.6, wb: size * 0.4, track: 0, torn: 1, seed }));
    else P.push({ t: 'shard', s: size * 0.6, c: [size * 0.3, 0, 0], m: 'alu', seed });
    return { parts: P, kind: rocket ? 'rocket stage fragment' : 'broken satellite section' };
  }
  P.push(cyl(size * 0.35, size, 'x', [0, 0, 0], rocket ? 'white' : 'mliGold', { torn: 1, seed }));
  P.push({ t: 'shard', s: size * 0.6, c: [size * 0.55, 0, 0], m: 'alu', seed });
  return { parts: P, kind: rocket ? 'large rocket stage section' : 'large satellite section' };
}

// ---------------- selection ----------------
const cache = new Map();
export function shapeFor(o) {
  const opsDead = o.ops === '-' || o.ops === 'D';
  const perObj = opsDead || (o.cls === 'starlink' && o.n > 15.35) || ['debris', 'rb', 'payload', 'unknown', 'eo', 'cube', 'science', 'sphere', 'iridium1', 'envisat'].includes(o.cls);
  const key = perObj ? o.cls + ':' + o.id : o.cls === 'starlink' ? 'starlink:' + (o.launch >= '2023-02' ? 'v2' : o.launch >= '2021-09' ? 'v15' : 'v1') : o.cls + ':' + (o.n < 1.1 ? 'geo' : '');
  if (cache.has(key)) return cache.get(key);
  let parts, label, known = 'exact', att = { mode: 'lvlh' }, kind = '', calMag = 0;
  switch (o.cls) {
    case 'iss': parts = issParts(); label = 'International Space Station'; calMag = -0.6; break;   // matched to observed pass brightness
    case 'css': parts = cssParts(); label = 'Tiangong (China Space Station)'; break;
    case 'dockedmodule': parts = cssParts(); label = 'Tiangong (China Space Station)'; break;
    case 'hst': parts = hstParts(); label = 'Hubble Space Telescope'; att = { mode: 'inertial' }; break;
    case 'starlink': {
      const g = o.launch >= '2023-02' ? 'v2' : o.launch >= '2021-09' ? 'v15' : 'v1'; parts = starlinkParts(g); label = g === 'v2' ? 'Starlink V2 mini' : g === 'v15' ? 'Starlink v1.5' : 'Starlink v1.0';
      // fresh launches raising their orbit fly "open book" (array folded up beside the chassis, low drag): the famous
      // bright trains of the first weeks
      if (o.n > 15.35 && o.launch && Date.now() - Date.parse(o.launch) < 70 * 864e5) {
        parts = parts.map(p => p.t === 'panel' ? { ...p, track: 0, n0: [0, 0.71, -0.71], a: [1, 0, 0] } : p);
        label += ' (orbit raising, "open book" attitude)';
      }
      break;
    }
    case 'oneweb': parts = onewebParts(); label = 'OneWeb satellite'; break;
    case 'kuiper': parts = kuiperParts(); label = 'Project Kuiper satellite (approximate)'; known = 'class'; break;
    case 'qianfan': parts = qianfanParts(); label = 'Chinese broadband constellation satellite (approximate)'; known = 'class'; break;
    case 'bluebird': parts = bluebirdParts(); label = 'AST SpaceMobile BlueBird (phased-array)'; break;
    case 'iridiumnext': parts = iridiumNextParts(); label = 'Iridium NEXT'; break;
    case 'iridium1': parts = iridium1Parts(); label = 'Iridium Block 1 (with flare antennas, tumbling)'; att = { mode: 'tumble', period: 30 + 400 * hash(o.id) }; break;
    case 'gps': parts = gnss('gps'); label = 'GPS satellite'; att = { mode: 'yawsteer' }; break;
    case 'galileo': parts = gnss('galileo'); label = 'Galileo satellite'; att = { mode: 'yawsteer' }; break;
    case 'beidou': parts = o.n < 1.1 ? geoParts(0.8) : gnss('beidou'); label = 'BeiDou satellite'; att = { mode: o.n < 1.1 ? 'geo' : 'yawsteer' }; break;
    case 'glonass': parts = gnss('glonass'); label = 'GLONASS-M satellite'; att = { mode: 'yawsteer' }; break;
    case 'geo': parts = geoParts(1); label = 'Geostationary satellite bus (typical)'; known = 'class'; att = { mode: 'geo' }; break;
    case 'dragon': parts = dragonParts(); label = 'SpaceX Dragon'; break;
    case 'soyuz': parts = soyuzParts(); label = 'Soyuz / Progress / Shenzhou type'; known = 'class'; break;
    case 'cygnus': parts = cygnusParts(); label = 'Cygnus / HTV type cargo ship'; known = 'class'; break;
    case 'tianzhou': parts = tianzhouParts(); label = 'Tianzhou cargo ship'; break;
    case 'envisat': parts = envisatParts(); label = 'Envisat'; att = { mode: 'tumble', period: 120 }; break;
    case 'cube3': parts = cubeParts(3, /LEMUR/.test(o.name) ? 1 : 0); label = '3U CubeSat'; known = 'class'; break;
    case 'cube': { const L = o.s1 || 0.34; parts = cubeParts(L < 0.15 ? 1 : L < 0.4 ? 3 : 6, 1); label = 'CubeSat'; known = 'class'; break; }
    case 'eo': parts = eoParts(o.s1 || 2.5, o.s2 || 1.6, o.s3 || 0); label = 'Earth-observation spacecraft (typical layout)'; known = 'class'; break;
    case 'sar': parts = sarParts(); label = 'Radar imaging microsatellite (typical)'; known = 'class'; break;
    case 'science': parts = eoParts(o.s1 || 3, o.s2 || 2, 1); label = 'Science spacecraft (typical layout)'; known = 'class'; att = { mode: 'inertial' }; break;
    case 'sphere': parts = [sph((o.s1 || 0.6) / 2, [0, 0, 0], /LAGEOS|AJISAI|STARLETTE|LARES|STELLA/.test(o.name) ? 'alu' : 'alu')]; label = 'Sphere'; att = { mode: 'tumble', period: 60 }; break;
    // tumble periods: measured rocket-body light curves (e.g. MMT-9, Silha et al.) mostly show tens of seconds to a few
    // minutes; spread evenly in log between 15 and 300 s
    case 'rb': parts = rbParts(o); label = 'Spent rocket stage'; known = 'class'; att = { mode: 'tumble', period: 15 * Math.pow(20, hash(o.id * 1.31)) }; kind = 'rocket body'; break;
    case 'debris': { const d = debrisParts(o); parts = d.parts; label = 'Debris: ' + d.kind; known = 'debris'; kind = d.kind; att = { mode: 'tumble', period: 3 * Math.pow(100, hash(o.id * 1.31)) }; break; }
    default: parts = genericPayload(o); label = 'Generic satellite (shape not known)'; known = 'generic';
  }
  if (opsDead && att.mode !== 'tumble' && o.cls !== 'iss' && o.cls !== 'css') att = { mode: 'tumble', period: 60 + 600 * hash(o.id * 0.7) };
  // Arrays turn to the Sun only on spacecraft known to do it (and only while they are controlled); everything else
  // keeps its panels fixed to the body
  const TRACKERS = ['iss', 'css', 'dockedmodule', 'hst', 'starlink', 'oneweb', 'iridiumnext', 'gps', 'galileo', 'glonass', 'beidou', 'geo', 'tianzhou'];
  if (!TRACKERS.includes(o.cls) || att.mode === 'tumble') parts = parts.map(p => p.t === 'panel' && p.track ? { ...p, track: 0, c: p.c || p.piv } : p);
  const sh = { key, label, known, att, parts, kind, facets: facetsOf(parts), calK: Math.pow(10, -0.4 * calMag) };
  sh.size = sizeOf(parts);
  cache.set(key, sh);
  return sh;
}
function sizeOf(parts) {
  let r = 0.05;
  for (const p of parts) {
    const c = p.c || [0, 0, 0], d = Math.hypot(...c);
    const e = p.t === 'box' || p.t === 'truss' ? Math.hypot(...p.s) / 2 : p.t === 'cyl' ? Math.hypot(p.r, p.l / 2) : p.t === 'cone' ? Math.hypot(p.r1, p.l / 2) : p.t === 'panel' ? Math.hypot(p.wa, p.wb) / 2 + (p.off ? Math.abs(p.off) : 0) : p.t === 'shard' ? p.s : (p.r || 0.1);
    r = Math.max(r, d + e);
  }
  return r * 2;
}
// Facets for photometry: one per flat face (boxes, panels), 12 per cylinder side, caps, and spheres as diffuse facets.
const AX = { x: X, y: Y, z: Z };
function facetsOf(parts) {
  const F = [], M = n => MAT[n] || MAT[n === 'cellGold' ? 'cell' : 'grey'];
  for (const p of parts) {
    if (p.t === 'box' || p.t === 'truss') {
      const [sx, sy, sz] = p.s, k = p.t === 'truss' ? 0.35 : 1, fm = p.faces || {};
      const add = (n, a, f) => F.push({ n, a: a * k, m: M(fm[f] || p.m) });
      add(X, sy * sz, 'px'); add(NX, sy * sz, 'nx'); add(Y, sx * sz, 'py'); add(NY, sx * sz, 'ny'); add(Z, sx * sy, 'pz'); add(NZ, sx * sy, 'nz');
    } else if (p.t === 'cyl' || p.t === 'cone') {
      // a smooth cylinder: 24 strips whose lobes are wide enough to merge into one continuous highlight (12 narrow
      // strips made a rotating stage flash a dozen times per turn, which real stages don't do)
      const a = AX[p.ax], r = p.t === 'cyl' ? p.r : (p.r1 + p.r2) / 2, l = p.l, N = 24, ms = { ...M(p.m) }; ms.sig = Math.max(ms.sig, 0.17);
      const u = p.ax === 'x' ? Y : X, v = p.ax === 'z' ? Y : Z;
      for (let i = 0; i < N; i++) { const t = i / N * 2 * Math.PI; F.push({ n: [u[0] * Math.cos(t) + v[0] * Math.sin(t), u[1] * Math.cos(t) + v[1] * Math.sin(t), u[2] * Math.cos(t) + v[2] * Math.sin(t)], a: 2 * Math.PI * r * l / N, m: ms }); }
      F.push({ n: a, a: Math.PI * r * r, m: M(p.m) }); F.push({ n: [-a[0], -a[1], -a[2]], a: Math.PI * r * r, m: M(p.m) });
    } else if (p.t === 'sphere') {
      // a sphere reflects like a diffuse sphere plus one tiny specular highlight: 14 facets approximate it
      const dirs = [X, NX, Y, NY, Z, NZ]; for (const s of [-1, 1]) for (const t of [-1, 1]) for (const w of [-1, 1]) dirs.push([s / 1.732, t / 1.732, w / 1.732]);
      for (const n of dirs) F.push({ n, a: 4 * Math.PI * p.r * p.r / 14 * 0.5, m: M(p.m) });
    } else if (p.t === 'dish') F.push({ n: p.n, a: Math.PI * p.r * p.r, m: MAT.white });
    else if (p.t === 'panel') {
      const area = p.wa * p.wb * (p.disc ? 0.785 : 1) * (p.torn ? 0.6 : 1);
      F.push({ n: p.n0, a: area, m: M(p.front), back: M(p.back), track: p.track, ax: p.track === 2 ? null : p.a, g: p.g });
    } else if (p.t === 'shard') {
      // crumpled sheet: a few facets in hashed directions
      for (let i = 0; i < 3; i++) { const n = [hash(p.seed + i) - 0.5, hash(p.seed + i + 9) - 0.5, hash(p.seed + i + 17) - 0.5], l = Math.hypot(...n) || 1; F.push({ n: n.map(c => c / l), a: p.s * p.s * 0.25, m: M(p.m), back: M(p.m) }); }
    }
  }
  return F;
}
