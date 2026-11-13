import { shapeFor } from '../js/shapes.js';
import { modelStd } from '../js/sight.js';
import { facetsIntensity, magFromI } from '../js/light.js';
const sh = shapeFor({ id: 25544, name: 'ISS', cls: 'iss', n: 15.5, ops: '+', launch: '1998' });
console.log('ISS std (random attitude)', modelStd(sh).toFixed(2));
const B = { x: [1,0,0], y:[0,1,0], z:[0,0,1] };
const n = v => { const l = Math.hypot(...v); return v.map(x => x / l); };
console.log('pass case 27deg/834km', magFromI(facetsIntensity(sh.facets, B, n([-0.89,-0.33,0.31]), n([0.53,-0.64,0.55])), 834, 1).toFixed(2), '(observed ~ -2.2)');
console.log('pass case 14deg/1249km', magFromI(facetsIntensity(sh.facets, B, n([-0.91,-0.33,0.23]), n([0.80,-0.44,0.42])), 1249, 1).toFixed(2), '(observed ~ -1.3)');
for (const e of [-5,-15,-25]) { const r=e*Math.PI/180; console.log('overhead 420 km, sun', e, magFromI(facetsIntensity(sh.facets, B, [Math.cos(r),0,-Math.sin(r)], [0,0,1]), 420, 1).toFixed(2)); }
