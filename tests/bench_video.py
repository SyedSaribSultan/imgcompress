"""Head-to-head for video, at matched perceptual quality.

The rule this file exists to obey is in CONTRIBUTING.md: a smaller file at a
lower score is not an improvement, it is a different setting. So every
strategy that *can* be searched is searched to the same measured floor against
the same source, and the comparison is bytes-at-equal-quality rather than
bytes alone.

The fixed-setting rows are deliberately **not** searched. They are what a
person gets by taking the advice the internet gives - "use CRF 23", "use the
Fast 1080p30 preset" - and they are here to show what guessing a number costs
on content that does not happen to suit it. Some of them undershoot the floor
badly and some overshoot it expensively, which is the point: one number cannot
be right for a screen recording and a grainy handheld shot at the same time.

Two metrics are reported for every row. SSIMULACRA 2 is the one the search
watches, so on its own it proves nothing - a strategy could be finding the
metric's blind spot rather than genuinely compressing better. XPSNR comes from
a different family, has published correlation with human opinion on video
rather than still images, and carries a temporal term. Two metrics agreeing is
the evidence.

    python tests/make_video_fixtures.py
    python tests/bench_video.py
"""

from __future__ import annotations

import shutil
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pocketsize import video  # noqa: E402

HERE = Path(__file__).resolve().parent
FIXTURES = HERE / "video_fixtures"
REPORT = HERE / "VIDEO_BENCHMARK.md"

FLOOR = 92.0
"""The `web` destination's floor, and the number every searched strategy is
held to so the row above and the row below mean the same thing."""

CLIPS = ("motion", "screen", "grain", "still")

# What people actually do, taken from the advice they are actually given.
FIXED = (
    ("x264 CRF 23 (the usual advice)", "h264-mp4", 23, False),
    ("x264 CRF 28 (the usual advice, smaller)", "h264-mp4", 28, False),
    ("x264 CRF 22, veryfast (a HandBrake-style fast preset)",
     "h264-mp4", 22, True),
    ("SVT-AV1 CRF 30 (a common AV1 default)", "av1-mp4", 30, False),
    ("SVT-AV1 CRF 24 (a common AV1 default, better)", "av1-mp4", 24, False),
)


def measure(source, path, width, height, windows):
    """Score a finished file the way the engine scores its own output."""
    from pocketsize import quality

    scores = []
    for start, length in windows:
        reference = video.read_frames(source, start, length,
                                      video.VERIFY_FRAMES, size=(width, height))
        candidate = video.read_frames(path, start, length,
                                      video.VERIFY_FRAMES, size=(width, height))
        for ref, cand in zip(reference, candidate):
            try:
                scores.append(quality.ssimulacra2(ref, cand))
            except Exception:
                continue
    reported, mean = video.pooled(scores)
    return reported, mean, video.xpsnr(source, path, width, height)


def run_fixed(source, info, fmt_name, crf, fast, work, windows):
    fmt = video.FORMATS[fmt_name]
    shown = video.display_shape(info)
    width, height = video.frame_for(shown[0], shown[1], 1920)
    path = work / f"fixed-{fmt_name}-{crf}-{int(fast)}.mp4"
    started = time.time()
    video.encode(
        source,
        video.EncodeSpec(fmt=fmt, width=width, height=height, crf=crf,
                         fast=fast, audio="copy", with_audio=True,
                         faststart=True, info=info),
        dest=path,
    )
    elapsed = time.time() - started
    score, mean, witness = measure(source, path, width, height, windows)
    return {
        "bytes": path.stat().st_size, "score": score, "mean": mean,
        "witness": witness, "seconds": elapsed,
    }


def run_searched(source, work, formats, slug):
    # A folder named after the label looked tidy and was a trap: the labels
    # carry markdown and punctuation, and Windows refuses `*`, `(` and `)` in
    # a path. The whole strategy then failed and simply did not appear in the
    # table, which is the worst way for a benchmark to be wrong.
    started = time.time()
    result = video.compress(source, "web", fast=False, formats=formats,
                            output_dir=work / slug)
    elapsed = time.time() - started
    if result.error or result.skipped or not result.output:
        return None
    return {
        "bytes": result.new_bytes, "score": result.score,
        "mean": result.score_mean, "witness": result.witness,
        "seconds": elapsed, "fmt": result.fmt, "crf": result.level,
    }


def bench_clip(name, work):
    source = FIXTURES / f"{name}.mp4"
    info = video.probe(source)
    windows = video.sample_windows(info.duration)
    rows = []

    for label, fmt_name, crf, fast in FIXED:
        row = run_fixed(source, info, fmt_name, crf, fast, work, windows)
        row["label"] = label
        row["setting"] = f"CRF {crf}" + (", veryfast" if fast else "")
        rows.append(row)

    for label, slug, formats in (
        ("pocketsize, H.264 only", "h264", ["h264-mp4"]),
        ("pocketsize, AV1 only", "av1", ["av1-mp4"]),
        ("**pocketsize (both, it chooses)**", "both", ["av1-mp4", "h264-mp4"]),
    ):
        row = run_searched(source, work, formats, f"{name}-{slug}")
        if row is None:
            continue
        row["label"] = label
        row["setting"] = f"searched -> {row['fmt']} CRF {row['crf']}"
        rows.append(row)

    rows.sort(key=lambda r: r["bytes"])
    return info, rows


def render(name, info, rows, original):
    passing = [r for r in rows if r["score"] >= FLOOR]
    best = min(passing, key=lambda r: r["bytes"]) if passing else None
    lines = [
        f"### {name}.mp4",
        "",
        f"{info.width}x{info.height}, {info.duration:.1f}s, "
        f"{original:,} bytes as given.",
        "",
        "| Strategy | Setting | Size | vs best | SSIMULACRA 2 | XPSNR | "
        "Clears floor |",
        "| --- | --- | ---: | ---: | ---: | ---: | :---: |",
    ]
    for row in rows:
        clears = row["score"] >= FLOOR
        ratio = (row["bytes"] / best["bytes"]) if best else 0.0
        mark = " **<-**" if best is not None and row is best else ""
        lines.append(
            f"| {row['label']}{mark} | {row['setting']} | "
            f"{row['bytes']:,} | "
            + (f"{ratio:.2f}x" if best else "-")
            + f" | {row['score']:.1f} | "
            + (f"{row['witness']:.1f} dB" if row["witness"] else "-")
            + " | " + ("yes" if clears else "**no**") + " |"
        )
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    if not video.available():
        print('video engine not installed: pip install "pocketsize[video]"',
              file=sys.stderr)
        return 1
    if not FIXTURES.exists() or not list(FIXTURES.glob("*.mp4")):
        print("build the corpus first: python tests/make_video_fixtures.py",
              file=sys.stderr)
        return 1

    work = Path(tempfile.mkdtemp(prefix="pocketsize-bench-"))
    parts = [
        "# Video benchmark",
        "",
        "Reproduce:",
        "",
        "```bash",
        "python tests/make_video_fixtures.py",
        "python tests/bench_video.py",
        "```",
        "",
        "Every strategy that can be searched is searched for the **smallest "
        f"file that still scores SSIMULACRA 2 >= {FLOOR:g}** against the same "
        "source, so the comparison is bytes-at-equal-quality rather than "
        "bytes alone. The fixed-setting rows are *not* searched: they are "
        "what taking the internet's advice costs on content it does not "
        "happen to suit.",
        "",
        "SSIMULACRA 2 is pooled worst-first (the low percentile, not the "
        "mean), because a per-frame metric cannot see time and an average "
        "hides exactly the moments a person notices. **XPSNR is reported as a "
        "second witness** - it comes from a different family and carries a "
        "temporal term, and two metrics agreeing is how you know a strategy "
        "compressed better rather than gamed the number the search watched.",
        "",
        "**Read the harder clips with this in mind.** These sources are "
        "written near-lossless on purpose, so `motion` and `grain` are close "
        "to the worst case a compressor ever meets: matching a pristine "
        "master at a visual match of 92 is a far harder ask than matching "
        "footage a camera has already compressed once, which is what a person "
        "actually hands this tool. Where no strategy clears the floor, the "
        "engine says so rather than shipping a file that quietly missed it - "
        "and the row to compare against is the fixed-setting one at a similar "
        "size, not the floor.",
        "",
    ]
    try:
        for name in CLIPS:
            source = FIXTURES / f"{name}.mp4"
            if not source.exists():
                continue
            print(f"benchmarking {name} ...", flush=True)
            info, rows = bench_clip(name, work)
            parts.append(render(name, info, rows, source.stat().st_size))
    finally:
        shutil.rmtree(work, ignore_errors=True)

    REPORT.write_text("\n".join(parts), encoding="utf-8")
    print(f"wrote {REPORT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
