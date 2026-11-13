# Builds data/sun-map.png: a 360 deg map of the solar surface (Carrington longitude x latitude, 2048x1024) from an
# SDO/HMI synoptic radial-field map (JSOC hmi.Synoptic_Mr.<CR>.fits, sine-latitude CEA). Strong fields are sunspots
# (R: brightness factor, umbra ~0.2, penumbra ~0.7); moderate plage fields are faculae (G: strength, bright near the limb).
#   python tools/sunmap.py hmi.Synoptic_Mr.2287.fits data/sun-map.png
import sys, numpy as np
from PIL import Image, ImageFilter
def readfits(fn):
    b = open(fn, 'rb').read(); hdr = {}; off = 0
    while True:
        blk = b[off:off + 2880]; off += 2880; end = False
        for i in range(36):
            card = blk[i * 80:(i + 1) * 80].decode('ascii', 'replace'); k = card[:8].strip()
            if k == 'END': end = True; break
            if '=' in card[:10]: hdr[k] = card[10:].split('/')[0].strip()
        if end: break
    nx, ny = int(hdr['NAXIS1']), int(hdr['NAXIS2'])
    return hdr, np.nan_to_num(np.frombuffer(b[off:off + nx * ny * 4], dtype='>f4').reshape(ny, nx).astype(float))
h, a = readfits(sys.argv[1]); ny, nx = a.shape
cd1, crp1, crv1 = float(h['CDELT1']), float(h['CRPIX1']), float(h['CRVAL1'])
W, H = 2048, 1024
lon = (np.arange(W) + 0.5) / W * 360.0; lat = ((np.arange(H) + 0.5) / H - 0.5) * 180.0
xs = (((lon[None, :] - crv1) % 360.0) / cd1 + crp1 - 1) % nx
ys = np.clip(np.sin(np.radians(lat))[:, None] / float(h['CDELT2']) + float(h['CRPIX2']) - 1, 0, ny - 1)
X = np.broadcast_to(xs, (H, W)); Y = np.broadcast_to(ys, (H, W))
x0 = np.floor(X).astype(int) % nx; y0 = np.floor(Y).astype(int); x1 = (x0 + 1) % nx; y1 = np.clip(y0 + 1, 0, ny - 1); fx = X - np.floor(X); fy = Y - y0
B = abs(a); Bm = (B[y0, x0] * (1 - fx) + B[y0, x1] * fx) * (1 - fy) + (B[y1, x0] * (1 - fx) + B[y1, x1] * fx) * fy
sm = lambda e0, e1, x: np.clip((x - e0) / (e1 - e0), 0, 1) ** 2 * (3 - 2 * np.clip((x - e0) / (e1 - e0), 0, 1))
I = 1 - 0.30 * sm(450, 850, Bm) - 0.52 * sm(1100, 1800, Bm)
fac = sm(80, 450, Bm) * (1 - sm(450, 750, Bm))
print('spot area', (I < 0.9).mean(), 'umbra', (I < 0.4).mean())
img = np.stack([I * 255, fac * 255, np.zeros_like(I)], -1).clip(0, 255).astype(np.uint8)
Image.fromarray(img[::-1]).filter(ImageFilter.GaussianBlur(0.6)).save(sys.argv[2], optimize=True)
