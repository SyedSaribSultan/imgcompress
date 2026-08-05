"""Generate a small benchmark corpus that exercises the cases that matter.

Four content types, chosen because they push compressors in different
directions and because the best output format genuinely differs between them:

  photo      smooth sky gradient (banding), fractal terrain (texture), hard
             edges (ringing), saturated red/blue bars (chroma), fine white
             stripes (high frequency), light grain
  ui_text    a dense UI screenshot - small text, thin borders, flat fills
  gradient   a pure smooth gradient, the classic banding torture test
  logo_alpha flat vector artwork with transparency
"""

from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

OUT = Path(__file__).resolve().parent / "fixtures"


def _fbm(h, w, octaves=6, seed=0):
    rng = np.random.default_rng(seed)
    out, amp = np.zeros((h, w)), 1.0
    for o in range(octaves):
        step = max(1, 64 // (2**o))
        small = rng.random((max(2, h // step + 1), max(2, w // step + 1)))
        up = np.asarray(
            Image.fromarray((small * 255).astype(np.uint8)).resize((w, h), Image.BICUBIC)
        ) / 255.0
        out += amp * up
        amp *= 0.5
    out -= out.min()
    return out / out.max()


def photo(size=(1280, 820)) -> Image.Image:
    W, H = size
    rng = np.random.default_rng(3)
    yy, xx = np.mgrid[0:H, 0:W]

    sky = np.zeros((H, W, 3))
    g = np.linspace(0, 1, H)[:, None]
    sky[..., 0], sky[..., 1], sky[..., 2] = 60 + 150 * g, 110 + 120 * g, 190 + 50 * g

    terrain = _fbm(H, W, 6, seed=1)
    land = np.stack([70 + 120 * terrain, 90 + 110 * terrain, 55 + 70 * terrain], -1)
    horizon = (H * 0.55 + 60 * np.sin(np.arange(W) / 180.0))[None, :]
    img = np.where((yy > horizon)[..., None], land, sky)

    glow = np.clip(1 - np.hypot(xx - W * 0.77, yy - H * 0.2) / (W * 0.33), 0, 1) ** 2
    img = img * (1 - glow[..., None] * 0.85) + np.array([255, 244, 214]) * glow[..., None] * 0.85

    im = Image.fromarray(img.clip(0, 255).astype(np.uint8))
    d = ImageDraw.Draw(im)
    d.polygon([(180, 760), (330, 430), (470, 760)], fill=(28, 32, 38))
    d.polygon([(420, 760), (560, 520), (700, 760)], fill=(44, 48, 56))
    d.rectangle([760, 600, 1180, 624], fill=(230, 20, 40))     # saturated red
    d.rectangle([760, 640, 1060, 664], fill=(20, 90, 230))     # saturated blue
    for i in range(14):                                        # fine detail
        d.rectangle([770 + i * 28, 700, 782 + i * 28, 742], fill=(255, 255, 255))
    im = im.filter(ImageFilter.GaussianBlur(0.35))
    arr = np.asarray(im).astype(np.int16) + rng.integers(-5, 5, (H, W, 3))
    return Image.fromarray(arr.clip(0, 255).astype(np.uint8))


def ui_text(size=(1280, 820)) -> Image.Image:
    W, H = size
    im = Image.new("RGB", size, (246, 247, 249))
    d = ImageDraw.Draw(im)
    try:
        big = ImageFont.truetype("DejaVuSans-Bold.ttf", 30)
        mid = ImageFont.truetype("DejaVuSans-Bold.ttf", 22)
        small = ImageFont.truetype("DejaVuSans.ttf", 13)
    except OSError:
        big = mid = small = ImageFont.load_default()

    d.text((32, 26), "Creative performance", font=big, fill=(15, 23, 42))
    d.text((32, 68), "Rolling 28 days - 14 active campaigns", font=small, fill=(100, 116, 139))

    for i, (label, value, delta, colour) in enumerate([
        ("SPEND", "$248,910", "+12.4%", (5, 150, 105)),
        ("ROAS", "3.42x", "-0.18", (225, 29, 72)),
        ("CREATIVES", "1,284", "+340", (5, 150, 105)),
    ]):
        x = 32 + i * 410
        d.rounded_rectangle([x, 100, x + 380, 240], radius=14,
                            fill=(255, 255, 255), outline=(226, 232, 240), width=2)
        d.text((x + 20, 118), label, font=small, fill=(100, 116, 139))
        d.text((x + 20, 142), value, font=mid, fill=(15, 23, 42))
        d.text((x + 20, 180), delta, font=small, fill=colour)
        d.rectangle([x + 20, 212, x + 20 + 300 - i * 70, 220], fill=(99, 102, 241))

    rows = [
        ("Spring drop - broad", "UGC video 9:16", "2,481,003", "1.84%", "$18.40"),
        ("Retargeting - 30d", "Static carousel", "884,217", "3.12%", "$9.05"),
        ("Lookalike 2% - US", "Founder talking head", "1,204,556", "0.94%", "$31.77"),
        ("Prospecting - EU", "Product hero still", "612,880", "1.21%", "$24.13"),
        ("Cold traffic - AU", "Testimonial cut", "301,449", "2.06%", "$14.62"),
    ]
    d.rectangle([32, 280, 1248, 316], fill=(248, 250, 252))
    for c, head in enumerate(("CAMPAIGN", "FORMAT", "IMPRESSIONS", "CTR", "CPA")):
        d.text((44 + c * 244, 292), head, font=small, fill=(71, 85, 105))
    for r, row in enumerate(rows):
        y = 316 + r * 38
        d.line([32, y + 37, 1248, y + 37], fill=(238, 242, 247))
        for c, cell in enumerate(row):
            d.text((44 + c * 244, y + 12), cell, font=small, fill=(15, 23, 42))
    return im


def gradient(size=(1000, 600)) -> Image.Image:
    W, H = size
    arr = np.zeros((H, W, 3))
    arr[..., 0] = np.linspace(30, 90, W)[None, :]
    arr[..., 1] = np.linspace(40, 120, H)[:, None]
    arr[..., 2] = np.linspace(120, 200, W)[None, :]
    return Image.fromarray(arr.astype(np.uint8))


def logo_alpha(size=(900, 900)) -> Image.Image:
    im = Image.new("RGBA", size, (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.ellipse([60, 60, 840, 840], fill=(99, 102, 241, 255))
    d.ellipse([230, 230, 670, 670], fill=(253, 224, 71, 255))
    d.polygon([(450, 180), (690, 700), (210, 700)], fill=(255, 255, 255, 235))
    return im


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for name, fn in (("photo", photo), ("ui_text", ui_text),
                     ("gradient", gradient), ("logo_alpha", logo_alpha)):
        fn().save(OUT / f"{name}.png")
    for path in sorted(OUT.iterdir()):
        with Image.open(path) as im:
            print(f"{path.name:18} {path.stat().st_size / 1024:>9,.0f} KB  {im.size}")


if __name__ == "__main__":
    main()
