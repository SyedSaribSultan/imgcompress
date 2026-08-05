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


ALL = {
    "jpeg": JpegEncoder,
    "png8": Png8Encoder,
    "png": PngEncoder,
    "webp": WebpEncoder,
    "webp-lossless": WebpLosslessEncoder,
}

# Which candidates each target is allowed to emit.
#
# figma: Figma's own docs say uploads are accepted as JPG, PNG, HEIC, WebP, GIF
#        and TIFF - but its plugin API only knows PNG/JPEG/GIF, and the standing
#        community answer is that WebP gets transcoded to PNG on import. If that
#        is right, shipping WebP to Figma turns a small file into a large PNG.
#        The downside is bad and the upside is small, so this target sticks to
#        JPEG and PNG.
TARGETS = {
    "figma": ["jpeg", "png8", "png"],
    "web": ["jpeg", "png8", "png", "webp", "webp-lossless"],
    "lossless": ["png", "webp-lossless"],
}


def build(names, zopfli: bool = True, background=(255, 255, 255)) -> list[Encoder]:
    out = []
    for name in names:
        cls = ALL[name]
        enc = cls(zopfli=zopfli, background=background) if cls is JpegEncoder else cls(zopfli=zopfli)
        if enc.available():
            out.append(enc)
    return out


def capabilities() -> dict:
    return {
        "imagequant (pngquant engine)": HAVE_IMAGEQUANT,
        "zopfli (png recompression)": HAVE_ZOPFLI,
        "mozjpeg (lossless jpeg pass)": HAVE_MOZJPEG,
    }
