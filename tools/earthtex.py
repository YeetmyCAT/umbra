"""Build the Earth maps from the user's high-resolution textures in D:/Earth Textures (all equirectangular, aligned):
  earth_color_10K.png       -> data/earth-day-8k.jpg (8192) and data/earth-day.jpg (4096)
  earth_landocean_16K.png   -> water mask, channel G of data/earth-aux*.jpg (white = water). Hairline features
                               (borders, small rivers drawn as lines, < ~3 px at 16K) are removed by an opening,
                               so they don't show as shiny lines across the land
  Earth-Cloud-Map-16k.png   -> clouds, channel R of data/earth-aux*.jpg
  Earth-Bump-Map-16k.png    -> data/earth-height.png (4096): 24.9 m per grey level (checked against known summits)
  Earth-Night-Map-16k.png   -> data/earth-lights-8k.jpg and data/earth-lights.jpg: the orange city light only (the
                               bluish moonlit land is dropped: the renderer lights the land itself), brightness matched
                               to the previous maps' calibration (a bright city core ~1.2 cd/m^2) by quantile matching
The third channel of the aux maps is kept as it is.
Usage: python tools/earthtex.py
"""
from PIL import Image, ImageFilter
import numpy as np, os

Image.MAX_IMAGE_PIXELS = None
ROOT = os.path.join(os.path.dirname(__file__), '..')
SRC = 'D:/Earth Textures'
D = lambda f: os.path.join(ROOT, 'data', f)
SIZES = {'-8k': (8192, 4096), '': (4096, 2048)}

print('colour...')
col = Image.open(os.path.join(SRC, 'earth_color_10K.png')).convert('RGB')
for suf, size in SIZES.items():
    col.resize(size, Image.LANCZOS).save(D(f'earth-day{suf}.jpg'), quality=92)

print('water...')
lo = Image.open(os.path.join(SRC, 'earth_landocean_16K.png')).convert('L')
lo = lo.filter(ImageFilter.MinFilter(5)).filter(ImageFilter.MaxFilter(5))   # opening: drop lines <= ~4 px wide

print('clouds...')
cl = Image.open(os.path.join(SRC, 'Earth-Cloud-Map-16k.png')).convert('L')

for suf, size in SIZES.items():
    p = D(f'earth-aux{suf}.jpg')
    aux = np.asarray(Image.open(p).convert('RGB').resize(size, Image.BICUBIC)).copy()
    aux[:, :, 0] = np.asarray(cl.resize(size, Image.BOX))
    aux[:, :, 1] = np.asarray(lo.resize(size, Image.BOX))
    Image.fromarray(aux).save(p, quality=92)

print('lights...')
ref = np.asarray(Image.open(os.path.join(ROOT, '.raw', 'before-earthtex', 'earth-lights-ref.jpg')).convert('L')).astype(np.float32)
nm = Image.open(os.path.join(SRC, 'Earth-Night-Map-16k.png')).convert('RGB')
for suf, size in SIZES.items():
    a = np.asarray(nm.resize(size, Image.BOX)).astype(np.float32)
    f = np.clip(a[:, :, 0] - 0.9 * a[:, :, 2], 0, None)
    small = np.asarray(Image.fromarray(f, 'F').resize(ref.shape[::-1], Image.BOX))
    qs = np.linspace(0, 100, 1001)
    sq = np.maximum.accumulate(np.percentile(small, qs) + np.arange(len(qs)) * 1e-6)
    out = np.interp(f, sq, np.percentile(ref, qs))
    Image.fromarray(np.clip(out, 0, 255).astype(np.uint8), 'L').save(D(f'earth-lights{suf}.jpg'), quality=92)

print('height...')
Image.open(os.path.join(SRC, 'Earth-Bump-Map-16k.png')).convert('L').resize((4096, 2048), Image.BOX).save(D('earth-height.png'), optimize=True)
for f in ['earth-day-8k.jpg', 'earth-day.jpg', 'earth-aux-8k.jpg', 'earth-aux.jpg', 'earth-lights-8k.jpg', 'earth-lights.jpg', 'earth-height.png']:
    print(f, os.path.getsize(D(f)) // 1024, 'KB')
