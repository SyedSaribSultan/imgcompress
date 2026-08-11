"""Run with:  python -m unittest discover -s tests -v"""

import sys
import tempfile
import unittest
import warnings
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np  # noqa: E402
from PIL import Image, ImageDraw  # noqa: E402

from imgcompress import Settings, compress_file, compress_tree  # noqa: E402
from imgcompress import destinations as dest  # noqa: E402
from imgcompress import encoders as enc  # noqa: E402
from imgcompress.core import frame_for  # noqa: E402
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


def photo_sample(size=(480, 360)) -> Image.Image:
    """Smooth gradients plus grain - an image lossy formats beat lossless on.

    The size-cap tests need this rather than `sample()`. Flat vector art
    compresses losslessly to a perfect score, so there is no quality headroom
    above the floor for a cap to trade against and "a looser cap buys better
    quality" cannot be observed at all. Grain is what makes lossless expensive.
    """
    W, H = size
    rng = np.random.default_rng(11)
    yy, xx = np.mgrid[0:H, 0:W]
    base = np.stack([
        90 + 120 * (xx / W) + 30 * np.sin(yy / 18.0),
        70 + 130 * (yy / H) + 30 * np.cos(xx / 23.0),
        140 + 90 * ((xx + yy) / (W + H)) + 25 * np.sin((xx + yy) / 15.0),
    ], -1)
    return Image.fromarray(
        (base + rng.normal(0, 6, (H, W, 3))).clip(0, 255).astype("uint8"))


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

    def test_the_clamp_is_reported_not_applied_in_silence(self):
        """A dimension that changes without saying so is the defect the whole
        destination rework exists to remove. It must not survive on the
        override path just because the override path is rarer.

        `effective_limit` is the one place the rule lives, so the CLI header
        and the engine cannot disagree - which they did: the header advertised
        `up to 8000px` for a run that produced 4096.
        """
        from imgcompress import destinations as d
        self.assertEqual(d.effective_limit("documents", 8000), 4096)
        self.assertEqual(d.effective_limit("documents", 800), 800)
        self.assertEqual(d.effective_limit("documents", 0), 4096)
        # Only documents clamps; asking web for 8000 gets 8000.
        self.assertEqual(d.effective_limit("web", 8000), 8000)
        self.assertEqual(d.effective_limit("original", 0), 0)

    def test_the_engine_uses_the_same_rule_the_cli_prints(self):
        from imgcompress import destinations as d
        path = self.src / "huge.png"
        sample((5000, 1200)).save(path)
        for name, asked in (("documents", 8000), ("documents", 800), ("web", 3000)):
            with self.subTest(destination=name, asked=asked):
                res = compress_file(path, self.dst / f"{name}{asked}",
                                    Settings(target=name, max_dimension=asked, **FAST))
                expected = d.effective_limit(name, asked)
                with Image.open(res.output) as out:
                    # 5000px source, so any limit at or below it must bite.
                    self.assertEqual(max(out.size), min(expected, 5000))

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


class DimensionModeTests(unittest.TestCase):
    """`max_dimension` governs one edge, and which one is now a setting."""

    def test_longest_is_the_old_behaviour(self):
        self.assertEqual(frame_for((3500, 4500), "longest", 2560), (1991, 2560))
        self.assertEqual(frame_for((4500, 3500), "longest", 2560), (2560, 1991))

    def test_width_pins_the_width_whatever_the_orientation(self):
        self.assertEqual(frame_for((3500, 4500), "width", 1600)[0], 1600)
        self.assertEqual(frame_for((4500, 3500), "width", 1600)[0], 1600)

    def test_height_pins_the_height_whatever_the_orientation(self):
        self.assertEqual(frame_for((3500, 4500), "height", 1000)[1], 1000)
        self.assertEqual(frame_for((4500, 3500), "height", 1000)[1], 1000)

    def test_none_never_resizes(self):
        self.assertIsNone(frame_for((3500, 4500), "none", 2560))

    def test_never_enlarges(self):
        """A pin is a ceiling, not a size. Enlarging spends bytes on blur."""
        for mode in ("longest", "width", "height"):
            self.assertIsNone(frame_for((320, 205), mode, 1600), mode)

    def test_hard_cap_applies_to_the_long_edge_under_every_mode(self):
        """`documents` clamps at 4096 because design tools rescale above it
        destructively. That is a fact about the long edge, so pinning the width
        must not be a way around it."""
        cap = dest.get("documents").hard_cap
        for mode, limit in (("longest", 0), ("width", 8000), ("height", 8000), ("none", 0)):
            frame = frame_for((9000, 6000), mode, limit, cap)
            self.assertEqual(max(frame), cap, mode)

    def test_engine_honours_the_mode_end_to_end(self):
        with tempfile.TemporaryDirectory() as tmp:
            src, dst = Path(tmp) / "in", Path(tmp) / "out"
            src.mkdir()
            path = src / "wide.png"
            sample((1200, 800)).save(path)
            res = compress_file(path, dst, Settings(
                dimension_mode="width", max_dimension=500, **FAST))
            self.assertEqual(res.resized_to[0], 500)


class SizeCapTests(unittest.TestCase):
    """`size_target` inverts the search: best quality that fits, not smallest."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        root = Path(self._tmp.name)
        self.src, self.dst = root / "in", root / "out"
        self.src.mkdir()
        self.path = self.src / "photo.png"
        photo_sample().save(self.path)
        self.floor = {"metric": "ssim", "zopfli": False, "fast": True,
                      "dimension_mode": "none", "max_dimension": 0}

    def tearDown(self):
        self._tmp.cleanup()

    def _run(self, **over):
        return compress_file(self.path, self.dst, Settings(**{**self.floor, **over}))

    def test_result_stays_under_a_reachable_cap(self):
        baseline = self._run(quality_target=0.95)
        cap = int(baseline.new_bytes * 1.8)
        res = self._run(quality_target=0.80, size_target=cap)
        self.assertLessEqual(res.new_bytes, cap)
        self.assertFalse(res.missed_size)
        self.assertEqual(res.size_target, cap)

    def test_spare_room_under_the_cap_is_spent_on_quality(self):
        """The point of the mode. A generous cap must not just reproduce the
        floor search's answer - it has to buy something with the headroom."""
        baseline = self._run(quality_target=0.95)
        res = self._run(quality_target=0.80, size_target=int(baseline.new_bytes * 1.8))
        self.assertGreater(res.score, baseline.score)

    def test_a_tighter_cap_costs_quality(self):
        baseline = self._run(quality_target=0.95)
        loose = self._run(quality_target=0.5, size_target=int(baseline.new_bytes * 1.8))
        tight = self._run(quality_target=0.5, size_target=int(baseline.new_bytes * 0.6))
        self.assertFalse(tight.missed_size)       # else the comparison is vacuous
        self.assertLessEqual(tight.new_bytes, int(baseline.new_bytes * 0.6))
        self.assertLess(tight.score, loose.score)

    def test_unreachable_cap_is_missed_out_loud_not_met_by_wrecking_the_image(self):
        """The one failure state the app has. It ships the smallest file still
        worth looking at - over the cap - rather than something that fits and
        looks broken, and it says so."""
        res = self._run(quality_target=0.95, size_target=800)
        self.assertTrue(res.missed_size)
        self.assertGreater(res.new_bytes, 800)
        self.assertGreaterEqual(res.score, 0.95)      # never went below the floor
        self.assertTrue(any("could not fit" in w for w in res.warnings))

    def test_the_miss_hands_back_exactly_the_ordinary_search(self):
        """A missed cap produces the same file the floor search would have, and
        the same list of versions tried.

        The capped pass's own attempts are dropped rather than listed beside the
        winner. Every one of them fitted the cap and none of them cleared the
        floor, so leaving them in the list reads as though the cap had been met
        after all. Note this is not "only passing candidates are listed" - the
        ordinary search shows what it tried whether it passed or not, and that
        is the point of the panel.
        """
        missed = self._run(quality_target=0.95, size_target=800)
        plain = self._run(quality_target=0.95)
        self.assertTrue(missed.missed_size)
        self.assertEqual(missed.new_bytes, plain.new_bytes)
        self.assertEqual(missed.fmt, plain.fmt)
        self.assertEqual([c[0] for c in missed.candidates],
                         [c[0] for c in plain.candidates])
        self.assertFalse([c for c in missed.candidates if c[1] <= 800],
                         "a candidate that fitted the cap leaked out of the failed pass")

    def test_no_cap_leaves_the_default_search_exactly_as_it_was(self):
        with_flag = self._run(quality_target=0.95, size_target=0)
        without = compress_file(self.path, self.dst, Settings(
            metric="ssim", quality_target=0.95, zopfli=False, fast=True,
            dimension_mode="none", max_dimension=0))
        self.assertEqual(with_flag.new_bytes, without.new_bytes)
        self.assertEqual(with_flag.fmt, without.fmt)
        self.assertFalse(with_flag.missed_size)

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


class FrozenBundleSafety(unittest.TestCase):
    """The pool must not be able to re-launch the application.

    `compress_tree` uses a ProcessPoolExecutor. Under the spawn start method -
    always on Windows, the default on macOS - each worker re-executes the
    program to import the module it needs. Frozen, there is no python to
    re-execute: the child runs the app's own executable again, starts a whole
    new imgcompress, and opens a pool of its own. A folder of images becomes a
    fork bomb.

    It hid because `compress_tree` takes a single-process path when there is one
    job, so every one-image smoke test passed. These two assertions are cheap
    and they are the only thing standing between a build and that.
    """

    def test_freeze_support_is_called_at_import(self):
        source = (Path(__file__).resolve().parent.parent
                  / "imgcompress" / "__init__.py").read_text(encoding="utf-8")
        self.assertIn("freeze_support()", source,
                      "multiprocessing.freeze_support() is gone from the package "
                      "__init__; a frozen build will fork-bomb on a folder")

    def test_a_real_pool_still_runs_more_than_one_job(self):
        """The path the guard protects has to keep working, or the guard is
        protecting nothing."""
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        src = root / "many"
        src.mkdir()
        for i in range(3):
            sample((240, 200)).save(src / f"a{i}.png")
        results = compress_tree(src, root / "out", Settings(**FAST), workers=3)
        self.assertEqual(len(results), 3)
        self.assertTrue(all(r.error == "" for r in results),
                        [r.error for r in results])


if __name__ == "__main__":
    unittest.main()
