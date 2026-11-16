"""Put a cloud map (grey: black = clear, white = cloud) into the cloud channel (R) of data/earth-aux-8k.jpg and
data/earth-aux.jpg, keeping the water mask (G) and the third channel. The shader reads clouds as
smoothstep(0.18, 0.75, R), so the map's grey levels are used as they are.
Usage: python tools/cloudmap.py D:/Earth-Cloud-Map-8k.png
To go back to the previous clouds: copy .raw/earth-aux*-prev.jpg over data/.
"""
from PIL import Image
import numpy as np, os, sys, shutil

Image.MAX_IMAGE_PIXELS = None
ROOT = os.path.join(os.path.dirname(__file__), '..')
src = Image.open(sys.argv[1]).convert('L')
for name, size in [('earth-aux-8k.jpg', (8192, 4096)), ('earth-aux.jpg', (4096, 2048))]:
    p = os.path.join(ROOT, 'data', name)
    keep = os.path.join(ROOT, '.raw', name.replace('.jpg', '-prev.jpg'))
    if not os.path.exists(keep):
        shutil.copy(p, keep)
    aux = np.asarray(Image.open(p).convert('RGB')).copy()
    aux[:, :, 0] = np.asarray(src.resize(size, Image.LANCZOS))
    Image.fromarray(aux).save(p, quality=92)
    print(name, os.path.getsize(p) // 1024, 'KB')
