"""Matched-quality comparison against version 1 of this tool.

Version 1 is re-implemented here exactly as it shipped: WebP output, quality
chosen by binary search on *mean luminance* SSIM with a 0.985 floor, plus a
lossless-WebP challenger for low-colour images.

Comparing raw sizes would be meaningless - the two versions aim at different
quality levels. So for each fixture this measures what v1 actually delivered on
the SSIMULACRA 2 scale, then asks v2 to hit that same number, and compares the
resulting file sizes. Same quality, different bytes.

    python tests/make_fixtures.py && python tests/bench_versions.py
"""

import io
import sys
import warnings
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

from imgcompress import encoders as enc  # noqa: E402
from imgcompress.core import _decode, _search_one  # noqa: E402
from imgcompress.quality import HAVE_SSIMULACRA2, get_metric, ssim_map  # noqa: E402

warnings.simplefilter("ignore", UserWarning)
FIXTURES = Path(__file__).resolve().parent / "fixtures"


def v1_compress(img, target=0.985):
    """Version 1, faithfully: WebP, mean-luma-SSIM search, lossless challenger."""

    def probe(q):
        buf = io.BytesIO()
        img.save(buf, "WEBP", quality=q, method=6)
        data = buf.getvalue()
        return float(np.mean(ssim_map(img, _decode(data)))), data

    lo, hi = 45, 95
    score, data = probe(hi)
    if score >= target:
        while lo <= hi:
            mid = (lo + hi) // 2
            s2, d2 = probe(mid)
            if s2 >= target:
                data, hi = d2, mid - 1
            else:
                lo = mid + 1
    if img.getcolors(maxcolors=8192) is not None:
        buf = io.BytesIO()
        img.save(buf, "WEBP", lossless=True, method=6)
        if len(buf.getvalue()) < len(data):
            data = buf.getvalue()
    return data


def v2_at(img, target, names):
    best = None
    metric = get_metric("ssimulacra2")
    for encoder in enc.build(names):
        if img.mode == "RGBA" and not encoder.supports_alpha:
            continue
        found = _search_one(img, encoder, metric, target, fast=False)
        if not found:
            continue
        data, _, score = found
        if score < target and best is not None:
            continue
        if best is None or len(data) < len(best[0]):
            best = (data, encoder.name)
    return best


def main() -> int:
    if not HAVE_SSIMULACRA2:
        print("Needs ssimulacra2: pip install -r requirements.txt")
        return 2
    files = sorted(FIXTURES.glob("*.png"))
    if not files:
        print("No fixtures. Run: python tests/make_fixtures.py")
        return 2

    metric = get_metric("ssimulacra2")
    totals = {"v1": 0, "figma": 0, "web": 0}

    print(f"{'image':<16}{'v1 (webp)':>12}{'ss2':>7}"
          f"{'v2 figma':>12}{'fmt':>7}{'v2 web':>11}{'fmt':>7}")
    for path in files:
        with Image.open(path) as opened:
            img = opened.convert("RGBA" if opened.mode in ("RGBA", "LA") else "RGB")

        v1 = v1_compress(img)
        delivered = metric.score(img, _decode(v1))

        figma = v2_at(img, delivered, enc.TARGETS["figma"])
        web = v2_at(img, delivered, enc.TARGETS["web"])

        totals["v1"] += len(v1)
        totals["figma"] += len(figma[0])
        totals["web"] += len(web[0])
        print(f"{path.name:<16}{len(v1) / 1024:>9,.1f} KB{delivered:>7.1f}"
              f"{len(figma[0]) / 1024:>9,.1f} KB{figma[1]:>7}"
              f"{len(web[0]) / 1024:>8,.1f} KB{web[1]:>7}")

    print(f"\n{'TOTAL':<16}{totals['v1'] / 1024:>9,.1f} KB{'':>7}"
          f"{totals['figma'] / 1024:>9,.1f} KB{'':>7}{totals['web'] / 1024:>8,.1f} KB")
    print(f"{'vs v1':<16}{'100%':>12}{'':>7}"
          f"{100 * totals['figma'] / totals['v1']:>11.0f}%{'':>7}"
          f"{100 * totals['web'] / totals['v1']:>10.0f}%")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
