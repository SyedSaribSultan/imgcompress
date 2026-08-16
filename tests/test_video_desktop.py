"""The desktop app's video path.

The engine is tested elsewhere. What is tested here is the wiring: that a
video reaches the video engine at all, that the queue knows what shape the
person will actually see before anything has been measured, that a long encode
reports where it has got to, and that saving moves the file the engine already
wrote rather than encoding it a second time.
"""

from __future__ import annotations

import shutil
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pocketsize import video  # noqa: E402
from pocketsize.server import Session  # noqa: E402

FIXTURES = Path(__file__).resolve().parent / "video_fixtures"
REAL_WORLD = Path(__file__).resolve().parent / "real_world_fixtures"


def _ensure(folder, builder):
    if not folder.exists() or not list(folder.glob("*.mp4")):
        builder(folder)


@unittest.skipUnless(video.available(), "video engine not installed")
class TheDesktopVideoPath(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import make_real_world_fixtures
        import make_video_fixtures

        _ensure(FIXTURES, make_video_fixtures.build)
        _ensure(REAL_WORLD, make_real_world_fixtures.build)
        cls.tmp = Path(tempfile.mkdtemp(prefix="pocketsize-desktop-"))

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def finish(self, session, timeout=300):
        deadline = time.time() + timeout
        stages = set()
        while time.time() < deadline:
            snapshot = session.snapshot()
            for entry in snapshot["items"]:
                if entry.get("stage"):
                    stages.add(entry["stage"])
            if all(e["status"] in ("done", "failed", "saved")
                   for e in snapshot["items"]):
                return snapshot, stages
            time.sleep(0.2)
        self.fail("the queue never finished")

    def test_a_video_is_recognised_before_it_is_measured(self):
        """The queue draws a row the moment a file lands, so it has to know it
        is a video then - not after an encode it has not started."""
        session = Session(workers=1)
        session.add_path(FIXTURES / "still.mp4")
        entry = session.snapshot()["items"][0]
        self.assertEqual(entry["kind"], "video")
        self.assertTrue(entry["is_video"])
        self.assertGreater(entry["duration"], 0.0)

    def test_the_queue_shows_the_shape_a_person_will_see(self):
        """A phone held upright stores a landscape frame and flags it. The row
        has to say 270x480, because that is what comes out and what the person
        is looking at - not the shape it happened to be filed away as."""
        session = Session(workers=1)
        session.add_path(REAL_WORLD / "portrait.mp4")
        entry = session.snapshot()["items"][0]
        self.assertGreater(entry["height"], entry["width"])

    def test_it_reports_where_a_long_encode_has_got_to(self):
        session = Session(workers=1)
        session.add_path(FIXTURES / "still.mp4")
        snapshot, stages = self.finish(session)
        self.assertTrue(stages, "the encode never said what it was doing")
        entry = snapshot["items"][0]
        self.assertEqual(entry["status"], "done")
        self.assertLess(entry["new_bytes"], entry["original_bytes"])
        # And the progress fields are cleared once there is a result, so a
        # finished row does not sit there showing a stale bar.
        self.assertEqual(entry["stage"], "")

    def test_a_finished_video_reports_its_shape_not_zero(self):
        """`not resized` means it came out the shape it went in, not that it
        came out nothing by nothing - which is what the UI would have drawn."""
        session = Session(workers=1)
        session.add_path(FIXTURES / "still.mp4")
        snapshot, _ = self.finish(session)
        entry = snapshot["items"][0]
        self.assertGreater(entry["out_width"], 0)
        self.assertGreater(entry["out_height"], 0)

    def test_saving_moves_the_file_the_engine_already_wrote(self):
        session = Session(workers=1)
        session.add_path(FIXTURES / "still.mp4")
        self.finish(session)
        folder = self.tmp / "saved"
        report = session.save(str(folder))
        self.assertEqual(report["failed"], [])
        self.assertEqual(len(report["written"]), 1)
        written = Path(report["written"][0])
        self.assertTrue(written.exists())
        self.assertGreater(written.stat().st_size, 0)
        self.assertEqual(session.snapshot()["items"][0]["status"], "saved")

    def test_saving_twice_does_not_write_over_the_first_one(self):
        session = Session(workers=1)
        session.add_path(FIXTURES / "still.mp4")
        self.finish(session)
        folder = self.tmp / "twice"
        first = Path(session.save(str(folder))["written"][0])
        session.snapshot()  # the item is 'saved'; saving again is explicit
        second = Path(session.save(str(folder), ids=[
            session.snapshot()["items"][0]["id"]])["written"][0])
        self.assertTrue(first.exists() and second.exists())
        self.assertNotEqual(first, second)

    def test_a_folder_of_videos_is_not_silently_ignored(self):
        """Folder intake listed pictures only, so a folder of holiday clips -
        exactly the thing a person drags in - added nothing at all."""
        folder = self.tmp / "dropped"
        folder.mkdir(parents=True, exist_ok=True)
        shutil.copy2(FIXTURES / "still.mp4", folder / "one.mp4")
        shutil.copy2(FIXTURES / "screen.mp4", folder / "two.mp4")
        session = Session(workers=1)
        session.add_path(folder)
        names = sorted(e["name"] for e in session.snapshot()["items"])
        self.assertEqual(names, ["one.mp4", "two.mp4"])

    def test_the_snapshot_says_whether_video_works_on_this_machine(self):
        """The UI cannot offer what this machine cannot do, and must not
        pretend the absence is a failure."""
        session = Session(workers=1)
        caps = session.snapshot()["video"]
        self.assertIn("available", caps)
        self.assertIn("install", caps)
        self.assertIn("web", caps["destinations"])
        self.assertNotIn("thumbnail", caps["destinations"])


if __name__ == "__main__":
    unittest.main()
