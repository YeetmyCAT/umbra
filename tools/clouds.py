"""Real cloud cover for the Earth maps, from one day of NASA VIIRS true-colour imagery (GIBS, 20 Mar 2025: equinox,
so both poles are lit, and the same season as the March Blue Marble ground, so sea ice isn't taken for cloud), NOAA-20 and Suomi NPP. Writes the cloud channel (R) of data/earth-aux-8k.jpg and
data/earth-aux.jpg; the water mask and the third channel are kept as they are.

  * cloud = how much whiter a pixel is than the cloud-free ground under it (Blue Marble), so deserts, ice and snow
    don't count as cloud
  * where both satellites saw the spot, the less white of the two is used: sunglint on the sea (grey streaks along
    each orbit) falls in different places on the two passes and drops out
  * no imagery (polar edges): the previous cloud map, blended in
  * stored so the shader's smoothstep(0.18, 0.75, r) gives back the measured cloud fraction
Tiles: .raw/gibs/<layer>_<i>_<j>.jpg, 2048 x 2048, 90 x 90 deg each (see the curl loop in the commit that added this).
"""
from PIL import Image
import numpy as np, os

Image.MAX_IMAGE_PIXELS = None
ROOT = os.path.join(os.path.dirname(__file__), '..')
G = os.path.join(ROOT, '.raw', 'gibs')
W, H = 8192, 4096
LAYERS = ['VIIRS_NOAA20_CorrectedReflectance_TrueColor', 'VIIRS_SNPP_CorrectedReflectance_TrueColor']


def mosaic(L):
    m = Image.new('RGB', (W, H))
    for i in range(4):
        for j in range(2):
            m.paste(Image.open(os.path.join(G, f'{L}_{i}_{j}.jpg')), (i * 2048, j * 2048))
    return np.asarray(m).astype(np.float32)


def box(a, r):
    for ax in (0, 1):
        c = np.cumsum(np.pad(a, [(r + 1, r) if i == ax else (0, 0) for i in range(2)], mode='edge'), axis=ax, dtype=np.float64)
        n = a.shape[ax]
        a = ((np.take(c, np.arange(2 * r + 1, 2 * r + 1 + n), axis=ax) - np.take(c, np.arange(n), axis=ax)) / (2 * r + 1)).astype(np.float32)
    return a


ground = np.asarray(Image.open(os.path.join(ROOT, 'data', 'earth-day-8k.jpg')).convert('RGB')).astype(np.float32)
s = ground.min(2) / 255.0                                   # cloud-free surface whiteness
cl, have = [], []
for L in LAYERS:
    a = mosaic(L)
    ok = a.max(2) > 8                                        # imagery present
    w = a.min(2) / 255.0                                     # whiteness (clouds are bright in all three colours)
    c = np.clip((w - s - 0.12) / np.maximum(0.75 - s, 0.15), 0, 1)   # above the haze over clear sea
    cl.append(np.where(ok, c, 0)); have.append(ok)
both = have[0] & have[1]
c = np.where(both, np.minimum(cl[0], cl[1]), np.where(have[0], cl[0], cl[1]))
cov = (have[0] | have[1]).astype(np.float32)
cov = box(cov, 24)                                           # soft edge where imagery ends (~120 km)
c = np.clip(c, 0, 1)

for name, size in [('earth-aux-8k.jpg', (W, H)), ('earth-aux.jpg', (W // 2, H // 2))]:
    p = os.path.join(ROOT, 'data', name)
    aux = np.asarray(Image.open(p).convert('RGB')).astype(np.float32)
    cc = c if size == (W, H) else np.asarray(Image.fromarray(c, 'F').resize(size, Image.BOX))
    cv = cov if size == (W, H) else np.asarray(Image.fromarray(cov, 'F').resize(size, Image.BOX))
    old = np.clip((aux[:, :, 0] / 255.0 - 0.18) / 0.57, 0, 1)
    old = old * old * (3 - 2 * old)                          # old cloud fraction as the shader saw it
    frac = cc * cv + old * (1 - cv)
    t = 0.5 - np.sin(np.arcsin(np.clip(1 - 2 * frac, -1, 1)) / 3)   # inverse smoothstep
    aux[:, :, 0] = (0.18 + 0.57 * t) * 255
    Image.fromarray(np.clip(aux, 0, 255).astype(np.uint8)).save(p, quality=92)
    print(name, 'mean cloud fraction', round(float(frac.mean()), 3))
