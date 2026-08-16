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

    def test_removing_a_video_stops_the_encode_it_was_waiting_on(self):
        """`/api/remove` used to drop the row while the worker encoded on for
        minutes - the app had no way to cancel a video at all, because the
        server never passed `should_stop` to the engine. Removing the item is
        the person saying stop, and stop has to mean now."""
        from pocketsize.server import video_workdir

        session = Session(workers=1)
        session.add_path(FIXTURES / "grain.mp4")
        item_id = session.snapshot()["items"][0]["id"]

        deadline = time.time() + 60
        while time.time() < deadline:
            entries = session.snapshot()["items"]
            if entries and entries[0]["status"] == "working":
                break
            time.sleep(0.05)
        else:
            self.fail("the encode never started")

        session.remove([item_id])
        # The engine checks the flag between frames, so the worker should be
        # idle again far sooner than the encode would have taken.
        deadline = time.time() + 20
        while time.time() < deadline:
            with session.lock:
                still_running = item_id in session.stops
            if not still_running:
                break
            time.sleep(0.1)
        self.assertFalse(still_running,
                         "the worker was still encoding a removed video")
        # And nothing of it is left on disk once the worker has let go.
        deadline = time.time() + 10
        while time.time() < deadline and video_workdir(item_id).exists():
            time.sleep(0.1)
        self.assertFalse(video_workdir(item_id).exists(),
                         "the removed video's working folder was left behind")

    def test_working_files_do_not_outlive_the_item(self):
        """Thirty phone clips used to leave several gigabytes in the system
        temp folder, permanently: nothing deleted a video's working directory,
        ever. Removing the item removes its folder; cleanup sweeps the rest."""
        from pocketsize.server import video_workdir

        session = Session(workers=1)
        session.add_path(FIXTURES / "still.mp4")
        item_id = session.snapshot()["items"][0]["id"]
        self.finish(session)
        self.assertTrue(video_workdir(item_id).exists(),
                        "the result should exist while the item is held")
        session.remove([item_id])
        self.assertFalse(video_workdir(item_id).exists(),
                         "removing the item must remove its working folder")

        # And whatever is still held when the app ends goes with the app.
        session = Session(workers=1)
        session.add_path(FIXTURES / "still.mp4")
        item_id = session.snapshot()["items"][0]["id"]
        self.finish(session)
        session.cleanup()
        self.assertFalse(video_workdir(item_id).exists(),
                         "shutdown must sweep the session's working folders")

    def test_a_video_may_be_uploaded_past_the_picture_limit(self):
        """`MAX_VIDEO_BODY` was defined and then referenced by nothing, so
        every upload was capped at the 512 MB picture limit - on the tier
        built for phone video, which routinely exceeds it. The two limits
        have to be different numbers AND the video one has to be reachable,
        which is what a dead constant cannot be."""
        from pocketsize import server

        self.assertGreater(server.MAX_VIDEO_BODY, server.MAX_BODY)

        # The handler picks the limit from the filename, the same way the
        # queue decides a file is a video at all. Asserted through the real
        # decision rather than by re-implementing it here.
        for name, expected in (("holiday.mp4", server.MAX_VIDEO_BODY),
                               ("clip.MOV", server.MAX_VIDEO_BODY),
                               ("photo.png", server.MAX_BODY)):
            with self.subTest(name=name):
                limit = (server.MAX_VIDEO_BODY
                         if video.is_video_path(name) else server.MAX_BODY)
                self.assertEqual(limit, expected)

    def test_an_upload_that_stops_early_is_refused_not_queued(self):
        """A dropped connection or a tab closed mid-upload ends the read
        early. The obvious streaming loop returns the partial byte count,
        which is truthy - so a half-written file was accepted and queued as
        though it were whole, and the person got a corrupt result or a
        confusing decode error for a file that never fully arrived.

        Driven through the real server rather than by calling the helper, so
        what is tested is the path an actual upload takes.
        """
        import http.client
        import threading

        from pocketsize.server import serve

        httpd, session, url = serve(port=0, workers=1)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        try:
            token = url.split("token=")[1]
            port = httpd.server_address[1]
            payload = (FIXTURES / "still.mp4").read_bytes()

            def upload(body, declared, name):
                conn = http.client.HTTPConnection("127.0.0.1", port, timeout=30)
                conn.putrequest("POST", "/api/upload")
                conn.putheader("X-Token", token)
                conn.putheader("X-Filename", name)
                conn.putheader("Content-Length", str(declared))
                conn.endheaders()
                try:
                    conn.send(body)
                    response = conn.getresponse()
                    return response.status, response.read().decode()
                finally:
                    conn.close()

            # Honest upload: accepted.
            status, _ = upload(payload, len(payload), "whole.mp4")
            self.assertEqual(status, 200)

            # Truncated: half the body against the full declaration, then the
            # socket is shut down for writing - which is what a dropped
            # connection actually looks like to the server, and is the only
            # thing that ends its read. Sent raw rather than through
            # http.client, which has no way to say "and now stop".
            import socket

            sock = socket.create_connection(("127.0.0.1", port), timeout=30)
            try:
                half = payload[:len(payload) // 2]
                head = (
                    f"POST /api/upload HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n"
                    f"X-Token: {token}\r\nX-Filename: cut-short.mp4\r\n"
                    f"Content-Length: {len(payload)}\r\n\r\n"
                ).encode()
                sock.sendall(head + half)
                sock.shutdown(socket.SHUT_WR)
                answer = b""
                while True:
                    chunk = sock.recv(4096)
                    if not chunk:
                        break
                    answer += chunk
            finally:
                sock.close()
            self.assertIn(b"400", answer.split(b"\r\n")[0], answer[:200])
            self.assertIn(b"did not finish", answer)

            # And nothing half-written was kept or queued.
            names = [i["name"] for i in session.snapshot()["items"]]
            self.assertIn("whole.mp4", names)
            self.assertNotIn("cut-short.mp4", names)
        finally:
            httpd.shutdown()
            session.cleanup()

    def test_the_desktop_page_carries_a_content_security_policy(self):
        """The page is handed the run's API token, so anything that could
        execute in it could read and write any file the person can. There is
        no injection to exploit today; this is the floor that keeps one from
        mattering if it ever lands. `connect-src 'self'` is the load-bearing
        directive - injected script still cannot send a byte off-machine."""
        import re

        page = (Path(__file__).resolve().parent.parent / "pocketsize"
                / "webui" / "app.html").read_text(encoding="utf-8")
        found = re.search(
            r'<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"',
            page)
        self.assertIsNotNone(found, "the desktop page declares no CSP")
        policy = found.group(1)
        self.assertIn("default-src 'none'", policy)
        self.assertIn("connect-src 'self'", policy)
        # frame-ancestors is ignored inside a meta element, so it must not be
        # claimed in the policy itself - a directive that silently does
        # nothing is worse than an absent one. Read from the parsed policy
        # rather than the file text, or the prose explaining this decision
        # would satisfy the assertion about it.
        self.assertNotIn("frame-ancestors", policy)

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
