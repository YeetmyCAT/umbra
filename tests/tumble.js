import { shapeFor } from '../js/shapes.js';
import { bodyFrame, facetsIntensity, magFromI, hash } from '../js/light.js';
const norm = v => { const l = Math.hypot(...v); return v.map(x => x / l); };
for (const [name, id, type] of [['SL-16 R/B', 22220, 1], ['SL-8 R/B', 4000, 1], ['CZ-2C R/B', 31114, 1], ['COSMOS DEB', 9001, 2]]) {
  const o = { id, name, cls: type === 1 ? 'rb' : 'debris', type, rcs: type === 1 ? 10 : 0.3, n: 14.5 };
  const sh = shapeFor(o);
  const s = norm([0.2, 0.9, 0.3]), ob = norm([-0.5, 0.2, 0.84]);
  const mags = [];
  for (let t = 0; t < 300; t += 0.5) { const B = bodyFrame(sh.att, [7000, 0, 0], [0, 7.5, 0], s, t * 1000, id); mags.push(magFromI(facetsIntensity(sh.facets, B, s, ob), 1000, 1)); }
  const sorted = [...mags].sort((a, b) => a - b), med = sorted[sorted.length >> 1];
  let peaks = 0; for (let k = 1; k < mags.length - 1; k++) if (mags[k] < mags[k - 1] && mags[k] <= mags[k + 1] && med - mags[k] > 1.5) peaks++;
  console.log(name.padEnd(11), 'period', sh.att.period.toFixed(0).padStart(4), 's  brightest-to-median', (med - sorted[0]).toFixed(1), 'mag  range', (sorted[sorted.length - 1] - sorted[0]).toFixed(1), 'mag  sharp flashes in 5 min:', peaks);
}
