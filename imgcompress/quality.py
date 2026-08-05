"""Perceptual quality measurement.

Two metrics are available:

**SSIMULACRA 2** (default when installed) is the metric the image-compression
community converged on. It works in XYB colour space, is multi-scale, and looks
at chroma as well as luma. On the CID22 human-opinion dataset it correlates with
what people actually see at r~0.88, versus ~0.76 for SSIM. Its published scale:

    90  distortion not noticeable in a flicker test at 1:1  ("visually lossless")
    85  imperceptible when A/B toggling
    80  imperceptible side by side
    70  perceptible but not annoying
    50  slightly annoying
    30  obvious and annoying

**SSIM** is the fallback: numpy-only, several times faster, but luma-only - so
it is structurally blind to chroma damage - and it is aggregated here at the
5th percentile rather than the mean. The mean is easy to game: a large flat
background drags the average up while the subject of the image falls apart. The
percentile thresholds the worst regions instead, which is what you actually care
about.

Neither metric is evaluated on a downscaled copy. Compression artefacts live at
native resolution; scoring a shrunk version hides exactly what you are looking
for. Large images are instead sampled as full-resolution tiles.
"""

from __future__ import annotations

import io

import numpy as np
from PIL import Image

try:  # optional, much better metric
    from ssimulacra2 import compute_ssimulacra2 as _ss2

    HAVE_SSIMULACRA2 = True
except Exception:  # pragma: no cover - depends on install
    HAVE_SSIMULACRA2 = False

# SSIM constants for 8-bit data (Wang et al. 2004)
_C1 = (0.01 * 255) ** 2
_C2 = (0.03 * 255) ** 2
_WINDOW = 8

# Tiling for the search phase
_TILE = 512
_TILE_BUDGET = 1_200_000


# --------------------------------------------------------------------------- #
# SSIM
# --------------------------------------------------------------------------- #


def has_alpha(img: Image.Image) -> bool:
    return img.mode in ("RGBA", "LA", "PA") or "transparency" in img.info


def flatten(img: Image.Image, background) -> Image.Image:
    """Composite over an opaque background so transparent pixels are comparable.

    Fully transparent pixels carry arbitrary RGB. Converting straight to RGB
    compares that garbage against different garbage and produces nonsense
    scores, so compositing has to happen explicitly - the upstream ssimulacra2
    package has a dead alpha branch and gets this wrong.
    """
    if not has_alpha(img):
        return img.convert("RGB")
    rgba = img.convert("RGBA")
    backdrop = Image.new("RGBA", rgba.size, tuple(background) + (255,))
    return Image.alpha_composite(backdrop, rgba).convert("RGB")


# Transparent artwork is judged against a dark and a light backdrop, and the
# worse of the two wins - a halo you cannot see on white is still a defect.
_BACKDROPS = ((26, 26, 26), (230, 230, 230))


def _to_luma(img: Image.Image) -> np.ndarray:
    if has_alpha(img):
        img = flatten(img, (128, 128, 128))
    return np.asarray(img.convert("L"), dtype=np.float64)


def _box_mean(arr: np.ndarray, win: int) -> np.ndarray:
    pad = np.zeros((arr.shape[0] + 1, arr.shape[1] + 1), dtype=np.float64)
    pad[1:, 1:] = arr.cumsum(axis=0).cumsum(axis=1)
    total = pad[win:, win:] - pad[:-win, win:] - pad[win:, :-win] + pad[:-win, :-win]
    return total / float(win * win)


def ssim_map(reference: Image.Image, candidate: Image.Image, win: int = _WINDOW) -> np.ndarray:
    a = _to_luma(reference)
    if candidate.size != reference.size:
        candidate = candidate.resize(reference.size, Image.LANCZOS)
    b = _to_luma(candidate)

    if min(a.shape) < win:
        win = max(2, min(a.shape))

    mu_a, mu_b = _box_mean(a, win), _box_mean(b, win)
    var_a = np.maximum(_box_mean(a * a, win) - mu_a * mu_a, 0.0)
    var_b = np.maximum(_box_mean(b * b, win) - mu_b * mu_b, 0.0)
    cov = _box_mean(a * b, win) - mu_a * mu_b

    numerator = (2 * mu_a * mu_b + _C1) * (2 * cov + _C2)
    denominator = (mu_a**2 + mu_b**2 + _C1) * (var_a + var_b + _C2)
    return numerator / denominator


def _aggregate(smap: np.ndarray, percentile: float) -> float:
    if percentile and percentile > 0:
        return float(np.percentile(smap, percentile))
    return float(np.mean(smap))


def ssim(reference: Image.Image, candidate: Image.Image, percentile: float = 5.0) -> float:
    """Percentile-aggregated SSIM. percentile <= 0 gives the plain mean."""
    if has_alpha(reference) or has_alpha(candidate):
        return min(
            _aggregate(ssim_map(flatten(reference, bg), flatten(candidate, bg)), percentile)
            for bg in _BACKDROPS
        )
    return _aggregate(ssim_map(reference, candidate), percentile)


# --------------------------------------------------------------------------- #
# SSIMULACRA 2
# --------------------------------------------------------------------------- #


def _as_png(img: Image.Image) -> io.BytesIO:
    buf = io.BytesIO()
    img.save(buf, "PNG", compress_level=1)
    buf.seek(0)
    return buf


def ssimulacra2(reference: Image.Image, candidate: Image.Image) -> float:
    if not HAVE_SSIMULACRA2:
        raise RuntimeError("ssimulacra2 is not installed")
    if candidate.size != reference.size:
        candidate = candidate.resize(reference.size, Image.LANCZOS)
    if has_alpha(reference) or has_alpha(candidate):
        return min(
            float(_ss2(_as_png(flatten(reference, bg)), _as_png(flatten(candidate, bg))))
            for bg in _BACKDROPS
        )
    return float(_ss2(_as_png(reference), _as_png(candidate)))


# --------------------------------------------------------------------------- #
# unified metric interface
# --------------------------------------------------------------------------- #


class Metric:
    """A perceptual metric plus the thresholds that make sense for it."""

    def __init__(self, name: str):
        self.name = name

    @property
    def default_target(self) -> float:
        return 90.0 if self.name == "ssimulacra2" else 0.97

    @property
    def perfect(self) -> float:
        return 100.0 if self.name == "ssimulacra2" else 1.0

    def valid_target(self, value: float) -> bool:
        return (0 < value <= 100) if self.name == "ssimulacra2" else (0 < value <= 1.0)

    def score(self, reference: Image.Image, candidate: Image.Image) -> float:
        if self.name == "ssimulacra2":
            return ssimulacra2(reference, candidate)
        return ssim(reference, candidate)

    def score_sampled(
        self,
        reference: Image.Image,
        candidate: Image.Image,
        tile: int = _TILE,
        budget: int = _TILE_BUDGET,
    ) -> float:
        """Cheaper estimate for the inner search loop.

        Scores a deterministic grid of native-resolution tiles instead of the
        whole frame. Measured drift versus the full-image score is under ~0.5
        SSIMULACRA2 points anywhere near the useful thresholds.
        """
        width, height = reference.size
        if width * height <= budget or min(width, height) < tile:
            return self.score(reference, candidate)

        if candidate.size != reference.size:
            candidate = candidate.resize(reference.size, Image.LANCZOS)

        wanted = max(2, budget // (tile * tile))
        cols = max(1, min(3, width // tile, wanted))
        rows = max(1, min(2, height // tile, max(1, wanted // max(1, cols))))

        scores = []
        for row in range(rows):
            for col in range(cols):
                left = (width - tile) * col // (cols - 1) if cols > 1 else (width - tile) // 2
                top = (height - tile) * row // (rows - 1) if rows > 1 else (height - tile) // 2
                box = (left, top, left + tile, top + tile)
                scores.append(self.score(reference.crop(box), candidate.crop(box)))
        return float(sum(scores) / len(scores))


def default_metric_name() -> str:
    return "ssimulacra2" if HAVE_SSIMULACRA2 else "ssim"


def get_metric(name: str | None = None) -> Metric:
    name = name or default_metric_name()
    if name == "ssimulacra2" and not HAVE_SSIMULACRA2:
        raise RuntimeError(
            "ssimulacra2 is not installed - run: pip install ssimulacra2 scipy"
        )
    if name not in ("ssimulacra2", "ssim"):
        raise ValueError(f"unknown metric: {name}")
    return Metric(name)
