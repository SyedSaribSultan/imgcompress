"""Run with:  python -m unittest discover -s tests -v"""

import sys
import tempfile
import unittest
import warnings
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from PIL import Image, ImageDraw  # noqa: E402

from imgcompress import Settings, compress_file, compress_tree  # noqa: E402
from imgcompress import destinations as dest  # noqa: E402
from imgcompress import encoders as enc  # noqa: E402
from imgcompress.quality import (  # noqa: E402
    HAVE_SSIMULACRA2,
    flatten,
    get_metric,
    ssim,
    ssimulacra2,
)

warnings.simplefilter("ignore", UserWarning)

# Keep the suite quick: SSIM is the fast metric and its behaviour is what most
# of these assertions are about. The SSIMULACRA2 path gets its own test.
FAST = {"metric": "ssim", "quality_target": 0.95, "zopfli": False, "fast": True}


def sample(size=(600, 420), alpha=False) -> Image.Image:
    mode = "RGBA" if alpha else "RGB"
    img = Image.new(mode, size, (250, 250, 252, 255) if alpha else (250, 250, 252))
    d = ImageDraw.Draw(img)
    for i in range(10):
        d.ellipse([40 * i, 30 * i, 40 * i + 190, 30 * i + 190],
                  fill=(30 + 20 * i, 90, 200 - 15 * i, 255))
        d.rectangle([20, 14 * i, 300, 14 * i + 6], fill=(240 - 8 * i, 30, 60, 255))
    return img


class QualityTests(unittest.TestCase):
    def test_identical_images_score_perfect(self):
        img = sample((300, 220))
        self.assertAlmostEqual(ssim(img, img.copy()), 1.0, places=5)

    def test_degraded_image_scores_lower(self):
        img = sample((300, 220))
        worse = img.resize((25, 18)).resize((300, 220))
        self.assertLess(ssim(img, worse), 0.95)

    def test_percentile_is_stricter_than_mean(self):
        """A small badly-damaged region must not be hidden by a large flat one."""
        img = Image.new("RGB", (400, 400), (255, 255, 255))
        ImageDraw.Draw(img).rectangle([10, 10, 90, 90], fill=(20, 120, 220))
        broken = img.copy()
        ImageDraw.Draw(broken).rectangle([10, 10, 90, 90], fill=(220, 120, 20))
        self.assertLess(ssim(broken, img, percentile=5), ssim(broken, img, percentile=0))

    def test_alpha_is_composited_not_dropped(self):
        """Transparent pixels carry junk RGB; comparing it raw gives nonsense."""
        a = Image.new("RGBA", (200, 200), (255, 0, 0, 0))
        b = Image.new("RGBA", (200, 200), (0, 0, 255, 0))
        self.assertGreater(ssim(a, b), 0.99)  # both fully transparent == identical
        self.assertEqual(flatten(a, (26, 26, 26)).mode, "RGB")

    @unittest.skipUnless(HAVE_SSIMULACRA2, "ssimulacra2 not installed")
    def test_ssimulacra2_scale(self):
        img = sample((300, 220))
        self.assertGreater(ssimulacra2(img, img.copy()), 99.0)
        worse = img.resize((40, 30)).resize((300, 220))
        self.assertLess(ssimulacra2(img, worse), 70.0)

    def test_metric_targets_are_on_the_right_scale(self):
        m = get_metric("ssim")
        self.assertTrue(m.valid_target(0.97))
        self.assertFalse(m.valid_target(90))


class EncoderTests(unittest.TestCase):
    def test_jpeg_never_uses_chroma_subsampling(self):
        """4:2:0 is invisible to luma SSIM and expensive on a colour metric."""
        img = sample()
        data = enc.JpegEncoder().encode(img, 80, fast=True)
        import io

        from PIL import JpegImagePlugin
        with Image.open(io.BytesIO(data)) as out:
            # 0 == 4:4:4, 1 == 4:2:2, 2 == 4:2:0
            self.assertEqual(JpegImagePlugin.get_sampling(out), 0)

    def test_png8_respects_palette_size(self):
        img = sample()
        data = enc.Png8Encoder(zopfli=False).encode(img, 32, fast=True)
        import io
        with Image.open(io.BytesIO(data)) as out:
            self.assertEqual(out.mode, "P")
            self.assertLessEqual(len(out.getcolors(maxcolors=1024)), 32)

    def test_every_named_format_has_an_encoder(self):
        """A destination may only offer formats the engine knows how to write.

        `available()` decides whether this machine can actually run one; this
        is the earlier question, and getting it wrong is a KeyError at the
        moment somebody's image is being compressed.
        """
        for d in dest.DESTINATIONS.values():
            for name in d.formats:
                self.assertIn(name, enc.ALL, f"{d.name} offers unknown format {name}")


class DestinationTests(unittest.TestCase):
    """The table is a promise about where an image is going. Pin all of it.

    These same five entries are duplicated in `web/worker.js`, `web/app.js` and
    the desktop UI, which cannot be checked from here - but the Python side is
    the reference, so at least it cannot drift on its own.
    """

    EXPECTED = {
        # name:        (formats,                  max_dimension, hard_cap, ss2)
        "web":         (("jpeg", "png8", "png", "webp", "webp-lossless", "avif"),
                        2560, 0, 90.0),
        # 2560 is the everyday downscale; 4096 is a clamp that only fires when
        # somebody explicitly asks for more. Two numbers, two jobs.
        "documents":   (("jpeg", "png8", "png"), 2560, 4096, 90.0),
        "email":       (("jpeg", "png8", "png"), 1920, 0, 88.0),
        "thumbnail":   (("jpeg", "png8", "png", "webp", "webp-lossless", "avif"),
                        512, 0, 80.0),
        "original":    (("jpeg", "png8", "png", "webp", "webp-lossless", "avif"),
                        0, 0, 95.0),
    }

    def test_documents_downscales_to_2560_by_default(self):
        """The clamp is not the setting. Defaulting to the ceiling would ship
        roughly 2.5x the pixels on every design asset."""
        self.assertEqual(dest.get("documents").max_dimension, 2560)
        self.assertEqual(dest.get("documents").max_dimension,
                         dest.get("web").max_dimension)

    def test_every_destination_matches_the_brief(self):
        for name, (formats, max_dim, cap, ss2) in self.EXPECTED.items():
            with self.subTest(destination=name):
                d = dest.get(name)
                self.assertEqual(d.formats, formats)
                self.assertEqual(d.max_dimension, max_dim)
                self.assertEqual(d.hard_cap, cap)
                self.assertEqual(d.ss2_target, ss2)

    def test_the_five_are_the_ones_offered(self):
        self.assertEqual(dest.names(), list(self.EXPECTED))

    def test_the_default_is_the_web(self):
        """Not a design tool. The old default silently refused WebP to everyone."""
        self.assertEqual(dest.DEFAULT, "web")
        self.assertEqual(Settings().target, "web")
        self.assertIn("webp", dest.formats_for(Settings().target))

    def test_documents_never_offers_webp_or_avif(self):
        formats = dest.formats_for("documents")
        for lossy_modern in ("webp", "webp-lossless", "avif"):
            self.assertNotIn(lossy_modern, formats)

    def test_documents_is_capped_at_4096(self):
        """The ceiling, which is a different number from the default."""
        self.assertEqual(dest.get("documents").hard_cap, 4096)
        self.assertNotEqual(dest.get("documents").max_dimension,
                            dest.get("documents").hard_cap)

    def test_only_documents_enforces_a_hard_cap(self):
        capped = [d.name for d in dest.DESTINATIONS.values() if d.hard_cap]
        self.assertEqual(capped, ["documents"])

    def test_old_names_still_resolve(self):
        """Scripts written against 2.6 keep working."""
        self.assertEqual(dest.resolve("figma"), "documents")
        self.assertEqual(dest.resolve("archive"), "original")
        self.assertEqual(dest.get("figma").formats, dest.get("documents").formats)

    def test_unknown_destination_is_rejected_not_guessed(self):
        self.assertFalse(dest.exists("nowhere"))
        with self.assertRaises(KeyError):
            dest.get("nowhere")

    def test_hidden_destinations_are_reachable_but_not_offered(self):
        self.assertIn("lossless", dest.DESTINATIONS)
        self.assertNotIn("lossless", dest.names())
        for name in dest.formats_for("lossless"):
            self.assertTrue(enc.ALL[name].lossless, f"{name} is not pixel-exact")


class CompressTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.src = self.root / "src"
        self.dst = self.root / "dst"
        self.src.mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def test_output_is_smaller_and_meets_quality_target(self):
        path = self.src / "a.png"
        sample().save(path, compress_level=1)
        res = compress_file(path, self.dst, Settings(**FAST))
        self.assertEqual(res.error, "")
        self.assertTrue(res.output.exists())
        self.assertLess(res.new_bytes, res.original_bytes)
        self.assertGreaterEqual(res.score, 0.95)

    def test_bakeoff_records_every_candidate(self):
        path = self.src / "a.png"
        sample().save(path)
        res = compress_file(path, self.dst, Settings(**FAST))
        names = {c[0] for c in res.candidates}
        self.assertTrue({"jpeg", "png8", "png"} <= names)
        # the winner must be the smallest passing candidate
        self.assertEqual(res.new_bytes, min(c[1] for c in res.candidates))

    def test_resize_caps_longest_edge(self):
        path = self.src / "big.png"
        sample((3000, 1500)).save(path)
        res = compress_file(path, self.dst, Settings(max_dimension=1000, **FAST))
        with Image.open(res.output) as out:
            self.assertEqual(max(out.size), 1000)

    def test_documents_caps_at_4096_even_when_unlimited(self):
        """Design tools rescale above this destructively, so asking for more is
        not a request the destination can honour."""
        path = self.src / "huge.png"
        sample((5000, 1200)).save(path)
        res = compress_file(path, self.dst,
                            Settings(target="documents", max_dimension=0, **FAST))
        with Image.open(res.output) as out:
            self.assertLessEqual(max(out.size), 4096)

    def test_documents_clamps_an_explicit_oversized_request(self):
        """`-m 8000` is the only way to reach the ceiling now that the default
        sits at 2560, so this is the branch that would otherwise go untested.

        It must *clamp*, not refuse. The person's intent is perfectly
        reasonable; the destination simply cannot carry it, and turning that
        into an error would make them go and find a number the tool already
        knows.
        """
        path = self.src / "huge.png"
        sample((5000, 1200)).save(path)
        res = compress_file(path, self.dst,
                            Settings(target="documents", max_dimension=8000, **FAST))
        self.assertEqual(res.error, "")
        with Image.open(res.output) as out:
            self.assertLessEqual(max(out.size), 4096)
            self.assertEqual(max(out.size), 4096)

    def test_the_clamp_does_not_inflate_a_smaller_request(self):
        """A ceiling only ever lowers. Asking for 800 must give 800."""
        path = self.src / "huge.png"
        sample((5000, 1200)).save(path)
        res = compress_file(path, self.dst,
                            Settings(target="documents", max_dimension=800, **FAST))
        with Image.open(res.output) as out:
            self.assertEqual(max(out.size), 800)

    def test_documents_downscale_matches_web_by_default(self):
        """The everyday behaviour of the two destinations differs in format
        policy, not in how many pixels survive."""
        path = self.src / "huge.png"
        sample((5000, 1200)).save(path)
        sizes = {}
        for name in ("web", "documents"):
            res = compress_file(path, self.dst / name,
                                Settings(target=name, **FAST))
            with Image.open(res.output) as out:
                sizes[name] = out.size
        self.assertEqual(sizes["web"], sizes["documents"])
        self.assertEqual(max(sizes["documents"]), 2560)

    def test_the_cap_belongs_to_documents_and_not_to_everything(self):
        """`original` means what it says. The 4096 ceiling was a Figma fact that
        used to apply to the default and therefore to everyone."""
        path = self.src / "huge.png"
        sample((5000, 1200)).save(path)
        res = compress_file(path, self.dst,
                            Settings(target="original", max_dimension=0, **FAST))
        with Image.open(res.output) as out:
            self.assertEqual(max(out.size), 5000)

    def test_documents_ships_no_webp_even_on_artwork_that_would_win_with_it(self):
        path = self.src / "alpha.png"
        img = Image.new("RGBA", (400, 400), (0, 0, 0, 0))
        ImageDraw.Draw(img).ellipse([40, 40, 360, 360], fill=(255, 0, 0, 255))
        img.save(path)
        res = compress_file(path, self.dst, Settings(target="documents", **FAST))
        tried = {c[0] for c in res.candidates}
        self.assertFalse(tried & {"webp", "webp-lossless", "avif"})
        self.assertIn(res.output.suffix, (".png", ".jpg"))

    def test_transparency_survives(self):
        path = self.src / "alpha.png"
        img = Image.new("RGBA", (400, 400), (0, 0, 0, 0))
        ImageDraw.Draw(img).ellipse([40, 40, 360, 360], fill=(255, 0, 0, 255))
        img.save(path)
        res = compress_file(path, self.dst, Settings(**FAST))
        with Image.open(res.output) as out:
            rgba = out.convert("RGBA")
        self.assertEqual(rgba.getpixel((3, 3))[3], 0)

    def test_alpha_never_routed_to_jpeg(self):
        path = self.src / "alpha.png"
        img = Image.new("RGBA", (300, 300), (0, 0, 0, 0))
        ImageDraw.Draw(img).ellipse([30, 30, 270, 270], fill=(0, 128, 255, 255))
        img.save(path)
        res = compress_file(path, self.dst, Settings(**FAST))
        self.assertNotIn("jpeg", {c[0] for c in res.candidates})
        self.assertNotEqual(res.fmt, "jpeg")

    def test_corrupt_file_reports_error_without_raising(self):
        path = self.src / "bad.png"
        path.write_bytes(b"definitely not a png")
        res = compress_file(path, self.dst, Settings(**FAST))
        self.assertNotEqual(res.error, "")
        self.assertIsNone(res.output)

    def test_animated_gif_passes_through_untouched(self):
        path = self.src / "anim.gif"
        frames = [Image.new("RGB", (80, 80), c) for c in ((255, 0, 0), (0, 255, 0))]
        frames[0].save(path, save_all=True, append_images=frames[1:], duration=80, loop=0)
        res = compress_file(path, self.dst, Settings(**FAST))
        self.assertTrue(res.skipped)
        self.assertEqual(res.new_bytes, res.original_bytes)

    def test_tree_mirrors_folder_structure(self):
        (self.src / "nested" / "deep").mkdir(parents=True)
        for p in ("one.png", "nested/two.png", "nested/deep/three.png"):
            sample((240, 200)).save(self.src / p)
        results = compress_tree(self.src, self.dst, Settings(**FAST), workers=1)
        self.assertEqual(len(results), 3)
        self.assertTrue((self.dst / "nested" / "deep").is_dir())
        self.assertEqual(len(list(self.dst.rglob("*.*"))), 3)

    def test_never_writes_a_larger_file(self):
        path = self.src / "already_small.jpg"
        sample((200, 160)).convert("RGB").save(path, quality=25)
        res = compress_file(path, self.dst, Settings(formats=["jpeg"], **FAST))
        self.assertLessEqual(res.new_bytes, res.original_bytes)

    def test_passing_candidate_beats_smaller_failing_one(self):
        """A candidate below the floor must not ship while another candidate
        cleared it - however small the failing one is. This shipped once: an
        early failing JPEG held the winner's spot against a passing lossless
        PNG purely on byte count."""
        path = self.src / "hard.png"
        img = sample((420, 300))
        d = ImageDraw.Draw(img)
        for i in range(0, 420, 2):  # fine detail no jpeg rung can carry at .999
            d.line([(i, 0), (i, 300)], fill=(i % 255, 255 - i % 255, 40), width=1)
        img.save(path)
        res = compress_file(path, self.dst, Settings(
            metric="ssim", quality_target=0.999, zopfli=False, fast=True,
            formats=["jpeg", "png"], target="web",
        ))
        self.assertEqual(res.error, "")
        self.assertEqual(res.fmt, "png")          # the one that actually passed
        self.assertGreaterEqual(res.score, 0.999)
        self.assertEqual(res.warnings, [])

    def test_never_grows_across_containers_either(self):
        """A tiny GIF whose candidates all come out bigger must pass through
        unchanged - not be converted into a larger PNG."""
        path = self.src / "tiny.gif"
        img = Image.new("P", (200, 150))
        img.putpalette([255, 0, 0, 0, 255, 0] + [0] * 762)
        img.save(path)
        res = compress_file(path, self.dst, Settings(**FAST))
        self.assertEqual(res.error, "")
        self.assertLessEqual(res.new_bytes, res.original_bytes)
        if res.skipped:
            self.assertEqual(res.output.suffix, ".gif")

    def test_forcing_a_format_is_respected(self):
        path = self.src / "a.png"
        sample().save(path)
        res = compress_file(path, self.dst, Settings(formats=["jpeg"], **FAST))
        self.assertEqual(res.fmt, "jpeg")
        self.assertEqual(res.output.suffix, ".jpg")


if __name__ == "__main__":
    unittest.main()
