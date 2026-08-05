"""Head-to-head against the alternatives, at matched perceptual quality.

The rule from CONTRIBUTING.md applies to comparisons as much as to changes: a
smaller file at a lower score is not a better compressor, it is a different
setting. So every strategy here is searched to the *same* measured floor and
only then compared on bytes.

Design
------
1. Each source image is normalised once - capped at 2560px, metadata stripped -
   and written as a lossless PNG. Every strategy then compresses those exact
   pixels, so nobody wins by resizing differently.
2. Every strategy is searched for the smallest file that clears
   SSIMULACRA 2 >= 90 - the app's default floor and the metric's published
   "not noticeable in a flicker test" line. Fixed-quality strategies are
   included unsearched on purpose, to show what guessing costs.
3. Every result is also scored with SSIM p5 as a second witness. Two metrics
   agreeing is how you know a strategy compressed better rather than gaming
   the one number the search watched.

The web app's own output is not produced here - it is written by
`bench_web_out.mjs`, which drives the real page in a real browser - but it is
scored by the same two metrics as everything else.

    python tests/bench_vs_alternatives.py [--corpus DIR] [--web DIR]
"""

from __future__ import annotations

import argparse
import io
import sys
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from PIL import Image  # noqa: E402

from imgcompress import Settings, compress  # noqa: E402
from imgcompress import encoders as enc  # noqa: E402
from imgcompress.quality import HAVE_SSIMULACRA2, ssim, ssimulacra2  # noqa: E402

FLOOR = 90.0          # SSIMULACRA 2, the app's default quality floor
MAX_DIM = 2560        # the app's default dimension cap


# --------------------------------------------------------------------------- #
# scoring
# --------------------------------------------------------------------------- #

def score_ssim(ref: Image.Image, data: bytes) -> float:
    with Image.open(io.BytesIO(data)) as cand:
        cand.load()
        return ssim(ref, cand, percentile=5.0)


def score_ss2(ref: Image.Image, data: bytes) -> float | None:
    if not HAVE_SSIMULACRA2:
        return None
    with Image.open(io.BytesIO(data)) as cand:
        cand.load()
        try:
            return ssimulacra2(ref, cand)
        except Exception:
            return None


# --------------------------------------------------------------------------- #
# encoders under test
# --------------------------------------------------------------------------- #

def jpeg_bytes(img: Image.Image, q: int, mozjpeg: bool = True) -> bytes:
    """4:4:4 JPEG, optionally through mozjpeg's lossless pass - i.e. exactly
    what a careful engineer would produce by hand."""
    flat = img
    if img.mode == "RGBA":
        backdrop = Image.new("RGBA", img.size, (255, 255, 255, 255))
        flat = Image.alpha_composite(backdrop, img).convert("RGB")
    elif img.mode != "RGB":
        flat = img.convert("RGB")
    buf = io.BytesIO()
    flat.save(buf, "JPEG", quality=q, optimize=True, progressive=True, subsampling="4:4:4")
    out = buf.getvalue()
    if mozjpeg:
        try:
            import mozjpeg_lossless_optimization as moz
            better = moz.optimize(out)
            if len(better) < len(out):
                out = better
        except Exception:
            pass
    return out


def jpeg_420_bytes(img: Image.Image, q: int) -> bytes:
    """The same, but with chroma subsampling left on - the industry default."""
    flat = img.convert("RGB") if img.mode != "RGB" else img
    if img.mode == "RGBA":
        backdrop = Image.new("RGBA", img.size, (255, 255, 255, 255))
        flat = Image.alpha_composite(backdrop, img).convert("RGB")
    buf = io.BytesIO()
    flat.save(buf, "JPEG", quality=q, optimize=True, progressive=True, subsampling="4:2:0")
    return buf.getvalue()


def webp_bytes(img: Image.Image, q: int) -> bytes:
    buf = io.BytesIO()
    img.save(buf, "WEBP", quality=q, method=6)
    return buf.getvalue()


def avif_bytes(img: Image.Image, q: int) -> bytes:
    buf = io.BytesIO()
    img.save(buf, "AVIF", quality=q, speed=4)
    return buf.getvalue()


def png8_bytes(img: Image.Image, colors: int, zopfli: bool = True) -> bytes:
    """libimagequant - the engine inside pngquant and ImageOptim - plus zopfli.
    This is the strongest palette pipeline in common use."""
    e = enc.Png8Encoder(zopfli=zopfli)
    return e.encode(img, colors, fast=not zopfli)


def png_lossless_bytes(img: Image.Image, zopfli: bool = True) -> bytes:
    return enc.PngEncoder(zopfli=zopfli).encode(img, 100, fast=not zopfli)


# --------------------------------------------------------------------------- #
# search: smallest output that clears the floor
# --------------------------------------------------------------------------- #

def search(ref: Image.Image, make, ladder) -> tuple[bytes | None, int | None]:
    """Bisect an ascending quality ladder for the smallest passing encode."""
    best: tuple[bytes, int] | None = None
    lo, hi = 0, len(ladder) - 1
    while lo <= hi:
        mid = (lo + hi) // 2
        try:
            data = make(ladder[mid])
        except Exception:
            lo = mid + 1
            continue
        if (score_ss2(ref, data) or 0.0) >= FLOOR:
            best = (data, ladder[mid])
            hi = mid - 1
        else:
            lo = mid + 1
    return best if best else (None, None)


JPEG_LADDER = [40, 50, 58, 65, 70, 74, 78, 82, 85, 88, 90, 92, 94, 96, 97, 98, 99]
WEBP_LADDER = [40, 50, 58, 65, 70, 75, 80, 84, 87, 90, 92, 94, 96, 98]
AVIF_LADDER = [30, 38, 45, 52, 58, 64, 70, 76, 82, 88, 93, 97]
PNG8_LADDER = [8, 16, 24, 32, 48, 64, 96, 128, 192, 256]


@dataclass
class Result:
    strategy: str
    fmt: str
    data: bytes
    setting: str
    searched: bool


def strategies(ref: Image.Image, web: dict[str, bytes]) -> list[Result]:
    out: list[Result] = []
    has_alpha = ref.mode in ("RGBA", "LA", "P") and "transparency" in ref.info or ref.mode == "RGBA"

    # -- what this project produces ---------------------------------------- #
    for label, data in web.items():
        kind = Image.open(io.BytesIO(data)).format or "?"
        out.append(Result(label, kind.lower(), data, "measured floor", True))

    buf = io.BytesIO()
    ref.save(buf, "PNG", compress_level=1)
    res = compress_from_bytes(buf.getvalue())
    if res is not None:
        out.append(Result("imgcompress desktop", res[1], res[0], "measured floor", True))

    # -- single format, done properly, searched to the same floor ---------- #
    if not has_alpha:
        d, q = search(ref, lambda q: jpeg_bytes(ref, q), JPEG_LADDER)
        if d:
            out.append(Result("mozjpeg 4:4:4 only", "jpeg", d, f"q{q}", True))
        d, q = search(ref, lambda q: jpeg_420_bytes(ref, q), JPEG_LADDER)
        if d:
            out.append(Result("JPEG 4:2:0 only", "jpeg", d, f"q{q}", True))

    d, q = search(ref, lambda q: webp_bytes(ref, q), WEBP_LADDER)
    if d:
        out.append(Result("WebP only", "webp", d, f"q{q}", True))

    d, q = search(ref, lambda q: avif_bytes(ref, q), AVIF_LADDER)
    if d:
        out.append(Result("AVIF only", "avif", d, f"q{q}", True))

    d, c = search(ref, lambda c: png8_bytes(ref, c), PNG8_LADDER)
    if d:
        out.append(Result("pngquant + zopfli", "png8", d, f"{c} colours", True))

    d = png_lossless_bytes(ref)
    out.append(Result("PNG lossless + zopfli", "png", d, "lossless", True))

    # -- guessing a number, which is what most tools ask you to do --------- #
    if not has_alpha:
        out.append(Result("JPEG q75 (a common default)", "jpeg", jpeg_420_bytes(ref, 75), "q75", False))
        out.append(Result("JPEG q85 (a common default)", "jpeg", jpeg_420_bytes(ref, 85), "q85", False))
    out.append(Result("WebP q75 (a common default)", "webp", webp_bytes(ref, 75), "q75", False))
    out.append(Result("AVIF q50 (a common default)", "avif", avif_bytes(ref, 50), "q50", False))
    return out


def compress_from_bytes(png: bytes) -> tuple[bytes, str] | None:
    """Run the repo's own desktop bake-off over an in-memory PNG."""
    import tempfile
    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / "ref.png"
        src.write_bytes(png)
        res = compress(src, Settings(
            target="web", max_dimension=0, metric="ssimulacra2",
            quality_target=FLOOR, fast=False,
        ))
        if res.error or not res.data:
            return None
        return res.data, res.fmt or "?"


# --------------------------------------------------------------------------- #
# driver
# --------------------------------------------------------------------------- #

def normalise(path: Path, out_dir: Path) -> Path:
    """Cap dimensions and strip metadata once, so every strategy sees the same
    pixels and nobody wins by downscaling harder."""
    with Image.open(path) as im:
        im.load()
        img = im.convert("RGBA" if im.mode in ("RGBA", "LA", "PA") else "RGB")
        if max(img.size) > MAX_DIM:
            scale = MAX_DIM / max(img.size)
            img = img.resize((round(img.width * scale), round(img.height * scale)),
                             Image.LANCZOS)
        dest = out_dir / (path.stem + ".png")
        img.save(dest, "PNG", compress_level=1)
    return dest


def human(n: int) -> str:
    v = float(n)
    for unit in ("B", "KB", "MB"):
        if v < 1024 or unit == "MB":
            return f"{v:,.0f} {unit}" if unit == "B" else f"{v:,.1f} {unit}"
        v /= 1024
    return f"{v:.1f} MB"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus", default="tests/bench_corpus")
    ap.add_argument("--web", default="tests/bench_web_out")
    ap.add_argument("--out", default="tests/BENCHMARK.md")
    args = ap.parse_args()

    corpus = Path(args.corpus)
    sources = sorted(p for p in corpus.iterdir()
                     if p.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"})
    if not sources:
        print(f"no images in {corpus}", file=sys.stderr)
        return 2

    ref_dir = corpus.parent / "bench_ref"
    ref_dir.mkdir(parents=True, exist_ok=True)
    web_root = Path(args.web)

    lines: list[str] = []
    lines.append("# Head-to-head, at matched perceptual quality\n")
    lines.append(f"Every strategy below is searched for the **smallest file that still scores "
                 f"SSIMULACRA 2 >= {FLOOR:g}** against the same normalised source — the metric the "
                 "image-compression community converged on, at its published 'not noticeable in a "
                 "flicker test' line — so the comparison is bytes-at-equal-quality rather than "
                 "bytes alone. Fixed-quality rows are *not* searched; they show what guessing a "
                 "number costs.\n")
    lines.append("`SSIM p5` is reported as a second witness. Two metrics agreeing is how you know "
                 "a strategy compressed better rather than gaming the number the search watched.\n")
    lines.append("Reproduce: `python tests/bench_vs_alternatives.py`\n")

    for src in sources:
        ref_path = normalise(src, ref_dir)
        with Image.open(ref_path) as im:
            im.load()
            ref = im.copy()
        orig_bytes = src.stat().st_size
        ref_bytes = ref_path.stat().st_size

        web: dict[str, bytes] = {}
        for target_dir, label in (("figma", "imgcompress web (Figma target)"),
                                  ("web", "imgcompress web (Web target)")):
            d = web_root / target_dir
            if not d.is_dir():
                continue
            hits = [p for p in d.iterdir() if p.stem.split(".")[0] == ref_path.stem]
            if hits:
                web[label] = hits[0].read_bytes()

        print(f"\n=== {src.name}  {ref.size[0]}x{ref.size[1]}  "
              f"source {human(orig_bytes)}  reference {human(ref_bytes)} ===", flush=True)
        rows = []
        for r in strategies(ref, web):
            s2 = score_ss2(ref, r.data) or 0.0
            s = score_ssim(ref, r.data)
            rows.append((r, s2, s))
            print(f"  {r.strategy:32} {r.fmt:5} {human(len(r.data)):>10}  "
                  f"ss2 {s2:5.1f}  ssim {s:.4f}  "
                  f"{'' if s2 >= FLOOR else 'BELOW FLOOR'}", flush=True)

        passing = [x for x in rows if x[1] >= FLOOR]
        winner = min(passing, key=lambda x: len(x[0].data)) if passing else None

        lines.append(f"\n## {src.name} — {ref.size[0]}x{ref.size[1]}\n")
        lines.append(f"Source {human(orig_bytes)}; normalised reference {human(ref_bytes)}.\n")
        lines.append("| Strategy | Format | Setting | Size | vs best | SSIMULACRA 2 | SSIM p5 | Clears floor |")
        lines.append("| --- | --- | --- | --- | --- | --- | --- | --- |")
        for r, s2, s in sorted(rows, key=lambda x: len(x[0].data)):
            rel = "—"
            if winner:
                w = len(winner[0].data)
                rel = "best" if r is winner[0] else f"+{100 * (len(r.data) - w) / w:.0f}%"
            mark = "yes" if s2 >= FLOOR else "**no**"
            star = " **←**" if winner and r is winner[0] else ""
            lines.append(f"| {r.strategy}{star} | {r.fmt} | {r.setting} | {human(len(r.data))} "
                         f"| {rel} | {s2:.1f} | {s:.4f} | {mark} |")

    Path(args.out).write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"\nwritten to {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
