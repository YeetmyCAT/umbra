// Deep star layer from Gaia DR3 (G < 10.6), for zoomed-in views. Bright stars (V <= 8) already come from
// stars.json + stars8.bin, so only 8 < V <= 10.5 is kept here. Gaia G and BP-RP are converted to Johnson V and B-V
// (Riello et al. 2021 / Gaia DR3 documentation photometric relations).
// Record: uint32 = RA (24 bit) | ... packed as: uint24 RA, int24 Dec, uint8 V*20 (offset 0), int8 (B-V)*50 -> 8 bytes,
// ~1.3 arcsec precision. Split by magnitude so the brighter half loads first.
//   node tools/prepgaia.js path/to/gaia.csv
const fs = require('fs'), path = require('path');
const src = process.argv[2]; const L = fs.readFileSync(src, 'utf8').split('\n');
const out = [[], []];
for (let k = 1; k < L.length; k++) {
  const p = L[k].split(','); if (p.length < 4) continue;
  const ra = +p[0], de = +p[1], G = +p[2], c = p[3] === '' ? 0.8 : +p[3];
  if (!Number.isFinite(ra) || !Number.isFinite(G)) continue;
  const x = Math.max(-0.5, Math.min(5, c));
  const GV = -0.02704 + 0.01424 * x - 0.2156 * x * x + 0.01426 * x * x * x;   // G - V
  const V = G - GV;
  if (V <= 8.0 || V > 10.5) continue;
  const bv = Math.max(-0.4, Math.min(2.4, (x - 0.0981) / 1.429 + 0.0188 * Math.max(0, x - 1.5) ** 2));
  out[V <= 9.6 ? 0 : 1].push([ra, de, V, bv]);
}
for (let f = 0; f < 2; f++) {
  const a = out[f].sort((p, q) => p[2] - q[2]), b = Buffer.alloc(a.length * 8);
  a.forEach(([ra, de, V, bv], i) => {
    const r = Math.round(ra / 360 * 16777215) & 0xffffff, d = Math.round(de / 90 * 8388607);
    const o = i * 8;
    b.writeUIntLE(r, o, 3); b.writeIntLE(d, o + 3, 3); b.writeUInt8(Math.round(V * 20) & 255, o + 6); b.writeInt8(Math.round(bv * 50), o + 7);
  });
  const fn = path.join(__dirname, '..', 'data', `gaia${f + 1}.bin`); fs.writeFileSync(fn, b);
  console.log(fn, a.length, 'stars', (b.length / 1e6).toFixed(2), 'MB');
}
