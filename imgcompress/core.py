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
    """The edge `dimension_mode` governs, in pixels. 0 disables resizing."""

    dimension_mode: str = "longest"
    """Which edge `max_dimension` caps: longest | width | height | none.

    Only ever downscales. An image already inside the limit is left as it is
    rather than enlarged: a larger frame cannot add detail, so enlarging inside
    a compressor produces a blurrier file that is also a bigger one, which is
    the opposite of the job. A batch pinned to `width` therefore comes out at
    that width or narrower, never wider.
    """

    metric: str = ""
    """ssimulacra2 (default when installed) or ssim."""

    quality_target: float | None = None
    """The floor the result may not fall below. Defaults to 90 for
    SSIMULACRA2, 0.97 for SSIM.

    It means the same thing in both searches, which is why there is only one of
    it: with no size cap it is what the search descends to, and under a size cap
    it is the point past which shrinking further is not worth doing.
    """

    size_target: int = 0
    """Byte ceiling. 0 runs the default search - the smallest file that still
    clears `quality_target`. Non-zero inverts it: the highest quality that fits
    under this many bytes.

    The two are one search read in opposite directions, and exactly one of them
    runs at a time. Quality is the currency either way, which is why a cap can
    be honoured at all: something has to give, and this is the thing that does.
    """

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

    size_target: int = 0
    """The byte ceiling this run was given, if any. Carried so the caller can
    say what was asked for without having to hold the settings alongside."""

    missed_size: bool = False
    """A size cap was set and could not be met without going below the quality
    floor. `new_bytes` is then the smallest file that was still worth shipping,
    and it is over the cap - deliberately, and said out loud, rather than a
    wrecked image that happens to fit."""

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


DIMENSION_MODES = ("longest", "width", "height", "none")


def frame_for(size: tuple, mode: str, limit: int, hard_cap: int = 0) -> tuple | None:
    """The frame this image will be drawn into, or None to leave it alone.

    `mode` decides which edge `limit` governs. `hard_cap` is a destination's own
    ceiling and always applies to the longest edge whatever the mode is - design
    tools rescale above it destructively on import, and that is true of the long
    edge regardless of which edge the caller chose to pin.

    Never enlarges. Every mode returns None for an image already inside its
    limit, so a folder pinned to a width comes out at that width or narrower and
    a small source is left alone. Enlarging would cost bytes to add blur.
    """
    width, height = size
    scale = 1.0

    if limit and mode != "none":
        if mode == "width":
            edge = width
        elif mode == "height":
            edge = height
        else:
            edge = max(width, height)
        if edge > limit:
            scale = limit / float(edge)

    if hard_cap and max(width, height) * scale > hard_cap:
        scale = hard_cap / float(max(width, height))

    if scale >= 1.0:
        return None
    return (max(1, round(width * scale)), max(1, round(height * scale)))


def _normalise(img: Image.Image, settings: Settings) -> tuple:
    img = ImageOps.exif_transpose(img)

    alpha = _has_alpha(img)
    if img.mode not in ("RGB", "RGBA"):
        img = img.convert("RGBA" if alpha else "RGB")

    original_size = img.size
    resized_to = None

    # Some destinations enforce a ceiling regardless of what was asked for -
    # design tools rescale above 4096px themselves, destructively, so the
    # choice is between our Lanczos and theirs. The clamp is handed to
    # `frame_for` rather than folded into the limit, because a ceiling on the
    # long edge and a pin on the width are not the same number and collapsing
    # them was only ever safe while `longest` was the only mode.
    cap = dest.get(settings.target).hard_cap if dest.exists(settings.target) else 0
    frame = frame_for(img.size, settings.dimension_mode, settings.max_dimension, cap)

    if frame:
        img = img.resize(frame, Image.LANCZOS)
        resized_to = frame

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


def _search_under_size(
    img: Image.Image,
    encoder: enc.Encoder,
    metric: Metric,
    cap: int,
    fast: bool,
) -> tuple | None:
    """Highest level of `encoder` that still fits in `cap` bytes.

    The mirror image of `_search_one`: same ladder, same bisection, opposite
    question. Size rises with quality just as score does, so a rung that
    overshoots the cap proves every rung above it would too, and the search is
    the same shape.

    Returns None when even the lowest rung overshoots - this format cannot hold
    this image that small, and the caller should try another one.
    """
    levels = encoder.levels

    if encoder.lossless or len(levels) == 1:
        data = encoder.encode(img, levels[-1], fast=fast)
        if len(data) > cap:
            return None
        return data, None, metric.perfect

    chosen = None
    lo, hi = 0, len(levels) - 1
    while lo <= hi:
        mid = (lo + hi) // 2
        if len(encoder.encode(img, levels[mid], fast=True)) <= cap:
            chosen, lo = mid, mid + 1
        else:
            hi = mid - 1

    if chosen is None:
        return None

    data = encoder.encode(img, levels[chosen], fast=fast)

    # Fast encodes run larger than full-effort ones - mozjpeg and zopfli only
    # ever take bytes away - so the bisection above is conservative and may have
    # rejected a rung that fits once those passes have run. One probe upward
    # recovers the quality that would otherwise be left on the table.
    if chosen < len(levels) - 1:
        better = encoder.encode(img, levels[chosen + 1], fast=fast)
        if len(better) <= cap:
            chosen, data = chosen + 1, better

    # Belt and braces. Shipping over a cap the person set is the one thing this
    # search must never do, so the final bytes are measured rather than assumed.
    while len(data) > cap and chosen > 0:
        chosen -= 1
        data = encoder.encode(img, levels[chosen], fast=fast)
    if len(data) > cap:
        return None

    return data, levels[chosen], metric.score(img, _decode(data))


def _candidate_names(settings: Settings, has_alpha: bool) -> list[str]:
    names = settings.formats or dest.formats_for(settings.target)
    # A destination names the formats it *wants*; this machine decides which of
    # them it can write. The two are not the same list - the table offers AVIF
    # everywhere the browser engine does, and most Pillow builds cannot make one.
    names = enc.usable(names)
    if has_alpha:
        names = [n for n in names if enc.ALL[n].supports_alpha]
    return names


def _broken(result: CompressionResult, encoder: enc.Encoder, exc: Exception) -> None:
    result.warnings.append(
        f"{encoder.name} could not be written for this image, so it was "
        f"left out of the comparison ({type(exc).__name__})")


def _bake_off(img, encoders, metric, target, settings, result):
    """Every candidate at the lowest quality that clears the floor. Smallest wins.

    A candidate that failed the floor may only ship when *nothing* cleared it -
    the old single-`best` bookkeeping let an early failing JPEG hold the spot
    against a later, passing lossless PNG purely because it was smaller, which
    is how a file below the promised floor once shipped without even a warning
    that anything better existed.
    """
    best_passing = None
    best_failing = None
    for encoder in encoders:
        try:
            found = _search_one(img, encoder, metric, target, settings.fast)
        except Exception as exc:  # a broken candidate must not kill the file
            _broken(result, encoder, exc)
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
    return best_passing or best_failing


def _bake_off_under_size(img, encoders, metric, cap, floor, settings, result):
    """Every candidate at the highest quality that fits the cap. Best-looking wins.

    Note which way this reads: under a cap the winner is the one that looks
    best, not the one that is smallest. Everything here already fits, so size
    has stopped being the thing worth competing on.

    Returns None when nothing fitted at a quality still worth shipping.
    """
    best = None
    for encoder in encoders:
        try:
            found = _search_under_size(img, encoder, metric, cap, settings.fast)
        except Exception as exc:
            _broken(result, encoder, exc)
            continue
        if not found:
            continue
        data, level, score = found
        result.candidates.append((encoder.name, len(data), score))
        if score >= floor and (best is None or score > best[2]):
            best = (data, level, score, encoder)
    return best


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
                result.note = "animated - left exactly as it is"
                return result

            img, original_size, resized_to = _normalise(opened, settings)
    except Exception as exc:
        result.error = f"{type(exc).__name__}: {exc}"
        return result

    has_alpha = _has_alpha(img)
    names = _candidate_names(settings, has_alpha)
    if not names:
        result.error = ("No format available here can hold this image. "
                        "Allow more formats, or choose a different destination.")
        return result

    encoders = enc.build(names, zopfli=settings.zopfli, background=settings.jpeg_background)
    result.size_target = settings.size_target

    if settings.size_target:
        best = _bake_off_under_size(
            img, encoders, metric, settings.size_target, target, settings, result)
        if best is None:
            # Nothing fitted the cap at a quality still worth shipping, so fall
            # back to the ordinary search and hand over the smallest file that
            # is - over the cap, and said out loud. A wrecked image that happens
            # to fit is not a result. This is the one path that pays for two
            # bake-offs, and only ever when the cap was unreachable anyway.
            #
            # The capped attempt's candidates are dropped rather than listed
            # beside the winner: every one of them is below the floor, and
            # showing them reads as if they had been real options.
            result.candidates.clear()
            best = _bake_off(img, encoders, metric, target, settings, result)
    else:
        best = _bake_off(img, encoders, metric, target, settings, result)

    if best is None:
        result.error = ("None of the formats could be written for this image. "
                        "It may be damaged; try re-exporting it.")
        return result

    data, level, score, encoder = best
    if score < target:
        label = "visual match" if metric.name == "ssimulacra2" else metric.name
        result.warnings.append(
            f"could not reach a {label} of {target:g}; the closest was {score:.1f}. "
            f"Lower the target, or keep the original."
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
        result.note = "already smaller than anything we could make - left as it is"
        result.fmt = encoder.name
        _note_size_miss(result, settings, metric, target)
        return result

    result.data = data
    result.suffix = encoder.extension
    result.new_bytes = len(data)
    result.level = level
    result.score = score
    result.fmt = encoder.name
    result.resized_from = original_size
    result.resized_to = resized_to
    _note_size_miss(result, settings, metric, target)
    return result


def _note_size_miss(result, settings: Settings, metric: Metric, floor: float) -> None:
    """Record, and explain, a size cap that could not be met.

    Read off the bytes that are actually being shipped rather than set where
    the fallback was chosen, so the flag cannot claim a miss on a file that in
    the end came in under the cap.
    """
    if not settings.size_target or result.new_bytes <= settings.size_target:
        return
    result.missed_size = True
    label = "visual match" if metric.name == "ssimulacra2" else metric.name
    over = result.new_bytes - settings.size_target
    result.warnings.append(
        f"could not fit {settings.size_target:,} bytes without dropping below a "
        f"{label} of {floor:g}; this is {over:,} bytes over. Allow a lower "
        f"{label}, or a smaller frame."
    )


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
