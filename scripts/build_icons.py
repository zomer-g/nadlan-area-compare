# The app icons (PWA manifest, Apple touch icon), drawn from the favicon in
# public/index.html: a blue rounded square (--accent, #2563eb) with a white
# house outline. Pillow, drawn at 4x and scaled down for smooth edges.
#
#   python scripts/build_icons.py      (writes public/icons/*.png)
#
# "any" icons keep the favicon's rounded corners; the maskable one is full
# bleed with the house inside the central 60% (the safe zone launchers keep
# whatever mask they apply).

from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / 'public' / 'icons'
BLUE = (37, 99, 235, 255)
WHITE = (255, 255, 255, 255)
SS = 4  # supersampling


def house(d, s, scale, ox, oy):
    # The favicon's path on a 32-unit grid: M6 24h20 M9 24V14l7-5 7 5v10,
    # stroke 2.5. Drawn with round joints so the scaled-up corners stay clean.
    k = s * scale / 32
    w = round(2.5 * k)
    pt = lambda x, y: (ox + x * k, oy + y * k)
    d.line([pt(6, 24), pt(26, 24)], fill=WHITE, width=w)
    d.line([pt(9, 24), pt(9, 14), pt(16, 9), pt(23, 14), pt(23, 24)], fill=WHITE, width=w, joint='curve')
    for x, y in [(6, 24), (26, 24), (9, 24), (23, 24)]:
        cx, cy = pt(x, y)
        d.ellipse([cx - w / 2, cy - w / 2, cx + w / 2, cy + w / 2], fill=WHITE)


def icon(size, maskable):
    s = size * SS
    img = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if maskable:
        d.rectangle([0, 0, s, s], fill=BLUE)
        # The house spans x 6..26, y 9..24 of 32: fit it in the 60% safe zone.
        scale = 0.6 * 32 / 20
        k = s * scale / 32
        house(d, s, scale, s / 2 - 16 * k, s / 2 - 16.5 * k)
    else:
        d.rounded_rectangle([0, 0, s - 1, s - 1], radius=s * 6 / 32, fill=BLUE)
        house(d, s, 1, 0, 0)
    return img.resize((size, size), Image.LANCZOS)


OUT.mkdir(parents=True, exist_ok=True)
for name, size, maskable in [
    ('icon-192.png', 192, False),
    ('icon-512.png', 512, False),
    ('icon-maskable-512.png', 512, True),
    # iOS ignores transparency and rounds the corners itself: full bleed.
    ('apple-touch-icon.png', 180, True),
]:
    icon(size, maskable).save(OUT / name, optimize=True)
    print('wrote', OUT / name)
