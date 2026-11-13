// Satellite photometry, shared by the page and the prediction worker.
//  * Sunlight on the satellite: the fraction of the Sun's disc not hidden by the Earth (penumbra), and for light that
//    grazes the atmosphere on its way, its reddened transmission (satellites go orange/red as they enter the shadow).
//  * Brightness: either a facet model of the real shape (diffuse + specular lobes per surface, panels that track
//    the Sun, the attitude the spacecraft keeps), which is also what makes flares and glints, or for objects with no
//    known shape a diffuse sphere scaled to the object's standard magnitude (McCants: at 1000 km, 90 deg phase).
import { RE, DEG, dot, cross, norm } from './frames.js';

export const SUN_MAG = -26.74;
const R_SUN = 696000;
const R_SHADOW = RE + 12;          // ground, clouds and the dense lower air block the Sun completely below ~12 km

// circle overlap area (unit-free) of radii a, b with centres d apart
function overlap(a, b, d) {
  if (d >= a + b) return 0;
  if (d <= Math.abs(a - b)) return Math.PI * Math.min(a, b) ** 2;
  const a2 = a * a, b2 = b * b;
  const x = (d * d + a2 - b2) / (2 * d);
  return a2 * Math.acos(Math.max(-1, Math.min(1, x / a))) + b2 * Math.acos(Math.max(-1, Math.min(1, (d - x) / b))) - Math.sqrt(Math.max(0, (-d + a + b) * (d + a - b) * (d - a + b) * (d + a + b))) / 2;
}
// Sunlight reaching a satellite at r (km, geocentric) with the Sun along unit s at distance sd (km).
// Returns [R, G, B] multipliers (1 = full sunlight) in out; out.f = geometric fraction of the solar disc visible.
export function sunlight(r, s, sd, out = [1, 1, 1]) {
  const rm = Math.hypot(r[0], r[1], r[2]);
  const cosA = -dot(r, s) / rm;                 // angle between the Sun and the Earth's centre seen from the satellite
  const th = Math.acos(Math.max(-1, Math.min(1, cosA)));
  const aS = Math.asin(Math.min(1, R_SUN / sd)), aE = Math.asin(Math.min(1, R_SHADOW / rm));
  let f = 1;
  if (th < aS + aE) f = 1 - overlap(aS, aE, th) / (Math.PI * aS * aS);
  out.f = f;
  if (f <= 0) { out[0] = out[1] = out[2] = 0; return out; }
  // grazing height of the ray to the Sun's centre (only when the Earth is in front of the Sun's direction)
  let T0 = 1, T1 = 1, T2 = 1;
  if (cosA > 0) {
    const hg = rm * Math.sin(th) - RE;
    if (hg < 120) {
      // slant optical depth through a 8 km scale-height atmosphere (Rayleigh) plus 1.2 km aerosol layer, both ways
      // of the tangent point: tau = tau_zenith * exp(-h/H) * sqrt(2 pi R / H)
      const h = Math.max(hg, 0), xr = Math.exp(-h / 8) * Math.sqrt(2 * Math.PI * RE / 8), xa = Math.exp(-h / 1.2) * Math.sqrt(2 * Math.PI * RE / 1.2);
      T0 = Math.exp(-(0.10 * xr + 0.12 * xa) * 1.0); T1 = Math.exp(-(0.17 * xr + 0.13 * xa) * 1.0); T2 = Math.exp(-(0.33 * xr + 0.14 * xa) * 1.0);
      // ozone (Chappuis) takes some orange and keeps a little blue at the shadow's edge
      const oz = Math.exp(-0.035 * Math.exp(-Math.abs(h - 25) / 12) * 18); T1 *= oz; T0 *= Math.sqrt(oz);
      // refraction spreads the grazing light out, dimming it further
      const spread = 1 / (1 + 6 * Math.exp(-h / 8)); T0 *= spread; T1 *= spread; T2 *= spread;
    }
  }
  out[0] = f * T0; out[1] = f * T1; out[2] = f * T2;
  return out;
}

// Earthshine: sunlight reflected by the Earth (albedo ~0.3, clouds included) lighting the satellite from below.
// Irradiance (fraction of direct sunlight) on a surface facing the Earth: pi * L * sin^2(angular radius), with the
// Earth's radiance averaged over the part of its disc the satellite sees (the sunlit share of that cap, cosine of the
// Sun's height there). Low orbits get ~25 % of full sunlight on their undersides in daytime; it fades across the
// terminator, which is why satellites don't wink out instantly at shadow entry.
export function earthshine(r, s) {
  const rm = Math.hypot(r[0], r[1], r[2]);
  const sinE = Math.min(1, RE / rm), thC = Math.acos(sinE);           // cap half-angle at the Earth's centre
  const cb = (r[0] * s[0] + r[1] * s[1] + r[2] * s[2]) / rm, beta = Math.acos(Math.max(-1, Math.min(1, cb)));
  let g = 0;
  for (let k = -4; k <= 4; k++) { const d = beta + k / 4 * thC * 0.75; g += Math.max(0, Math.cos(d)) * (1 - 0.5 * Math.abs(k) / 4); }
  g /= 6.0;
  return 0.30 * g * sinE * sinE;
}
// diffuse-only intensity of the facets lit from direction e (the Earth below) with relative irradiance w
export function facetsEarthshine(facets, B, e, o, sunB, w) {
  if (w <= 1e-5) return 0;
  const eb = [dot(B.x, e), dot(B.y, e), dot(B.z, e)], ob = [dot(B.x, o), dot(B.y, o), dot(B.z, o)];
  let I = 0;
  for (const f of facets) {
    const n = f.track ? panelNormal(f, sunB) : f.n;
    for (let side = 0; side < (f.back ? 2 : 1); side++) {
      const sg = side ? -1 : 1, m = side ? f.back : f.m;
      const ci = sg * (n[0] * eb[0] + n[1] * eb[1] + n[2] * eb[2]), co = sg * (n[0] * ob[0] + n[1] * ob[1] + n[2] * ob[2]);
      // the Earth is a wide source: count it from half a hemisphere around the surface normal
      const ciw = Math.max(0, 0.5 + 0.5 * ci);
      if (co > 0) I += (m.kd + m.ks * 0.5) / Math.PI * ciw * co * f.a;
    }
  }
  return I * w;
}
// Lambert sphere phase function normalised to 1 at 90 deg phase
export function spherePhase(phi) { return (Math.sin(phi) + (Math.PI - phi) * Math.cos(phi)) / 1.0; }

// ---------------- facet model ----------------
// Materials: kd diffuse albedo, ks specular reflectance, sig lobe width (rad) from surface roughness/warping.
export const MAT = {
  cell: { kd: 0.04, ks: 0.06, sig: 0.025 },     // solar cell cover glass
  cellGold: { kd: 0.15, ks: 0.10, sig: 0.05 },   // ISS-style arrays (golden-brown blankets)
  cellBack: { kd: 0.38, ks: 0.05, sig: 0.4 },
  cellBackDark: { kd: 0.07, ks: 0.05, sig: 0.3 },
  mliGold: { kd: 0.22, ks: 0.28, sig: 0.32 },   // crinkled kapton/aluminised MLI
  mliSilver: { kd: 0.42, ks: 0.32, sig: 0.25 },
  beta: { kd: 0.72, ks: 0.04, sig: 0.6 },       // white beta cloth
  white: { kd: 0.78, ks: 0.04, sig: 0.6 },
  alu: { kd: 0.25, ks: 0.5, sig: 0.12 },
  osr: { kd: 0.05, ks: 0.85, sig: 0.012 },      // optical solar reflector (mirror) radiators
  dark: { kd: 0.06, ks: 0.04, sig: 0.25 },
  mirrorFilm: { kd: 0.03, ks: 0.4, sig: 0.12 },   // Starlink V2 mini dielectric mirror film: on a bus that isn't optically flat
  grey: { kd: 0.35, ks: 0.08, sig: 0.4 },
  foam: { kd: 0.45, ks: 0.02, sig: 0.6 },       // orange insulation foam
  mma: { kd: 0.04, ks: 0.82, sig: 0.006 },      // silver-Teflon main mission antenna (Iridium block 1)
  truss: { kd: 0.28, ks: 0.1, sig: 0.3 },
};
const SIG_SUN = 0.0033;   // the Sun's disc as a lobe width
// One facet's reflected intensity per unit solar irradiance (m^2/sr), light from s, viewer at o (unit, body/world).
function facetI(n, area, m, s, o, sg = 1) {
  const ci = sg * (n[0] * s[0] + n[1] * s[1] + n[2] * s[2]), co = sg * (n[0] * o[0] + n[1] * o[1] + n[2] * o[2]);
  if (ci <= 0 || co <= 0) return 0;
  let I = m.kd / Math.PI * ci * co * area;
  if (m.ks > 0) {
    const rx = 2 * ci * sg * n[0] - s[0], ry = 2 * ci * sg * n[1] - s[1], rz = 2 * ci * sg * n[2] - s[2];
    const c = Math.max(-1, Math.min(1, rx * o[0] + ry * o[1] + rz * o[2]));
    const sg2 = m.sig * m.sig + SIG_SUN * SIG_SUN;
    const th2 = 2 * (1 - c);   // ~ theta^2
    if (th2 < 30 * sg2) {
      // Fresnel brightening at grazing angles for glassy surfaces is folded into ks
      I += m.ks * ci * area * Math.exp(-th2 / (2 * sg2)) / (2 * Math.PI * sg2);
    }
  }
  return I;
}
// Body frame (unit vectors x, y, z in the reference frame) for an attitude law at time ms.
// r, v: state (km, km/s, TEME); s: Sun unit vector; att: { mode, ... } from the shape.
export function bodyFrame(att, r, v, s, ms, seed, out) {
  const B = out || { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
  const mode = att ? att.mode : 'tumble';
  if (mode === 'lvlh' || mode === 'yawsteer' || mode === 'geo') {
    const z = norm([-r[0], -r[1], -r[2]]), h = norm(cross(r, v));
    let y = [-h[0], -h[1], -h[2]];
    if (mode === 'yawsteer') {
      // GNSS yaw steering: rotate about nadir so the Sun stays in the body x-z plane (panels' axis y stays square to it)
      const sp = norm([s[0] - z[0] * dot(s, z), s[1] - z[1] * dot(s, z), s[2] - z[2] * dot(s, z)]);
      y = norm(cross(z, sp));
    }
    const x = cross(y, z);
    B.x = x; B.y = y; B.z = z; return B;
  }
  if (mode === 'inertial') {
    // fixed pointing (unknown science target): a hashed direction held for hours, kept >60 deg from the Sun
    const blk = Math.floor(ms / 5.4e6);
    let a = hash(seed * 7.1 + blk) * 2 * Math.PI, b = Math.acos(2 * hash(seed * 3.3 + blk * 1.7) - 1);
    let x = [Math.sin(b) * Math.cos(a), Math.sin(b) * Math.sin(a), Math.cos(b)];
    if (dot(x, s) > 0.5) x = norm([x[0] - s[0], x[1] - s[1], x[2] - s[2]]);
    const yv = norm(cross(x, s)); const z = cross(x, yv);
    B.x = x; B.y = yv; B.z = z; return B;
  }
  // tumbling: a spin axis fixed in space (hashed from the catalogue number) and a spin period of seconds to minutes
  const P = att && att.period ? att.period : 4 + 200 * Math.pow(hash(seed * 1.31), 2);
  const ax = norm([hash(seed * 2.1) - 0.5, hash(seed * 4.7) - 0.5, hash(seed * 9.3) - 0.5]);
  const ang = (ms / 1000 / P) * 2 * Math.PI + hash(seed) * 6.28;
  const p = norm(cross(ax, Math.abs(ax[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0])), q = cross(ax, p);
  const c = Math.cos(ang), sn = Math.sin(ang);
  const x = [p[0] * c + q[0] * sn, p[1] * c + q[1] * sn, p[2] * c + q[2] * sn];
  // slight nutation so the light curve isn't perfectly periodic
  const tilt = 0.25 * Math.sin(ang * 0.37 + seed), y0 = [q[0] * c - p[0] * sn, q[1] * c - p[1] * sn, q[2] * c - p[2] * sn];
  const y = norm([y0[0] * Math.cos(tilt) + ax[0] * Math.sin(tilt), y0[1] * Math.cos(tilt) + ax[1] * Math.sin(tilt), y0[2] * Math.cos(tilt) + ax[2] * Math.sin(tilt)]);
  const z = cross(x, y);
  B.x = x; B.y = y; B.z = z; return B;
}
export function hash(x) { const s = Math.sin(x * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); }
const toBody = (B, v, o = [0, 0, 0]) => { o[0] = dot(B.x, v); o[1] = dot(B.y, v); o[2] = dot(B.z, v); return o; };
const _sb = [0, 0, 0], _ob = [0, 0, 0], _pn = [0, 0, 0], _nn = [0, 0, 0];
// panel normal (body frame) for a facet that tracks the Sun: about its axis (1), or fully (2)
export function panelNormal(f, sb, out = [0, 0, 0]) {
  if (f.track === 2) return sb;
  if (f.track === 1) {
    const a = f.ax, k = a[0] * sb[0] + a[1] * sb[1] + a[2] * sb[2];
    const x = sb[0] - a[0] * k, y = sb[1] - a[1] * k, z = sb[2] - a[2] * k, l = Math.sqrt(x * x + y * y + z * z);
    if (l > 1e-6) { out[0] = x / l; out[1] = y / l; out[2] = z / l; return out; }
    return f.n;
  }
  return f.n;
}
// Sum of reflected intensity (m^2/sr per unit irradiance) toward o for the facet list, in the body frame B.
// s and o are unit vectors in the reference frame. Panels that track the Sun reorient here.
export function facetsIntensity(facets, B, s, o) {
  const sb = toBody(B, s, _sb), ob = toBody(B, o, _ob);
  let I = 0;
  for (let i = 0; i < facets.length; i++) {
    const f = facets[i];
    const n = f.track ? panelNormal(f, sb, _pn) : f.n;
    I += facetI(n, f.a, f.m, sb, ob, 1);
    if (f.back) I += facetI(n, f.a, f.back, sb, ob, -1);
  }
  return I;
}
// Apparent visual magnitude from reflected intensity I (m^2/sr per unit irradiance) at range km, with sunlight factor L
export function magFromI(I, rangeKm, L) {
  const v = I * L / (rangeKm * rangeKm * 1e6);
  return v > 0 ? SUN_MAG - 2.5 * Math.log10(v) : 99;
}
// Objects without a model: diffuse sphere with the standard magnitude (1000 km, 90 deg phase)
export function magSphere(std, rangeKm, phi, L) {
  const F = spherePhase(phi);
  if (F <= 1e-6 || L <= 0) return 99;
  return std + 5 * Math.log10(rangeKm / 1000) - 2.5 * Math.log10(F * L);
}
// Standard magnitude from an optical cross-section area (m^2). Calibrated on McCants' values for well-known objects
// (e.g. a 1 m^2 object ~ mag 7.2 at 1000 km, half lit).
export function stdMagFromArea(A) { return 7.2 - 2.5 * Math.log10(Math.max(A, 1e-5)); }
