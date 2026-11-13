import { shapeFor } from '../js/shapes.js';
import { modelStd } from '../js/sight.js';
import { facetsIntensity, magFromI, MAT } from '../js/light.js';
const mk = (cls, extra={}) => ({ id: 1, name: 'X', cls, n: 15.5, ops: '+', launch: '2024-01', ...extra });
for (const [c, ex] of [['iss'], ['css'], ['hst'], ['starlink',{launch:'2022-01'}], ['starlink',{launch:'2024-05'}], ['iridiumnext'], ['iridium1'], ['gps'], ['geo'], ['oneweb'], ['rb',{name:'SL-16 R/B', type:1}], ['rb',{name:'CZ-2C R/B',type:1}], ['debris',{rcs:0.003,type:2,id:5}], ['debris',{rcs:0.1,type:2,id:6}], ['debris',{rcs:1.5,type:2,id:7}], ['cube3']]) {
  const sh = shapeFor(mk(c, ex));
  console.log(c.padEnd(12), (ex?.launch||ex?.name||ex?.rcs||'').toString().padEnd(10), 'std', modelStd(sh).toFixed(2), 'size', sh.size.toFixed(1), 'facets', sh.facets.length);
}
// ISS overhead at 420 km, sun 15 deg below horizon to the west: body frame lvlh with observer below
const sh = shapeFor(mk('iss'));
const B = { x: [1,0,0], y:[0,1,0], z:[0,0,1] };   // body = local: x fwd, z down
for (const sunEl of [-5, -15, -25]) { const e=sunEl*Math.PI/180; const s=[Math.cos(e),0,-Math.sin(e)]; // sun direction in body frame: sun below satellite horizontal => +z component
  const I = facetsIntensity(sh.facets, B, s, [0,0,1]); console.log('ISS overhead 420km, sun', sunEl, 'deg vs sat horizon: mag', magFromI(I, 420, 1).toFixed(2)); }
// GEO glint: panel tracks sun about y; sun in orbit plane (equinox) and observer near anti-sun direction
const g = shapeFor(mk('geo'));
for (const off of [0, 0.5, 1, 2, 4]) { const a=off*Math.PI/180; const s=[1,0,0]; const o=[Math.cos(a),Math.sin(a),0];
  console.log('GEO glint offset', off, 'deg: mag', magFromI(facetsIntensity(g.facets,B,s,o), 36500, 1).toFixed(2)); }
