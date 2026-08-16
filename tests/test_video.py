"""Video: the table, the arithmetic, and the engine.

Split deliberately. The first two classes are pure and run everywhere,
including on a machine with no video engine installed at all - a destination's
promise about where a video is going does not depend on whether this laptop can
encode one. The engine tests skip themselves when PyAV is missing, the same way
the AVIF tests skip without the plugin.
"""

from __future__ import annotations

import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pocketsize import destinations as dest  # noqa: E402
from pocketsize import video  # noqa: E402

FIXTURES = Path(__file__).resolve().parent / "video_fixtures"


class TheVideoTable(unittest.TestCase):
    """What each destination promises a video. Pinned, like the image table."""

    EXPECTED = {
        # name:      (formats,                    max_dim, target, cap_mb, audio)
        "web":       (("av1-mp4", "h264-mp4"),    1920, 92.0, 0.0,   "copy"),
        "documents": (("h264-mp4",),              1920, 90.0, 0.0,   "aac"),
        "email":     (("h264-mp4",),              1920, 90.0, 18.0,  "copy"),
        "chat":      (("h264-mp4", "av1-mp4"),    1280, 88.0, 10.0,  "aac"),
        "social":    (("h264-mp4",),              1920, 90.0, 500.0, "aac"),
        "original":  (("av1-mp4", "h264-mp4"),    0,    96.0, 0.0,   "copy"),
    }

    def test_every_video_destination_matches_the_brief(self):
        for name, (formats, max_dim, target, cap, audio) in self.EXPECTED.items():
            with self.subTest(destination=name):
                d = dest.get(name)
                self.assertEqual(d.video_formats, formats)
                self.assertEqual(d.video_max_dimension, max_dim)
                self.assertEqual(d.video_target, target)
                self.assertEqual(d.size_cap_mb, cap)
                self.assertEqual(d.audio, audio)

    def test_the_video_destinations_are_exactly_the_expected(self):
        self.assertEqual(dest.video_names(), list(self.EXPECTED))

    def test_a_thumbnail_is_not_a_place_to_send_a_video(self):
        """And says so rather than inventing an answer."""
        self.assertFalse(dest.takes_video("thumbnail"))
        self.assertEqual(dest.video_formats_for("thumbnail"), [])

    def test_documents_only_writes_what_slides_can_play(self):
        """PowerPoint documents MP4/H.264 and Keynote converts everything else.
        AV1 in a deck is a file that plays where it was made and nowhere else."""
        self.assertEqual(dest.video_formats_for("documents"), ["h264-mp4"])

    def test_nothing_ever_writes_hevc(self):
        """Encode never, decode always. Three patent pools, no internet-use
        exemption, and no free tool emits it."""
        for d in dest.DESTINATIONS.values():
            for pair in d.video_formats:
                self.assertNotIn("hevc", pair)
                self.assertNotIn("h265", pair)

    def test_every_video_format_named_is_one_the_engine_knows(self):
        for d in dest.DESTINATIONS.values():
            for pair in d.video_formats:
                self.assertIn(pair, video.FORMATS)

    def test_a_destination_with_video_carries_all_of_its_numbers(self):
        """Half a video destination is worse than none: a zero frame cap reads
        as 'never resize' and a zero target reads as 'anything passes'."""
        for d in dest.DESTINATIONS.values():
            if not d.video_formats:
                continue
            with self.subTest(destination=d.name):
                self.assertGreater(d.video_target, 0.0)
                self.assertIn(d.audio, ("copy", "aac", "opus"))

    def test_the_email_cap_leaves_room_for_the_encoding_overhead(self):
        """Gmail and Outlook stop at 25 MB and base64 adds about a third on the
        way out, so the cap that matters is not the advertised one."""
        self.assertLess(dest.get("email").size_cap_mb, 25.0 / 1.33)

    def test_chat_fits_discords_free_limit(self):
        self.assertEqual(dest.get("chat").size_cap_mb, 10.0)


class TheSuiteItself(unittest.TestCase):
    """The rule that keeps 'video absent' from meaning 'suite broken'.

    Video is an optional extra; most of CI runs without it, and a
    destination's promise about where a video is going does not depend on
    whether this machine can encode one. So the classes that are not behind
    `skipUnless(video.available())` must not touch `av` - not at module
    level, not inside a method.

    This is written as a gate rather than trusted to review because it was
    NOT caught by review: a test needing a real `av.VideoFrame` was written
    into the pure colour class, passed on a developer machine that has PyAV,
    and turned every one of the seven no-video CI legs red. The mistake is
    invisible locally, which is exactly the kind that needs a machine to
    watch for it.
    """

    def test_no_engine_free_class_reaches_for_the_video_library(self):
        import ast

        source = Path(__file__).read_text(encoding="utf-8")
        tree = ast.parse(source)

        def guarded(node) -> bool:
            """Whether a class sits behind the video-engine skip.

            Matched on the shape of the call - `skipUnless(video.available())`
            - rather than on the text of `ast.dump`, which renders it as
            `Attribute(value=Name(id='video'), attr='available')` and never
            as the literal "video.available". The first version of this check
            searched for that literal, matched nothing, and would have
            reported every correctly-guarded class as an offender forever.
            """
            for decorator in node.decorator_list:
                for sub in ast.walk(decorator):
                    if (isinstance(sub, ast.Attribute)
                            and sub.attr == "available"
                            and isinstance(sub.value, ast.Name)
                            and sub.value.id == "video"):
                        return True
            return False

        def imports_av(node) -> bool:
            for sub in ast.walk(node):
                if isinstance(sub, ast.Import):
                    if any(alias.name.split(".")[0] == "av"
                           for alias in sub.names):
                        return True
                if isinstance(sub, ast.ImportFrom):
                    if (sub.module or "").split(".")[0] == "av":
                        return True
            return False

        offenders = [
            node.name for node in tree.body
            if isinstance(node, ast.ClassDef)
            and not guarded(node) and imports_av(node)
        ]
        self.assertEqual(
            offenders, [],
            f"{offenders} import `av` without being behind "
            "@skipUnless(video.available()). On a machine without the video "
            "extra those tests error instead of skipping, which reports a "
            "missing optional engine as a broken test suite. Move the test "
            "to a guarded class."
        )


class TheVideoArithmetic(unittest.TestCase):
    """Pure functions. No encoder required, so these run in CI on any machine."""

    def test_frame_for_only_ever_shrinks(self):
        self.assertEqual(video.frame_for(640, 360, 1920), (640, 360))
        self.assertEqual(video.frame_for(3840, 2160, 1920), (1920, 1080))
        self.assertEqual(video.frame_for(1080, 1920, 1280), (720, 1280))

    def test_frame_for_keeps_both_sides_even(self):
        """4:2:0 chroma is literally half resolution in both axes; an odd
        dimension is rejected by encoders or silently padded."""
        for source in ((1999, 1131), (1233, 707), (999, 999)):
            for limit in (0, 640, 1280, 1920):
                width, height = video.frame_for(*source, limit)
                with self.subTest(source=source, limit=limit):
                    self.assertEqual(width % 2, 0)
                    self.assertEqual(height % 2, 0)

    def test_frame_for_zero_never_resizes(self):
        self.assertEqual(video.frame_for(3840, 2160, 0), (3840, 2160))

    def test_a_short_clip_is_measured_whole(self):
        """Sampling a ten-second clip costs more than it saves and measures
        less. The rule is coverage, not duration."""
        self.assertEqual(video.sample_windows(8.0), [(0.0, 8.0)])

    def test_a_long_video_gets_several_windows_inside_its_runtime(self):
        duration = 45 * 60.0
        windows = video.sample_windows(duration)
        self.assertGreaterEqual(len(windows), 3)
        for start, length in windows:
            self.assertGreaterEqual(start, 0.0)
            self.assertLessEqual(start + length, duration + 0.001)

    def test_windows_do_not_overlap(self):
        windows = video.sample_windows(40 * 60.0)
        for (a_start, a_len), (b_start, _) in zip(windows, windows[1:]):
            self.assertLessEqual(a_start + a_len, b_start + 0.001)

    def test_a_minute_of_video_gets_more_than_one_look(self):
        """One sample of a two-minute clip is one scene's opinion of the whole
        thing."""
        self.assertGreaterEqual(len(video.sample_windows(120.0)), 2)

    def test_the_reported_score_is_the_worst_end_not_the_average(self):
        """A clip that is perfect for four seconds and falls apart for one is
        not a good clip, and the mean says it is."""
        scores = [95.0, 96.0, 94.0, 95.0, 40.0]
        reported, mean = video.pooled(scores)
        self.assertEqual(reported, 40.0)
        self.assertGreater(mean, reported)

    def test_pooling_an_empty_set_is_zero_not_a_crash(self):
        self.assertEqual(video.pooled([]), (0.0, 0.0))

    def test_a_tiny_probe_is_not_hostage_to_one_unlucky_frame(self):
        """Three frames is every probe of every clip under a minute, and the
        raw minimum of three is whatever the unluckiest frame said - a cut, a
        flash - which drove the search to a needlessly high rung and a
        needlessly large file. The median is the estimate one bad draw cannot
        own; the number a person sees still comes from the verify pass."""
        reported, _ = video.pooled([90.0, 91.0, 40.0])
        self.assertEqual(reported, 90.0)
        # A pair reports its worse half - two frames cannot outvote each other.
        reported, _ = video.pooled([90.0, 40.0])
        self.assertEqual(reported, 40.0)
        # One frame is its own answer.
        reported, _ = video.pooled([77.0])
        self.assertEqual(reported, 77.0)

    def test_frame_times_stay_inside_the_window(self):
        times = video.frame_times(10.0, 20.0, 8)
        self.assertEqual(len(times), 8)
        self.assertGreater(times[0], 10.0)
        self.assertLess(times[-1], 30.0)

    def test_a_bitrate_for_a_cap_leaves_room_for_the_container(self):
        info = video.VideoInfo(has_audio=False)
        rate = video._bitrate_for_cap(10 * 1024 * 1024, 60.0, info, "aac")
        self.assertLess(rate * 60.0 / 8.0, 10 * 1024 * 1024)

    def test_a_bitrate_for_a_cap_subtracts_the_sound(self):
        silent = video.VideoInfo(has_audio=False)
        noisy = video.VideoInfo(has_audio=True, audio_bitrate=128_000)
        cap, duration = 10 * 1024 * 1024, 60.0
        self.assertLess(
            video._bitrate_for_cap(cap, duration, noisy, "aac"),
            video._bitrate_for_cap(cap, duration, silent, "aac"),
        )

    def test_a_video_is_recognised_by_name(self):
        self.assertTrue(video.is_video_path("holiday.MP4"))
        self.assertTrue(video.is_video_path(Path("a/b/clip.mov")))
        self.assertFalse(video.is_video_path("photo.png"))

    def test_the_quality_ladders_run_from_worse_to_better(self):
        """The search bisects these, so the ordering is load-bearing: CRF falls
        as quality rises, which is why they read backwards."""
        for fmt in video.FORMATS.values():
            with self.subTest(fmt=fmt.name):
                self.assertEqual(list(fmt.levels), sorted(fmt.levels,
                                                          reverse=True))
                self.assertGreater(len(fmt.levels), 8)

    def test_the_winner_rule_inverts_under_a_cap(self):
        """With no cap everything on the table already looks right, so smallest
        wins. Under a cap everything already fits, so best-looking wins."""
        small_and_worse = {"bytes": 100, "score": 80.0, "capped": True}
        big_and_better = {"bytes": 900, "score": 95.0, "capped": True}
        self.assertTrue(video._beats(big_and_better, small_and_worse, True))

        small = {"bytes": 100, "score": 91.0, "capped": False}
        big = {"bytes": 900, "score": 95.0, "capped": False}
        self.assertTrue(video._beats(small, big, False))

    def test_meeting_the_quality_floor_beats_merely_fitting(self):
        kept_promise = {"bytes": 900, "score": 92.0, "capped": False}
        compromise = {"bytes": 100, "score": 99.0, "capped": True}
        self.assertTrue(video._beats(kept_promise, compromise, True))


class TheColourArithmetic(unittest.TestCase):
    """High dynamic range, checked as maths rather than by eye.

    Nobody writing this could look at the picture, and "it ran without
    crashing" is not a check on a colour transform - a conversion that is
    wrong by a factor of three in the shadows produces a perfectly valid file
    that simply looks bad, which is exactly the failure mode this whole
    section exists to prevent. So everything below pins a number.

    Where possible the number comes from *outside* this codebase: a value
    published in ST 2084 or BT.2408, a self-consistency condition the standard
    states, or an agreement between two independent routes to the same answer.
    A test that computes the expected value the same way the code does is a
    tautology with extra steps.
    """

    def test_the_pq_constants_satisfy_the_standards_own_identity(self):
        """ST 2084 defines c1 as c3 - c2 + 1. It holds exactly, in binary, for
        the real constants - so a single mistyped digit in any of the three
        fails here rather than a stop bath later."""
        self.assertEqual(video._PQ_C1, video._PQ_C3 - video._PQ_C2 + 1.0)

    def test_pq_lands_on_the_luminances_the_standard_is_quoted_for(self):
        """Three figures anyone can look up: PQ code 1.0 is 10 000 nits by
        definition, 50% of the range is about 92 nits, and 75% is about
        1000 - the numbers every HDR reference table prints."""
        self.assertAlmostEqual(float(video.pq_signal(10000.0)), 1.0, places=9)
        self.assertAlmostEqual(float(video.pq_nits(0.5)), 92.2, delta=0.1)
        self.assertAlmostEqual(float(video.pq_nits(0.75)), 983.4, delta=0.5)

    def test_hdr_reference_white_sits_where_bt2408_says_it_does(self):
        """BT.2408 puts HDR reference white at 203 nits and says that is about
        58% of the PQ range. If this drifts, every brightness in the
        conversion drifts with it."""
        self.assertAlmostEqual(float(video.pq_signal(203.0)), 0.58, delta=0.005)

    def test_pq_and_its_inverse_really_are_inverses(self):
        """A transfer function that does not round-trip is not a transfer
        function, and the two directions are written out separately here rather
        than one being solved from the other."""
        for nits in (0.0, 0.05, 1.0, 10.0, 26.0, 100.0, 203.0, 1000.0,
                     4000.0, 10000.0):
            with self.subTest(nits=nits):
                back = float(video.pq_nits(video.pq_signal(nits)))
                self.assertAlmostEqual(back, nits, delta=max(1e-6, nits * 1e-9))

    def test_the_hlg_curve_is_continuous_where_its_two_halves_meet(self):
        """HLG is a square root below half signal and a logarithm above it,
        and the join is the one place the definition can be got wrong without
        looking wrong: both halves have to arrive at scene light 1/12 at
        exactly 50%. A square root missing its factor of three lands at a
        quarter of that and darkens every shadow by two stops."""
        joint = 1.0 / 12.0
        self.assertAlmostEqual(float(video.hlg_scene_light(0.5)), joint,
                               places=12)
        self.assertAlmostEqual(float(video.hlg_scene_light(0.5 - 1e-9)), joint,
                               places=8)
        self.assertAlmostEqual(float(video.hlg_scene_light(0.5 + 1e-9)), joint,
                               places=8)

    def test_hlg_and_pq_agree_about_what_white_is(self):
        """The two formats are unrelated curves written by different
        committees, and they have to land on the same white or a clip
        converted from one would not match the same clip converted from the
        other. BT.2100 puts HLG reference white at 75% signal; BT.2408 puts
        HDR reference white at 203 nits. They meet, and nothing in this file
        made them."""
        import numpy as np

        white = video.hlg_nits(np.array([0.75, 0.75, 0.75]))
        self.assertAlmostEqual(float(white[0]), 203.0, delta=0.5)
        peak = video.hlg_nits(np.array([1.0, 1.0, 1.0]))
        self.assertAlmostEqual(float(peak[0]), 1000.0, delta=0.5)

    def test_the_gamut_matrix_leaves_white_exactly_alone(self):
        """Every row summing to one is what makes a neutral stay neutral. Get
        it wrong by a thousandth and every grey in the film picks up a tint -
        which is invisible in a still and obvious in a pan."""
        for row in video.BT2020_TO_BT709:
            self.assertAlmostEqual(float(row.sum()), 1.0, places=12)

    def test_the_gamut_matrix_matches_the_published_table(self):
        """Derived here from the two sets of primaries; checked against the
        matrix everyone else prints."""
        published = [[1.6605, -0.5876, -0.0728],
                     [-0.1246, 1.1329, -0.0083],
                     [-0.0182, -0.1006, 1.1187]]
        for row, expected in zip(video.BT2020_TO_BT709, published):
            for got, want in zip(row, expected):
                self.assertAlmostEqual(float(got), want, places=4)

    def test_the_tone_curve_leaves_ordinary_brightness_exactly_alone(self):
        """The reason this curve was chosen over Reinhard or Hable. Below the
        knee it is the identity, to the last bit - so shadows and midtones come
        out of an HDR clip exactly as they went in, and only the highlights
        that genuinely have nowhere to go are touched."""
        import numpy as np

        # With a 1000-nit source the knee sits at about 88 nits.
        below = np.array([0.0, 0.5, 5.0, 26.0, 50.0, 80.0])
        kept = video.tone_curve(below, 1000.0)
        for got, want in zip(kept, below):
            self.assertAlmostEqual(float(got), float(want), places=6)

    def test_content_that_never_leaves_ordinary_brightness_is_not_touched(self):
        """And when the whole file fits, the curve does nothing at all rather
        than scaling the picture down to make room for headroom nobody used."""
        import numpy as np

        values = np.linspace(0.0, 203.0, 50)
        kept = video.tone_curve(values, video.SDR_REFERENCE_WHITE_NITS)
        self.assertTrue(np.allclose(kept, values, atol=1e-9))

    def test_the_tone_curve_never_goes_backwards(self):
        """A tone curve that dips anywhere turns a gradient into a band and a
        sunset into a contour map. Swept densely across every source peak a
        real file could carry, including inputs above the peak."""
        import numpy as np

        worst = 0.0
        for peak in np.linspace(203.0, 10000.0, 60):
            values = np.linspace(0.0, float(peak) * 1.2, 2000)
            worst = min(worst,
                        float(np.diff(video.tone_curve(values,
                                                       float(peak))).min()))
        self.assertGreaterEqual(worst, -1e-9, "the tone curve dips")

    def test_the_tone_curve_lands_on_the_target_and_never_passes_it(self):
        """The peak has to arrive exactly at white - short of it and the
        picture is dull, past it and the highlights clip after all."""
        import numpy as np

        for peak in (250.0, 400.0, 1000.0, 4000.0, 10000.0):
            with self.subTest(peak=peak):
                at_peak = float(video.tone_curve(np.array([peak]), peak)[0])
                self.assertAlmostEqual(at_peak, 203.0, delta=0.01)
                over = video.tone_curve(np.linspace(0.0, 20000.0, 3000), peak)
                self.assertLessEqual(float(over.max()), 203.0 + 1e-6)

    def test_reference_white_comes_out_as_white(self):
        """The single failure this work exists to fix: a white shirt in an HDR
        clip arriving as mid grey. Read as if it were ordinary video, PQ's
        code for 203 nits is 0.58 - grey, code 148. Converted properly it is
        white, code 255."""
        import numpy as np

        white = video.sdr_from_nits(np.array([203.0, 203.0, 203.0]), 203.0)
        self.assertAlmostEqual(float(white[0]) * 255.0, 255.0, delta=0.01)
        self.assertGreater(float(white[0]) * 255.0, 148.0 + 100.0)

    def test_white_stays_neutral_however_hard_the_highlights_are_rolled(self):
        """The curve is applied to the brightest channel and the resulting
        ratio to all three, so no amount of rolling can tint a grey. If this
        ever failed, an HDR clip would come back with a cast."""
        import numpy as np

        for peak in (203.0, 400.0, 1000.0, 4000.0, 10000.0):
            for nits in (5.0, 50.0, 203.0, 1000.0):
                if nits > peak:
                    continue
                with self.subTest(peak=peak, nits=nits):
                    out = video.sdr_from_nits(np.array([nits] * 3), peak)
                    self.assertAlmostEqual(float(out[0]), float(out[1]),
                                           places=6)
                    self.assertAlmostEqual(float(out[1]), float(out[2]),
                                           places=6)
            top = video.sdr_from_nits(np.array([peak] * 3), peak)
            self.assertAlmostEqual(float(top[0]), 1.0, delta=1e-4)

    def test_mid_grey_stays_mid_grey(self):
        """Half-way up an ordinary video signal is 38.8 nits of display light.
        An HDR clip carrying 38.8 nits has to come back at code 128, or every
        midtone in the picture has moved."""
        import numpy as np

        nits = (128.0 / 255.0) ** video.SDR_DISPLAY_GAMMA \
            * video.SDR_REFERENCE_WHITE_NITS
        self.assertAlmostEqual(nits, 38.8, delta=0.1)
        code = float(video.sdr_from_nits(np.array([nits] * 3), 203.0)[0]) * 255
        self.assertAlmostEqual(code, 128.0, delta=0.5)

    def test_an_18_percent_grey_card_lands_where_an_sdr_camera_puts_it(self):
        """The cross-check between two standards that were not written
        together. BT.2408 grades an 18% grey card at 26 nits in HDR; a BT.709
        camera puts the same card at code 104 in SDR. The conversion has to
        agree with both, and it does: 108 against 104, four code values apart
        out of 255. That gap is also the evidence that the output is encoded
        with the *display* curve rather than the camera curve - the camera
        curve lands the same card at 86, eighteen values adrift, which is a
        visibly darker picture and is what the usual ffmpeg one-liner
        produces."""
        import numpy as np

        code = float(video.sdr_from_nits(np.array([26.0] * 3), 203.0)[0]) * 255
        camera = (1.099 * 0.18 ** 0.45 - 0.099) * 255
        self.assertAlmostEqual(camera, 104.3, delta=0.5)
        self.assertAlmostEqual(code, camera, delta=4.5)

        # And the alternative really is much further away.
        with_camera_curve = 1.099 * (26.0 / 203.0) ** 0.45 - 0.099
        self.assertGreater(abs(with_camera_curve * 255 - camera), 15.0)

    def test_100_nits_maps_to_the_level_the_arithmetic_predicts(self):
        """100 nits is 49.3% of reference white; the display curve puts that
        at code 190. Pinned because it is the midpoint of the range a person
        actually looks at."""
        import numpy as np

        code = float(video.sdr_from_nits(np.array([100.0] * 3), 203.0)[0]) * 255
        self.assertAlmostEqual(code, 189.9, delta=0.2)

    def test_nothing_ever_leaves_the_range_or_becomes_a_nan(self):
        """Including the awkward inputs: pure BT.2020 primaries, which are
        outside BT.709 entirely and go negative on the way across, and light
        far above the peak the curve was built for."""
        import numpy as np

        rng = np.random.default_rng(7)
        awkward = np.array([
            [0.0, 0.0, 0.0], [203.0, 0.0, 0.0], [0.0, 1000.0, 0.0],
            [0.0, 0.0, 4000.0], [10000.0, 10000.0, 10000.0],
            [20000.0, 1.0, 0.0],
        ])
        samples = np.vstack([awkward, rng.random((500, 3)) * 4000.0])
        for peak in (203.0, 1000.0, 10000.0):
            with self.subTest(peak=peak):
                out = video.sdr_from_nits(samples, peak)
                self.assertFalse(bool(np.isnan(out).any()))
                self.assertGreaterEqual(float(out.min()), 0.0)
                self.assertLessEqual(float(out.max()), 1.0)

    def test_the_fast_path_agrees_with_the_exact_one(self):
        """Everything above is checked in double precision; every real frame
        goes through in single, because a 4K frame is 25 MB one way and 50 the
        other and it is copied several times. PQ raises its input to the power
        of 78, which is exactly where single precision would show if it were
        going to - so the two are compared rather than assumed equal."""
        import numpy as np

        rng = np.random.default_rng(11)
        samples = rng.random((2000, 3)) * 4000.0
        for peak in (203.0, 1000.0, 10000.0):
            with self.subTest(peak=peak):
                exact = video.sdr_from_nits(samples.astype(np.float64), peak)
                fast = video.sdr_from_nits(samples.astype(np.float32), peak)
                self.assertEqual(fast.dtype, np.float32,
                                 "the frame path quietly widened to float64")
                worst = float(np.abs(exact - fast).max()) * 255.0
                self.assertLess(worst, 0.05,
                                f"{worst:.3f} code values apart")

    def test_the_float32_path_stays_exact_at_the_gamut_boundary(self):
        """The one place approximation can never be allowed back in. The
        conversion ends in a 2.4 gamma whose slope is unbounded at black, and
        the gamut matrix pushes saturated colours through black - so an error
        of e in linear light becomes 255 * e^(1/2.4) code values on screen.
        A 65-cube lookup table measured 14-19 code values wrong exactly here,
        which is why there is no lookup table; float32 evaluation of the real
        formulas has to stay under one code value on the same colours, and
        does, with margin."""
        import numpy as np

        rng = np.random.default_rng(21)
        edges = []
        for ch in range(3):
            plane = np.zeros((60_000, 3))
            plane[:, ch] = rng.random(60_000)
            other = (ch + 1) % 3
            plane[:, other] = rng.random(60_000) * 0.2
            edges.append(plane)
        signal = np.vstack(edges)
        nits = video.pq_nits(signal)
        exact = video.sdr_from_nits(nits.astype(np.float64), 1000.0, True)
        fast = video.sdr_from_nits(nits.astype(np.float32), 1000.0, True)
        worst = float(np.abs(exact - fast).max()) * 255.0
        self.assertLess(worst, 1.0,
                        f"{worst:.2f} code values apart at the gamut edge")

    def test_a_witness_that_cannot_see_the_source_reports_nothing(self):
        """The independent metric compares two files straight out of their
        containers, and nothing in this build can apply a PQ transfer inside a
        filter graph - so on a tone-mapped clip it would be reading the
        washed-out picture as its reference and returning about 12 dB. A
        meaningless number that looks like a catastrophe is worse than an
        absent one, and zero already means "no second opinion available"."""
        self.assertEqual(video.xpsnr(b"", b"", 16, 16, tone_mapped=True), 0.0)

    def test_the_peak_is_read_from_the_pixels(self):
        """A tag says what the format can carry; only the pixels say what the
        picture uses. A percentile rather than the maximum, so one ringing
        overshoot cannot decide how the whole file is graded."""
        import numpy as np

        picture = np.full((100, 100, 3), 50.0)
        picture[0, 0] = 9000.0          # one stuck pixel, 0.01% of the frame
        picture[:8, :] = 600.0          # a real highlight, 8% of the frame
        self.assertAlmostEqual(video.content_peak_nits(picture), 600.0,
                               delta=1.0)

    def test_ordinary_video_is_never_given_a_tone_map(self):
        """Keyed on the transfer curve and nothing else. Ten-bit BT.709 is
        ordinary video that happens to be ten-bit, and running it through a
        tone map would crush a picture that was already right."""
        self.assertIsNone(video.tone_map_for(video.VideoInfo()))
        ten_bit_sdr = video.VideoInfo(pix_fmt="yuv420p10le", colorspace=1,
                                      color_primaries=1)
        self.assertIsNone(video.tone_map_for(ten_bit_sdr))

    def test_a_dynamic_range_we_cannot_name_is_refused_rather_than_guessed(self):
        """`compress` turns this None into a refusal with an explanation. A
        documented refusal beats a washed-out video; it does not beat an
        honest conversion, which is why it is now the rare path."""
        odd = video.VideoInfo(hdr=True, hdr_reason="something-new")
        self.assertIsNone(video.tone_map_for(odd))
        self.assertIsNotNone(video.tone_map_for(
            video.VideoInfo(hdr=True, hdr_reason="smpte2084")))


@unittest.skipUnless(video.available(), "video engine not installed")
class TheColourArithmeticOnRealFrames(unittest.TestCase):
    """The colour conversion, checked on an actual decoded frame.

    Separate from `TheColourArithmetic` above for one reason that is a rule
    rather than a preference: that class is pure and must run on a machine
    with no video engine at all, because a destination's promise does not
    depend on whether this laptop can encode. Anything needing an
    `av.VideoFrame` belongs here instead, behind the skip - a test that
    imports `av` from the pure class turns "video absent" into "test suite
    broken", which is exactly the distinction CONTRIBUTING.md draws.
    """

    def test_the_banded_path_agrees_with_the_plain_arithmetic(self):
        """`to_frame` runs the conversion on row bands in parallel for speed.
        Banding is only legitimate because every step is per-pixel, so the
        result must match the plain functions composed by hand - within one
        code value, which is the rounding slack of reordering float ops."""
        import av
        import numpy as np

        rng = np.random.default_rng(31)
        height, width = 500, 320   # tall enough to be split into bands
        planes = np.empty((height, width, 3), np.uint16)
        planes[..., 0] = (rng.random((height, width)) * 56064 + 4096)
        planes[..., 1:] = (rng.random((height, width, 2)) * 28672 + 18000)
        frame = av.VideoFrame.from_ndarray(planes, format="yuv444p16le")
        tone = video.ToneMap(transfer="smpte2084", source_peak=1000.0)

        got = tone.to_frame(frame).to_ndarray(format="yuv444p").astype(int)
        code = video.sdr_from_nits(video.pq_nits(tone.signal(frame)),
                                   1000.0, True)
        ycc = code @ video._RGB_TO_BT709_YCBCR.T.astype(code.dtype)
        want = np.empty((3, height, width), int)
        want[0] = np.clip(ycc[..., 0] * 219.0 + 16.0, 0.0, 255.0).round()
        want[1] = np.clip(ycc[..., 1] * 224.0 + 128.0, 0.0, 255.0).round()
        want[2] = np.clip(ycc[..., 2] * 224.0 + 128.0, 0.0, 255.0).round()
        self.assertLessEqual(int(np.abs(got.reshape(want.shape) - want).max()),
                             1)


@unittest.skipUnless(video.available(), "video engine not installed")
class TheVideoEngine(unittest.TestCase):
    """The real thing, on real files. Slow, so kept to the load-bearing cases."""

    @classmethod
    def setUpClass(cls):
        if not FIXTURES.exists() or not list(FIXTURES.glob("*.mp4")):
            import make_video_fixtures

            make_video_fixtures.build(FIXTURES)
        cls.tmp = Path(tempfile.mkdtemp(prefix="pocketsize-video-"))

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def out(self, name):
        path = self.tmp / name
        path.mkdir(parents=True, exist_ok=True)
        return path

    def test_it_reads_a_video_without_decoding_it(self):
        info = video.probe(FIXTURES / "motion.mp4")
        self.assertEqual((info.width, info.height), (480, 270))
        self.assertGreater(info.duration, 2.0)
        self.assertGreater(info.fps, 20.0)

    def test_a_still_clip_compresses_far_further_than_a_grainy_one(self):
        """Content decides, not the setting - the whole premise, in one test.
        Noise is incompressible by construction and a near-static shot is
        almost free, so a tool that spends the same bits on both is guessing."""
        still = video.compress(FIXTURES / "still.mp4", "web", fast=True,
                               formats=["h264-mp4"],
                               output_dir=self.out("still"))
        grain = video.compress(FIXTURES / "grain.mp4", "web", fast=True,
                               formats=["h264-mp4"],
                               output_dir=self.out("grain"))
        self.assertFalse(still.error, still.error)
        self.assertFalse(grain.error, grain.error)
        self.assertLess(still.new_bytes, grain.new_bytes)

    def test_it_measures_what_it_shipped(self):
        result = video.compress(FIXTURES / "motion.mp4", "web", fast=True,
                                formats=["h264-mp4"],
                                output_dir=self.out("measured"))
        self.assertFalse(result.error, result.error)
        self.assertGreater(result.score, 0.0)
        # The reported number is the worst end of the clip, so it cannot sit
        # above the average of the same measurements.
        self.assertLessEqual(result.score, result.score_mean + 0.001)
        self.assertTrue(result.output.exists())

    def test_it_never_writes_a_file_bigger_than_the_one_it_was_given(self):
        """`screen.mp4` is already 8 KB. Nothing we can make beats that, and
        the answer is to leave it alone rather than to ship the bigger file."""
        result = video.compress(FIXTURES / "screen.mp4", "web", fast=True,
                                formats=["h264-mp4"],
                                output_dir=self.out("screen"))
        self.assertLessEqual(result.new_bytes, result.original_bytes)

    def test_a_size_cap_is_actually_met(self):
        cap = 220 * 1024
        result = video.compress(FIXTURES / "grain.mp4", "chat", fast=True,
                                size_target=cap, formats=["h264-mp4"],
                                output_dir=self.out("cap"))
        self.assertFalse(result.error, result.error)
        self.assertLessEqual(result.new_bytes, cap)
        self.assertFalse(result.missed_size)

    def test_a_cap_that_costs_quality_says_so_on_the_result(self):
        """The disclosure rule, applied to the thing video does that images do
        not: when the byte limit decided the answer, the result has to admit
        the picture is not as sharp - and it must be a fact the engine reports,
        never something a caller infers by comparing numbers."""
        result = video.compress(FIXTURES / "grain.mp4", "chat", fast=True,
                                size_target=90 * 1024, formats=["h264-mp4"],
                                output_dir=self.out("capped"))
        self.assertFalse(result.error, result.error)
        self.assertTrue(result.capped)

    def test_falling_short_of_the_floor_is_disclosed_even_under_a_cap(self):
        """The bug this pins shipped a video below its destination's own
        quality floor in silence, because the code was busy reporting the size
        limit it *did* meet. Most video destinations carry a limit, so the
        disclosure that only fired without one almost never fired."""
        result = video.compress(FIXTURES / "grain.mp4", "chat", fast=True,
                                quality_target=99.5, formats=["h264-mp4"],
                                output_dir=self.out("shortfall"))
        self.assertFalse(result.error, result.error)
        self.assertLess(result.score, 99.5)
        self.assertTrue(any("visual match" in w for w in result.warnings),
                        f"no disclosure in {result.warnings}")

    def test_a_bake_off_between_two_formats_leaves_a_real_file(self):
        """AV1 and H.264 both live in `.mp4`. Naming candidates after the
        source alone gave every competitor the same path, so they overwrote
        each other and the loser's cleanup deleted the winner - the engine
        reported a size for a file that was no longer there. `web`, `chat` and
        `original` all allow two formats, so that was most of them."""
        folder = self.out("bakeoff")
        result = video.compress(FIXTURES / "still.mp4", "web", fast=True,
                                output_dir=folder)
        self.assertFalse(result.error, result.error)
        self.assertGreaterEqual(len(result.candidates), 2,
                                "both formats should have competed")
        self.assertIsNotNone(result.output)
        self.assertTrue(result.output.exists(),
                        "the winner's file was deleted by the loser's cleanup")
        self.assertEqual(result.output.stat().st_size, result.new_bytes)
        # And the losing candidate is not left lying around next to it.
        self.assertEqual(sorted(p.name for p in folder.glob("*")),
                         [result.output.name])

    def test_a_long_job_says_what_it_is_doing(self):
        """A video encode is the first thing this project does that can run
        for minutes. Silence for minutes is indistinguishable from a hang."""
        seen = []
        result = video.compress(
            FIXTURES / "motion.mp4", "web", fast=True, formats=["h264-mp4"],
            output_dir=self.out("progress"),
            on_progress=lambda stage, frac, detail: seen.append((stage, frac)),
        )
        self.assertFalse(result.error, result.error)
        self.assertGreaterEqual(len(seen), 3)
        fractions = [f for _, f in seen]
        self.assertEqual(fractions, sorted(fractions),
                         "a progress bar that goes backwards is worse than none")
        self.assertEqual(fractions[-1], 1.0)

    def test_a_job_can_be_stopped(self):
        """Picking the wrong destination should not mean waiting it out or
        killing the application."""
        import time

        started = time.time()
        result = video.compress(
            FIXTURES / "grain.mp4", "web", fast=True, formats=["h264-mp4"],
            output_dir=self.out("stopped"),
            should_stop=lambda: time.time() - started > 0.3,
        )
        self.assertTrue(result.skipped)
        self.assertEqual(result.note, "stopped")
        self.assertIsNone(result.output)
        # Nothing half-written is left behind: a file that looks finished and
        # is not is the one outcome worse than no file.
        self.assertEqual(list(self.out("stopped").glob("*.mp4")), [])

    def already_small(self, name="already-small.mp4"):
        """A file no honest re-encode can beat: the grainy fixture squeezed
        to the bottom rung first. Grain is incompressible by construction, so
        any near-lossless second encode of this file must come out bigger -
        which makes the never-bigger passthrough reachable on purpose instead
        of by luck."""
        path = self.tmp / name
        if not path.exists():
            fmt = video.FORMATS["h264-mp4"]
            info = video.probe(FIXTURES / "grain.mp4")
            video.encode(
                FIXTURES / "grain.mp4",
                video.EncodeSpec(fmt=fmt, width=info.width, height=info.height,
                                 crf=fmt.levels[0], fast=True, info=info),
                dest=path,
            )
        return path

    def test_leaving_a_file_alone_erases_every_fact_about_the_deleted_encode(self):
        """The passthrough keeps the person's original, so every measurement
        of the discarded encode has to go with it: the score, the format, the
        sound claim - and the warning that the deleted encode fell short of a
        floor, which stayed behind once and described a file that no longer
        existed."""
        result = video.compress(self.already_small(), "web", fast=True,
                                quality_target=99.9, formats=["h264-mp4"],
                                output_dir=self.out("left-alone"))
        self.assertFalse(result.error, result.error)
        self.assertTrue(result.skipped,
                        "the fixture was beaten, so this test measured nothing")
        self.assertEqual(result.new_bytes, result.original_bytes)
        self.assertEqual(result.score, 0.0)
        self.assertEqual(result.fmt, "")
        self.assertEqual(result.audio_note, "")
        self.assertFalse(result.capped)
        self.assertFalse(result.missed_size)
        self.assertFalse(
            [w for w in result.warnings if "could not reach" in w],
            f"a warning about the deleted encode survived: {result.warnings}")

    def test_never_bigger_holds_even_when_the_frame_was_capped(self):
        """This rule used to step aside whenever the destination had resized
        the frame, so a re-encode *larger* than its source shipped anyway,
        wearing a saving of nothing. A limit on the frame is not a licence to
        hand back a worse file."""
        source = self.already_small()
        info = video.probe(source)
        result = video.compress(source, "web", fast=True,
                                quality_target=99.9, formats=["h264-mp4"],
                                max_dimension=info.width // 2,
                                output_dir=self.out("resized-bigger"))
        self.assertFalse(result.error, result.error)
        self.assertTrue(result.skipped,
                        "the fixture was beaten, so this test measured nothing")
        self.assertEqual(result.new_bytes, result.original_bytes)
        self.assertIsNone(result.output)
        # The kept file is the source at its own size, so no resize happened
        # and no resize may be reported.
        self.assertIsNone(result.resized_from)
        self.assertIsNone(result.resized_to)

    def test_stopping_reaches_inside_a_running_encode(self):
        """The stages are where the engine talks; the encode loop is where
        the minutes go. A stop that only lands between stages leaves a person
        watching a half-hour encode they already cancelled."""
        fmt = video.FORMATS["h264-mp4"]
        info = video.probe(FIXTURES / "grain.mp4")
        asked = [0]

        def should_stop():
            asked[0] += 1
            return asked[0] > 3   # arm only once the loop is genuinely inside

        progress = video.Progress(should_stop=should_stop)
        dest = self.out("mid-encode") / "stopped.mp4"
        with self.assertRaises(video.Cancelled):
            video.encode(
                FIXTURES / "grain.mp4",
                video.EncodeSpec(fmt=fmt, width=info.width,
                                 height=info.height, crf=fmt.levels[-1],
                                 fast=True, info=info),
                dest=dest, progress=progress,
            )
        self.assertGreater(asked[0], 3,
                           "the encode loop never consulted should_stop")

    def test_a_lying_duration_label_is_not_believed(self):
        """A container's duration label steers the bitrate a size cap aims.
        Trusting it once turned a 10 MB cap into a 5,690 MB file. The packets
        are the only honest source, so the packets are what get counted."""
        real = video.probe(FIXTURES / "motion.mp4").duration
        liar = video.VideoInfo(duration=1.0)
        counted = video.measured_duration(FIXTURES / "motion.mp4", liar)
        self.assertAlmostEqual(counted, real, delta=0.25)
        # And an unreadable file falls back to the label instead of crashing.
        self.assertEqual(
            video.measured_duration(self.tmp / "missing.mp4", liar), 1.0)

    def test_a_destination_that_takes_no_video_says_so_and_skips(self):
        result = video.compress(FIXTURES / "motion.mp4", "thumbnail",
                                output_dir=self.out("thumb"))
        self.assertTrue(result.skipped)
        self.assertIn("pictures", result.note)
        self.assertEqual(result.new_bytes, 0)

    def test_a_file_that_is_not_a_video_fails_gracefully(self):
        broken = self.tmp / "broken.mp4"
        broken.write_bytes(b"this is not a video")
        result = video.compress(broken, "web", output_dir=self.out("broken"))
        self.assertTrue(result.error)
        self.assertIsNone(result.output)

    def test_resizing_is_reported_as_a_fact_not_left_to_be_noticed(self):
        result = video.compress(FIXTURES / "motion.mp4", "web", fast=True,
                                max_dimension=320, formats=["h264-mp4"],
                                output_dir=self.out("resized"))
        self.assertFalse(result.error, result.error)
        self.assertEqual(result.resized_from, (480, 270))
        self.assertEqual(result.resized_to[0], 320)

    def test_the_second_opinion_is_a_different_metric(self):
        """The search watches SSIMULACRA 2, so the number that certifies the
        result cannot be the only one reported. XPSNR fails differently."""
        result = video.compress(FIXTURES / "motion.mp4", "web", fast=True,
                                formats=["h264-mp4"],
                                output_dir=self.out("witness"))
        if not video._has_filter("xpsnr"):
            self.skipTest("this build has no xpsnr filter")
        self.assertGreater(result.witness, 0.0)


REAL_WORLD = Path(__file__).resolve().parent / "real_world_fixtures"


@unittest.skipUnless(video.available(), "video engine not installed")
class TheAwkwardInputs(unittest.TestCase):
    """The shapes real video actually arrives in.

    Every case here is one where a compressor does not produce a *large* file,
    which a person would notice, but a *wrong* one, which they might not until
    it is too late to matter - sideways, squashed, grey, out of sync, or
    missing a soundtrack. These are the defects that end trust.
    """

    @classmethod
    def setUpClass(cls):
        import make_real_world_fixtures as builder

        # Rebuilt when a clip is missing *or older than the script that makes
        # it*. Checking only for existence certifies whatever happened to be
        # built last: this corpus is ignored by git, so a folder left over from
        # a previous shape of the fixtures would let every test below pass
        # while measuring a picture nobody meant to make.
        written = Path(builder.__file__).stat().st_mtime
        stale = [
            name for name in builder.PLAN
            if not (REAL_WORLD / f"{name}.mp4").exists()
            or (REAL_WORLD / f"{name}.mp4").stat().st_mtime < written
        ]
        if stale:
            builder.build(REAL_WORLD)
        cls.tmp = Path(tempfile.mkdtemp(prefix="pocketsize-awkward-"))

    def pixels_of(self, path, at=0.0):
        """The first frame of a result, as plain RGB."""
        import av
        import numpy as np

        with av.open(str(path)) as container:
            frame = next(container.decode(container.streams.video[0]))
            return frame.to_ndarray(format="rgb24").astype(np.float32)

    def bars_of(self, pixels):
        """(top bar, left bar, background) means of an HDR fixture's result.

        The fixture carries a specular highlight along the top edge at 1000
        nits and a band of diffuse white down the left at 203, both neutral,
        with ordinary indoor brightness everywhere else. Sampled well inside
        each bar so a blurred edge cannot decide the answer.
        """
        height, width, _ = pixels.shape
        return (
            pixels[2:height // 12, width // 4:width * 3 // 4].mean(axis=(0, 1)),
            pixels[height // 3:height * 2 // 3, 2:width // 16].mean(axis=(0, 1)),
            pixels[height // 2:height * 3 // 4, width // 2:].mean(axis=(0, 1)),
        )

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def out(self, name):
        path = self.tmp / name
        path.mkdir(parents=True, exist_ok=True)
        return path

    def shape_of(self, path):
        """The size a player would actually show, flag included."""
        import av

        with av.open(str(path)) as container:
            stream = container.streams.video[0]
            frame = next(container.decode(stream))
            width, height = frame.width, frame.height
            turn = int(getattr(frame, "rotation", 0) or 0) % 180
            return (height, width) if turn == 90 else (width, height)

    def run_one(self, name, folder, **kwargs):
        result = video.compress(REAL_WORLD / f"{name}.mp4", "web", fast=True,
                                formats=["h264-mp4"],
                                output_dir=self.out(folder), **kwargs)
        return result

    def run_converted(self, name, folder):
        """One HDR fixture, compressed so that something actually ships.

        The colour tests need a finished file to look at, and the fixtures
        are near-lossless on purpose - so at the destination's own floor the
        smallest passing encode can come out *bigger* than the source, and
        the never-bigger rule (correctly) hands the original back. These
        tests measure the conversion, not the compression, so they ask for a
        quality the fixture can beat and then insist the encode really did
        ship. The passthrough side has its own test below.
        """
        result = self.run_one(name, folder, max_dimension=320,
                              quality_target=70.0)
        self.assertFalse(result.error, result.error)
        self.assertFalse(result.skipped,
                         f"nothing shipped, so nothing can be checked "
                         f"({result.note})")
        return result

    def test_a_phone_held_upright_does_not_come_out_sideways(self):
        """The most common consumer video shape there is: stored landscape
        with a rotation flag. Ignore the flag and every portrait clip a person
        compresses is ruined."""
        result = self.run_one("portrait", "portrait")
        self.assertFalse(result.error, result.error)
        width, height = self.shape_of(result.output)
        self.assertGreater(height, width,
                           f"portrait video came out {width}x{height}")

        # Portrait dimensions alone do not prove the turn went the right way -
        # both directions produce a tall frame. The source carries a bright
        # bar along its top edge, and a quarter turn counter-clockwise, which
        # is what a +90 flag means, has to put that bar on the left.
        import av
        import numpy as np

        with av.open(str(result.output)) as container:
            frame = next(container.decode(container.streams.video[0]))
            pixels = frame.to_ndarray(format="rgb24").astype(np.float32)
        columns = pixels.shape[1]
        left = pixels[:, : columns // 8].mean()
        right = pixels[:, -columns // 8:].mean()
        self.assertGreater(left, right,
                           "the picture was turned the wrong way round")

    def test_a_video_recorded_upside_down_is_turned_back(self):
        result = self.run_one("upside", "upside")
        self.assertFalse(result.error, result.error)
        import av
        import numpy as np

        with av.open(str(result.output)) as container:
            frame = next(container.decode(container.streams.video[0]))
            pixels = frame.to_ndarray(format="rgb24").astype(np.float32)
        top = pixels[: pixels.shape[0] // 8].mean()
        bottom = pixels[-pixels.shape[0] // 8:].mean()
        # The source has a bright bar along its top edge. Turned through 180
        # degrees for display, that bar belongs at the bottom of the result.
        self.assertGreater(bottom, top,
                           "the picture was not turned the right way up")

    def test_the_witness_sees_the_straightened_picture(self):
        """The second opinion used to compare the straightened output against
        the sideways stored reference, and returned about 12 dB of catastrophe
        that was not there - on exactly the most common consumer video shape.
        The reference now goes through the same straightening the encoder
        applied, so the witness measures the encode."""
        if not video._has_filter("xpsnr"):
            self.skipTest("this build carries no xpsnr filter")
        result = self.run_one("portrait", "witness")
        self.assertFalse(result.error, result.error)
        self.assertFalse(result.skipped, result.note)
        self.assertGreater(
            result.witness, 20.0,
            f"the witness scored {result.witness:.1f} dB - that is the "
            "sideways comparison this test exists to forbid")

    def test_the_sound_claim_comes_from_what_the_encode_did(self):
        """The old claim was inferred afterwards by comparing codec names on
        the finished file, which told two lies: sound decoded and re-encoded
        back to its own codec read as "kept exactly as it was", and sound
        that failed to open at all - a silent file - read as "re-encoded".
        The claim now comes from the moment the sound was handled."""
        src = REAL_WORLD / "multitrack.mp4"
        info = video.probe(src)
        self.assertTrue(info.has_audio)
        fmt = video.FORMATS["h264-mp4"]
        windows = [(0.0, min(2.0, info.duration or 2.0))]
        folder = self.out("sound-claims")

        # Re-encoded sound, even to the codec the source already used, is
        # re-encoded sound.
        spec = video.EncodeSpec(fmt=fmt, width=info.width, height=info.height,
                                crf=fmt.levels[0], fast=True, audio="aac",
                                info=info)
        out = folder / "re-encoded.mp4"
        video.encode(src, spec, dest=out)
        self.assertTrue(spec.audio_written)
        self.assertFalse(spec.audio_copied)
        _, _, state = video._verify(src, out, info.width, info.height,
                                    windows, "aac", info, spec=spec)
        self.assertEqual(state, "encoded")

        # Copied sound is copied sound.
        spec = video.EncodeSpec(fmt=fmt, width=info.width, height=info.height,
                                crf=fmt.levels[0], fast=True, audio="copy",
                                info=info)
        out = folder / "copied.mp4"
        video.encode(src, spec, dest=out)
        self.assertTrue(spec.audio_copied)
        _, _, state = video._verify(src, out, info.width, info.height,
                                    windows, "copy", info, spec=spec)
        self.assertEqual(state, "copied")

        # And a result with no soundtrack at all must never be described as
        # having any kind of sound.
        spec = video.EncodeSpec(fmt=fmt, width=info.width, height=info.height,
                                crf=fmt.levels[0], fast=True,
                                with_audio=False, info=info)
        out = folder / "silent.mp4"
        video.encode(src, spec, dest=out)
        _, _, state = video._verify(src, out, info.width, info.height,
                                    windows, "copy", info, spec=spec)
        self.assertEqual(state, "lost")

    def test_non_square_pixels_are_not_left_squashed(self):
        """DV and many camera modes store a frame that is not the shape the
        picture should be. The stored frame is 320x176 with 4:3 pixels, so the
        picture is really about 427 wide."""
        result = self.run_one("anamorphic", "anamorphic")
        self.assertFalse(result.error, result.error)
        width, height = self.shape_of(result.output)
        self.assertGreater(width / height, 1.9,
                           f"squashed: came out {width}x{height}")

    def test_hdr_is_never_silently_flattened(self):
        """A phone records HDR by default, so this is most consumer video.

        This test used to encode a refusal: there is no tone-mapping filter in
        this wheel, so the engine detected HDR and left the file alone. The
        contract is stronger now - the colour is converted, in arithmetic, and
        the person is told it happened. What it has always forbidden, and
        still forbids, is the third outcome: a re-encode that quietly drops
        the wide colour and hands back a picture where white is grey.

        Both halves are required. A conversion nobody is told about is a file
        that no longer matches the one they shot, and a disclosure with no
        conversion behind it is a lie.
        """
        result = self.run_converted("hdr", "hdr")

        # 1. the colour was converted, and the engine says so as a fact rather
        #    than leaving a surface to work it out from the tags.
        self.assertTrue(result.tone_mapped,
                        "HDR was re-encoded without being converted")
        self.assertGreater(result.hdr_peak_nits,
                           video.SDR_REFERENCE_WHITE_NITS)

        # 2. and the person is told, in the list every surface already prints.
        said = " ".join(result.warnings)
        self.assertIn("HDR", said)
        self.assertIn("converted", said)

        # 3. and the picture is not the washed-out one. Read as if it were
        #    ordinary video, this clip's diffuse white sits at code 148 - mid
        #    grey. Converted, it is up near white.
        _top, left, _rest = self.bars_of(self.pixels_of(result.output))
        self.assertGreater(float(left.mean()), 200.0,
                           f"white came out at {left} - that is the flattened "
                           "picture this test exists to forbid")

    def test_a_converted_clip_says_what_colour_it_now_holds(self):
        """The pixels changed, so the label has to change with them. Untagged
        standard-definition video is assumed BT.601 by most players, and this
        tool makes small frames for a living - an untagged conversion would
        come back with a cast on exactly its most common output."""
        import av

        result = self.run_converted("hdr", "hdr-tags")
        with av.open(str(result.output)) as container:
            context = container.streams.video[0].codec_context
            self.assertEqual(int(context.color_trc), 1)          # BT.709
            self.assertEqual(int(context.color_primaries), 1)
            self.assertEqual(int(context.colorspace), 1)
            self.assertEqual(int(context.color_range), 1)        # limited

    def test_white_stays_white_and_the_shadows_stay_dark(self):
        """The whole picture, not just its brightest corner. A conversion can
        be wrong in three directions at once - white grey, midtones lifted,
        colours tinted - and only the last of those is obvious in a still."""
        result = self.run_converted("hdr", "hdr-shape")
        top, left, rest = self.bars_of(self.pixels_of(result.output))

        # The 1000-nit highlight is the brightest thing here and arrives at
        # white; the 203-nit diffuse white sits just under it; the ordinary
        # indoor background stays well down the scale.
        self.assertGreater(float(top.mean()), 245.0)
        self.assertGreater(float(left.mean()), 200.0)
        self.assertLess(float(left.mean()), float(top.mean()) + 1.0)
        self.assertLess(float(rest.mean()), 130.0)

        # And both bars are still neutral. A tint here would mean the matrix
        # or the gamut conversion is wrong even though the brightness is right.
        for bar in (top, left):
            self.assertLess(float(bar.max() - bar.min()), 6.0,
                            f"a neutral came back tinted: {bar}")

    def test_the_two_kinds_of_hdr_produce_the_same_picture(self):
        """`hdr` and `hlg` are the same brightnesses written through two
        unrelated transfer curves - PQ and HLG, different committees, one
        absolute and one scene-referred. If both are read correctly they have
        to converge on one picture, and neither implementation can be checked
        against the other by construction.

        This is the test that found the real bug in this work: the fixture's
        HLG curve was missing a factor of three below half signal, which is
        invisible in the HLG clip alone and unmistakable the moment the PQ
        version of the same frame is put beside it.
        """
        import numpy as np

        pq = self.run_converted("hdr", "pq-vs-hlg-a")
        hlg = self.run_converted("hlg", "pq-vs-hlg-b")
        self.assertTrue(pq.tone_mapped and hlg.tone_mapped)

        left = self.pixels_of(pq.output)
        right = self.pixels_of(hlg.output)
        self.assertEqual(left.shape, right.shape)
        for a, b, where in zip(self.bars_of(left), self.bars_of(right),
                               ("highlight", "white", "background")):
            with self.subTest(region=where):
                self.assertLess(float(np.abs(a - b).max()), 8.0,
                                f"PQ gave {a} where HLG gave {b}")

    def test_a_phone_held_upright_in_hdr_is_straightened_and_converted(self):
        """Both corrections at once, which is not a corner case: it is the
        default setting of the most common camera there is. They share a filter
        graph, so it is entirely possible for one of them to eat the other -
        the straightening runs inside the graph and the conversion reads what
        the graph produces."""
        import numpy as np

        result = self.run_converted("phone", "phone")
        self.assertTrue(result.tone_mapped)

        width, height = self.shape_of(result.output)
        self.assertGreater(height, width,
                           f"the portrait clip came out {width}x{height}")

        pixels = self.pixels_of(result.output)
        columns = pixels.shape[1]
        # The source's bright top edge belongs on the left after a quarter turn
        # counter-clockwise, and it is the 1000-nit highlight - so it is both
        # the orientation check and the brightness check in one reading.
        left = pixels[:, : columns // 8]
        right = pixels[:, -columns // 8:]
        self.assertGreater(float(left.mean()), float(right.mean()),
                           "the picture was turned the wrong way round")
        self.assertGreater(float(np.percentile(left, 90)), 240.0,
                           "the highlight did not survive the straightening")

    def test_ordinary_ten_bit_video_is_not_crushed(self):
        """The control, and the reason the tone map is keyed on the transfer
        curve and never on the bit depth. `sdr10` is plain BT.709 that happens
        to be ten-bit; running it through a tone map would darken a picture
        that was already correct, and claiming a conversion that did not
        happen would be worse still."""
        result = self.run_one("sdr10", "sdr10", max_dimension=320)
        self.assertFalse(result.error, result.error)
        self.assertFalse(result.tone_mapped)
        self.assertEqual(result.hdr_peak_nits, 0.0)
        self.assertFalse([w for w in result.warnings if "HDR" in w],
                         f"ordinary video was reported as HDR: {result.warnings}")

        # The fixture's left edge is written at 55% of full scale and has to
        # come back at 55% of full scale.
        _top, left, _rest = self.bars_of(self.pixels_of(result.output))
        self.assertAlmostEqual(float(left.mean()), 0.55 * 255, delta=10.0)

    def test_a_clip_left_alone_does_not_claim_to_have_been_converted(self):
        """These fixtures are written near-lossless, so an HDR clip can lose
        the never-bigger rule and be handed back untouched. When that happens
        the person still holds an HDR file, and a result that says its colour
        was converted would be describing a file that does not exist."""
        result = self.run_one("hdr", "hdr-left-alone")
        if not result.skipped:
            self.skipTest("this build could beat the fixture, so nothing was "
                          "left alone")
        self.assertFalse(result.tone_mapped)
        self.assertNotIn(video.HDR_DISCLOSURE, result.warnings)
        self.assertIn("HDR", result.note)

    def test_the_same_numbers_read_the_same_at_every_bit_depth(self):
        """FFmpeg widens 8-, 10- and 12-bit samples to 16 by shifting left, so
        the limits of a limited-range signal land on the same four constants
        whatever the source depth - which is why the conversion can carry them
        as constants at all. If that convention ever changes, every HDR
        brightness in this engine shifts by half a code value and nothing else
        would notice."""
        import av
        import numpy as np

        # Black, white and a midpoint, each exactly representable at 8, 10 and
        # 12 bits: 16/235/126 becomes 64/940/504 and 256/3760/2016.
        depths = ("yuv420p", "yuv420p10le", "yuv420p12le")
        tone = video.ToneMap(transfer="smpte2084")
        for level, name in ((4096, "black"), (60160, "white"),
                            (32256, "midpoint")):
            planes = np.empty((16, 16, 3), np.uint16)
            planes[..., 0] = level
            planes[..., 1:] = 32768
            source = av.VideoFrame.from_ndarray(planes, format="yuv444p16le")
            for pix_fmt in depths:
                with self.subTest(level=name, pix_fmt=pix_fmt):
                    widened = source.reformat(format=pix_fmt).to_ndarray(
                        format="yuv444p16le")
                    self.assertEqual(sorted(np.unique(widened[..., 0])),
                                     [level],
                                     "the depth-widening convention changed")

        # And the constants the conversion carries follow from exactly that:
        # limited-range black and white are 0.0 and 1.0 at every depth.
        for pix_fmt in depths:
            for level, want in ((4096, 0.0), (60160, 1.0)):
                planes = np.empty((16, 16, 3), np.uint16)
                planes[..., 0] = level
                planes[..., 1:] = 32768
                frame = av.VideoFrame.from_ndarray(
                    planes, format="yuv444p16le").reformat(format=pix_fmt)
                with self.subTest(pix_fmt=pix_fmt, level=level):
                    signal = tone.signal(frame)
                    self.assertAlmostEqual(float(signal.mean()), want,
                                           delta=1.0 / 255.0)

    def test_a_variable_frame_rate_clip_keeps_its_length(self):
        """Screen recorders and phones emit uneven timestamps. Assume a
        constant rate and the picture drifts away from the sound."""
        result = self.run_one("vfr", "vfr")
        self.assertFalse(result.error, result.error)
        after = video.probe(result.output)
        before = video.probe(REAL_WORLD / "vfr.mp4")
        self.assertAlmostEqual(after.duration, before.duration, delta=0.15)

    def test_dropping_a_soundtrack_is_disclosed(self):
        """Two audio tracks in, one out. That is a defensible choice and an
        indefensible silence."""
        result = self.run_one("multitrack", "multitrack")
        self.assertFalse(result.error, result.error)
        said = " ".join(result.warnings) + " " + (result.audio_note or "")
        self.assertTrue(
            any(word in said.lower() for word in ("extra", "second", "other")),
            f"the dropped soundtrack was not disclosed: {said!r}",
        )


if __name__ == "__main__":
    unittest.main()
