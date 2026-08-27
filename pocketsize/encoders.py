"""Candidate encoders.

Each encoder exposes an ascending ladder of quality levels so the search can
bisect over it generically, and reports whether it can carry transparency.

Three optional pip packages do real work here when present. All three ship
Windows wheels, so `pip install -r requirements.txt` gets you the good path on
any machine:

* ``imagequant``  - libimagequant, the engine inside pngquant. Pillow's own
  quantizers are not close: on a UI screenshot, libimagequant hit SSIMULACRA2
  90 at 64 colours while Pillow's best (MEDIANCUT at 256 colours) reached only
  87 in a larger file. MAXCOVERAGE and FASTOCTREE scored around 30.
* ``zopflipy``    - zopflipng-grade deflate. Another ~10% off any PNG, lossless.
* ``mozjpeg_lossless_optimization`` - mozjpeg's lossless recompression pass.
  Small (~1%), free, and never changes a pixel.
"""

from __future__ import annotations

import io
import warnings

from PIL import Image

# Pillow 12 ships an AVIF plugin but does not register it on `import PIL.Image`
# the way it does JPEG or WebP: the codec only appears in `Image.SAVE` once the
# plugin module has been imported. `AvifEncoder.available()` asks
# `"AVIF" in Image.SAVE`, so without this line a machine that can write AVIF
# perfectly well reports that it cannot - and the format silently drops out of
# every destination that offers it.
#
# Found on a real folder: 67 photographic PNGs where AVIF at a visual match of
# 88 was half the size of the JPEG the bake-off settled for, because AVIF was
# never in the running.
#
# Guarded because the plugin is genuinely absent on some builds, which is the
# case `available()` exists for. The import is for its registration side effect
# only, hence the noqa.
try:
    import PIL.AvifImagePlugin  # noqa: F401
except Exception:
    pass

try:
    import imagequant as _imagequant

    HAVE_IMAGEQUANT = True
except Exception:  # pragma: no cover
    HAVE_IMAGEQUANT = False

try:
    import zopfli as _zopfli

    HAVE_ZOPFLI = True
except Exception:  # pragma: no cover
    HAVE_ZOPFLI = False

try:
    import mozjpeg_lossless_optimization as _mozjpeg

    HAVE_MOZJPEG = True
except Exception:  # pragma: no cover
    HAVE_MOZJPEG = False


PNG8_COLORS = [16, 24, 32, 48, 64, 96, 128, 192, 256]
# The lossy ladders reach into the high 90s deliberately: with a strict floor,
# a ceiling of 96 meant no lossy rung could pass on hard content and a
# multi-megabyte lossless PNG won by forfeit. Bisection makes the extra rungs
# cost at most one more probe.
JPEG_QUALITY = [40, 50, 58, 65, 70, 74, 78, 82, 85, 88, 90, 92, 94, 96, 97, 98, 99]
WEBP_QUALITY = [40, 50, 58, 65, 70, 75, 80, 84, 87, 90, 92, 94, 96, 98]
AVIF_QUALITY = [30, 38, 45, 52, 58, 64, 70, 76, 82, 88, 93, 96]


def _zopfli_png(data: bytes, enabled: bool = True) -> bytes:
    if not (enabled and HAVE_ZOPFLI):
        return data
    try:
        out = _zopfli.ZopfliPNG().optimize(data)
        return out if len(out) < len(data) else data
    except Exception:
        return data


class Encoder:
    """Base class. `levels` runs worst -> best quality."""

    name = "?"
    extension = ".bin"
    supports_alpha = False
    lossless = False
    levels: list[int] = []

    def __init__(self, zopfli: bool = True):
        self.zopfli = zopfli

    def encode(self, img: Image.Image, level: int, fast: bool = False) -> bytes:
        raise NotImplementedError

    def available(self) -> bool:
        return True


class JpegEncoder(Encoder):
    """JPEG at 4:4:4.

    Chroma subsampling is deliberately off. On a colour-aware metric, 4:2:0 is
    punished hard on saturated content: in testing, matching 4:4:4's score at
    quality 76 needed quality 97 with 4:2:0, and the resulting file was ~3.8x
    larger. Luma-only SSIM cannot see this, which is how the mistake survives
    in most hand-rolled compressors.
    """

    name = "jpeg"
    extension = ".jpg"
    supports_alpha = False
    levels = JPEG_QUALITY

    def __init__(self, zopfli: bool = True, background=(255, 255, 255)):
        super().__init__(zopfli)
        self.background = background

    def encode(self, img: Image.Image, level: int, fast: bool = False) -> bytes:
        flat = img
        if img.mode == "RGBA":
            backdrop = Image.new("RGBA", img.size, tuple(self.background) + (255,))
            flat = Image.alpha_composite(backdrop, img).convert("RGB")
        elif img.mode != "RGB":
            flat = img.convert("RGB")

        buf = io.BytesIO()
        flat.save(buf, "JPEG", quality=level, optimize=True,
                  progressive=True, subsampling="4:4:4")
        data = buf.getvalue()
        if not fast and HAVE_MOZJPEG:
            try:
                better = _mozjpeg.optimize(data)
                if len(better) < len(data):
                    data = better
            except Exception:
                pass
        return data


class Png8Encoder(Encoder):
    """Palette PNG. Level is the palette size."""

    name = "png8"
    extension = ".png"
    supports_alpha = True
    levels = PNG8_COLORS

    def available(self) -> bool:
        return True

    def encode(self, img: Image.Image, level: int, fast: bool = False) -> bytes:
        if HAVE_IMAGEQUANT:
            pal = _imagequant.quantize_pil_image(
                img.convert("RGBA"), max_colors=level, dithering_level=1.0
            )
            if img.mode != "RGBA":
                # Opaque source: drop the alpha entry libimagequant always adds,
                # otherwise Pillow warns and writes a needless tRNS chunk.
                pal.info.pop("transparency", None)
        else:
            # Pillow fallback. Materially worse - see module docstring.
            pal = (
                img.quantize(colors=level, method=Image.FASTOCTREE)
                if img.mode == "RGBA"
                else img.convert("RGB").quantize(
                    colors=level, method=Image.MEDIANCUT, dither=Image.FLOYDSTEINBERG
                )
            )
        buf = io.BytesIO()
        with warnings.catch_warnings():
            # Palette + tRNS is exactly what we want here; Pillow warns anyway.
            warnings.simplefilter("ignore", UserWarning)
            pal.save(buf, "PNG", optimize=True, compress_level=9)
        data = buf.getvalue()
        return data if fast else _zopfli_png(data, self.zopfli)


class PngEncoder(Encoder):
    """Full-colour lossless PNG. One level."""

    name = "png"
    extension = ".png"
    supports_alpha = True
    lossless = True
    levels = [100]

    def encode(self, img: Image.Image, level: int, fast: bool = False) -> bytes:
        buf = io.BytesIO()
        img.save(buf, "PNG", optimize=True, compress_level=9)
        data = buf.getvalue()
        return data if fast else _zopfli_png(data, self.zopfli)


class WebpEncoder(Encoder):
    name = "webp"
    extension = ".webp"
    supports_alpha = True
    levels = WEBP_QUALITY

    def encode(self, img: Image.Image, level: int, fast: bool = False) -> bytes:
        buf = io.BytesIO()
        img.save(buf, "WEBP", quality=level, method=3 if fast else 6)
        return buf.getvalue()


class WebpLosslessEncoder(Encoder):
    name = "webp-lossless"
    extension = ".webp"
    supports_alpha = True
    lossless = True
    levels = [100]

    def encode(self, img: Image.Image, level: int, fast: bool = False) -> bytes:
        buf = io.BytesIO()
        img.save(buf, "WEBP", lossless=True, method=4 if fast else 6)
        return buf.getvalue()


class AvifEncoder(Encoder):
    """AVIF, where Pillow was built with one.

    Pillow gained native AVIF support in 11.3, but only where the wheel was
    built against libavif - which most Windows wheels are not, and the plugin
    (`pillow-avif-plugin`) is a separate install. The browser engine has had
    AVIF since the WASM codec tier landed, so the destination table lists it
    either way and this reports honestly whether this machine can write one.
    A destination that offers a format nobody here can encode simply loses it,
    the same way `png8` falls back when libimagequant is missing.
    """

    name = "avif"
    extension = ".avif"
    supports_alpha = True
    levels = AVIF_QUALITY

    def available(self) -> bool:
        return "AVIF" in Image.SAVE

    def encode(self, img: Image.Image, level: int, fast: bool = False) -> bytes:
        buf = io.BytesIO()
        img.save(buf, "AVIF", quality=level, speed=8 if fast else 4)
        return buf.getvalue()


ALL = {
    "jpeg": JpegEncoder,
    "png8": Png8Encoder,
    "png": PngEncoder,
    "webp": WebpEncoder,
    "webp-lossless": WebpLosslessEncoder,
    "avif": AvifEncoder,
}


def build(names, zopfli: bool = True, background=(255, 255, 255)) -> list[Encoder]:
    """Instantiate the named encoders, dropping any this machine cannot run."""
    out = []
    for name in names:
        cls = ALL[name]
        enc = cls(zopfli=zopfli, background=background) if cls is JpegEncoder else cls(zopfli=zopfli)
        if enc.available():
            out.append(enc)
    return out


def usable(names) -> list:
    """Of `names`, the ones that exist and this machine can actually write.

    Which formats a destination *offers* and which it can *emit here* are
    different questions, and conflating them is how a destination table that
    lists AVIF turns into a KeyError on a machine without an AVIF encoder.
    """
    return [n for n in names if n in ALL and ALL[n](zopfli=False).available()]


def capabilities() -> dict:
    return {
        "imagequant (pngquant engine)": HAVE_IMAGEQUANT,
        "zopfli (png recompression)": HAVE_ZOPFLI,
        "mozjpeg (lossless jpeg pass)": HAVE_MOZJPEG,
    }
