"""Where the image is going.

A destination is the one question a person can answer without knowing anything
about compression: where will this image end up? Everything the engine needs
follows from the answer - which formats it may write, how large the frame may
be, and how close the result has to look.

This replaces two older ideas that overlapped and were both named after the
wrong thing. `--preset` used to set size and quality; `--target` used to set the
format list; and the default for both was `figma`, which refused WebP for a
reason that applies to design tools and nobody else. Someone compressing a photograph for their website silently got no WebP
and was never told why. One list, named after destinations, is the fix.

This table is the single source of truth for the Python side. `web/worker.js`,
`web/destinations.js` (generated from this file) and
`imgcompress/webui/app.html` carry the same entries with the
same numbers; if you change one, change all four. `tests/test_compress.py` has
a test per destination so the Python side cannot drift on its own.
"""

from __future__ import annotations

from dataclasses import dataclass

# Everything the bake-off knows how to write. A destination that lists a format
# this machine has no encoder for simply drops it - see `Encoder.available`.
EVERY_FORMAT = ("jpeg", "png8", "png", "webp", "webp-lossless", "avif")

# Formats that design tools, office suites and document editors store as they
# were given them. Figma's own docs accept WebP, but its plugin API only knows
# PNG/JPEG/GIF and the standing community answer is that a WebP dropped on the
# canvas is decoded and re-encoded as PNG. If that is right, handing one of
# these tools a beautifully compressed 40 KB WebP gets you a multi-megabyte PNG
# inside the saved file. The downside is severe and the upside is a few
# percent, so this list stays conservative on purpose.
STORED_AS_GIVEN = ("jpeg", "png8", "png")


@dataclass(frozen=True)
class Destination:
    name: str
    label: str
    """What a person calls this place."""

    formats: tuple
    max_dimension: int
    """Longest edge in pixels. 0 never resizes."""

    ss2_target: float
    ssim_target: float
    help: str

    hard_cap: int = 0
    """A limit the destination enforces even when asked for more. 0 means none."""

    hidden: bool = False
    """Kept working for scripts written against an older version, not offered."""


DESTINATIONS = {
    d.name: d
    for d in (
        Destination(
            name="web",
            label="Website or app",
            formats=EVERY_FORMAT,
            max_dimension=2560,
            ss2_target=90.0,
            ssim_target=0.97,
            help="Smallest possible files using modern formats. "
                 "Best for anything that loads in a browser.",
        ),
        Destination(
            name="documents",
            label="Design tool or document",
            formats=STORED_AS_GIVEN,
            # Two numbers doing two different jobs, and collapsing them into
            # one is a real bug this file shipped with for exactly one commit.
            #
            # 2560 is the everyday downscale, the same as `web`, and it is
            # where most of the saving on a design asset actually comes from -
            # no codec recovers the bytes wasted on a 6000px export that
            # renders at 1200px.
            #
            # 4096 is a safety clamp, not a setting. Design tools rescale
            # above it destructively on import with no control over the
            # resampling, so an explicit `-m 8000` is quietly brought down to
            # 4096 rather than honoured or rejected: the intent is fine, the
            # destination simply cannot carry it.
            max_dimension=2560,
            hard_cap=4096,
            ss2_target=90.0,
            ssim_target=0.97,
            help="Only formats these tools store as-is. "
                 "Prevents files getting bigger when you import them.",
        ),
        Destination(
            name="email",
            label="Email or chat",
            formats=STORED_AS_GIVEN,
            max_dimension=1920,
            ss2_target=88.0,
            ssim_target=0.965,
            help="Small enough to attach, and opens everywhere.",
        ),
        Destination(
            name="social",
            label="Social media post",
            # JPEG/PNG only, on purpose: every major platform re-encodes
            # uploads on arrival, so WebP/AVIF buy nothing past the upload
            # form - and some upload paths reject them outright. 2048 covers
            # Instagram's 1080 display size at 2x with headroom; the platform
            # will not shrink it again itself.
            formats=STORED_AS_GIVEN,
            max_dimension=2048,
            ss2_target=88.0,
            ssim_target=0.965,
            help="Sized and saved so Instagram, X and Facebook "
                 "won't shrink it again themselves.",
        ),
        Destination(
            name="thumbnail",
            label="Thumbnail or avatar",
            formats=EVERY_FORMAT,
            max_dimension=512,
            # 512 covers a 2x display at 256px, which is the change that can
            # be argued for. The quality target stays at the 80 it has always
            # been: artefacts are *less* visible at a smaller size, so if
            # anything it could fall, and moving it up was a second change
            # with no reason behind it. Nothing in the history records why the
            # original 800px was chosen - it arrived in the initial import.
            ss2_target=80.0,
            ssim_target=0.95,
            help="For small display sizes - profile pictures, list icons, previews.",
        ),
        Destination(
            name="original",
            label="Keep full quality",
            # Lossless is preferred by arithmetic rather than by rule: at a
            # minimum visual match of 95 with no resizing, a lossy encode has
            # to be both smaller and near-perfect to beat a lossless one, which
            # on the content people reach for this with it rarely is.
            formats=EVERY_FORMAT,
            max_dimension=0,
            ss2_target=95.0,
            ssim_target=0.99,
            help="No resizing, highest fidelity. For print and originals.",
        ),
        Destination(
            name="lossless",
            label="Pixel-perfect only",
            # This set backs the "identical - every pixel kept" choice in the
            # UIs as well as `--for lossless`. Identical means identical:
            # resizing changes pixels, so this destination never resizes.
            # (It used to carry the everyday 2560 downscale, which quietly
            # contradicted its own name.)
            formats=("png", "webp-lossless"),
            max_dimension=0,
            ss2_target=90.0,
            ssim_target=0.97,
            help="Nothing but pixel-exact output. Never resized.",
            hidden=True,
        ),
    )
}

# Older names, kept working so existing scripts do not break. Not offered
# anywhere a person can see them.
ALIASES = {
    "figma": "documents",
    "archive": "original",
}

DEFAULT = "web"


def resolve(name: str) -> str:
    """Canonical destination name, following aliases. Unknown names pass through
    so the caller can raise its own error with its own wording."""
    return ALIASES.get(name, name)


def get(name: str) -> Destination:
    canonical = resolve(name)
    try:
        return DESTINATIONS[canonical]
    except KeyError:
        raise KeyError(f"unknown destination: {name}") from None


def exists(name: str) -> bool:
    return resolve(name) in DESTINATIONS


def formats_for(name: str) -> list:
    return list(get(name).formats)


def effective_limit(name: str, requested: int) -> int:
    """The longest edge that will actually be produced. 0 means no resizing.

    The clamp rule lives here and nowhere else. It is already restated in
    `worker.js`, and the moment a third copy appeared in the CLI - purely to
    print an accurate number - the header started advertising `up to 8000px`
    for a run that produced 4096. One function, two callers.
    """
    limit = requested or 0
    cap = get(name).hard_cap if exists(name) else 0
    if cap:
        limit = min(limit, cap) if limit else cap
    return limit


def visible() -> list:
    """The destinations a person is offered, in the order they are offered."""
    return [d for d in DESTINATIONS.values() if not d.hidden]


def names() -> list:
    return [d.name for d in visible()]
