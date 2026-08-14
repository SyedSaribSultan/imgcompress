"""Reproduce the format bake-off claims in the README.

For every fixture and every candidate encoder, binary-search the smallest file
that still scores at or above a given SSIMULACRA2 target, then print the table.
Every candidate is scored with SSIMULACRA2 regardless of what it optimises for,
so no encoder is graded on its own homework.

    python tests/make_fixtures.py && python tests/bench_formats.py
"""

import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import warnings  # noqa: E402

from PIL import Image  # noqa: E402

from pocketsize import encoders as enc  # noqa: E402
from pocketsize.core import _decode  # noqa: E402
from pocketsize.quality import HAVE_SSIMULACRA2, get_metric  # noqa: E402

warnings.simplefilter("ignore", UserWarning)

FIXTURES = Path(__file__).resolve().parent / "fixtures"
TARGETS = [90.0, 80.0]
CANDIDATES = ["jpeg", "png8", "png", "webp", "webp-lossless"]


def job(args):
    path, name, target = args
    metric = get_metric("ssimulacra2")
    with Image.open(path) as opened:
        img = opened.convert("RGBA" if opened.mode in ("RGBA", "LA") else "RGB")
    encoder = enc.build([name])[0]
    if img.mode == "RGBA" and not encoder.supports_alpha:
        return None

    levels = encoder.levels
    best = None
    if encoder.lossless:
        data = encoder.encode(img, levels[-1])
        return (path.name, name, target, len(data), "lossless")

    lo, hi = 0, len(levels) - 1
    while lo <= hi:
        mid = (lo + hi) // 2
        data = encoder.encode(img, levels[mid])
        score = metric.score_sampled(img, _decode(data))
        if score >= target:
            if best is None or len(data) < best[0]:
                best = (len(data), levels[mid], score)
            hi = mid - 1
        else:
            lo = mid + 1
    if best is None:
        return None
    return (path.name, name, target, best[0], f"q{best[1]} ss2={best[2]:.1f}")


def main() -> int:
    if not HAVE_SSIMULACRA2:
        print("This benchmark needs ssimulacra2: pip install -r requirements.txt")
        return 2
    files = sorted(FIXTURES.glob("*.png"))
    if not files:
        print("No fixtures. Run: python tests/make_fixtures.py")
        return 2

    jobs = [(p, n, t) for p in files for n in CANDIDATES for t in TARGETS]
    with ProcessPoolExecutor() as pool:
        rows = [r for r in pool.map(job, jobs) if r]

    for path in files:
        print(f"\n=== {path.name}   source {path.stat().st_size / 1024:,.0f} KB ===")
        for target in TARGETS:
            entries = sorted((s, n, note) for (f, n, t, s, note) in rows
                             if f == path.name and t == target)
            if not entries:
                continue
            print(f"  -- SSIMULACRA2 >= {target:.0f} --")
            for size, name, note in entries:
                print(f"     {name:<16}{size / 1024:>9,.1f} KB   {note}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
