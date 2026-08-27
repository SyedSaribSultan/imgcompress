"""Folder watching, and the subfolders it used to miss.

Watching a folder is the one intake path in this application that a person sets
up once and then stops looking at. That is what makes a quiet failure here
worse than the same failure anywhere else: a drop that misses files shows you a
short queue, and a watch that misses files shows you nothing and says nothing -
which is indistinguishable from a folder where nothing has happened yet.

It scanned with `iterdir` until 2026-08-27, so it saw only the top level. Every
other intake path already recursed - `add_path` walks with `iter_images` plus
`rglob`, and the CLI defaults to recursive with `--no-recursive` to opt out -
so the watcher was both the odd one out and the place where being the odd one
out was invisible. Pointed at a folder holding three folders of renders, it
found nothing at all.

There were no tests for any of this before this file, which is the other half
of why it lasted.
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from PIL import Image  # noqa: E402

from pocketsize.server import Session  # noqa: E402


def _png(path: Path, size=(8, 8)) -> Path:
    """A real, tiny PNG. Real because `_watchable` asks the filesystem, and a
    zero-byte file with the right suffix would pass a test the engine would
    then choke on."""
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", size, (120, 90, 60)).save(path)
    return path


class TheWatchScanReachesSubfolders(unittest.TestCase):
    """`_watchable` is the shared scan. Both the initial "everything here is
    old" pass and the every-two-seconds "what is new" pass call it, so it is
    the one place worth testing directly."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="pocketsize-watch-"))
        self.addCleanup(self._cleanup)
        self.session = Session()

    def _cleanup(self):
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_it_finds_an_image_at_the_top_level(self):
        """The case that always worked, kept so a fix for the nested case
        cannot quietly break the flat one."""
        _png(self.tmp / "top.png")
        found = {p.name for p in self.session._watchable(str(self.tmp))}
        self.assertEqual(found, {"top.png"})

    def test_it_finds_an_image_several_folders_down(self):
        """The bug, at the depth the owner's folder actually had: three levels
        below the folder you would point this at."""
        _png(self.tmp / "outfits" / "mens_casual" / "jeans" / "deep.png")
        found = {p.name for p in self.session._watchable(str(self.tmp))}
        self.assertEqual(found, {"deep.png"})

    def test_a_folder_that_holds_only_folders_is_not_empty(self):
        """The exact shape that reported nothing. Every image is nested, so a
        flat scan finds zero files and the watch looks like it is working."""
        for group in ("outfits", "poses", "scenes"):
            _png(self.tmp / group / f"{group}_a" / "one.png")
            _png(self.tmp / group / f"{group}_b" / "two.png")
        found = self.session._watchable(str(self.tmp))
        self.assertEqual(len(found), 6,
                         "a folder of folders scanned as empty - this is the "
                         "iterdir bug, and it reports nothing while failing")

    def test_it_ignores_files_it_cannot_compress(self):
        """The owner's folder has a .json sidecar beside every image. Queueing
        those would be 67 failures in a queue that should be 67 successes."""
        _png(self.tmp / "shot" / "keep.png")
        (self.tmp / "shot" / "keep.png.json").write_text("{}", encoding="utf-8")
        (self.tmp / "shot" / "notes.txt").write_text("hello", encoding="utf-8")
        found = {p.name for p in self.session._watchable(str(self.tmp))}
        self.assertEqual(found, {"keep.png"})

    def test_a_missing_folder_is_not_an_error(self):
        """A watched folder can be deleted or unplugged while it is watched.
        The thread has to survive that: the next tick tries again."""
        self.assertEqual(self.session._watchable(str(self.tmp / "gone")), [])


class TheInitialScanAndTheWatchAgree(unittest.TestCase):
    """`set_watch` records what is already there so only new arrivals are
    compressed. If that scan and the watcher's scan disagree, every file the
    watcher sees and the initial scan missed is re-added on every tick - which
    with the old code meant a nested folder was recompressed forever."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="pocketsize-watch2-"))
        self.addCleanup(self._cleanup)
        self.session = Session()

    def _cleanup(self):
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_existing_nested_files_are_marked_already_seen(self):
        _png(self.tmp / "a" / "b" / "old.png")
        self.session.set_watch(str(self.tmp))
        self.assertEqual(len(self.session.watch_seen), 1,
                         "a nested file that was already there was not recorded "
                         "as seen, so the watcher would compress it as if new")

    def test_nothing_already_there_is_queued(self):
        """Setting a watch must not start work. Pointing this at a folder of
        500 photos should not begin compressing 500 photos."""
        _png(self.tmp / "a" / "b" / "old.png")
        self.session.set_watch(str(self.tmp))
        self.assertEqual(self.session.order, [])

    def test_a_new_nested_file_is_not_already_seen(self):
        """The other side of the same coin: a file that arrives after the watch
        was set has to be recognised as new, however deep it is."""
        _png(self.tmp / "a" / "b" / "old.png")
        self.session.set_watch(str(self.tmp))
        fresh = _png(self.tmp / "a" / "b" / "c" / "new.png")
        after = self.session._watchable(str(self.tmp))
        unseen = [p for p in after if str(p) not in self.session.watch_seen]
        self.assertEqual([p.name for p in unseen], [fresh.name])

    def test_clearing_the_watch_forgets_what_it_had_seen(self):
        _png(self.tmp / "a" / "old.png")
        self.session.set_watch(str(self.tmp))
        self.session.set_watch("")
        self.assertEqual(self.session.watch_folder, "")
        self.assertEqual(self.session.watch_seen, set())


if __name__ == "__main__":
    unittest.main()
