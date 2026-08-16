"""Video, and the search for the smallest one that still looks like the original.

The idea is the same one the image engine is built on, and most of the code
below is that idea with time added: encode the thing several ways, open every
result back up, measure it against the source, and keep the smallest version
that still measures close enough. Nothing here guesses a quality number.

Three things are genuinely different from images, and each one shows up in the
shape of the code:

**You cannot afford to encode the whole file to learn what a setting does.**
A ten-minute clip takes minutes per attempt and the search needs several. So
the search runs on *samples* - twenty-second windows, evenly spaced through
the runtime - and only the winning setting is applied to the whole file. This
is the mechanism `ab-av1` proved: a three-sample probe predicts the full
file's quality within a fraction of a point, at a fraction of the cost.

**The destination often is a number.** An image destination is defined by
where it is going; a video destination is frequently defined by a limit
somebody else chose - Discord's 10 MB, a mail server's 25. When
`size_cap_mb` is set the search stops asking "how small can this be while
still looking right" and starts asking "how good can this look inside 10 MB",
which is a different question with a different answer, and the honest thing
to do is report the quality it actually reached rather than the quality we
wanted.

**A per-frame metric cannot see time.** SSIMULACRA 2 scores a still. It
cannot see flicker, or the way quality can sag between keyframes and snap
back. Averaging hides exactly the moments a person notices. So frame scores
are pooled worst-first: the reported score is the low percentile, not the
mean, and a mean that sits far above it is itself evidence of pumping.

**And the colour is not always ordinary colour.** A modern phone records high
dynamic range by default, which is a different picture entirely: brightness is
absolute rather than relative, white is not the brightest thing in the frame,
and the primaries are wider than any ordinary screen can show. Handing those
numbers to an ordinary encoder unchanged produces the failure this engine used
to refuse outright - a video where a white shirt comes out mid grey. The
`colour` section below converts it properly instead, and says so.

Everything here degrades. PyAV is an optional install; without it every
function still imports, `available()` says no, and a video is reported and
skipped with the command that would fix it - never a crash, never a silent
pass-through of an uncompressed file.
"""

from __future__ import annotations

import io
import math
import os
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from fractions import Fraction
from pathlib import Path

import numpy as np

# PyAV carries its own FFmpeg, so this is one pip install and no binaries for
# the user to find - the rule that has governed every engine in this project.
# The import is guarded exactly like `imagequant` and `zopflipy` are.
try:  # pragma: no cover - exercised by whichever half of the branch is live
    import av

    HAVE_AV = True
except Exception:  # pragma: no cover
    av = None
    HAVE_AV = False

INSTALL_HINT = 'pip install "pocketsize[video]"'

# Containers people actually hand a compressor. The long tail (AVI, WMV, FLV)
# decodes through the same FFmpeg, so there is no reason to refuse it.
VIDEO_SUFFIXES = frozenset(
    {
        ".mp4", ".m4v", ".mov", ".webm", ".mkv", ".avi", ".wmv", ".flv",
        ".mpg", ".mpeg", ".m2ts", ".mts", ".ts", ".3gp", ".ogv",
    }
)


def is_video_path(path) -> bool:
    """Whether this looks like a video by name alone.

    Deliberately cheap and deliberately not authoritative: it decides which
    door a file goes through, and the real answer comes from opening it.
    """
    return Path(path).suffix.lower() in VIDEO_SUFFIXES


def available() -> bool:
    return HAVE_AV


# --------------------------------------------------------------------------
# formats
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class VideoFormat:
    """A codec and the container it travels in.

    They are one choice, not two. AV1 is the smaller file and H.264 is the one
    that plays on a 2019 iPad, and neither is any use inside a container the
    destination will not accept - so the destination table lists pairs, and
    this is what a pair means.
    """

    name: str
    codec: str
    container: str
    extension: str
    mime: str

    levels: tuple
    """CRF rungs, ascending in *quality* - so the search can bisect this the
    same way it bisects a JPEG quality ladder, with no special cases. Lower CRF
    means better and bigger, which is why these read backwards."""

    preset_slow: str
    preset_fast: str
    """What `--fast` trades away. Both encoders spend roughly exponentially
    more time per preset step, and both give back very little quality for it -
    SVT-AV1 spans about 0.4 VMAF between presets 2 and 12 at a fixed CRF."""

    audio_codec: str

    def rung(self, level: int) -> int:
        return self.levels[level]


# x264's visually-lossless band is CRF 17-18 at 1080p and has been for a
# decade; the ladder runs well past it in both directions so a destination
# with a hard byte cap has somewhere to go, and `original` has headroom above.
_X264_LEVELS = (34, 32, 30, 28, 26, 25, 24, 23, 22, 21, 20, 19, 18, 17, 16,
                15, 14, 13, 12)

# SVT-AV1 4.x extended CRF to 70 and added quarter steps. Whole numbers are
# enough here: the acceptance tolerance in the search is wider than a quarter
# step, so finer rungs would cost probes and buy nothing.
_SVTAV1_LEVELS = (52, 48, 45, 42, 39, 36, 34, 32, 30, 28, 26, 24, 22, 20, 18,
                  16, 14, 12)

FORMATS = {
    "h264-mp4": VideoFormat(
        name="h264-mp4",
        codec="libx264",
        container="mp4",
        extension=".mp4",
        mime="video/mp4",
        levels=_X264_LEVELS,
        preset_slow="slow",
        preset_fast="veryfast",
        audio_codec="aac",
    ),
    "av1-mp4": VideoFormat(
        name="av1-mp4",
        codec="libsvtav1",
        container="mp4",
        extension=".mp4",
        mime="video/mp4",
        levels=_SVTAV1_LEVELS,
        # Preset 6 lands within a rounding error of preset 2's file size at
        # roughly twenty times the speed. Preset 8 is about the point where a
        # laptop keeps up with real time at 1080p.
        preset_slow="6",
        preset_fast="8",
        audio_codec="aac",
    ),
}


def usable(names) -> list:
    """The formats this machine can actually write, in the order given.

    A destination that asks for AV1 on a build without SVT-AV1 simply loses
    it, the same way a machine with no AVIF plugin loses AVIF.
    """
    if not HAVE_AV:
        return []
    live = []
    for name in names:
        fmt = FORMATS.get(name)
        if fmt is None:
            continue
        try:
            av.codec.Codec(fmt.codec, "w")
        except Exception:
            continue
        live.append(name)
    return live


def capabilities() -> dict:
    """What `pocketsize --check` reports about video."""
    if not HAVE_AV:
        return {"pyav": False}
    caps = {"pyav": True, "version": getattr(av, "__version__", "?")}
    for name, fmt in FORMATS.items():
        try:
            av.codec.Codec(fmt.codec, "w")
            caps[name] = True
        except Exception:
            caps[name] = False
    for extra in ("libopus", "aac"):
        try:
            av.codec.Codec(extra, "w")
            caps[extra] = True
        except Exception:
            caps[extra] = False
    caps["xpsnr"] = _has_filter("xpsnr")
    caps["libvmaf"] = _has_filter("libvmaf")
    return caps


def _has_filter(name: str) -> bool:
    if not HAVE_AV:
        return False
    try:
        av.filter.Filter(name)
        return True
    except Exception:
        return False


# --------------------------------------------------------------------------
# probing
# --------------------------------------------------------------------------


@dataclass
class VideoInfo:
    width: int = 0
    height: int = 0
    duration: float = 0.0
    fps: float = 0.0
    codec: str = ""
    pix_fmt: str = ""
    has_audio: bool = False
    audio_codec: str = ""
    audio_bitrate: int = 0
    audio_channels: int = 0
    audio_rate: int = 0
    audio_tracks: int = 0
    subtitles: int = 0
    frames: int = 0

    rotation: int = 0
    """Degrees counter-clockwise the picture must be turned to be shown the
    right way up. A phone held upright records a landscape frame and sets this
    flag; a tool that ignores it writes a sideways video, which is the most
    common way to ruin the most common kind of consumer video there is."""

    sar: float = 1.0
    """Pixel shape. Not every video has square pixels - DV and several camera
    modes stretch them - so the stored frame is not always the shape the
    picture should be."""

    hdr: bool = False
    """Wide colour with a high-dynamic-range transfer, which is what a modern
    phone records by default. It cannot be turned into ordinary colour without
    tone mapping - see the `colour` section, which does exactly that."""

    hdr_reason: str = ""
    """Which transfer said so: `smpte2084` (PQ) or `arib-std-b67` (HLG)."""

    colorspace: int = 0
    color_primaries: int = 0
    color_range: int = 0
    """The three numbers that say what the stored samples mean. Read here once
    because the tone map needs all three and re-reading them per frame would be
    a probe per frame."""

    tone_map: object = None
    """A `ToneMap` when this file needs converting to ordinary colour, else
    None. Set by `probe` from the tags, and refined by `compress` once it has
    measured how bright the content actually gets."""

    probe_note: str = ""
    """Set when the first frame could not be decoded during probing. Rotation
    and some colour tags live only on the frames, so a file that fails here
    may be encoded sideways or in the wrong colour - which is exactly the
    kind of thing that must be said out loud rather than swallowed."""

    @property
    def megapixels(self) -> float:
        return (self.width * self.height) / 1_000_000.0


def probe(path) -> VideoInfo:
    """Read the shape of a video without decoding it.

    Container metadata only, so this stays instant even on a 2 GB file.
    """
    info = VideoInfo()
    with av.open(str(path)) as container:
        if not container.streams.video:
            raise ValueError("no video track")
        vs = container.streams.video[0]
        info.width = vs.codec_context.width
        info.height = vs.codec_context.height
        info.codec = vs.codec_context.name or ""
        info.pix_fmt = str(vs.codec_context.pix_fmt or "")
        rate = vs.average_rate or vs.guessed_rate
        info.fps = float(rate) if rate else 0.0

        aspect = vs.codec_context.sample_aspect_ratio
        if aspect and aspect.denominator and float(aspect) > 0:
            info.sar = float(aspect)

        # Colour is read from the stream, and rotation from the first frame -
        # PyAV surfaces the display matrix there rather than on the stream.
        context = vs.codec_context
        info.hdr, info.hdr_reason = _looks_hdr(context, info.pix_fmt)
        info.colorspace = _code(getattr(context, "colorspace", 0))
        info.color_primaries = _code(getattr(context, "color_primaries", 0))
        info.color_range = _code(getattr(context, "color_range", 0))
        try:
            first = next(container.decode(vs), None)
            if first is not None:
                info.rotation = _turn_of(getattr(first, "rotation", 0))
                if not info.hdr:
                    info.hdr, info.hdr_reason = _looks_hdr(first, info.pix_fmt)
                # Some containers carry the colour tags only on the frames.
                for field_name in ("colorspace", "color_primaries",
                                   "color_range"):
                    if not getattr(info, field_name):
                        setattr(info, field_name,
                                _code(getattr(first, field_name, 0)))
        except Exception as exc:
            # Rotation and per-frame colour tags are unknowable for this
            # file. Recorded rather than swallowed: the old bare `pass` here
            # meant a phone clip whose first frame would not decode was
            # encoded sideways with no hint as to why.
            info.probe_note = (
                "could not decode the first frame to check rotation and "
                f"colour ({type(exc).__name__})"
            )
        info.tone_map = tone_map_for(info)
        container.seek(0)
        if vs.frames:
            info.frames = int(vs.frames)
        # Duration can live on the stream or only on the container, and on
        # some phone recordings only one of them is honest.
        if vs.duration is not None and vs.time_base:
            info.duration = float(vs.duration * vs.time_base)
        if not info.duration and container.duration:
            info.duration = float(container.duration) / 1_000_000.0

        info.audio_tracks = len(container.streams.audio)
        try:
            info.subtitles = len(container.streams.subtitles)
        except Exception:
            info.subtitles = 0
        if container.streams.audio:
            a = container.streams.audio[0]
            info.has_audio = True
            info.audio_codec = a.codec_context.name or ""
            info.audio_bitrate = int(a.codec_context.bit_rate or 0)
            info.audio_channels = int(getattr(a.codec_context, "channels", 0) or 0)
            info.audio_rate = int(a.codec_context.sample_rate or 0)
    return info


# Transfer characteristics that mean high dynamic range: SMPTE ST 2084 (PQ,
# what Apple and most HDR10 cameras write) and ARIB STD-B67 (HLG, what many
# broadcast and Android devices write).
_HDR_TRANSFERS = {16, 18}
_HDR_TRANSFER_NAMES = {"smpte2084", "arib-std-b67"}


def _looks_hdr(carrier, pix_fmt: str = "") -> tuple:
    """(is_hdr, why). Reads whichever spelling of the flag this object uses.

    Deliberately generous about what counts. Getting this wrong in the
    cautious direction costs a person one refused file with an explanation;
    getting it wrong the other way hands them a washed-out grey video and no
    hint as to why.
    """
    transfer = getattr(carrier, "color_trc", None)
    name = str(getattr(transfer, "name", transfer) or "").lower()
    value = getattr(transfer, "value", transfer)
    if name in _HDR_TRANSFER_NAMES:
        return True, name
    if isinstance(value, int) and value in _HDR_TRANSFERS:
        return True, "smpte2084" if value == 16 else "arib-std-b67"
    return False, ""


def _code(value) -> int:
    """One of FFmpeg's colour enums as a plain number.

    PyAV hands these back as an int on one object and an enum on another
    depending on where it read them, and reading `.value` off an int throws.
    """
    try:
        return int(getattr(value, "value", value) or 0)
    except (TypeError, ValueError):
        return 0


def _turn_of(rotation) -> int:
    """A display-matrix angle, normalised to one of 0, 90, 180, 270.

    FFmpeg reports the angle counter-clockwise in the range -180..180, so a
    phone's quarter turn arrives as either 90 or -90 depending on which way it
    was held, and half a turn as -180. All four have to land on a whole
    quarter or the transform below cannot be expressed.
    """
    try:
        angle = int(round(float(rotation or 0))) % 360
    except (TypeError, ValueError):
        return 0
    return min((0, 90, 180, 270), key=lambda q: min(abs(angle - q),
                                                    360 - abs(angle - q)))


def display_shape(info) -> tuple:
    """The size a player actually shows, rotation and pixel shape applied.

    Everything downstream - the frame cap, the encode, the comparison - works
    in these numbers rather than the stored ones, because these are the
    picture and the stored frame is only how it was filed away.
    """
    width, height = info.width, info.height
    if info.sar and abs(info.sar - 1.0) > 0.01:
        width = int(round(width * info.sar))
    if info.rotation in (90, 270):
        width, height = height, width
    return _even(width), _even(height)


def frame_for(width: int, height: int, limit: int) -> tuple:
    """The output frame size. Only ever shrinks, and keeps the aspect ratio.

    Encoders want even dimensions - 4:2:0 chroma is literally half-resolution
    in both axes - so both numbers are rounded to even. This is the same
    function `core.frame_for` is for images, minus the modes images needed and
    plus the evenness videos need.
    """
    if not limit or max(width, height) <= limit:
        return _even(width), _even(height)
    scale = limit / float(max(width, height))
    return _even(round(width * scale)), _even(round(height * scale))


def _even(n: int) -> int:
    n = int(n)
    return n if n % 2 == 0 else n - 1


# --------------------------------------------------------------------------
# colour: high dynamic range, made ordinary
# --------------------------------------------------------------------------
#
# A phone records HDR by default, so this is not an exotic case - it is most
# consumer video shot after about 2020. Three things make it different from
# ordinary video, and all three have to be undone before an ordinary encoder
# and an ordinary screen can be handed the picture:
#
# 1. **Brightness is absolute.** An HDR sample says "this pixel is 600 candela
#    per square metre", not "this pixel is 60% of whatever white is". So there
#    is a real number to convert, and 1.0 does not mean white - white sits at
#    203 nits (ITU-R BT.2408) and everything above it is headroom for
#    specular highlights.
# 2. **The transfer curve is not a gamma curve.** PQ (SMPTE ST 2084) and HLG
#    (ARIB STD-B67) are different shapes entirely; reading either one as if it
#    were gamma is what produces the washed-out grey picture this engine used
#    to refuse to make.
# 3. **The primaries are wider.** BT.2020 red is a redder red than a BT.709
#    screen can show, so the colours have to be re-expressed as well as
#    re-scaled.
#
# **Why it is done here in arithmetic rather than by a filter.** The PyAV wheel
# ships no `zscale` and no `libplacebo`, and the filters it *does* ship cannot
# read a PQ or an HLG transfer at all: `tonemap` expects light that is already
# linear, and `colorspace` refuses smpte2084 outright. There is no filter chain
# in this build that can do this correctly. What there is, is numpy - and
# colour transfer functions are small, exactly specified, published functions.
# Written out they are testable against the numbers in the standards, which a
# filter chain would not have been.
#
# **The pipeline, in order.** Decode -> R'G'B' code values -> absolute light in
# nits -> roll the highlights down to fit an ordinary screen -> BT.2020 to
# BT.709 primaries -> encode with the ordinary SDR display curve.
#
# **The tone curve is the BT.2390 EETF**, chosen over Hable and Reinhard for
# one reason that matters more than its shape: it is *exactly the identity*
# below its knee. Reinhard and Hable compress everything, so a video that never
# went above ordinary brightness would still come back darker than it went in.
# The EETF leaves shadows and midtones untouched to the last bit and spends its
# entire effect on the highlights that genuinely have nowhere to go. It is also
# the curve ITU-R actually publishes for this job, it is monotone (pinned by a
# test), and it hits the target peak exactly.
#
# **The output is display-referred**, and encoded with the inverse of the SDR
# display curve (BT.1886, gamma 2.4) rather than with the BT.709 camera curve.
# That is the choice that makes the result *look like the original did*: light
# in, the same light out. Encoding display light with the camera curve - which
# is what the usual ffmpeg one-liner does - leaves the end-to-end system gamma
# in twice and lands an 18% grey card about 20 code values dark. Checked
# against BT.2408's own anchors: HDR reference white (203 nits) comes out at
# code 255, and HDR reference grey (26 nits) at code 108 where an ordinary SDR
# camera would have put 106.

_PQ_M1 = 2610.0 / 16384.0
_PQ_M2 = 2523.0 / 4096.0 * 128.0
_PQ_C1 = 3424.0 / 4096.0
_PQ_C2 = 2413.0 / 4096.0 * 32.0
_PQ_C3 = 2392.0 / 4096.0 * 32.0
"""SMPTE ST 2084, written as the fractions the standard gives so a reader can
check them against the document without doing arithmetic first."""

_HLG_A = 0.17883277
_HLG_B = 1.0 - 4.0 * _HLG_A
_HLG_C = 0.5 - _HLG_A * math.log(4.0 * _HLG_A)
"""ARIB STD-B67 / BT.2100. `b` and `c` are derived rather than typed, because
they are defined in terms of `a` and typing them invites a transcription
error that no test would catch."""

PQ_PEAK_NITS = 10000.0
"""What a PQ signal of 1.0 means. Not what any screen can show - it is the
range the curve was defined over."""

HLG_NOMINAL_PEAK_NITS = 1000.0
HLG_SYSTEM_GAMMA = 1.2
"""BT.2100's nominal HLG display: 1000 nits peak, system gamma 1.2. Together
these put HLG's 75% signal at 203 nits, which is the same reference white PQ
uses - the two formats agree, and a test pins that they do."""

SDR_REFERENCE_WHITE_NITS = 203.0
"""ITU-R BT.2408: the HDR luminance that means the same thing as 100% white in
an ordinary video. This is the anchor the whole conversion hangs off."""

SDR_DISPLAY_GAMMA = 2.4
"""BT.1886. The curve an ordinary video display actually applies, and therefore
the curve to invert when writing display light out."""

HDR_ASSUMED_PEAK_NITS = 1000.0
"""How bright to assume the content gets when nothing has measured it. 1000 is
the mastering peak of essentially all consumer HDR, and it is only ever a
starting point - `compress` measures the real content peak before encoding."""

PEAK_PERCENTILE = 99.9
"""Where to read the content's peak. Not the maximum: one stuck pixel or one
ringing overshoot would then decide how the whole film is graded."""

HDR_DISCLOSURE = ("HDR colour was converted to ordinary colour, so it looks "
                  "right on any screen")
"""What the person is told. A constant rather than a literal because it is
written in one place and removed again in another - and a disclosure that can
be *nearly* removed is worse than one that is never removed at all."""

BT2020_LUMA = (0.2627, 0.6780, 0.0593)

_D65 = (0.3127, 0.3290)
_BT709_PRIMARIES = ((0.640, 0.330), (0.300, 0.600), (0.150, 0.060))
_BT2020_PRIMARIES = ((0.708, 0.292), (0.170, 0.797), (0.131, 0.046))


def _rgb_to_xyz(primaries, white) -> np.ndarray:
    """The matrix taking linear RGB in these primaries to CIE XYZ."""
    xy = np.asarray(primaries, np.float64)
    cone = np.stack([xy[:, 0] / xy[:, 1],
                     np.ones(3),
                     (1.0 - xy[:, 0] - xy[:, 1]) / xy[:, 1]])
    point = np.array([white[0] / white[1], 1.0,
                      (1.0 - white[0] - white[1]) / white[1]])
    return cone * np.linalg.solve(cone, point)


BT2020_TO_BT709 = (np.linalg.inv(_rgb_to_xyz(_BT709_PRIMARIES, _D65))
                   @ _rgb_to_xyz(_BT2020_PRIMARIES, _D65))
"""Derived from the two sets of primaries rather than typed in from a table,
so that the one property that has to hold - each row summing to exactly one,
which is what makes white stay white instead of picking up a tint - is a
consequence of the arithmetic rather than of careful copying."""


def _ycbcr_to_rgb(kr: float, kb: float) -> np.ndarray:
    """The non-constant-luminance Y'CbCr matrix for one pair of coefficients."""
    kg = 1.0 - kr - kb
    return np.array([
        [1.0, 0.0, 2.0 * (1.0 - kr)],
        [1.0, -2.0 * (1.0 - kb) * kb / kg, -2.0 * (1.0 - kr) * kr / kg],
        [1.0, 2.0 * (1.0 - kb), 0.0],
    ])


_YCBCR = {
    "bt2020": _ycbcr_to_rgb(0.2627, 0.0593),
    "bt709": _ycbcr_to_rgb(0.2126, 0.0722),
}
_RGB_TO_BT709_YCBCR = np.linalg.inv(_YCBCR["bt709"])

_BT709_CODE = 1
_LIMITED_RANGE = 1
_FULL_RANGE = 2
"""FFmpeg's enum values, named here once. 1 is BT.709 for all three of
primaries, transfer and matrix; colour range 1 is limited ("MPEG") and 2 is
full ("JPEG")."""


def _floats(values) -> np.ndarray:
    """As an array of floats, without promoting a 32-bit picture to 64-bit.

    A 4K frame is 25 MB at float32 and 50 at float64, and it is copied several
    times on the way through - so this is the difference between a comfortable
    conversion and one that swaps.
    """
    array = np.asarray(values)
    if array.dtype in (np.float32, np.float64):
        return array
    return array.astype(np.float64)


def pq_signal(nits):
    """SMPTE ST 2084 inverse EOTF: absolute nits to a code value in 0..1."""
    y = np.clip(_floats(nits) / PQ_PEAK_NITS, 0.0, 1.0)
    yp = np.power(y, _PQ_M1)
    return np.power((_PQ_C1 + _PQ_C2 * yp) / (1.0 + _PQ_C3 * yp), _PQ_M2)


def pq_nits(signal):
    """SMPTE ST 2084 EOTF: a code value in 0..1 to absolute nits."""
    e = np.clip(_floats(signal), 0.0, 1.0)
    ep = np.power(e, 1.0 / _PQ_M2)
    ratio = np.maximum(ep - _PQ_C1, 0.0) / np.maximum(_PQ_C2 - _PQ_C3 * ep,
                                                      1e-12)
    return np.power(ratio, 1.0 / _PQ_M1) * PQ_PEAK_NITS


def hlg_scene_light(signal):
    """ARIB STD-B67 inverse OETF: a code value in 0..1 to relative scene light.

    HLG is scene-referred, which is the whole reason it survives being shown on
    a screen that knows nothing about it. Turning that scene light into the
    light a display actually emits is a separate step - the OOTF below.
    """
    e = np.clip(_floats(signal), 0.0, 1.0)
    return np.where(e <= 0.5,
                    e * e / 3.0,
                    (np.exp((e - _HLG_C) / _HLG_A) + _HLG_B) / 12.0)


def hlg_nits(signal_rgb, peak: float = HLG_NOMINAL_PEAK_NITS,
             gamma: float = HLG_SYSTEM_GAMMA):
    """HLG R'G'B' code values to absolute display light, per channel.

    The system gamma is applied to the *luminance* of the pixel and the result
    scales all three channels together, which is what BT.2100 specifies and is
    why HLG keeps its saturation as it gets brighter.
    """
    scene = hlg_scene_light(signal_rgb)
    luma = scene @ np.asarray(BT2020_LUMA, scene.dtype)
    boost = peak * np.power(np.maximum(luma, 0.0), gamma - 1.0)
    return scene * boost[..., None]


def tone_curve(nits, source_peak: float,
               target_peak: float = SDR_REFERENCE_WHITE_NITS):
    """ITU-R BT.2390 EETF: absolute nits in, absolute nits out.

    Below the knee this returns its input unchanged - that is the property the
    curve was picked for, and it is what lets an HDR clip that never went above
    ordinary brightness come back with its midtones bit-for-bit intact. Above
    the knee a Hermite spline rolls the highlights down, meeting the straight
    part with matching slope so there is no visible corner, and landing exactly
    on the target peak with zero slope so nothing clips.

    Normalised against the source peak and un-normalised again afterwards, so
    "below the knee" means below a real luminance rather than below some
    fraction of the file's own range.
    """
    values = _floats(nits)
    top = float(pq_signal(source_peak))
    reach = float(pq_signal(target_peak)) / top
    if reach >= 1.0:
        # The content never gets brighter than an ordinary screen's white.
        # There is nothing to roll off, and rolling anything off would be
        # damage rather than conversion.
        return np.minimum(values, target_peak)
    knee = max(0.0, 1.5 * reach - 0.5)
    e1 = np.clip(pq_signal(values) / top, 0.0, 1.0)
    t = np.clip((e1 - knee) / (1.0 - knee), 0.0, 1.0)
    t2 = t * t
    t3 = t2 * t
    spline = ((2.0 * t3 - 3.0 * t2 + 1.0) * knee
              + (t3 - 2.0 * t2 + t) * (1.0 - knee)
              + (-2.0 * t3 + 3.0 * t2) * reach)
    e2 = np.clip(np.where(e1 < knee, e1, spline), 0.0, reach)
    return pq_nits(e2 * top)


def sdr_from_nits(nits, source_peak: float, wide_gamut: bool = True):
    """Absolute BT.2020 display light to BT.709 SDR code values in 0..1.

    The tone curve is applied to the brightest channel of each pixel and the
    resulting ratio to all three. That is deliberate: scaling all three by one
    number cannot change a colour's hue and cannot tint a neutral, so white
    stays white however hard the highlights are rolled - which is the exact
    failure ("the shirt came out grey") this whole section exists to prevent.
    Tone mapping the luminance instead would leave individual channels above
    the peak and need a desaturation fudge to bring them back.

    Highlights are rolled down before the primaries are converted, in the
    source's own gamut, because a colour pushed out of BT.709 first would have
    negative channels for the curve to chew on.
    """
    light = _floats(nits)
    brightest = light.max(axis=-1)
    safe = np.maximum(brightest, 1e-6)
    ratio = np.where(brightest > 1e-6, tone_curve(safe, source_peak) / safe, 1.0)
    linear = light * ratio[..., None] / SDR_REFERENCE_WHITE_NITS
    if wide_gamut:
        linear = linear @ BT2020_TO_BT709.T.astype(linear.dtype)
    np.clip(linear, 0.0, 1.0, out=linear)
    return np.power(linear, 1.0 / SDR_DISPLAY_GAMMA)


def content_peak_nits(nits, percentile: float = PEAK_PERCENTILE) -> float:
    """How bright this picture actually gets, in nits.

    Measured rather than assumed, and this is not a refinement - it is the
    difference between a holiday clip that never leaves ordinary brightness
    coming back untouched, and the same clip coming back 14% dark because the
    file was *tagged* as capable of 1000 nits. A container's tags describe the
    format; only the pixels describe the picture.
    """
    brightest = np.asarray(nits).max(axis=-1)
    if brightest.size == 0:
        return SDR_REFERENCE_WHITE_NITS
    return float(np.percentile(brightest, percentile))


# --- applying the arithmetic at speed ---------------------------------------
#
# The functions above are exact, and they stay exact: a lookup table was tried
# here twice and measured out of the question both times. The reason is worth
# recording so nobody spends a third day on it. The conversion ends in a 2.4
# gamma whose slope is unbounded at black, and the BT.2020->709 matrix pushes
# saturated colours *through* black (negative light, clipped to zero). Right at
# that boundary, an error of e in linear light becomes 255*e^(1/2.4) code
# values on screen: a 65^3 tetrahedral table leaves ~1e-3 of linear error and
# therefore 14-19 code values of output error on gamut-edge colours - measured,
# not estimated - and staying under one code value there needs the linear error
# below (1/255)^2.4 = 1.7e-6, which no interpolated table of any practical size
# reaches. Only near-exact evaluation passes: float32 arithmetic lands at ~0.19
# code values on the same adversarial colours.
#
# So the speed comes from running the exact arithmetic on row bands in
# parallel. Every step below is per-pixel independent, so splitting the frame
# into horizontal bands changes nothing about the answer; numpy releases the
# GIL inside each element sweep, so the bands genuinely overlap. The 3x3
# matrices are applied as explicit multiplies rather than `@` because BLAS
# spins up its own thread pool per call and the two pools fight - measured as
# a 5x slowdown at two workers.

_TONE_POOL = None
_TONE_BAND_ROWS = 128
"""Frames shorter than two bands of this are converted inline - the fixtures
are 270 rows tall and a thread pool would cost more than it saved."""


def _tone_pool() -> ThreadPoolExecutor:
    global _TONE_POOL
    if _TONE_POOL is None:
        _TONE_POOL = ThreadPoolExecutor(
            max_workers=max(1, min(8, os.cpu_count() or 2)),
            thread_name_prefix="tonemap",
        )
    return _TONE_POOL


def _matvec(matrix, planes):
    """(..., 3) through a 3x3 matrix, as plain ufunc arithmetic (no BLAS)."""
    m = np.asarray(matrix, planes.dtype)
    x0, x1, x2 = planes[..., 0], planes[..., 1], planes[..., 2]
    out = np.empty_like(planes)
    for i in range(3):
        out[..., i] = m[i, 0] * x0 + m[i, 1] * x1 + m[i, 2] * x2
    return out


@dataclass(frozen=True)
class ToneMap:
    """Everything needed to turn one file's HDR frames into ordinary colour.

    Frozen because it is read from several places at once - the encoder, the
    scorer and the peak scan all have to agree on it exactly, and a source
    measured against one setting and encoded with another would be scored
    against a picture nobody ever saw.
    """

    transfer: str
    """`smpte2084` or `arib-std-b67`. Nothing else reaches here."""

    source_peak: float = HDR_ASSUMED_PEAK_NITS
    matrix: str = "bt2020"
    wide_gamut: bool = True
    full_range: bool = False

    def with_peak(self, peak: float) -> ToneMap:
        peak = min(PQ_PEAK_NITS, max(SDR_REFERENCE_WHITE_NITS, float(peak)))
        return ToneMap(self.transfer, peak, self.matrix, self.wide_gamut,
                       self.full_range)

    def signal(self, frame) -> np.ndarray:
        """One decoded frame as R'G'B' code values in 0..1, still HDR.

        The only step that leaves this module is the one that cannot go wrong:
        FFmpeg is asked for 4:4:4 16-bit *Y'CbCr*, which is a chroma upsample
        and a bit shift and touches no colour matrix at all. Every decision
        about what the numbers mean is made here, where it can be tested,
        rather than inside a scaler that would silently pick BT.601.
        """
        planes = frame.to_ndarray(format="yuv444p16le").astype(np.float32)
        if self.full_range:
            # Depth expansion is a left shift, so full-range white is not
            # 65535 - it is the top code of the source depth, shifted up.
            depth = _component_bits(frame)
            top = float(((1 << depth) - 1) << (16 - depth))
            planes[..., 0] /= top
            planes[..., 1:] = (planes[..., 1:] - 32768.0) / top
        else:
            # Limited range in the shifted 16-bit space is the same four
            # numbers at every source depth, which is why they can be written
            # here as constants - pinned by a test across 8, 10 and 12 bits.
            planes[..., 0] = (planes[..., 0] - 4096.0) / 56064.0
            planes[..., 1:] = (planes[..., 1:] - 32768.0) / 28672.0
        rgb = planes @ _YCBCR[self.matrix].T.astype(np.float32)
        return np.clip(rgb, 0.0, 1.0, out=rgb)

    def nits(self, frame) -> np.ndarray:
        """One decoded frame as absolute display light, per channel."""
        signal = self.signal(frame)
        if self.transfer == "arib-std-b67":
            return hlg_nits(signal)
        return pq_nits(signal)

    def display(self, frame) -> np.ndarray:
        """One decoded frame as BT.709 SDR code values in 0..1."""
        return self._convert(frame, pack=False)

    def to_frame(self, frame):
        """One HDR frame as an ordinary BT.709 frame, ready to encode or score.

        Y'CbCr rather than RGB, and converted here rather than by the encoder,
        for the same reason the read side avoids a scaler: FFmpeg's default
        RGB-to-Y'CbCr matrix is BT.601, so handing it RGB and a BT.709 tag
        would write a file whose pixels and whose label disagree.

        Both the encoder and the scorer take the frame from here, so whatever
        an onward scaler does to the candidate it does to the reference too,
        and the comparison stays about the encode.
        """
        planes = self._convert(frame, pack=True)
        out = av.VideoFrame.from_ndarray(planes, format="yuv444p")
        out.colorspace = _BT709_CODE
        out.color_primaries = _BT709_CODE
        out.color_trc = _BT709_CODE
        out.color_range = _LIMITED_RANGE
        return out

    def _convert(self, frame, pack: bool):
        """The whole conversion, run on row bands in parallel.

        Same arithmetic as `signal` -> `nits` -> `sdr_from_nits`, sliced into
        horizontal bands: every step is per-pixel, so the bands cannot see
        each other and the answer is the one the plain functions give. This
        is what took a 4K frame from 2.2 seconds to well under half of one -
        the sweeps are transcendental-bound and numpy lets go of the GIL
        inside each one, so the cores genuinely overlap.
        """
        planes = frame.to_ndarray(format="yuv444p16le").astype(np.float32)
        height, width = planes.shape[0], planes.shape[1]
        if pack:
            out = np.empty((3, height, width), np.uint8)
        else:
            out = np.empty_like(planes)
        top = 0.0
        if self.full_range:
            depth = _component_bits(frame)
            top = float(((1 << depth) - 1) << (16 - depth))

        def band(a, b):
            chunk = planes[a:b]
            if self.full_range:
                chunk[..., 0] /= top
                chunk[..., 1:] = (chunk[..., 1:] - 32768.0) / top
            else:
                chunk[..., 0] = (chunk[..., 0] - 4096.0) / 56064.0
                chunk[..., 1:] = (chunk[..., 1:] - 32768.0) / 28672.0
            rgb = _matvec(_YCBCR[self.matrix], chunk)
            np.clip(rgb, 0.0, 1.0, out=rgb)
            if self.transfer == "arib-std-b67":
                nits = hlg_nits(rgb)
            else:
                nits = pq_nits(rgb)
            code = sdr_from_nits(nits, self.source_peak, self.wide_gamut)
            if pack:
                ycc = _matvec(_RGB_TO_BT709_YCBCR, code)
                out[0, a:b] = np.clip(ycc[..., 0] * 219.0 + 16.0,
                                      0.0, 255.0).round()
                out[1, a:b] = np.clip(ycc[..., 1] * 224.0 + 128.0,
                                      0.0, 255.0).round()
                out[2, a:b] = np.clip(ycc[..., 2] * 224.0 + 128.0,
                                      0.0, 255.0).round()
            else:
                out[a:b] = code

        pool = _tone_pool()
        workers = pool._max_workers
        if height < 2 * _TONE_BAND_ROWS or workers < 2:
            band(0, height)
        else:
            count = min(workers * 2, max(2, height // _TONE_BAND_ROWS))
            edges = np.linspace(0, height, count + 1, dtype=int)
            list(pool.map(lambda p: band(*p), zip(edges[:-1], edges[1:])))
        return out


def _component_bits(frame) -> int:
    try:
        return int(frame.format.components[0].bits)
    except Exception:
        return 8


class ToneCache:
    """Converted HDR frames, remembered so the arithmetic runs once.

    The reason this exists is the single biggest cost in the whole engine.
    Tone mapping a 4K frame is over a second of per-pixel work, and a
    destination that allows two formats used to encode the whole file twice -
    converting every frame a second time to produce pixels identical to the
    ones it had just thrown away. The conversion depends only on the source
    frame and the tone map, never on which codec is about to receive it, so
    the second format can have the first one's answer.

    Bounded by bytes rather than by frame count, because "1000 frames" means
    30 MB at 480x270 and 6 GB at 4K. When the budget is spent the cache stops
    accepting new frames rather than evicting: these are read in presentation
    order and an encode that has passed a frame will not ask for it again, so
    the useful window is always the newest one. Nothing here changes a single
    output pixel - it is the same converted frame either way, which is what
    `test_a_second_format_reuses_the_converted_frames` pins.
    """

    def __init__(self, budget_bytes: int = 768 * 1024 * 1024):
        self.budget = budget_bytes
        self.used = 0
        self.hits = 0
        self.misses = 0
        self._frames = {}

    def get(self, key):
        frame = self._frames.get(key)
        if frame is None:
            self.misses += 1
        else:
            self.hits += 1
        return frame

    def put(self, key, frame) -> None:
        if key in self._frames:
            return
        cost = int(frame.width) * int(frame.height) * 3
        if self.used + cost > self.budget:
            return
        self._frames[key] = frame
        self.used += cost

    def clear(self) -> None:
        self._frames.clear()
        self.used = 0


def tone_map_for(info):
    """The conversion this file needs, or None if it needs none.

    Keyed on the *transfer curve* and nothing else. Bit depth deliberately does
    not enter into it: ordinary 10-bit video is ordinary video, and running it
    through a tone map would crush a picture that was already correct.
    """
    if not getattr(info, "hdr", False):
        return None
    transfer = getattr(info, "hdr_reason", "")
    if transfer not in _HDR_TRANSFER_NAMES:
        # Flagged as high dynamic range by something we cannot name, and so
        # cannot convert. The caller refuses rather than guessing.
        return None
    return ToneMap(
        transfer=transfer,
        source_peak=HDR_ASSUMED_PEAK_NITS,
        matrix=("bt709" if getattr(info, "colorspace", 0) == _BT709_CODE
                else "bt2020"),
        wide_gamut=getattr(info, "color_primaries", 0) != _BT709_CODE,
        full_range=getattr(info, "color_range", 0) == _FULL_RANGE,
    )


# --------------------------------------------------------------------------
# sampling
# --------------------------------------------------------------------------

SAMPLE_SECONDS = 20.0
SECONDS_PER_SAMPLE = 12 * 60.0
WHOLE_FILE_COVERAGE = 0.85


def sample_windows(duration: float) -> list:
    """Where to look, as a list of (start, length) in seconds.

    Evenly spaced rather than scene-aware on purpose. Scene detection buys
    encode *efficiency*, not probe accuracy, and its accuracy is worst on
    exactly the handheld consumer footage this tool sees most. Evenly spaced
    windows are what the tool that proved this mechanism uses, and its
    published error against a full-file measurement is a fraction of a point.

    Short clips are not sampled at all: once the windows would cover most of
    the runtime, sampling costs more than it saves and measures less.
    """
    if duration <= 0:
        return [(0.0, SAMPLE_SECONDS)]
    count = max(1, int(round(duration / SECONDS_PER_SAMPLE)))
    if duration > 60.0:
        count = max(count, 2)
    if SAMPLE_SECONDS * count >= duration * WHOLE_FILE_COVERAGE:
        return [(0.0, duration)]
    gap = (duration - SAMPLE_SECONDS * count) / (count + 1)
    return [
        (gap * (i + 1) + SAMPLE_SECONDS * i, SAMPLE_SECONDS) for i in range(count)
    ]


# --------------------------------------------------------------------------
# encoding
# --------------------------------------------------------------------------


@dataclass
class EncodeSpec:
    fmt: VideoFormat
    width: int
    height: int
    crf: int = 0
    bitrate: int = 0
    """When set, rate-targeted rather than quality-targeted. This is the mode a
    hard byte cap forces: you cannot ask for a quality and also promise a
    size."""
    fast: bool = False
    audio: str = "copy"
    start: float = 0.0
    length: float = 0.0
    """0 means the whole file."""
    with_audio: bool = True
    faststart: bool = True
    info: object = None
    """The source's own description of itself - rotation, pixel shape. Carried
    here because the encoder needs to undo both, and reading them again from
    the file per encode would be four probes per search."""

    audio_copied: bool = False
    audio_written: bool = False
    """What the encode actually did with the sound, written back by `encode`.
    These are facts recorded at the moment the choice was made, because the
    old way - inferring "copied" afterwards by comparing codec names on the
    finished file - reported "kept exactly as it was" for audio that had in
    fact been decoded and re-encoded to the same codec."""

    tone_cache: object = None
    """Where converted HDR frames are remembered between encodes of the same
    material - see `ToneCache`. Set by `compress` for the final encodes only;
    None everywhere else, which is the ordinary path and costs nothing."""


def _transform_chain(info, width: int, height: int,
                     pixel_format: str = "yuv420p") -> list:
    """The filters that turn a stored frame into the picture, in order.

    Rotation is baked into the pixels rather than passed along as a flag, and
    that is a deliberate choice rather than laziness. A flag is advice: some
    players honour it, plenty of upload forms and editors do not, and a person
    who compresses a video to send it somewhere has no way to know which kind
    they are dealing with until it is already sideways in front of an
    audience. Pixels are not advice.

    Non-square pixels are resolved the same way and for the same reason - the
    output is square-pixel, whatever went in.

    `pixel_format` is the format the chain hands on. It is `yuv420p` for an
    ordinary encode, and 4:4:4 16-bit when a tone map runs next - straightening
    and scaling happen first so the expensive arithmetic runs on the smaller
    finished frame, and it runs at full depth so nothing is quantised twice.
    """
    chain = []
    turn = _turn_of(info.rotation)
    if turn == 90:
        # FFmpeg reports the angle counter-clockwise, so a quarter turn is
        # undone by turning the frame counter-clockwise again.
        chain.append(("transpose", "2"))
    elif turn == 270:
        chain.append(("transpose", "1"))
    elif turn == 180:
        chain.append(("hflip", ""))
        chain.append(("vflip", ""))
    chain.append(("scale", f"{width}:{height}:flags=lanczos"))
    chain.append(("setsar", "1"))
    chain.append(("format", pixel_format))
    return chain


def _needs_transform(info) -> bool:
    return bool(_turn_of(info.rotation)) or abs((info.sar or 1.0) - 1.0) > 0.01


def _build_graph(stream, info, width: int, height: int,
                 pixel_format: str = "yuv420p"):
    graph = av.filter.Graph()
    node = graph.add_buffer(template=stream)
    for name, args in _transform_chain(info, width, height, pixel_format):
        step = graph.add(name, args) if args else graph.add(name)
        node.link_to(step)
        node = step
    sink = graph.add("buffersink")
    node.link_to(sink)
    graph.configure()
    return graph, sink


def _tone_map_of(spec) -> object:
    """The colour conversion this encode needs, if any.

    Carried on the source's own description of itself rather than passed
    separately, because every path that already threads `info` through - the
    probe encodes, the final encode, the verification - then cannot get a
    different answer from the one the search was scored against.
    """
    return getattr(spec.info, "tone_map", None) if spec.info is not None else None


def _sws_flags() -> str:
    """The resampler, spelled the way PyAV wants it.

    Lanczos for the same reason the image tier uses it: it is the resampler
    that does not turn detail into porridge on the way down. The capitals are
    not cosmetic - PyAV looks this up in an enum by name and raises `KeyError`
    on the lowercase spelling, which turns every resize into "every encoder
    failed on this file" and nothing more specific.
    """
    return "LANCZOS"


def encode(src, spec: EncodeSpec, dest=None, progress=None):
    """Encode one video, or one window of it, and return the bytes written.

    `dest` may be a path; when it is None the result comes back in memory,
    which is what the probe encodes want.

    `progress` is only ever consulted, never reported to, from here down:
    the encode loop asks it "should I stop?" between frames, because this
    loop is where the minutes are actually spent and a cancellation that is
    only checked between stages is a cancellation the person cannot use.
    """
    buffer = None
    if dest is None:
        buffer = io.BytesIO()
        target = buffer
    else:
        target = str(dest)

    options = {}
    if spec.faststart and spec.fmt.container == "mp4":
        # Puts the index at the front so a browser can start playing before the
        # file has finished arriving. A pure remux of what was already written.
        options["movflags"] = "+faststart"

    with av.open(str(src)) as inp:
        vs = inp.streams.video[0]
        vs.thread_type = "AUTO"

        out = av.open(target, mode="w", format=spec.fmt.container, options=options)
        try:
            rate = vs.average_rate or vs.guessed_rate or Fraction(30, 1)
            ostream = out.add_stream(spec.fmt.codec, rate=rate)
            ostream.width = spec.width
            ostream.height = spec.height
            ostream.pix_fmt = "yuv420p"
            ostream.time_base = Fraction(1, 90000)
            ostream.options = _encoder_options(spec)
            if _tone_map_of(spec) is not None:
                # A converted file has to carry the tags for the colour it now
                # holds, not the ones it arrived with. Untagged standard-
                # definition video is assumed BT.601 by most players, so a
                # tone-mapped clip left untagged would come back with a green
                # cast on exactly the small frames this tool produces most.
                ostream.codec_context.color_primaries = _BT709_CODE
                ostream.codec_context.color_trc = _BT709_CODE
                ostream.codec_context.colorspace = _BT709_CODE
                ostream.codec_context.color_range = _LIMITED_RANGE

            astream = None
            aresampler = None
            copy_audio = False
            src_audio = inp.streams.audio[0] if inp.streams.audio else None
            if spec.with_audio and src_audio is not None:
                copy_audio, astream, aresampler = _open_audio(
                    out, src_audio, spec
                )

            spec.audio_copied = copy_audio
            spec.audio_written = astream is not None
            _pump(inp, out, vs, ostream, src_audio, astream, aresampler,
                  copy_audio, spec, progress)
        finally:
            out.close()

    if buffer is not None:
        return buffer.getvalue()
    return Path(dest).stat().st_size


def _encoder_options(spec: EncodeSpec) -> dict:
    preset = spec.fmt.preset_fast if spec.fast else spec.fmt.preset_slow
    opts = {}
    if spec.fmt.codec == "libx264":
        opts["preset"] = preset
        if spec.bitrate:
            # Rate-targeted. Single pass with a tight VBV: two passes over a
            # sample would be measuring the wrong thing, and over the whole
            # file the second pass is applied by the caller.
            opts["b"] = str(spec.bitrate)
            opts["maxrate"] = str(int(spec.bitrate * 1.45))
            opts["bufsize"] = str(int(spec.bitrate * 2))
        else:
            opts["crf"] = str(spec.crf)
    elif spec.fmt.codec == "libsvtav1":
        opts["preset"] = preset
        if spec.bitrate:
            opts["b"] = str(spec.bitrate)
        else:
            opts["crf"] = str(spec.crf)
        # Variance boost came out of the psychovisual fork and landed in
        # mainline SVT-AV1 3.1; it spends bits where flat areas would
        # otherwise band. Film grain synthesis is deliberately NOT enabled:
        # decoders synthesise grain differently, so a file measured here and
        # played elsewhere would not be the file that was measured.
        opts["svtav1-params"] = "enable-variance-boost=1"
    return opts


def _open_audio(out, src_audio, spec: EncodeSpec):
    """Set up the sound. Copying is the default and the point.

    Re-encoding audio that is already lossy only ever loses, and audio is a
    small share of a video's bytes, so the win is nil and the cost is real.
    We copy whenever the destination allows it and the container can carry the
    codec, and say so afterwards either way.
    """
    wanted = spec.audio
    codec_name = (src_audio.codec_context.name or "").lower()
    mp4_safe = {"aac", "mp3", "alac", "ac3", "eac3"}

    if wanted == "copy" and (
        spec.fmt.container != "mp4" or codec_name in mp4_safe
    ):
        try:
            stream = out.add_stream_from_template(src_audio)
            return True, stream, None
        except Exception:
            pass  # fall through to a re-encode rather than losing the sound

    target = "libopus" if spec.fmt.container == "webm" else spec.fmt.audio_codec
    try:
        astream = out.add_stream(target, rate=src_audio.codec_context.sample_rate)
    except Exception:
        return False, None, None
    # 128 kbps stereo is transparent for both AAC and Opus by every published
    # listening test; there is nothing to gain above it for consumer material.
    astream.bit_rate = 128_000
    resampler = av.audio.resampler.AudioResampler(
        format=astream.format, layout=astream.layout, rate=astream.rate
    )
    return False, astream, resampler


_STOP_CHECK_FRAMES = 16
"""How often the encode loop asks whether it should stop, in demuxed packets.
Roughly twice a second of content: often enough that "stop" means now, rare
enough to cost nothing."""


def _pump(inp, out, vs, ostream, src_audio, astream, aresampler, copy_audio,
          spec: EncodeSpec, progress=None):
    """Decode, straighten, scale, convert the colour, encode, mux."""
    reformatter_size = (spec.width, spec.height)
    tone = _tone_map_of(spec)
    graph = sink = None
    # A tone map always goes through the graph, even when the picture is the
    # right way up and square-pixelled: the graph is what gets the frame down
    # to its final size and full depth before the arithmetic runs on it.
    if spec.info is not None and (tone is not None or _needs_transform(spec.info)):
        graph, sink = _build_graph(
            vs, spec.info, spec.width, spec.height,
            "yuv444p16le" if tone is not None else "yuv420p",
        )
    start = spec.start
    end = start + spec.length if spec.length else None

    if start > 0:
        try:
            inp.seek(int(start / vs.time_base), stream=vs)
        except Exception:
            inp.seek(int(start * 1_000_000))

    streams = [vs]
    if src_audio is not None and astream is not None:
        streams.append(src_audio)

    first_pts = None
    decoded = 0
    for packet in inp.demux(streams):
        if progress is not None:
            decoded += 1
            if decoded % _STOP_CHECK_FRAMES == 0:
                progress.check()
        # A packet with no dts is the demuxer's flush signal, and decoding it
        # is how the last frames come out. Skipping it - the usual "ignore
        # corrupt packets" idiom - quietly truncates every encode by however
        # many frames the decoder was holding, which is enough to shift a
        # file's frame count and misalign anything paired against it.
        if packet.stream is src_audio and astream is not None:
            if copy_audio:
                if packet.dts is None:
                    continue
                t = float(packet.pts * packet.time_base) if packet.pts else 0.0
                if t < start or (end is not None and t > end):
                    continue
                packet.stream = astream
                # Rebase onto the output timeline so a window that starts at
                # 3:20 does not produce a file that begins with 200 seconds of
                # silence.
                if packet.pts is not None:
                    packet.pts -= int(start / packet.time_base)
                    packet.dts = packet.pts
                out.mux(packet)
            else:
                for frame in packet.decode():
                    t = float(frame.time) if frame.time is not None else 0.0
                    if t < start or (end is not None and t > end):
                        continue
                    for resampled in aresampler.resample(frame):
                        for pkt in astream.encode(resampled):
                            out.mux(pkt)
            continue

        if packet.stream is not vs:
            continue

        for frame in packet.decode():
            t = float(frame.time) if frame.time is not None else 0.0
            if t < start:
                continue
            if end is not None and t > end:
                break
            if first_pts is None:
                first_pts = t
            stamp = int(round((t - first_pts) * 90000))
            if graph is not None:
                # A converted frame this run has already produced is reused
                # rather than recomputed. Keyed on the source frame's own
                # presentation time, which is what identifies the picture
                # regardless of which codec is about to receive it - so the
                # second format in a bake-off pays nothing for colour.
                cached = None
                if tone is not None and spec.tone_cache is not None:
                    cached = spec.tone_cache.get(stamp)
                if cached is not None:
                    cached.pts = stamp
                    cached.time_base = Fraction(1, 90000)
                    for pkt in ostream.encode(cached):
                        out.mux(pkt)
                    continue
                graph.push(frame)
                while True:
                    try:
                        shaped = sink.pull()
                    except Exception:
                        break
                    if tone is not None:
                        shaped = tone.to_frame(shaped)
                        if spec.tone_cache is not None:
                            spec.tone_cache.put(stamp, shaped)
                    shaped.pts = stamp
                    shaped.time_base = Fraction(1, 90000)
                    for pkt in ostream.encode(shaped):
                        out.mux(pkt)
                continue
            if (frame.width, frame.height) != reformatter_size:
                frame = frame.reformat(
                    width=spec.width,
                    height=spec.height,
                    format="yuv420p",
                    interpolation=_sws_flags(),
                )
            elif str(frame.format.name) != "yuv420p":
                frame = frame.reformat(format="yuv420p")
            frame.pts = stamp
            frame.time_base = Fraction(1, 90000)
            for pkt in ostream.encode(frame):
                out.mux(pkt)
        else:
            continue
        break

    for pkt in ostream.encode():
        out.mux(pkt)
    if astream is not None and not copy_audio:
        try:
            for pkt in astream.encode():
                out.mux(pkt)
        except Exception:
            pass


# --------------------------------------------------------------------------
# measuring
# --------------------------------------------------------------------------


def frame_times(start: float, length: float, count: int) -> list:
    """The moments to compare, in seconds.

    Inset from both ends of the window, because the first frame after a cut is
    a keyframe and the most flattering frame in the encode - measuring there
    would systematically overstate quality.
    """
    if count <= 1 or length <= 0:
        return [start + max(0.0, length) / 2.0]
    inset = length / (count + 1)
    return [start + inset * (i + 1) for i in range(count)]


def _as_image(frame, size=None, tone_map=None):
    """One decoded frame as the picture a person would see.

    Straighten before resizing, and straighten the *source* only - the output
    we produce has its rotation baked in and carries no flag, so this reads
    zero on it. Skip this and every portrait video is scored against a sideways
    copy of itself, which measures the rotation rather than the encode and
    reports a catastrophe that is not there.

    A tone map is the same kind of correction: an HDR source compared against
    its own converted output without being converted first would score the
    conversion as damage and send the search hunting for a setting that cannot
    exist.
    """
    from PIL import Image

    turn = _turn_of(getattr(frame, "rotation", 0))
    if tone_map is not None:
        frame = tone_map.to_frame(frame)
    image = frame.to_image()
    if turn == 90:
        image = image.transpose(Image.ROTATE_90)
    elif turn == 180:
        image = image.transpose(Image.ROTATE_180)
    elif turn == 270:
        image = image.transpose(Image.ROTATE_270)
    if size and image.size != tuple(size):
        image = image.resize(tuple(size), Image.LANCZOS)
    return image


def decoded_frames_at(source, times) -> list:
    """The decoded frames nearest these moments, untouched.

    Paired by *timestamp*, never by position in the file. Two encodes of the
    same source do not necessarily contain the same number of frames - a
    dropped frame at the tail, a different keyframe cadence - and pairing the
    Nth of one with the Nth of the other silently compares frame 40 to frame
    39 and reports it as catastrophic quality loss. Asking both files what
    they were showing at 3.5 seconds cannot drift.

    `source` is a path or a bytes object; both open the same way, which is what
    lets a probe encode be measured without ever touching disk.
    """
    if not times:
        return []
    handle = (
        io.BytesIO(source)
        if isinstance(source, (bytes, bytearray))
        else str(source)
    )
    targets = sorted(float(t) for t in times)
    out = []
    index = 0
    previous = None

    with av.open(handle) as container:
        vs = container.streams.video[0]
        vs.thread_type = "AUTO"
        if targets[0] > 0.5:
            try:
                container.seek(
                    int(max(0.0, targets[0] - 0.5) / vs.time_base), stream=vs
                )
            except Exception:
                container.seek(int(max(0.0, targets[0] - 0.5) * 1_000_000))
        for frame in container.decode(vs):
            t = float(frame.time) if frame.time is not None else 0.0
            while index < len(targets) and t >= targets[index]:
                pick = frame
                if previous is not None and abs(
                    previous[0] - targets[index]
                ) < abs(t - targets[index]):
                    pick = previous[1]
                out.append(pick)
                index += 1
            if index >= len(targets):
                break
            previous = (t, frame)

    # A window that runs past the end of the file still has to answer. The
    # last frame is the honest answer for a moment after the last frame.
    while index < len(targets) and previous is not None:
        out.append(previous[1])
        index += 1
    return out


def read_frames_at(source, times, size=None, tone_map=None) -> list:
    """The frames nearest these moments, as RGB images ready to compare."""
    return [_as_image(frame, size, tone_map)
            for frame in decoded_frames_at(source, times)]


def read_frames(source, start: float, length: float, count: int,
                size=None, tone_map=None) -> list:
    """Evenly spaced frames from a window. Thin wrapper over the pair above."""
    return read_frames_at(source, frame_times(start, length, count), size=size,
                          tone_map=tone_map)


PEAK_SCAN_FRAMES = 3
"""Frames looked at per sample window when measuring how bright a file gets.
Cheap on purpose - this answers one question with one number, and the windows
already cover the whole runtime."""

PEAK_SCAN_SIZE = 960
"""Frames are shrunk to this before the peak is read. A 4K frame in floating
point is a quarter of a gigabyte once the arithmetic has copied it a few times,
and a highlight large enough to matter survives a halving."""


def measure_peak_nits(source, windows, tone_map) -> float:
    """The brightest thing this file actually contains, in nits.

    Falls back to the assumed peak when nothing can be decoded, because a file
    that will not open here will fail loudly a moment later in the encoder and
    should not fail quietly here first.
    """
    times = []
    for start, length in windows:
        times.extend(frame_times(start, length, PEAK_SCAN_FRAMES))
    peak = 0.0
    for frame in decoded_frames_at(source, times):
        try:
            peak = max(peak, content_peak_nits(tone_map.nits(_shrunk(frame))))
        except Exception:
            continue
    return peak if peak > 0.0 else tone_map.source_peak


def _shrunk(frame, limit: int = PEAK_SCAN_SIZE):
    longest = max(frame.width, frame.height)
    if longest <= limit:
        return frame
    scale = limit / float(longest)
    return frame.reformat(width=_even(round(frame.width * scale)),
                          height=_even(round(frame.height * scale)))


def pooled(scores) -> tuple:
    """(reported, mean) for a set of per-frame scores.

    The reported number is the low percentile, not the average, and the gap
    between them is itself information. A per-frame metric cannot see time, so
    an encode that looks perfect for four seconds and sags for one averages to
    "fine" while being exactly the thing a person notices. Reporting the worst
    end means the promise covers the whole clip.
    """
    if not scores:
        return 0.0, 0.0
    ordered = sorted(scores)
    mean = sum(ordered) / len(ordered)
    if len(ordered) < 4:
        # Too few scores for a percentile to mean anything. The raw minimum
        # was used here once and it made the search flinch: three frames is
        # every probe of every clip under a minute, and one unlucky frame -
        # a cut, a flash - drove the whole search to a needlessly high rung
        # and a needlessly large file. The median of a tiny set is the
        # estimate that one bad draw cannot own; the number a person is shown
        # still comes from the verify pass, which has enough scores for the
        # percentile below.
        # (lower middle, so a pair reports its worse half, not its better)
        return ordered[(len(ordered) - 1) // 2], mean
    index = max(0, int(math.floor(0.10 * (len(ordered) - 1))))
    return ordered[index], mean


def xpsnr(reference, candidate, width: int, height: int,
          tone_mapped: bool = False, info=None) -> float:
    """A second opinion, in dB, from a different family of metric.

    The search watches SSIMULACRA 2. If the only number we ever reported was
    the one the search optimised, we would have no way to tell "this encode is
    genuinely good" from "this encode found the metric's blind spot" - which
    is not hypothetical: encoders now ship modes tuned to score well on
    specific metrics. XPSNR is cheap, has published correlation with human
    opinion on video (not still images), and carries a temporal term, so it
    fails differently. Two numbers agreeing is the evidence; either one alone
    is a claim.

    The reference goes through the same straightening the encoder applied -
    a phone clip's output has its rotation baked into the pixels, and
    comparing it against the sideways stored frames would measure the
    rotation, return about 12 dB, and look like a catastrophe that is not
    there. Frames are paired by timestamp for the same reason the scorer
    pairs them that way: two files do not have to hold the same number of
    frames. And the result is pooled worst-first like every other score
    here, because an average is exactly the number that hides the five bad
    seconds a person notices.

    Returns 0.0 when there is no second opinion to be had, which is not a
    failure - it means this build, or this file, cannot offer one.

    A tone-mapped source is one of those files. The filter reads both clips
    straight out of their containers and nothing in this build can apply a PQ
    or HLG transfer inside a filter graph, so the reference it would compare
    against is the washed-out picture the conversion exists to prevent. It
    would return something near 12 dB and mean nothing by it, and a meaningless
    number that looks like a catastrophe is worse than an absent one.
    """
    if not _has_filter("xpsnr") or tone_mapped:
        return 0.0
    try:
        ref_h = io.BytesIO(reference) if isinstance(reference, (bytes, bytearray)) else str(reference)
        cand_h = io.BytesIO(candidate) if isinstance(candidate, (bytes, bytearray)) else str(candidate)
        with av.open(ref_h) as rc, av.open(cand_h) as cc:
            rs, cs = rc.streams.video[0], cc.streams.video[0]
            rs.thread_type = cs.thread_type = "AUTO"
            graph = av.filter.Graph()
            dist_in = graph.add_buffer(template=cs)
            ref_in = graph.add_buffer(template=rs)
            # The candidate was straightened and un-squashed on its way out
            # of the encoder, so the reference must be too.
            node = ref_in
            steps = (_transform_chain(info, width, height)[:-1]
                     if info is not None
                     else [("scale", f"{width}:{height}")])
            for name, args in steps:
                step = graph.add(name, args) if args else graph.add(name)
                node.link_to(step)
                node = step
            metric = graph.add("xpsnr")
            sink = graph.add("buffersink")
            dist_in.link_to(metric, 0, 0)
            node.link_to(metric, 0, 1)
            metric.link_to(sink)
            graph.configure()

            values = []

            def drain():
                while True:
                    try:
                        got = sink.pull()
                    except Exception:
                        return
                    raw = got.metadata.get("lavfi.xpsnr.xpsnr.y")
                    if raw:
                        try:
                            values.append(float(raw))
                        except ValueError:
                            pass

            # Paired by presentation time, not by position: for each frame
            # of the candidate, the reference is advanced to the frame
            # nearest that moment. Position pairing drifts the instant one
            # file drops or duplicates a frame, and then the metric reports
            # the drift instead of the encode.
            def moment(frame, fallback=0.0):
                return float(frame.time) if frame.time is not None else fallback

            ref_frames = rc.decode(rs)
            ahead = next(ref_frames, None)
            behind = None
            for frame in cc.decode(cs):
                t = moment(frame)
                while ahead is not None and moment(ahead, t) < t:
                    behind, ahead = ahead, next(ref_frames, None)
                if ahead is None:
                    pick = behind
                elif behind is None:
                    pick = ahead
                else:
                    pick = (ahead if abs(moment(ahead, t) - t)
                            <= abs(moment(behind, t) - t) else behind)
                if pick is None:
                    break
                dist_in.push(frame)
                ref_in.push(pick)
                drain()
            if not values:
                return 0.0
            reported, _mean = pooled(values)
            return reported
    except Exception:
        return 0.0


# --------------------------------------------------------------------------
# the search
# --------------------------------------------------------------------------

PROBE_FRAMES = 3
"""Frames scored per window while hunting for the setting. Small on purpose:
a probe only has to rank two settings against each other, and SSIMULACRA 2 is
the expensive part of every iteration."""

VERIFY_FRAMES = 8
"""Frames scored per window on the finished file. This is the number that gets
reported, so it is measured properly."""

class Cancelled(Exception):
    """Raised inside the engine when the caller asked it to stop.

    A video encode is the first thing this project does that can run for
    minutes, which makes stopping it a feature rather than a nicety: a person
    who picked the wrong destination should not have to choose between waiting
    it out and killing the whole application.
    """


class Progress:
    """Where a long job says what it is doing.

    Deliberately tiny, and deliberately not a callback the engine trusts. The
    engine calls `step()` at the points where it genuinely knows something
    new; the caller decides whether that becomes a progress bar, a line of
    text, or nothing at all.

    Stopping is checked in two places, and the difference matters. `step()`
    checks at stage boundaries. `check()` is asked *inside* the encode and
    verify loops, every second or so of content - because the stages are
    where the engine talks and the loops are where the minutes go, and a
    cancellation that waits for the next stage boundary on a half-hour encode
    is not a cancellation. Whoever owns a half-written file removes it on the
    way out, so stopping never leaves something that looks like a result.
    """

    def __init__(self, on_step=None, should_stop=None):
        self._on_step = on_step
        self._should_stop = should_stop
        self.stage = ""
        self.fraction = 0.0

    def step(self, stage: str, fraction: float, detail: str = "") -> None:
        self.stage = stage
        self.fraction = max(0.0, min(1.0, fraction))
        if self._should_stop is not None and self._should_stop():
            raise Cancelled()
        if self._on_step is not None:
            self._on_step(stage, self.fraction, detail)

    def check(self) -> None:
        if self._should_stop is not None and self._should_stop():
            raise Cancelled()


# The search is allowed to spend roughly this share of the total job before
# the final encode. Probing is what makes the result honest, but a person
# waiting on a ten-minute clip does not care that the eighth probe would have
# saved another two percent.
PROBE_BUDGET = 0.45

MIN_BITRATE = 120_000
"""Below this a 1080p encode is not a compromise, it is a smear. If a size cap
cannot be met above this floor, the honest answer is that it cannot be met."""


@dataclass
class VideoResult:
    """What happened to one video.

    Field names deliberately match `core.CompressionResult` wherever they mean
    the same thing, so the CLI and the desktop app can print an image and a
    video with the same code path.
    """

    source: Path
    output: Path = None
    suffix: str = ".mp4"
    original_bytes: int = 0
    new_bytes: int = 0
    fmt: str = ""
    level: int = 0
    score: float = 0.0
    score_mean: float = 0.0
    witness: float = 0.0
    metric: str = "ssimulacra2"
    resized_from: tuple = None
    resized_to: tuple = None
    duration: float = 0.0
    candidates: list = field(default_factory=list)
    warnings: list = field(default_factory=list)
    skipped: bool = False
    note: str = ""
    error: str = ""
    size_target: int = 0
    missed_size: bool = False
    capped: bool = False
    """The size cap, not the quality floor, decided the answer - so the result
    line has to say the picture is not as sharp as the original."""
    audio_copied: bool = False
    audio_note: str = ""

    tone_mapped: bool = False
    """The colour was converted from high dynamic range to ordinary colour.

    Posted as a fact by the engine rather than left for a surface to work out
    from the tags, exactly like `capped` and `audio_copied`: a disclosure that
    depends on somebody downstream noticing is not a disclosure.
    """

    hdr_peak_nits: float = 0.0
    """How bright the source actually got, measured. Zero when it was not an
    HDR file. Recorded because it is the one number that explains why two HDR
    clips converted with the same settings came out looking different."""

    @property
    def saved_bytes(self) -> int:
        return max(0, self.original_bytes - self.new_bytes)

    @property
    def saved_pct(self) -> float:
        if not self.original_bytes:
            return 0.0
        return 100.0 * self.saved_bytes / self.original_bytes


def _encode_windows(src, fmt, width, height, crf, windows, fast=True,
                    bitrate=0, info=None, progress=None):
    """One probe: every sample window encoded at one setting, in memory."""
    out = []
    for start, length in windows:
        spec = EncodeSpec(
            fmt=fmt, width=width, height=height, crf=crf, bitrate=bitrate,
            fast=fast, start=start, length=length, with_audio=False,
            faststart=False, info=info,
        )
        out.append(encode(src, spec, progress=progress))
    return out


_REF_CACHE_BUDGET = 512 * 1024 * 1024
"""How much decoded reference imagery one compress() call may keep around.
The same reference frames are read for every probe rung and again for every
format, and at 4K each one costs a couple of seconds of tone mapping - so
they are worth keeping. The budget stops an 8K `original` run from trading
the time problem for a memory one."""


def _cached_reference(cache, src, start, length, count, size, tone_map):
    """The reference frames for one window, remembered across the search.

    Safe to share because the reference depends only on the source, the
    window and the comparison size - all fixed for the whole of one
    compress() call - and the images are only ever read, never drawn on.
    """
    if cache is None:
        return read_frames(src, start, length, count, size=size,
                           tone_map=tone_map)
    key = (round(start, 3), round(length, 3), count)
    frames = cache.get(key)
    if frames is None:
        frames = read_frames(src, start, length, count, size=size,
                             tone_map=tone_map)
        cost = sum(f.width * f.height * 3 for f in frames)
        if cache.get("_bytes", 0) + cost <= _REF_CACHE_BUDGET:
            cache[key] = frames
            cache["_bytes"] = cache.get("_bytes", 0) + cost
    return frames


def _score_windows(src, encoded, width, height, windows, per_window,
                   tone_map=None, ref_cache=None):
    """Compare each encoded window against the same seconds of the source.

    The reference is scaled to the candidate's frame size before comparison.
    That is not a detail: if the video was made smaller on screen, scoring the
    small candidate against the big original would fold the resize into the
    codec's score and blame the encoder for a decision the destination made.
    Resizing is disclosed on its own line; this measures the encode.

    The tone map is applied to the reference and never to the candidate, for
    the same reason: the candidate has already been converted, and converting
    it twice would measure our own arithmetic instead of the codec's loss.
    """
    from . import quality as _quality

    scores = []
    for (start, length), data in zip(windows, encoded):
        reference = _cached_reference(ref_cache, src, start, length,
                                      per_window, (width, height), tone_map)
        candidate = read_frames(data, 0.0, length, per_window,
                                size=(width, height))
        for ref, cand in zip(reference, candidate):
            try:
                scores.append(_quality.ssimulacra2(ref, cand))
            except Exception:
                continue
    return scores


def _search_quality(src, fmt, width, height, target, windows, fast, log=None,
                    info=None, progress=None, ref_cache=None):
    """Find the lowest-quality rung that still measures at or above `target`.

    Straight bisection over the CRF ladder, the same shape as the image tier's
    search over a JPEG quality ladder, and for the same reason: the ladder is
    ordered, the metric is monotone enough across it, and four probes settle
    sixteen rungs. The top rung is tried first so a source no setting can
    satisfy - already heavily compressed, or pure noise - costs one probe
    rather than a whole search.
    """
    memo = {}

    probes_done = [0]

    def probe(index):
        if index not in memo:
            if progress is not None:
                # Four probes is the usual settle, so report against that and
                # let the bar sit at the top of the range if a stubborn file
                # needs more. A bar that goes backwards is worse than a bar
                # that pauses.
                probes_done[0] += 1
                progress.step(
                    "looking for the setting",
                    PROBE_BUDGET * min(1.0, probes_done[0] / 5.0),
                    f"{fmt.name}, try {probes_done[0]}",
                )
            data = _encode_windows(src, fmt, width, height,
                                   fmt.levels[index], windows, fast=True,
                                   info=info, progress=progress)
            scores = _score_windows(src, data, width, height, windows,
                                    PROBE_FRAMES,
                                    tone_map=getattr(info, "tone_map", None),
                                    ref_cache=ref_cache)
            reported, _ = pooled(scores)
            memo[index] = (reported, sum(len(d) for d in data))
            if log is not None:
                log.append((fmt.name, fmt.levels[index], reported,
                            memo[index][1]))
        return memo[index]

    top = len(fmt.levels) - 1
    best_possible, _ = probe(top)
    if best_possible < target:
        # Nothing on the ladder reaches the floor. Best effort, and the caller
        # warns - the same contract the image search has.
        return top, memo, False

    chosen = top
    lo, hi = 0, top
    while lo <= hi:
        mid = (lo + hi) // 2
        reported, _ = probe(mid)
        if reported >= target:
            chosen, hi = mid, mid - 1
        else:
            lo = mid + 1
    return chosen, memo, True


def measured_duration(source, info=None) -> float:
    """How long the video actually runs, counted from its packets.

    The container carries a duration label, and on real phone recordings the
    label sometimes lies - a copy interrupted mid-transfer, a live photo's
    sidecar, a muxer that wrote the header before it knew. Everything that
    divides by the duration has to survive that: a one-second claim on a
    ten-minute file aims six hundred times too many bits per second at a
    size cap, and a zero refuses a perfectly encodable file outright.

    Demuxes without decoding, so it costs one read of the file, and it is
    only paid on the paths where a wrong duration writes a wrong file.
    Falls back to the label when the packets cannot be read at all.
    """
    label = float(getattr(info, "duration", 0.0) or 0.0)
    try:
        with av.open(str(source)) as container:
            vs = container.streams.video[0]
            begin = end = None
            for packet in container.demux(vs):
                if packet.dts is None or packet.pts is None:
                    continue
                base = packet.time_base or vs.time_base
                if base is None:
                    continue
                t = float(packet.pts * base)
                span = float((packet.duration or 0) * base)
                begin = t if begin is None else min(begin, t)
                end = t + span if end is None else max(end, t + span)
            if begin is not None and end is not None and end > begin:
                return end - begin
    except Exception:
        pass
    return label


def _bitrate_for_cap(cap_bytes, duration, info, audio) -> int:
    """Bits per second that lands under a hard byte ceiling.

    Aim at 95% of the cap, not 100%: container overhead is real, rate control
    is approximate, and a file that misses Discord's limit by 40 KB is as
    useless as one that misses it by 4 MB.
    """
    if duration <= 0:
        return 0
    audio_bits = 0
    if info.has_audio:
        audio_bits = 128_000 if audio != "copy" else max(
            96_000, min(info.audio_bitrate or 128_000, 256_000)
        )
    budget = cap_bytes * 0.95 * 8
    return int(max(0, (budget / duration) - audio_bits))


def compress(source, destination, *, fast=False, size_target=0,
             max_dimension=None, quality_target=None, formats=None,
             output_dir=None, on_progress=None, should_stop=None):
    """Compress one video for one destination. The whole engine, in order.

    Returns a `VideoResult`. Never raises for an unreadable file: a broken
    video is reported and skipped, exactly like a broken image.
    """
    from . import destinations as dest

    source = Path(source)
    result = VideoResult(source=source)
    try:
        result.original_bytes = source.stat().st_size
    except OSError as exc:
        result.error = str(exc)
        return result

    if not HAVE_AV:
        result.skipped = True
        result.error = "video needs an extra install - " + INSTALL_HINT
        return result

    name = dest.resolve(destination)
    if not dest.takes_video(name):
        result.skipped = True
        result.note = name + " is for pictures, not video - left alone"
        return result

    entry = dest.get(name)
    try:
        info = probe(source)
    except Exception as exc:
        result.error = "could not read this video (" + str(exc) + ")"
        return result

    if not info.width or not info.height:
        result.error = "no video track"
        return result

    # High dynamic range is converted, not refused and not flattened. It is
    # only refused when it is flagged as HDR by a transfer curve this engine
    # has no arithmetic for - see `tone_map_for`, which returns None rather
    # than guessing. A documented refusal beats a washed-out video; an honest
    # conversion beats both.
    if info.hdr and info.tone_map is None:
        result.skipped = True
        result.note = (
            "HDR video in a kind of colour this app cannot convert yet, so it "
            "was left exactly as it is"
        )
        result.new_bytes = result.original_bytes
        return result

    if info.probe_note:
        result.warnings.append(
            info.probe_note + " - if the result comes out sideways or with "
            "odd colour, this file is why"
        )

    result.duration = info.duration
    limit = entry.video_max_dimension if max_dimension is None else max_dimension
    shown = display_shape(info)
    width, height = frame_for(shown[0], shown[1], limit)
    if (width, height) != shown:
        result.resized_from = shown
        result.resized_to = (width, height)

    # Anything the output cannot carry is said out loud. One soundtrack is a
    # defensible choice; losing the second one in silence is not.
    if info.audio_tracks > 1:
        result.warnings.append(
            f"kept the first soundtrack, dropped {info.audio_tracks - 1} other"
            + ("s" if info.audio_tracks > 2 else "")
        )
    if info.subtitles:
        result.warnings.append(
            f"dropped {info.subtitles} subtitle track"
            + ("s" if info.subtitles > 1 else "")
        )

    target = entry.video_target if quality_target is None else quality_target
    cap_bytes = int(size_target) if size_target else int(
        entry.size_cap_mb * 1024 * 1024
    )

    wanted = list(formats) if formats else list(entry.video_formats)
    live = usable(wanted)
    if not live:
        result.error = "no video encoder available on this machine"
        return result
    if len(live) < len(wanted):
        missing = [n for n in wanted if n not in live]
        result.warnings.append(
            "this machine cannot write " + ", ".join(missing)
        )

    # The container's duration label steers everything that divides by time -
    # the sample windows, and above all the bitrate a size cap aims. Labels
    # lie on real files, so whenever the label is missing or a wrong label
    # would write a wrong file, the packets are counted instead.
    duration = info.duration
    if cap_bytes or duration <= 0:
        counted = measured_duration(source, info)
        if counted > 0:
            if duration <= 0 or abs(counted - duration) > 0.05 * counted:
                duration = counted
    result.duration = duration or info.duration

    windows = sample_windows(duration)
    out_dir = Path(output_dir) if output_dir else source.parent
    probe_log = []
    ref_cache = {}
    progress = Progress(on_progress, should_stop)
    progress.step("reading", 0.02, source.name)

    if info.tone_map is not None:
        # Measured before anything is encoded, and then held fixed for the
        # whole file. A peak recomputed per frame would make the picture
        # breathe every time a highlight entered the shot, which is the one
        # artefact of tone mapping a person notices without being told to
        # look for it.
        info.tone_map = info.tone_map.with_peak(
            measure_peak_nits(source, windows, info.tone_map)
        )
        result.tone_mapped = True
        result.hdr_peak_nits = info.tone_map.source_peak
        result.warnings.append(HDR_DISCLOSURE)

    # HDR costs more than a second of arithmetic per 4K frame, and a
    # destination that allows two formats would otherwise pay it twice for
    # pixels that come out identical. Only built when there is both a
    # conversion to remember and a second format to remember it for.
    tone_cache = (ToneCache()
                  if info.tone_map is not None and len(live) > 1 else None)

    best = None
    for fmt_name in live:
        fmt = FORMATS[fmt_name]
        try:
            # Quality first, even when there is a cap. "Fits under 10 MB" is a
            # limit, not an instruction to spend 10 MB: if the smallest encode
            # that still looks right is 3 MB, that is the answer, and filling
            # the budget would make a worse product out of a bigger file. Only
            # when the honest quality answer does not fit does the cap take
            # over and decide - and then it says so.
            candidate = _at_quality(source, fmt, width, height, info,
                                    target, entry.audio, windows, fast,
                                    out_dir, probe_log, progress,
                                    ref_cache=ref_cache,
                                    tone_cache=tone_cache)
            if cap_bytes and (candidate is None
                              or candidate["bytes"] > cap_bytes):
                over_cap = candidate
                candidate = _under_cap(source, fmt, width, height, info,
                                       cap_bytes, duration, entry.audio,
                                       windows, fast, out_dir, probe_log,
                                       progress, ref_cache=ref_cache,
                                       tone_cache=tone_cache)
                if candidate is None:
                    # The cap cannot be met at any usable rate - a corrupt
                    # duration, or a limit no encode can reach. The honest
                    # quality answer, over the cap and disclosed as over the
                    # cap, beats "every encoder failed" on a file that
                    # encodes fine.
                    candidate = over_cap
                elif over_cap is not None:
                    _unlink(over_cap["path"])
        except Cancelled:
            # Stopping is not failing. Everything written so far is removed,
            # because a half-encoded file that looks finished is the one
            # outcome worse than no file at all.
            for leftover in (best, locals().get("candidate")):
                if isinstance(leftover, dict):
                    _unlink(leftover.get("path"))
            if tone_cache is not None:
                tone_cache.clear()
            result.skipped = True
            result.note = "stopped"
            result.new_bytes = result.original_bytes
            return result
        except Exception as exc:  # one format failing must not end the run
            result.warnings.append(fmt_name + " failed (" + str(exc) + ")")
            continue
        if candidate is None:
            continue
        result.candidates.append(
            (fmt_name, candidate["bytes"], candidate["score"])
        )
        if best is None:
            best = candidate
        elif _beats(candidate, best, bool(cap_bytes)):
            _unlink(best["path"])
            best = candidate
        else:
            _unlink(candidate["path"])

    if tone_cache is not None:
        # The bake-off is over, so the converted frames have no next reader.
        # Held any longer this is just several hundred megabytes of a file
        # nobody is encoding.
        tone_cache.clear()

    if best is None:
        result.error = "every encoder failed on this file"
        return result

    settled = _final_path(out_dir, source, FORMATS[best["fmt"]])
    if settled != best["path"]:
        try:
            if settled.exists():
                settled.unlink()
            best["path"].replace(settled)
            best["path"] = settled
        except OSError as exc:
            result.warnings.append(f"could not name the result ({exc})")

    result.fmt = best["fmt"]
    result.level = best["crf"]
    result.score = best["score"]
    result.score_mean = best["mean"]
    result.new_bytes = best["bytes"]
    result.output = best["path"]
    result.suffix = FORMATS[best["fmt"]].extension
    result.audio_copied = best["audio_copied"]
    if info.has_audio:
        state = best.get("audio_state",
                         "copied" if best["audio_copied"] else "encoded")
        if state == "lost":
            # The one thing worse than re-encoded sound is no sound at all
            # presented as sound. Said twice on purpose: once where the
            # facts live and once where warnings cannot be missed.
            result.audio_note = ("This file has no sound - the original's "
                                 "sound could not be carried over.")
            result.warnings.append(
                "the sound could not be converted, so the result is silent"
            )
        elif state == "copied":
            result.audio_note = "Sound kept exactly as it was."
        else:
            result.audio_note = "Sound re-encoded to fit this format."
    result.witness = best.get("witness", 0.0)
    result.size_target = cap_bytes

    if cap_bytes:
        result.missed_size = result.new_bytes > cap_bytes
        result.capped = bool(best.get("capped"))
        if result.missed_size:
            result.warnings.append(
                "could not get under the size limit without ruining it"
            )
    # Falling short of the floor is disclosed whether or not there was a size
    # limit involved. Hanging this off the `else` of the cap branch meant a
    # destination that has a limit - which is most of them - could ship a
    # video below its own quality floor and say nothing, because the code was
    # busy reporting the limit it *did* meet. A disclosure that only fires
    # when nothing else went wrong is not a disclosure.
    if result.score < target:
        result.warnings.append(
            f"could not reach a visual match of {target:g} "
            f"(best was {result.score:.1f})"
        )

    progress.step("done", 1.0, result.fmt)

    # Never ship a bigger file than the one handed to us. A video already
    # smaller than anything we can make is a video we leave alone. No
    # exception for resized output: this rule used to step aside whenever
    # the destination's frame cap had fired, and a re-encode *larger* than
    # its source shipped anyway, wearing "-0%". A limit on the frame is not
    # a licence to hand back a worse file.
    if result.new_bytes >= result.original_bytes:
        _unlink(result.output)
        result.output = None
        result.new_bytes = result.original_bytes
        result.skipped = True
        result.note = "already smaller than anything we could make - left alone"
        # Every measurement below describes a file that no longer exists.
        # Clearing the colour disclosure was the half of this the code already
        # did; the half it missed is the half a person reads first. The app
        # told them their untouched video "was measured at 94" and that "its
        # sound was kept exactly as it was" - when nothing was encoded, and
        # nothing was kept because nothing was made. A fact about a deleted
        # file is not a fact.
        result.score = 0.0
        result.score_mean = 0.0
        result.witness = 0.0
        result.fmt = ""
        result.level = 0
        result.audio_copied = False
        result.audio_note = ""
        result.capped = False
        result.missed_size = False
        # The kept file is the source at its own size, so the resize facts
        # describe nothing either.
        result.resized_from = None
        result.resized_to = None
        # And so do the warnings about the deleted encode: the quality it
        # fell short of, the limit it missed, the sound it lost. Only the
        # facts about the *source* file survive.
        stale = ("soundtrack", "subtitle", "could not reach a visual match",
                 "could not get under the size limit", "sound could not be")
        result.warnings = [w for w in result.warnings
                           if not any(marker in w for marker in stale)]
        if result.tone_mapped:
            # Nothing shipped, so nothing was converted, so the colour
            # disclosure has to go with it - it would otherwise describe a
            # file that does not exist while the person still holds an HDR
            # one. The note says which file they are actually left with.
            result.tone_mapped = False
            result.warnings = [w for w in result.warnings
                               if w != HDR_DISCLOSURE]
            result.note = ("already smaller than anything we could make, so "
                           "the HDR original was kept exactly as it is")

    return result


def _beats(candidate, best, under_cap) -> bool:
    """Which of two finished encodes wins.

    The rule inverts under a size cap, and that inversion is the whole reason
    this is a function. With no cap, everything on the table already measures
    close enough, so the smallest file wins. Under a cap, everything on the
    table already fits, so the best-looking one wins. Getting this backwards
    produces a technically-correct file nobody wants.
    """
    # A candidate that met the quality floor always beats one that only met
    # the byte limit, whatever the numbers say: the first kept the promise and
    # the second is a compromise we are about to disclose.
    if candidate.get("capped") != best.get("capped"):
        return not candidate.get("capped")
    if candidate.get("capped"):
        if candidate["score"] != best["score"]:
            return candidate["score"] > best["score"]
        return candidate["bytes"] < best["bytes"]
    if candidate["bytes"] != best["bytes"]:
        return candidate["bytes"] < best["bytes"]
    return candidate["score"] > best["score"]


VERIFY_CLIMB_LIMIT = 2
"""How many rungs the verify pass may climb when the finished file measures
short of what the probes promised. Each climb is a full-file encode plus a
full verify - minutes each on a long clip - and an unbounded loop here could
re-encode the whole file nineteen times outside every budget the search
respects. Two climbs recovers the probe-versus-verify optimism this exists
for; a file still short after that is disclosed as short, which is the same
contract the search itself has when the whole ladder cannot reach the floor."""


def _at_quality(src, fmt, width, height, info, target, audio, windows, fast,
                out_dir, probe_log, progress=None, ref_cache=None,
                tone_cache=None):
    """The ordinary case: smallest file that still measures close enough."""
    index, _memo, reached = _search_quality(src, fmt, width, height, target,
                                            windows, fast, probe_log,
                                            info=info, progress=progress,
                                            ref_cache=ref_cache)
    if progress is not None:
        progress.step("compressing", PROBE_BUDGET + 0.05, fmt.name)
    crf = fmt.levels[index]
    path = _output_path(out_dir, src, fmt)
    try:
        spec = EncodeSpec(fmt=fmt, width=width, height=height, crf=crf,
                          fast=fast, audio=audio, with_audio=True,
                          faststart=True, info=info, tone_cache=tone_cache)
        encode(src, spec, dest=path, progress=progress)

        if progress is not None:
            progress.step("checking the result", 0.9, fmt.name)
        score, mean, audio_state = _verify(src, path, width, height, windows,
                                           audio, info, spec=spec,
                                           ref_cache=ref_cache,
                                           progress=progress)
        # Sampled probes can be optimistic - they look at three frames per
        # window where the verify looks at eight. If the finished file
        # misses, climb - a bounded number of times, because each climb is a
        # whole-file encode and the shortfall disclosure exists for the rest.
        climbs = 0
        while (score < target and index < len(fmt.levels) - 1
               and climbs < VERIFY_CLIMB_LIMIT):
            climbs += 1
            index += 1
            crf = fmt.levels[index]
            if progress is not None:
                progress.step("checking the result",
                              min(0.97, 0.9 + 0.03 * climbs),
                              f"{fmt.name}, one rung higher")
            spec = EncodeSpec(fmt=fmt, width=width, height=height, crf=crf,
                              fast=fast, audio=audio, with_audio=True,
                              faststart=True, info=info,
                              tone_cache=tone_cache)
            encode(src, spec, dest=path, progress=progress)
            score, mean, audio_state = _verify(src, path, width, height,
                                               windows, audio, info,
                                               spec=spec, ref_cache=ref_cache,
                                               progress=progress)
    except Cancelled:
        # This format's own half-written file is this format's to remove.
        # The caller only knows about finished candidates, so a file
        # abandoned mid-encode would otherwise sit next to the person's
        # source looking like a result.
        _unlink(path)
        raise

    return {
        "fmt": fmt.name, "crf": crf, "path": path,
        "bytes": path.stat().st_size, "score": score, "mean": mean,
        "audio_state": audio_state,
        "audio_copied": audio_state == "copied",
        "reached": reached, "capped": False,
        "witness": xpsnr(src, path, width, height,
                         tone_mapped=getattr(info, "tone_map", None)
                         is not None, info=info),
    }


def _under_cap(src, fmt, width, height, info, cap_bytes, duration, audio,
               windows, fast, out_dir, probe_log, progress=None,
               ref_cache=None, tone_cache=None):
    """The hard-ceiling case: the best this can look inside N bytes.

    Rate-targeted rather than quality-targeted, because you cannot promise
    both. One encode, one measurement, and one retry at a tighter rate if the
    first overshoots - which is the whole of the state of the art here, and is
    what every tool that reliably hits a chat app's limit actually does.

    `duration` arrives measured from the packets, not read from the
    container's label - see `measured_duration`. Trusting the label here once
    turned a 10 MB cap into a 5,690 MB file, because the label claimed one
    second of a ten-minute clip and the arithmetic dutifully aimed eighty
    megabits at it.
    """
    bitrate = _bitrate_for_cap(cap_bytes, duration, info, audio)
    if bitrate < MIN_BITRATE:
        return None

    path = _output_path(out_dir, src, fmt)
    try:
        spec = None
        for attempt in range(2):
            spec = EncodeSpec(fmt=fmt, width=width, height=height,
                              bitrate=bitrate, fast=fast, audio=audio,
                              with_audio=True, faststart=True, info=info,
                              tone_cache=tone_cache)
            encode(src, spec, dest=path, progress=progress)
            size = path.stat().st_size
            if size <= cap_bytes or attempt == 1:
                break
            # Overshot. Scale the rate by how much, with a little margin, and
            # go again exactly once.
            bitrate = int(bitrate * (cap_bytes / float(size)) * 0.95)
            if bitrate < MIN_BITRATE:
                break

        score, mean, audio_state = _verify(src, path, width, height, windows,
                                           audio, info, spec=spec,
                                           ref_cache=ref_cache,
                                           progress=progress)
    except Cancelled:
        _unlink(path)
        raise
    return {
        "fmt": fmt.name, "crf": 0, "path": path,
        "bytes": path.stat().st_size, "score": score, "mean": mean,
        "audio_state": audio_state,
        "audio_copied": audio_state == "copied",
        "reached": True, "capped": True,
        "witness": xpsnr(src, path, width, height,
                         tone_mapped=getattr(info, "tone_map", None)
                         is not None, info=info),
    }


def _verify(src, path, width, height, windows, audio, info, spec=None,
            ref_cache=None, progress=None):
    """Measure the finished file properly, and report what became of the sound.

    The audio answer comes from what the encode *recorded doing* plus one
    check that the finished file really carries a track. It used to be
    inferred by comparing codec names on the finished file, which told two
    lies: audio decoded and re-encoded back to its own codec read as "kept
    exactly as it was", and audio that failed to open at all - a silent file -
    read as "re-encoded". A fact about sound has to come from the moment the
    sound was handled.
    """
    from . import quality as _quality

    tone_map = getattr(info, "tone_map", None)
    scores = []
    for start, length in windows:
        if progress is not None:
            progress.check()
        reference = _cached_reference(ref_cache, src, start, length,
                                      VERIFY_FRAMES, (width, height),
                                      tone_map)
        candidate = read_frames(path, start, length, VERIFY_FRAMES,
                                size=(width, height))
        for ref, cand in zip(reference, candidate):
            try:
                scores.append(_quality.ssimulacra2(ref, cand))
            except Exception:
                continue
    reported, mean = pooled(scores)

    audio_state = "absent"
    if info.has_audio:
        carried = False
        try:
            with av.open(str(path)) as out:
                carried = bool(out.streams.audio)
        except Exception:
            carried = False
        if not carried:
            audio_state = "lost"
        elif spec is not None and spec.audio_copied:
            audio_state = "copied"
        else:
            audio_state = "encoded"
    return reported, mean, audio_state


def _output_path(out_dir, src, fmt) -> Path:
    """Where one candidate is written while the bake-off is still running.

    The format's name is in the filename, and it has to be: AV1 and H.264 both
    live in `.mp4`, so naming candidates after the source alone gives every
    competitor in a multi-format destination the same path. They overwrite
    each other, and then the loser's cleanup deletes the winner's file - the
    engine reports a size for a file that is no longer there. `web`, `chat`
    and `original` all allow two formats, so that was most of them.
    """
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    return out_dir / f"{Path(src).stem}.{fmt.name}{fmt.extension}"


def _final_path(out_dir, src, fmt) -> Path:
    """What the winner is called once there is nothing left to compare it to."""
    return Path(out_dir) / (Path(src).stem + fmt.extension)


def _unlink(path):
    try:
        if path is not None:
            Path(path).unlink()
    except OSError:
        pass
