// Planet discs at their true apparent size, oriented by their IAU poles and rotation, lit from the Sun's real
// direction (phases), with procedural low-resolution surfaces; Saturn's rings; Jupiter's and Saturn's large moons.
import * as THREE from '../vendor/three.module.min.js';
import { COMMON } from './glsl.js';

const A = () => window.Astronomy;
const D2R = Math.PI / 180;
// IAU WGCCRE pole (J2000 RA, Dec) and prime meridian W0 + rate*d (deg), equatorial radius (km), flattening, magnitude
export const PLANET_DATA = {
  Mercury: { ra: 281.0103, dec: 61.4155, w0: 329.5988, wr: 6.1385108, R: 2439.7, f: 0, kind: 0 },
  Venus: { ra: 272.76, dec: 67.16, w0: 160.20, wr: -1.4813688, R: 6051.8, f: 0, kind: 1 },
  Mars: { ra: 317.269, dec: 54.432, w0: 176.049863, wr: 350.891982443297, R: 3396.2, f: 0.00589, kind: 2 },
  Jupiter: { ra: 268.056595, dec: 64.495303, w0: 284.95, wr: 870.536, R: 71492, f: 0.06487, kind: 3 },
  Saturn: { ra: 40.589, dec: 83.537, w0: 38.90, wr: 810.7939024, R: 60268, f: 0.09796, kind: 4 },
  Uranus: { ra: 257.311, dec: -15.175, w0: 203.81, wr: -501.1600928, R: 25559, f: 0.02293, kind: 5 },
  Neptune: { ra: 299.36, dec: 43.46, w0: 249.978, wr: 541.1397757, R: 24764, f: 0.0171, kind: 6 },
};
const NAMES = Object.keys(PLANET_DATA);
const raDec = (ra, de) => [Math.cos(de * D2R) * Math.cos(ra * D2R), Math.cos(de * D2R) * Math.sin(ra * D2R), Math.sin(de * D2R)];
// Saturn's major moons from JPL's mean orbital elements (SAT441, epoch 2000 Jan 1.5 TDB), referred to each moon's
// local Laplace plane (pole RA/Dec in ICRF; the node is measured from that plane's ascending node on the ICRF
// equator). The node regresses and the apsis advances with the listed periods. Good to about a degree of orbit.
// a km, e, w (arg. of periapsis), M, i, node (deg), P (sidereal, days), Pw / Pn (apsis / node precession, years)
const SATURN_MOONS = [
  { name: 'Titan', a: 1221900, e: 0.029, w: 78.3, M: 11.7, i: 0.3, node: 78.6, P: 15.945448, Pw: 346.680, Pn: 687.370, ra: 36.4, dec: 84.0, mag: 8.3 },
  { name: 'Rhea', a: 527200, e: 0.001, w: 44.3, M: 31.5, i: 0.3, node: 133.7, P: 4.517503, Pw: 33.939, Pn: 35.775, ra: 40.6, dec: 83.5, mag: 9.7 },
  { name: 'Dione', a: 377700, e: 0.002, w: 116.0, M: 212.0, i: 0.0, node: 0.0, P: 2.736916, Pw: 11.698, Pn: 0, ra: 40.6, dec: 83.5, mag: 10.4 },
  { name: 'Tethys', a: 295000, e: 0.001, w: 335.3, M: 0.0, i: 1.1, node: 273.0, P: 1.887802, Pw: 0.005, Pn: 4.982, ra: 40.6, dec: 83.5, mag: 10.2 },
  { name: 'Iapetus', a: 3561700, e: 0.028, w: 254.5, M: 74.8, i: 7.6, node: 86.5, P: 79.331002, Pw: 1662.900, Pn: 3130.302, ra: 288.7, dec: 78.9, mag: 11.0 },
];
// position of a moon relative to its planet (km, ICRF/EQJ) at d days after J2000
function moonOffset(s, d) {
  const P = raDec(s.ra, s.dec), X = norm3(cross3([0, 0, 1], P)), Y = cross3(P, X);
  const node = (s.node - (s.Pn ? 360 * d / (s.Pn * 365.25) : 0)) * D2R;
  // the mean longitude advances at the sidereal rate; the longitude of periapsis precesses forward
  const lam0 = s.node + s.w + s.M, lam = (lam0 + 360 * d / s.P) * D2R;
  const varpi = (s.node + s.w + (s.Pw ? 360 * d / (s.Pw * 365.25) : 0)) * D2R + (node - s.node * D2R);
  const M = lam - varpi, e = s.e, w = varpi - node;
  let E = M; for (let k = 0; k < 6; k++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  const nu = 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2)), r = s.a * (1 - e * Math.cos(E));
  const u = nu + w, ci = Math.cos(s.i * D2R), si = Math.sin(s.i * D2R);
  const x = r * (Math.cos(node) * Math.cos(u) - Math.sin(node) * Math.sin(u) * ci), y = r * (Math.sin(node) * Math.cos(u) + Math.cos(node) * Math.sin(u) * ci), z = r * Math.sin(u) * si;
  return [x * X[0] + y * Y[0] + z * P[0], x * X[1] + y * Y[1] + z * P[1], x * X[2] + y * Y[2] + z * P[2]];
}
const GALILEAN = [['io', 'Io', 5.0], ['europa', 'Europa', 5.3], ['ganymede', 'Ganymede', 4.6], ['callisto', 'Callisto', 5.6]];

export class PlanetDiscs {
  constructor(U) {
    this.U = U; this.group = new THREE.Group(); this.discs = {};
    for (const name of NAMES) {
      const u = {
        uP: { value: new THREE.Vector3() }, uPole: { value: new THREE.Vector3(0, 1, 0) }, uSunP: { value: new THREE.Vector3(1, 0, 0) }, uRad: { value: 1e-5 }, uFlat: { value: 0 },
        uW: { value: 0 }, uKind: { value: PLANET_DATA[name].kind }, uLum: { value: 0 }, uQuad: { value: 1 }, uPE: { value: 1 },
      };
      const mat = new THREE.ShaderMaterial({
        uniforms: Object.assign(u, U), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        vertexShader: /* glsl */`
          uniform vec3 uP, uPole; uniform float uRad, uQuad; out vec2 vQ;
          void main(){
            vQ = position.xy*uQuad;
            vec3 f = normalize(uP), up0 = abs(dot(uPole, f)) > 0.999 ? vec3(0.0, 1.0, 0.0) : uPole;
            vec3 r = normalize(cross(f, up0)), u = cross(r, f);
            float s = tan(uRad)*1.0e6*uQuad;
            vec3 w = cameraPosition + f*1.0e6 + (r*position.x + u*position.y)*s;
            gl_Position = projectionMatrix*viewMatrix*vec4(w, 1.0);
          }`,
        fragmentShader: COMMON + /* glsl */`
          in vec2 vQ; uniform vec3 uP, uPole, uSunP; uniform float uRad, uFlat, uW, uKind, uLum, uPE;
          float hh(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y)*p3.z); }
          float nn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0 - 2.0*f); return mix(mix(hh(i), hh(i + vec2(1,0)), f.x), mix(hh(i + vec2(0,1)), hh(i + vec2(1,1)), f.x), f.y); }
          // surface albedo by planet (mean ~1), from planetocentric latitude/longitude
          vec3 surf(float lat, float lon){
            float k = uKind;
            if (k < 0.5) return vec3(0.95, 0.93, 0.9)*(0.85 + 0.3*nn(vec2(lon*6.0, lat*6.0)));                    // Mercury
            if (k < 1.5) return vec3(1.05, 1.0, 0.85)*(0.97 + 0.05*nn(vec2(lon*2.0, lat*3.0)));                  // Venus clouds
            if (k < 2.5) {                                                                                        // Mars
              float d = smoothstep(0.45, 0.65, nn(vec2(lon*3.0, lat*4.0)) * 0.7 + nn(vec2(lon*9.0, lat*9.0))*0.3);
              vec3 c = mix(vec3(1.25, 0.72, 0.45), vec3(0.75, 0.45, 0.32), d);
              return mix(c, vec3(1.6), smoothstep(1.2, 1.32, abs(lat)));
            }
            if (k < 3.5) {                                                                                        // Jupiter
              // the real belt/zone layout: bright equatorial zone, dark North and South Equatorial Belts, tropical zones,
              // temperate belts, greyer polar regions; edges wobble a little
              float L = degrees(lat) + 2.5*(nn(vec2(lon*5.0, lat*30.0)) - 0.5);
              float belt = smoothstep(6.0, 8.0, L)*(1.0 - smoothstep(17.0, 19.5, L))             // NEB
                         + smoothstep(6.0, 8.0, -L)*(1.0 - smoothstep(19.0, 21.5, -L))           // SEB
                         + 0.55*smoothstep(24.0, 26.0, L)*(1.0 - smoothstep(30.0, 32.0, L))       // NTB
                         + 0.5*smoothstep(27.0, 29.0, -L)*(1.0 - smoothstep(33.0, 35.0, -L))      // STB
                         + 0.35*smoothstep(38.0, 50.0, abs(L));                                    // polar regions
              vec3 c = mix(vec3(1.25, 1.12, 0.92), vec3(0.88, 0.58, 0.38), clamp(belt, 0.0, 1.0));
              vec2 g = vec2(mod(lon - 1.2 + 3.14159, 6.28318) - 3.14159, lat + 0.384); float grs = exp(-dot(g/vec2(0.22, 0.09), g/vec2(0.22, 0.09)));
              return mix(c, vec3(1.15, 0.55, 0.38), grs*0.8);
            }
            if (k < 4.5) { float b = sin(lat*10.0 + 0.3*nn(vec2(lon*2.0, lat*12.0))); return mix(vec3(1.12, 1.03, 0.8), vec3(0.92, 0.82, 0.62), smoothstep(-0.3, 0.7, b)); }   // Saturn
            if (k < 5.5) return vec3(0.75, 1.05, 1.1);                                                            // Uranus
            return vec3(0.6, 0.8, 1.25)*(0.95 + 0.1*nn(vec2(lon*3.0, lat*6.0)));                                  // Neptune
          }
          void main(){
            vec3 f = normalize(uP), up0 = abs(dot(uPole, f)) > 0.999 ? vec3(0.0, 1.0, 0.0) : uPole;
            vec3 rr = normalize(cross(f, up0)), uu = cross(rr, f);
            vec2 q = vQ; vec3 col = vec3(0.0);
            // view ray against an oblate spheroid (flattened along the pole) of radius 1
            vec3 ro = -f*10.0 + rr*q.x + uu*q.y, rd = f;
            vec3 Pz = normalize(uPole); float s = 1.0/(1.0 - uFlat);
            vec3 ro2 = ro + Pz*dot(ro, Pz)*(s - 1.0), rd2 = rd + Pz*dot(rd, Pz)*(s - 1.0);
            float a = dot(rd2, rd2), b = dot(ro2, rd2), c = dot(ro2, ro2) - 1.0, disc = b*b - a*c;
            float tP = disc > 0.0 ? (-b - sqrt(disc))/a : 1e9;
            vec3 Ls = normalize(uSunP);
            if (tP < 1e8) {
              vec3 p = ro + rd*tP, n = normalize(p + Pz*dot(p, Pz)*(s*s - 1.0));
              float lat = asin(clamp(dot(normalize(p), Pz), -1.0, 1.0));
              vec3 Q = normalize(cross(Pz, abs(Pz.z) < 0.9 ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0))), S2 = cross(Pz, Q);
              float lon = atan(dot(p, S2), dot(p, Q)) - uW;
              float ci = dot(n, Ls), mu = max(dot(n, -rd), 0.0);
              // Lambert with a little limb darkening for the giants; Saturn's rings cast a shadow band
              float shade = max(ci, 0.0)*(uKind > 2.5 ? pow(mu, 0.15) : 1.0);
              if (uKind > 3.5 && uKind < 4.5) {
                float tr = -dot(p, Pz)/max(abs(dot(Ls, Pz)), 1e-4)*sign(dot(Ls, Pz));
                vec3 pr = p + Ls*tr; float rrn = length(pr);
                if (tr > 0.0 && rrn > 1.24 && rrn < 2.27) shade *= 0.25 + 0.75*smoothstep(1.92, 2.0, rrn)*(1.0 - smoothstep(2.03, 2.1, rrn));
              }
              col = surf(lat, lon)*shade;
            }
            // Saturn's rings: the ring plane, in front of the planet or around it, lit unless in the planet's shadow
            if (uKind > 3.5 && uKind < 4.5) {
              float tr = -dot(ro, Pz)/dot(rd, Pz);
              if (tr > 0.0 && tr < tP) {
                vec3 pr = ro + rd*tr; float rn = length(pr);
                float op = rn < 1.24 ? 0.0 : rn < 1.53 ? 0.12 : rn < 1.95 ? 0.85 : rn < 2.03 ? 0.05 : rn < 2.27 ? 0.55 : 0.0;
                op *= 0.85 + 0.15*sin(rn*90.0);
                // planet shadow on the rings
                float bb = dot(pr, Ls), cc = dot(pr, pr) - 1.0, dd = bb*bb - cc; bool shadowed = dd > 0.0 && -bb + sqrt(dd) > 0.0 && -bb - sqrt(dd) > -1e-3 && bb < 0.0;
                // no sunlight at all in the shadow (Saturn's night side faces it, no light source to fill it)
                float lit = shadowed ? 0.0 : abs(dot(Ls, Pz))*2.0 + 0.1;
                col = mix(col, vec3(1.05, 0.98, 0.85)*lit, op);
              }
            }
            // exposure local to the disc (as a camera on a telescope would set it), never brighter than the sky's own
            gl_FragColor = vec4(min(col*uLum*directT(f.y)*min(uExposure, uPE), vec3(3.0e4)), 1.0);
          }`,
      });
      const m = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat); m.frustumCulled = false; m.renderOrder = -85; m.visible = false;
      this.group.add(m); this.discs[name] = { m, u };
    }
    // moons as points
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9 * 3), 3)); g.setAttribute('mag', new THREE.BufferAttribute(new Float32Array(9).fill(30), 1)); g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(9 * 3).fill(1), 3));
    this.moonPts = g; this.moonLabels = [];
  }
  // date: JS Date; m: J2000 -> world matrix (row-major 9); obsAstro: astronomy-engine Observer; lift(dir) applies refraction
  update(date, m, obsAstro, lift) {
    const Ast = A(), t = Ast.MakeTime(date), d = (date.getTime() - 946728000000) / 864e5;
    const toW = v => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
    const sunG = Ast.GeoVector('Sun', t, true);
    this.info = {};
    // the Sun's true distance and direction from here: a planet is hidden behind it only if farther away (so Mars and
    // the outer planets can never cross it), and only Mercury and Venus can pass in front of it
    const se = Ast.Equator('Sun', date, obsAstro, false, true), sunDist = se.dist * 149597870.7, sV = se.vec ? [se.vec.x, se.vec.y, se.vec.z] : raDec(se.ra * 15, se.dec), sl = Math.hypot(...sV);
    const sunDir = lift(toW(sV.map(x => x / sl))), sunRad = Math.asin(696000 / sunDist);
    const occ = [this.U.uOcc1, this.U.uOcc2]; if (occ[0]) occ.forEach(o => o.value.set(0, 0, 1, 0));
    for (const name of NAMES) {
      const P = PLANET_DATA[name], dsc = this.discs[name];
      // topocentric, light-time corrected position (EQJ, AU)
      const eq = Ast.Equator(name, date, obsAstro, false, true), dist = eq.dist * 149597870.7;
      const vE = eq.vec ? [eq.vec.x, eq.vec.y, eq.vec.z] : raDec(eq.ra * 15, eq.dec), vl = Math.hypot(...vE), dir = toW(vE.map(x => x / vl));
      const pg = Ast.GeoVector(name, t, true);
      const sunP = toW([sunG.x - pg.x, sunG.y - pg.y, sunG.z - pg.z]);
      const rad = Math.atan(P.R / dist);
      let mag = 6; try { mag = Ast.Illumination(name, t).mag; } catch { }
      const ld = lift(dir), u = dsc.u;
      u.uP.value.set(...ld); u.uPole.value.set(...toW(raDec(P.ra, P.dec))); u.uSunP.value.set(...sunP).normalize(); u.uRad.value = rad; u.uFlat.value = P.f;
      u.uW.value = (((P.w0 + P.wr * d) % 360) + 360) % 360 * D2R; u.uQuad.value = name === 'Saturn' ? 2.35 : 1.05;
      // mean disc luminance that reproduces the planet's magnitude: E (lux) spread over the lit disc
      const E = 2.54e-6 * Math.pow(10, -0.4 * mag), phase = Math.acos(Math.max(-1, Math.min(1, -(sunP[0] * dir[0] + sunP[1] * dir[1] + sunP[2] * dir[2]) / Math.hypot(...sunP))));
      const litFrac = Math.max(0.02, (Math.sin(phase) + (Math.PI - phase) * Math.cos(phase)) / Math.PI);   // Lambert sphere relative to full
      u.uLum.value = E / (Math.PI * rad * rad) / litFrac * (name === 'Saturn' ? 0.55 : 1);
      u.uPE.value = 1.3 / Math.max(u.uLum.value, 1e-9);
      const sep = angle(ld, sunDir), near = sep < sunRad + rad, behind = near && dist > sunDist, front = near && dist < sunDist;
      if (front && occ[0] && (name === 'Mercury' || name === 'Venus')) occ[name === 'Mercury' ? 0 : 1].value.set(ld[0], ld[1], ld[2], rad);
      this.info[name] = { dir: ld, dirU: dir, rad, dist, mag, pole: u.uPole.value.clone(), behind, front };
    }
    // Jupiter's Galilean moons (real positions) and Saturn's large moons (approximate, ring plane)
    const P = this.moonPts.attributes.position.array, M = this.moonPts.attributes.mag.array; let k = 0; this.moonLabels = [];
    try {
      const jm = Ast.JupiterMoons(t), ji = this.info.Jupiter, jg = Ast.Equator('Jupiter', date, obsAstro, false, true);
      const jv = jg.vec ? [jg.vec.x, jg.vec.y, jg.vec.z] : raDec(jg.ra * 15, jg.dec);
      for (const [key, nm, mg] of GALILEAN) {
        const s = jm[key], v = [jv[0] + s.x, jv[1] + s.y, jv[2] + s.z], l = Math.hypot(...v), w = toW(v.map(x => x / l));   // true direction (the point shader refracts)
        const behind = l > Math.hypot(...jv) && angle(w, ji.dirU) < ji.rad;   // hidden behind Jupiter
        P.set(w, k * 3); M[k] = behind ? 30 : mg; this.moonLabels.push({ name: nm, dir: w, parent: 'Jupiter' }); k++;
      }
    } catch { }
    {
      // real positions (JPL mean elements), seen at the light-time-corrected instant like the planet itself
      const si = this.info.Saturn, sg = Ast.Equator('Saturn', date, obsAstro, false, true);
      const sv = sg.vec ? [sg.vec.x, sg.vec.y, sg.vec.z] : raDec(sg.ra * 15, sg.dec), svl = Math.hypot(...sv);
      const dl = d - si.dist / 299792.458 / 86400, AUk = 149597870.7;
      for (const s of SATURN_MOONS) {
        const o = moonOffset(s, dl), v = [sv[0] + o[0] / AUk, sv[1] + o[1] / AUk, sv[2] + o[2] / AUk], l = Math.hypot(...v), w = toW(v.map(x => x / l));
        const behind = l > svl && angle(w, si.dirU) < si.rad;   // hidden behind Saturn
        P.set(w, k * 3); M[k] = behind ? 30 : s.mag; this.moonLabels.push({ name: s.name, dir: w, parent: 'Saturn' }); k++;
        if (k >= 9) break;
      }
    }
    this.moonPts.attributes.position.needsUpdate = true; this.moonPts.attributes.mag.needsUpdate = true;
  }
  // show a disc once it is a few pixels across; returns the planets drawn as discs (their points are dimmed)
  frame(pxRad) {
    const out = {};
    for (const name of NAMES) { const dsc = this.discs[name], i = this.info && this.info[name]; if (!i) continue; const px = i.rad / pxRad; dsc.m.visible = px > 1.5 && i.dir[1] > -0.02 && !i.behind; out[name] = i.behind ? 1 : Math.min(1, Math.max(0, (px - 1.5) / 2.5)); }
    return out;
  }
}
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm3 = a => { const l = Math.hypot(...a) || 1; return a.map(x => x / l); };
const angle = (a, b) => Math.acos(Math.max(-1, Math.min(1, dot3(a, b))));
