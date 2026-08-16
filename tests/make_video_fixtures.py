"""Build the video benchmark corpus.

Four clips, chosen the same way the image fixtures were: because they push an
encoder in different directions, and because the right answer genuinely
differs between them.

- `motion`    a moving gradient with gentle grain. The ordinary case: real
              detail, real movement, compresses well but not trivially.
- `screen`    a static background with a few blocks that change. What a screen
              recording looks like to an encoder, and the case where AV1's
              lead over H.264 is largest.
- `grain`     heavy sensor-style noise. The hard case: noise is incompressible
              by construction, so this is where a quality floor becomes
              genuinely expensive and where a size cap has to give something
              up. A corpus without it would make the engine look better than
              it is.
- `still`     a nearly-static shot. The case where a compressor can win by a
              factor of ten, and where a naive bitrate-per-second rule wastes
              almost everything it spends.

Short and small on purpose - these exist so the tests can run in a minute, not
to prove anything about 4K. Reproduce with:

    python tests/make_video_fixtures.py
"""

from __future__ import annotations

import sys
from fractions import Fraction
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE / "video_fixtures"

WIDTH, HEIGHT, FPS, SECONDS = 480, 270, 24, 3


def _writer(av, path, fps=FPS):
    container = av.open(str(path), "w")
    stream = container.add_stream("libx264", rate=fps)
    stream.width, stream.height = WIDTH, HEIGHT
    stream.pix_fmt = "yuv420p"
    # Near-lossless on purpose, and the reason is not fussiness. A fixture
    # written at an ordinary quality is already a compressed file, so the
    # engine under test is asked to beat a good encode of a good encode and
    # correctly refuses - which measures nothing except that the fixture was
    # small. Real footage off a camera or a phone arrives with far more
    # headroom than that, and the corpus has to look like the input the tool
    # actually receives.
    stream.options = {"crf": "4", "preset": "veryfast"}
    return container, stream


def _write(av, np, path, frame_fn, fps=FPS, seconds=SECONDS):
    container, stream = _writer(av, path, fps)
    for index in range(int(fps * seconds)):
        array = frame_fn(index / float(fps), index)
        frame = av.VideoFrame.from_ndarray(
            np.clip(array, 0, 255).astype(np.uint8), format="rgb24"
        )
        frame.pts = int(index * (90000 / fps))
        frame.time_base = Fraction(1, 90000)
        for packet in stream.encode(frame.reformat(format="yuv420p")):
            container.mux(packet)
    for packet in stream.encode():
        container.mux(packet)
    container.close()


def build(out_dir=OUT) -> list:
    import av
    import numpy as np

    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    yy, xx = np.mgrid[0:HEIGHT, 0:WIDTH].astype(np.float32)
    rng = np.random.default_rng(11)
    made = []

    def motion(t, _i):
        img = np.empty((HEIGHT, WIDTH, 3), np.float32)
        img[..., 0] = 128 + 90 * np.sin(xx / 48.0 + t * 2.2)
        img[..., 1] = 128 + 90 * np.sin(yy / 34.0 - t * 1.7)
        img[..., 2] = 128 + 80 * np.sin((xx + yy) / 60.0 + t)
        return img + rng.normal(0, 1.2, img.shape)

    def screen(t, _i):
        img = np.full((HEIGHT, WIDTH, 3), 244.0, np.float32)
        img[0:26, :, :] = 32.0                      # a title bar
        for row in range(6):
            top = 44 + row * 34
            img[top:top + 18, 24:24 + 300 - row * 18, :] = 90.0   # text-ish
        blink = int(t * 2) % 2
        img[150:210, 340:450, :] = 60.0 if blink else 200.0
        return img

    def grain(t, _i):
        base = np.full((HEIGHT, WIDTH, 3), 118.0, np.float32)
        base[..., 0] += 40 * np.sin(xx / 90.0 + t)
        return base + rng.normal(0, 22, base.shape)

    def still(t, _i):
        img = np.empty((HEIGHT, WIDTH, 3), np.float32)
        img[..., 0] = 60 + 40 * (xx / WIDTH)
        img[..., 1] = 90 + 30 * (yy / HEIGHT)
        img[..., 2] = 150
        # One small thing moves, so it is a video and not a slideshow.
        x = int(20 + (WIDTH - 60) * (t / float(SECONDS)))
        img[120:150, x:x + 30, :] = 240
        return img

    for name, fn in (("motion", motion), ("screen", screen),
                     ("grain", grain), ("still", still)):
        path = out_dir / f"{name}.mp4"
        _write(av, np, path, fn)
        made.append(path)
    return made


def main() -> int:
    try:
        import av  # noqa: F401
        import numpy  # noqa: F401
    except Exception:
        print("video fixtures need PyAV and numpy: "
              'pip install "pocketsize[video]"', file=sys.stderr)
        return 1
    for path in build():
        print(f"{path.name:>12}  {path.stat().st_size:>9,} bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
