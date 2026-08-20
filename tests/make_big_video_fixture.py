"""A video big enough to be the problem, built rather than downloaded.

The four fixtures in tests/video_fixtures are all small on purpose: they make
the correctness tests fast, and correctness is what they exist for. None of
them can show the failure this file exists for. The owner froze a laptop with a
300 MB video, and a 8 MB fixture cannot reproduce that - the peak memory of a
video job scales with the frame size, the duration and the number of encodes,
and the small corpus is small in all three.

So this builds one deliberately awkward clip: 1080p, long enough that the
sampler picks several windows, and grainy enough that the encoder cannot cheat
its way to a tiny file. It is NOT committed - it is several hundred megabytes,
and a repository is not a place to keep one. Build it when you need it:

    python tests/make_big_video_fixture.py

Written next to the small corpus, and gitignored by name.
"""

from __future__ import annotations

import sys
from pathlib import Path

OUT = Path(__file__).resolve().parent / "video_fixtures"
NAME = "big.mp4"

# 1080p, because that is the shape a phone or a screen recorder produces and
# the frame cost is what drives the decoded-frame memory this probe measures.
WIDTH, HEIGHT = 1920, 1080
FPS = 30
# Tuned to land near the 300 MB the owner actually froze a laptop with. Grain
# at crf 8 costs roughly 30 MB/s of 1080p, so ten seconds is the neighbourhood;
# the exact size is printed and the probe reads it off the file rather than
# assuming it.
SECONDS = 10


def build(out_dir: Path = OUT, seconds: int = SECONDS) -> Path:
    import av
    import numpy as np

    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / NAME

    container = av.open(str(path), mode="w")
    stream = container.add_stream("libx264", rate=FPS)
    stream.width, stream.height = WIDTH, HEIGHT
    stream.pix_fmt = "yuv420p"
    # Near-lossless on purpose. A fixture written at an ordinary quality is
    # already a compressed file, so the engine correctly refuses to beat it and
    # the measurement becomes a measurement of the fixture. The small corpus
    # learned this the hard way - it is recorded in the video plan.
    stream.options = {"crf": "8", "preset": "veryfast"}

    rng = np.random.default_rng(7)
    total = FPS * seconds
    for index in range(total):
        # Moving gradient plus fresh grain every frame: the gradient gives the
        # encoder real motion to track, and the grain denies it an easy win.
        t = index / FPS
        base = np.linspace(0, 255, WIDTH, dtype=np.float32)
        frame_data = np.tile(base, (HEIGHT, 1))
        frame_data = (frame_data + t * 40.0) % 255.0
        grain = rng.integers(0, 40, (HEIGHT, WIDTH), dtype=np.uint8)
        plane = (frame_data.astype(np.uint8) // 2) + grain
        rgb = np.stack([plane, plane, plane], axis=2)

        frame = av.VideoFrame.from_ndarray(rgb, format="rgb24")
        for packet in stream.encode(frame):
            container.mux(packet)
        if index % (FPS * 10) == 0:
            print(f"  {index}/{total} frames", flush=True)

    for packet in stream.encode():
        container.mux(packet)
    container.close()
    return path


def main() -> int:
    try:
        path = build()
    except ImportError:
        print("needs the video extra: pip install -e .[video]", file=sys.stderr)
        return 1
    size = path.stat().st_size
    print(f"wrote {path} ({size / 1024 / 1024:.1f} MB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
