"""Validation vectors for the JS SSIMULACRA 2 port.

Builds a diverse set of (original, distorted) pairs, scores each with the
Python reference implementation (the one the desktop app uses), and dumps
both the scores and the raw RGB pixels so Node can score the identical
buffers without needing an image decoder.
"""

import io
import json
import random
import sys
from pathlib import Path

# The reference ssimulacra2 package comes with the repo's dev environment.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

from ssimulacra2 import compute_ssimulacra2

OUT = Path(__file__).parent / "ss2_vectors"
OUT.mkdir(exist_ok=True)
random.seed(3)


def photo(w, h):
    img = Image.new("RGB", (w, h))
    d = ImageDraw.Draw(img, "RGBA")
    for y in range(0, h, 2):
        t = y / h
        d.rectangle([0, y, w, y + 2], fill=(int(235 - 140 * t), int(150 - 60 * t), int(110 + 80 * t)))
    for i in range(60):
        r = random.randint(8, w // 6)
        x, y = random.randint(0, w), random.randint(0, h)
        tint = [(255, 210, 160), (230, 140, 130), (140, 130, 200)][i % 3]
        d.ellipse([x - r, y - r, x + r, y + r], fill=tint + (40,))
    img = img.filter(ImageFilter.GaussianBlur(2))
    px = img.load()
    for _ in range((w * h) // 8):
        x, y = random.randrange(w), random.randrange(h)
        n = random.randint(-14, 14)
        r, g, b = px[x, y]
        px[x, y] = (max(0, min(255, r + n)), max(0, min(255, g + n)), max(0, min(255, b + n)))
    return img


def ui(w, h):
    img = Image.new("RGB", (w, h), (246, 246, 248))
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, w, 40], fill=(24, 26, 32))
    for i in range((h - 60) // 50):
        top = 60 + i * 50
        d.rectangle([20, top, w - 20, top + 36], fill=(255, 255, 255))
        d.rectangle([32, top + 8, 32 + (140 + i * 61) % (w - 90), top + 15], fill=(50, 54, 62))
        d.rectangle([32, top + 22, 32 + (90 + i * 97) % (w - 120), top + 27], fill=(150, 155, 165))
    return img


def gradient(w, h):
    a = np.zeros((h, w, 3), np.uint8)
    for y in range(h):
        for c, (lo, hi) in enumerate([(20, 240), (60, 180), (200, 40)]):
            a[y, :, c] = int(lo + (hi - lo) * y / h)
    return Image.fromarray(a)


def saturated(w, h):
    """Chroma-heavy content — the case luma metrics miss."""
    img = Image.new("RGB", (w, h))
    d = ImageDraw.Draw(img)
    cols = [(255, 0, 60), (0, 200, 90), (30, 60, 255), (255, 200, 0)]
    bw = w // len(cols)
    for i, c in enumerate(cols):
        d.rectangle([i * bw, 0, (i + 1) * bw, h], fill=c)
    for i in range(24):
        x = random.randint(0, w - 40)
        y = random.randint(0, h - 40)
        d.ellipse([x, y, x + 36, y + 36], fill=cols[(i + 2) % 4])
    return img


def rgb_bytes(img: Image.Image) -> bytes:
    return np.asarray(img.convert("RGB"), dtype=np.uint8).tobytes()


def variants(img: Image.Image):
    """Distortions across the whole quality range, several codecs."""
    out = []
    for q in (35, 60, 75, 90):
        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=q, subsampling="4:2:0")
        out.append((f"jpeg{q}", Image.open(io.BytesIO(buf.getvalue())).convert("RGB")))
    for q in (50, 80):
        buf = io.BytesIO()
        img.save(buf, "WEBP", quality=q, method=4)
        out.append((f"webp{q}", Image.open(io.BytesIO(buf.getvalue())).convert("RGB")))
    for q in (40, 70):
        buf = io.BytesIO()
        img.save(buf, "AVIF", quality=q, speed=8)
        out.append((f"avif{q}", Image.open(io.BytesIO(buf.getvalue())).convert("RGB")))
    out.append(("pal32", img.convert("RGB").quantize(colors=32).convert("RGB")))
    out.append(("identical", img.convert("RGB")))
    return out


def main():
    sources = {
        "photo640": photo(640, 420),
        "ui640": ui(640, 420),
        "grad512": gradient(512, 320),
        "sat400": saturated(400, 300),
        # small sizes exercise the fewer-scales path
        "photo127": photo(127, 83),
        "ui260": ui(260, 200),
    }
    vectors = []
    for sname, src in sources.items():
        sp = OUT / f"{sname}.png"
        src.save(sp)
        (OUT / f"{sname}.rgb").write_bytes(rgb_bytes(src))
        for vname, dist in variants(src):
            dp = OUT / f"{sname}-{vname}.png"
            dist.save(dp)
            (OUT / f"{sname}-{vname}.rgb").write_bytes(rgb_bytes(dist))
            score = compute_ssimulacra2(str(sp), str(dp))
            vectors.append({
                "ref": sname, "dist": f"{sname}-{vname}",
                "w": src.width, "h": src.height,
                "score": round(float(score), 6),
            })
            print(f"{sname:10} {vname:10} {score:8.3f}", flush=True)

    (OUT / "vectors.json").write_text(json.dumps(vectors, indent=1))
    print(f"\n{len(vectors)} vectors written")


if __name__ == "__main__":
    main()
