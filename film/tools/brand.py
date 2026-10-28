"""Exports the Aha Labs horizontal lockup in its celadon colourway as two
layers, the ring and the wordmark, so the end card can turn the ring the way
the brand does.

    python tools/brand.py <branding checkout>   → brand/ring.svg,
                                                      brand/wordmark.svg,
                                                      brand/lockup.json (layout and colours)

The brand's own source (the aha-labs-hq/branding repository) owns every
shape and colour; this only reuses its lockup() and its 青瓷 ground, and
places the two parts where the lockup puts them. Needs skia-pathops, as the brand
source does."""
import json, os, sys

sys.dont_write_bytecode = True  # leave the brand's checkout as it was
brand = os.path.abspath(sys.argv[1])
sys.path.insert(0, os.path.join(brand, 'source'))
from build import lockups, tight_svg, GROUNDS         # noqa: E402
from aha_ring import X                                # noqa: E402
from geom import shift, transform                     # noqa: E402

COLOURWAY = '青瓷'
background, ink = next((bg, fg) for name, bg, fg in GROUNDS if name == COLOURWAY)

R, W, H, _ = lockups()
# Rebuild the lockup's two parts exactly as lockups() does.
rx0, ry0, rx1, ry1 = R.bounds; wx0, wy0, wx1, wy1 = W.bounds
d = ry1 - ry0; k = (wy1 - wy0 + 64) / d
r = d * k / 2; gap = 0.36 * 2 * r
ring = shift(transform(R, lambda x, y: (x * k, y * k)), r, X * 0.56)
word = shift(W, 2 * r + gap - wx0, 0)
hx0, hy0, hx1, hy1 = H.bounds

def box(p):
    x0, y0, x1, y1 = p.bounds
    return {'x': round(x0 - hx0, 3), 'y': round(hy1 - y1, 3), 'width': round(x1 - x0, 3), 'height': round(y1 - y0, 3)}

out = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'brand')
os.makedirs(out, exist_ok=True)
for stale in ('ring-cream.svg', 'wordmark-cream.svg'):
    if os.path.exists(os.path.join(out, stale)): os.remove(os.path.join(out, stale))
open(os.path.join(out, 'ring.svg'), 'w').write(tight_svg(ring, ink))
open(os.path.join(out, 'wordmark.svg'), 'w').write(tight_svg(word, ink))
layout = {'width': round(hx1 - hx0, 3), 'height': round(hy1 - hy0, 3), 'ring': box(ring), 'wordmark': box(word),
          'colourway': COLOURWAY, 'background': background, 'ink': ink}
json.dump(layout, open(os.path.join(out, 'lockup.json'), 'w'), ensure_ascii=False, indent=2)
print(json.dumps(layout, ensure_ascii=False))
