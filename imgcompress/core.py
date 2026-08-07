"""The compression engine.

Strategy, in order of how much size it actually saves:

1.  Cap the pixel dimensions. A 6000px export that renders at 1200px is mostly
    wasted bytes, and inside a design tool the dimensions drive canvas memory
    more than the byte count does. How large is a property of the destination
    - see `destinations.py`.
2.  Strip metadata (EXIF, ICC, XMP).
3.  Run a **bake-off**: encode the image as JPEG *and* as palette PNG *and* as
    lossless PNG, binary-searching each one for the lowest quality that still
    clears the perceptual floor, then keep whichever candidate came out
    smallest. Which format wins is genuinely content-dependent - in testing,
    photographs went to JPEG, UI screenshots and logos to palette PNG, and a
    smooth gradient to lossless PNG - so guessing the format up front leaves a
    lot on the table.
4.  Never write a file larger than what came in.

Quality is measured, never assumed: every candidate is decoded and scored.
"""

from __future__ import annotations

import io
import os
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path

from PIL import Image, ImageOps

from . import destinations as dest
from . import encoders as enc
from .quality import Metric, get_metric

# Design sources are legitimately huge; Pillow's bomb guard is too tight.
Image.MAX_IMAGE_PIXELS = 512_000_000

SUPPORTED_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff", ".gif"}


@dataclass
class Settings:
    target: str = dest.DEFAULT
    """Where the image is going - see `destinations.py`. Decides which output
    formats are allowed and whether a dimension cap is enforced."""

    max_dimension: int = 2560
    """Longest edge in pixels. 0 disables resizing."""

    metric: str = ""
    """ssimulacra2 (default when installed) or ssim."""

    quality_target: float | None = None
    """Perceptual floor. Defaults to 90 for SSIMULACRA2, 0.97 for SSIM."""

    keep_metadata: bool = False
    zopfli: bool = True
    fast: bool = False
    """Skip the expensive final encoder passes during search."""

    formats: list[str] | None = None
    """Override the candidate list entirely."""

    jpeg_background: tuple = (255, 255, 255)


@dataclass
class CompressionResult:
    source: Path
    output: Path | None = None
    data: bytes | None = None
    """The compressed bytes. Held in memory until something writes them."""
    suffix: str = ""
    original_bytes: int = 0
    new_bytes: int = 0
    level: int | None = None
    score: float | None = None
    metric: str = ""
    fmt: str = ""
    resized_from: tuple | None = None
    resized_to: tuple | None = None
    candidates: list[tuple] = field(default_factory=list)
    skipped: bool = False
    note: str = ""
    error: str = ""
    warnings: list[str] = field(default_factory=list)

    @property
    def saved_bytes(self) -> int:
        return max(self.original_bytes - self.new_bytes, 0)

    @property
    def saved_pct(self) -> float:
        if not self.original_bytes:
            return 0.0
        return 100.0 * (self.original_bytes - self.new_bytes) / self.original_bytes


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #


def _has_alpha(img: Image.Image) -> bool:
    if img.mode in ("RGBA", "LA", "PA"):
        return img.getchannel("A").getextrema()[0] < 255
    return "transparency" in img.info


def _is_animated(img: Image.Image) -> bool:
    return getattr(img, "n_frames", 1) > 1


def _normalise(img: Image.Image, settings: Settings) -> tuple:
    img = ImageOps.exif_transpose(img)

    alpha = _has_alpha(img)
    if img.mode not in ("RGB", "RGBA"):
        img = img.convert("RGBA" if alpha else "RGB")

    original_size = img.size
    resized_to = None

    limit = settings.max_dimension or 0
    # Some destinations enforce a ceiling regardless of what was asked for -
    # design tools rescale above 4096px themselves, destructively, so the
    # choice is between our Lanczos and theirs.
    cap = dest.get(settings.target).hard_cap if dest.exists(settings.target) else 0
    if cap:
        limit = min(limit, cap) if limit else cap

    if limit and max(img.size) > limit:
        scale = limit / float(max(img.size))
        new_size = (max(1, round(img.width * scale)), max(1, round(img.height * scale)))
        img = img.resize(new_size, Image.LANCZOS)
        resized_to = new_size

    if not settings.keep_metadata:
        # Rebuild from raw pixels: fast C path, leaves EXIF/XMP/ICC behind.
        img = Image.frombytes(img.mode, img.size, img.tobytes())

    return img, original_size, resized_to


def _decode(data: bytes) -> Image.Image:
    img = Image.open(io.BytesIO(data))
    img.load()
    return img


def _search_one(
    img: Image.Image,
    encoder: enc.Encoder,
    metric: Metric,
    target: float,
    fast: bool,
) -> tuple | None:
    """Lowest level of `encoder` that clears `target`. -> (bytes, level, score)"""
    levels = encoder.levels

    if encoder.lossless or len(levels) == 1:
        data = encoder.encode(img, levels[-1], fast=fast)
        return data, None, metric.perfect

    def probe(index: int) -> float:
        data = encoder.encode(img, levels[index], fast=True)
        return metric.score_sampled(img, _decode(data))

    top = len(levels) - 1
    if probe(top) < target:
        chosen = top
    else:
        chosen = top
        lo, hi = 0, top
        while lo <= hi:
            mid = (lo + hi) // 2
            if probe(mid) >= target:
                chosen, hi = mid, mid - 1
            else:
                lo = mid + 1

    data = encoder.encode(img, levels[chosen], fast=fast)
    score = metric.score(img, _decode(data))

    # The sampled search can be marginally optimistic. If the full-frame check
    # misses, step up until it clears rather than shipping something that fails
    # the promise we just made.
    while score < target and chosen < top:
        chosen += 1
        data = encoder.encode(img, levels[chosen], fast=fast)
        score = metric.score(img, _decode(data))

    return data, levels[chosen], score


def _candidate_names(settings: Settings, has_alpha: bool) -> list[str]:
    names = settings.formats or dest.formats_for(settings.target)
    # A destination names the formats it *wants*; this machine decides which of
    # them it can write. The two are not the same list - the table offers AVIF
    # everywhere the browser engine does, and most Pillow builds cannot make one.
    names = enc.usable(names)
    if has_alpha:
        names = [n for n in names if enc.ALL[n].supports_alpha]
    return names


# --------------------------------------------------------------------------- #
# public API
# --------------------------------------------------------------------------- #


def compress(source: Path, settings: Settings) -> CompressionResult:
    """Compress into memory. Nothing is written; `result.data` holds the bytes.

    This is the form the GUI uses, so a batch can be reviewed and then saved or
    thrown away as a whole.
    """
    source = Path(source)
    result = CompressionResult(source=source)

    try:
        result.original_bytes = source.stat().st_size
    except OSError as exc:
        result.error = str(exc)
        return result

    try:
        metric = get_metric(settings.metric or None)
    except Exception as exc:
        result.error = str(exc)
        return result
    target = settings.quality_target
    if target is None:
        target = metric.default_target
    result.metric = metric.name

    try:
        with Image.open(source) as opened:
            if _is_animated(opened):
                result.data = source.read_bytes()
                result.suffix = source.suffix
                result.new_bytes = result.original_bytes
                result.skipped = True
                result.note = "animated - passed through unchanged"
                return result

            img, original_size, resized_to = _normalise(opened, settings)
    except Exception as exc:
        result.error = f"{type(exc).__name__}: {exc}"
        return result

    has_alpha = _has_alpha(img)
    names = _candidate_names(settings, has_alpha)
    if not names:
        result.error = "no candidate format can carry this image"
        return result

    # The smallest candidate that clears the floor wins. A candidate that
    # failed the floor may only ship when *nothing* cleared it - the old
    # single-`best` bookkeeping let an early failing JPEG hold the spot against
    # a later, passing lossless PNG purely because it was smaller, which is how
    # a file below the promised floor once shipped without even a warning that
    # anything better existed.
    best_passing = None
    best_failing = None
    for encoder in enc.build(names, zopfli=settings.zopfli, background=settings.jpeg_background):
        try:
            found = _search_one(img, encoder, metric, target, settings.fast)
        except Exception as exc:  # a broken candidate must not kill the file
            result.warnings.append(f"{encoder.name} failed: {type(exc).__name__}")
            continue
        if not found:
            continue
        data, level, score = found
        result.candidates.append((encoder.name, len(data), score))
        if score >= target:
            if best_passing is None or len(data) < len(best_passing[0]):
                best_passing = (data, level, score, encoder)
        elif (best_failing is None or score > best_failing[2]
              or (score == best_failing[2] and len(data) < len(best_failing[0]))):
            best_failing = (data, level, score, encoder)

    best = best_passing or best_failing
    if best is None:
        result.error = "no candidate produced usable output"
        return result

    data, level, score, encoder = best
    if score < target:
        result.warnings.append(
            f"could not reach {metric.name} {target:g}; best was {score:.1f}"
        )

    # Never ship a bigger file. The one exception is a caller who *forced* a
    # format different from the source's - that is an explicit conversion and
    # may legitimately grow. The engine's own bake-off never may: a 318 B GIF
    # must not come back as a 344 B PNG just because the container changed.
    same_container = encoder.extension.lower() == source.suffix.lower()
    forced_conversion = bool(settings.formats) and not same_container
    if len(data) >= result.original_bytes and resized_to is None and not forced_conversion:
        result.data = source.read_bytes()
        result.suffix = source.suffix
        result.new_bytes = result.original_bytes
        result.skipped = True
        result.note = "already well compressed - passed through unchanged"
        result.fmt = encoder.name
        return result

    result.data = data
    result.suffix = encoder.extension
    result.new_bytes = len(data)
    result.level = level
    result.score = score
    result.fmt = encoder.name
    result.resized_from = original_size
    result.resized_to = resized_to
    return result


def write_result(result: CompressionResult, destination_dir: Path) -> Path | None:
    """Write an in-memory result to disk, never over its own source."""
    if result.data is None:
        return None
    destination_dir = Path(destination_dir)
    destination_dir.mkdir(parents=True, exist_ok=True)
    out_path = destination_dir / (result.source.stem + (result.suffix or result.source.suffix))
    try:
        clashes = out_path.resolve() == result.source.resolve()
    except OSError:
        clashes = False
    if clashes:
        out_path = out_path.with_name(f"{result.source.stem}.min{out_path.suffix}")
    out_path.write_bytes(result.data)
    result.output = out_path
    return out_path


def compress_file(source: Path, destination_dir: Path, settings: Settings) -> CompressionResult:
    """Compress and write in one step. What the CLI uses."""
    result = compress(source, settings)
    if not result.error:
        write_result(result, destination_dir)
        result.data = None  # written; don't hold the bytes
    return result


def iter_images(root: Path, recursive: bool = True) -> Iterable[Path]:
    root = Path(root)
    if root.is_file():
        yield root
        return
    walker = root.rglob("*") if recursive else root.glob("*")
    for path in sorted(walker):
        if path.is_file() and path.suffix.lower() in SUPPORTED_SUFFIXES:
            yield path


def compress_tree(
    source_root: Path,
    destination_root: Path,
    settings: Settings,
    recursive: bool = True,
    workers: int = 0,
    on_result=None,
) -> list:
    """Compress every image under source_root, mirroring the folder structure.

    Processes, not threads: the metric is numpy/scipy-bound and this is the
    difference between using one core and using all of them.
    """
    from concurrent.futures import ProcessPoolExecutor

    source_root = Path(source_root)
    destination_root = Path(destination_root)
    files = list(iter_images(source_root, recursive))
    if not files:
        return []

    base = source_root if source_root.is_dir() else source_root.parent
    jobs = [(p, destination_root / p.parent.relative_to(base), settings) for p in files]

    if workers <= 0:
        workers = max(1, min(8, (os.cpu_count() or 2)))

    results = []
    if workers == 1 or len(jobs) == 1:
        for job in jobs:
            res = _job(job)
            results.append(res)
            if on_result:
                on_result(res)
        return results

    with ProcessPoolExecutor(max_workers=workers) as pool:
        for res in pool.map(_job, jobs):
            results.append(res)
            if on_result:
                on_result(res)
    return results


def _job(args):
    path, destination, settings = args
    return compress_file(path, destination, settings)
