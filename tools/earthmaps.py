"""Build the 8192 x 4096 Earth maps used on desktop (phones keep the 4096 originals).

The look of the existing 4096 maps is kept exactly at their own scale: only finer detail is added from higher-resolution
sources, so colours and brightness don't change.
  day    : current earth-day.jpg + fine detail of NASA Blue Marble (world.topo.bathy 21600 x 10800)
  lights : current earth-lights.jpg x fine structure of NASA Black Marble 2016 (13500 x 6750)
  aux    : clouds (R) and the third channel upsampled as they are (no higher-resolution cloud map is available);
           the water mask (G) is the current one, with the coastline re-drawn at 8192 from the Blue Marble colours
           (each coastal pixel goes to whichever of the nearby sea / land colours it is closer to)
Usage: python tools/earthmaps.py   (sources in .raw/ and ../artemisx/.raw/earth/)
"""
from PIL import Image, ImageFilter
import numpy as np, os

Image.MAX_IMAGE_PIXELS = None
ROOT = os.path.join(os.path.dirname(__file__), '..')
W, H = 8192, 4096
DAY_SRC = os.path.join(ROOT, '..', 'artemisx', '.raw', 'earth', 'world.topo.bathy.200403.3x21600x10800.jpg')
BM_SRC = os.path.join(ROOT, '.raw', 'BlackMarble_2016_3km.jpg')
D = lambda f: os.path.join(ROOT, 'data', f)


def up(a, mode=Image.BICUBIC):
    """upsample a float array (H/2 x W/2 [x C]) to H x W"""
    if a.ndim == 2:
        return np.asarray(Image.fromarray(a.astype(np.float32), 'F').resize((W, H), mode))
    return np.stack([up(a[:, :, c], mode) for c in range(a.shape[2])], 2)


def down(a):
    if a.ndim == 2:
        return np.asarray(Image.fromarray(a.astype(np.float32), 'F').resize((W // 2, H // 2), Image.BOX))
    return np.stack([down(a[:, :, c]) for c in range(a.shape[2])], 2)


def _box1(a, r, ax):
    c = np.cumsum(np.pad(a, [(r + 1, r) if i == ax else (0, 0) for i in range(a.ndim)], mode='edge'), axis=ax, dtype=np.float64)
    n = a.shape[ax]
    hi = np.take(c, np.arange(2 * r + 1, 2 * r + 1 + n), axis=ax); lo = np.take(c, np.arange(0, n), axis=ax)
    return ((hi - lo) / (2 * r + 1)).astype(np.float32)


def blur(a, r):
    if a.ndim == 2:
        return _box1(_box1(a.astype(np.float32), r, 0), r, 1)
    return np.stack([blur(a[:, :, c], r) for c in range(a.shape[2])], 2)


print('day...')
cur = np.asarray(Image.open(D('earth-day.jpg')).convert('RGB')).astype(np.float32)
src = np.asarray(Image.open(DAY_SRC).convert('RGB').resize((W, H), Image.LANCZOS)).astype(np.float32)
detail = src - up(down(src))                     # what the 21600 map has finer than 4096 pixels
day = np.clip(up(cur) + detail, 0, 255)
Image.fromarray(day.astype(np.uint8)).save(D('earth-day-8k.jpg'), quality=90)

print('lights...')
# straight from Black Marble at 8192 (clean: diffuse glow with bright towns and roads). The orange city light is kept
# and the bluish moonlit land dropped; one monotonic brightness curve (quantile matching at the 4096 scale) makes it
# exactly as bright as the current map, so only the detail changes
curL = np.asarray(Image.open(D('earth-lights.jpg')).convert('L')).astype(np.float32)
bm = np.asarray(Image.open(BM_SRC).convert('RGB').resize((W, H), Image.LANCZOS)).astype(np.float32)
f = np.clip(bm[:, :, 0] - 0.9 * bm[:, :, 2], 0, None)
qs = np.linspace(0, 100, 1001)
src_q = np.percentile(down(f), qs); dst_q = np.percentile(curL, qs)
src_q = np.maximum.accumulate(src_q + np.arange(len(qs)) * 1e-6)
lights = np.interp(f, src_q, dst_q)
Image.fromarray(np.clip(lights, 0, 255).astype(np.uint8), 'L').save(D('earth-lights-8k.jpg'), quality=92)

print('aux...')
aux = np.asarray(Image.open(D('earth-aux.jpg')).convert('RGB')).astype(np.float32)
clouds, third = up(aux[:, :, 0]), up(aux[:, :, 2])
g = up(aux[:, :, 1], Image.BILINEAR)             # current mask, smooth
band = (g > 25) & (g < 230)                      # only the coastline zone is redrawn
wat, lan = (g >= 230).astype(np.float32), (g <= 25).astype(np.float32)
R = 6                                            # local neighbourhood (~30 km) for the sea and land colours
nw, nl = blur(wat, R) + 1e-3, blur(lan, R) + 1e-3
cw = blur(src * wat[:, :, None], R) / nw[:, :, None]
cl = blur(src * lan[:, :, None], R) / nl[:, :, None]
dw = np.sqrt(((src - cw) ** 2).sum(2)); dl = np.sqrt(((src - cl) ** 2).sum(2))
soft = np.clip(0.5 + (dl - dw) / (dl + dw + 1e-3) * 2.5, 0, 1) * 255   # 1 = water
ok = band & (nw > 0.02) & (nl > 0.02)            # both sides known nearby; elsewhere keep the current mask
gnew = np.where(ok, soft, g)
def aa(a):   # light [1 2 1] smoothing, so the new coastline is anti-aliased but still one pixel sharp
    a = (np.roll(a, 1, 0) + 2 * a + np.roll(a, -1, 0)) / 4
    return (np.roll(a, 1, 1) + 2 * a + np.roll(a, -1, 1)) / 4
gnew = aa(gnew.astype(np.float32))
out = np.stack([clouds, np.clip(gnew, 0, 255), third], 2)
Image.fromarray(np.clip(out, 0, 255).astype(np.uint8)).save(D('earth-aux-8k.jpg'), quality=92)
for f_ in ['earth-day-8k.jpg', 'earth-lights-8k.jpg', 'earth-aux-8k.jpg']:
    print(f_, os.path.getsize(D(f_)) // 1024, 'KB')
