"""Test fixtures for the web app: a photo-ish image, flat UI art, an alpha
logo, a static GIF, an animated GIF, and a corrupt file."""

import random
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).parent / "fixtures"
OUT.mkdir(exist_ok=True)
random.seed(7)

# photo-ish, with real photographic STRUCTURE - bokeh at several scales, a
# dark foreground ridge, sparse grain. A gradient field with noise on top is
# the pathological case for JPEG under SSIMULACRA 2 (banding), and the engine
# was correctly refusing to ship it lossy; an actual photo compresses fine.
from PIL import ImageFilter  # noqa: E402

img = Image.new("RGB", (1400, 900))
d = ImageDraw.Draw(img, "RGBA")
for y in range(0, 900, 3):
    t = y / 900
    d.rectangle([0, y, 1400, y + 3],
                fill=(int(238 - 148 * t), int(152 - 58 * t), int(112 + 76 * t)))
for i in range(100):
    r = random.randint(15, 160)
    x, y = random.randint(0, 1400), random.randint(180, 900)
    tint = [(255, 214, 168), (232, 150, 140), (150, 132, 196), (255, 236, 205)][i % 4]
    d.ellipse([x - r, y - r, x + r, y + r], fill=tint + (30,))
img = img.filter(ImageFilter.GaussianBlur(2.5))
d = ImageDraw.Draw(img)
pts = [(0, 900)] + [(x, int(900 * (0.72 + 0.09 * ((x / 1400) ** 1.4))))
                    for x in range(0, 1401, 56)] + [(1400, 900)]
d.polygon(pts, fill=(29, 25, 47))
px = img.load()
for _ in range((1400 * 900) // 10):
    x, y = random.randrange(1400), random.randrange(900)
    n = random.randint(-11, 11)
    r, g, b = px[x, y]
    px[x, y] = (max(0, min(255, r + n)), max(0, min(255, g + n)), max(0, min(255, b + n)))
img.save(OUT / "photo.png", compress_level=1)

# The same structure at 5MP - larger than the metric's full-frame verification
# budget, so this fixture exercises the dense-tile verify path and the memory
# ceiling that once silently killed every lossy candidate on big frames.
big = img.resize((2800, 1800), Image.LANCZOS)
px = big.load()
for _ in range((2800 * 1800) // 14):
    x, y = random.randrange(2800), random.randrange(1800)
    n = random.randint(-9, 9)
    r, g, b = px[x, y]
    px[x, y] = (max(0, min(255, r + n)), max(0, min(255, g + n)), max(0, min(255, b + n)))
big.save(OUT / "photo5mp.png", compress_level=1)

# chroma torture: saturated per-channel noise. 4:2:0 destroys this, and the
# per-channel guard must notice and refuse to ship it as JPEG.
ct = Image.new("RGB", (640, 420))
px = ct.load()
for y in range(420):
    for x in range(640):
        px[x, y] = (
            int(128 + random.gauss(0, 60)),
            int(128 - random.gauss(0, 60)),
            int(128 + random.gauss(0, 60)),
        )
ct.save(OUT / "chromanoise.png", compress_level=1)

# flat UI: few colours, sharp edges — png8 should win
ui = Image.new("RGB", (1200, 800), (245, 246, 248))
d = ImageDraw.Draw(ui)
for i in range(14):
    d.rectangle([40, 40 + i * 52, 1160, 78 + i * 52], fill=(255, 255, 255))
    d.rectangle([56, 52 + i * 52, 300 + (i * 37) % 500, 66 + i * 52],
                fill=(60 + i * 9, 90, 200 - i * 7))
d.rectangle([0, 0, 1200, 28], fill=(24, 26, 32))
ui.save(OUT / "ui.png")

# alpha logo
logo = Image.new("RGBA", (600, 600), (0, 0, 0, 0))
d = ImageDraw.Draw(logo)
d.ellipse([60, 60, 540, 540], fill=(210, 154, 94, 255))
d.polygon([(180, 400), (300, 200), (420, 400)], fill=(20, 21, 24, 255))
logo.save(OUT / "logo.png")

# static + animated GIF
frames = [Image.new("RGB", (200, 150), c) for c in ((250, 60, 60), (60, 250, 120))]
frames[0].save(OUT / "static.gif")
frames[0].save(OUT / "anim.gif", save_all=True, append_images=frames[1:],
               duration=120, loop=0)

# a jpeg source, already small
img.resize((300, 200)).convert("RGB").save(OUT / "small.jpg", quality=30)

# corrupt
(OUT / "corrupt.png").write_bytes(b"definitely not a png" * 3)

print("fixtures:", sorted(p.name for p in OUT.iterdir()))
