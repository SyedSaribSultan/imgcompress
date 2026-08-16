"""The vendored files are what the licence table says they are.

`web/vendor/LICENSES.md` records a SHA-256 for every third-party file this
repository redistributes. That table is the answer to "is the build we ship
the one an advisory is about", and it carries the licence each file arrives
under - so it has to be true, not aspirational.

Until this existed it was enforced by the instruction inside the file itself
("any change to these files must update this table in the same commit"),
which is to say by whoever remembered. A hash nobody recomputes is a comment.
Every hash in the table was correct when this was written; the point is that
it stays correct the day somebody re-vendors a codec in a hurry.

Deliberately checked both ways. A table listing a file that no longer exists
is as broken as a wrong hash, and a vendored file absent from the table is
the case that actually matters - it means something is being redistributed
with no recorded licence at all.
"""

from __future__ import annotations

import hashlib
import re
import unittest
from pathlib import Path

VENDOR = Path(__file__).resolve().parent.parent / "web" / "vendor"
LICENCES = VENDOR / "LICENSES.md"

# Files in web/vendor/ that are ours rather than vendored, and so are not
# expected to appear in the pin table.
NOT_VENDORED = {"LICENSES.md"}


def _table() -> dict:
    """{filename: sha256} as the licence file records it."""
    rows = re.findall(r"^\|\s*`([0-9a-f]{64})`\s*\|\s*`([^`]+)`\s*\|\s*$",
                      LICENCES.read_text(encoding="utf-8"), re.M)
    return {name: digest for digest, name in rows}


class TheVendoredFilePins(unittest.TestCase):
    def test_the_table_is_not_empty(self):
        """A regex that can match nothing and pass is one of the four checks
        CONTRIBUTING.md lists as having been green while checking nothing."""
        self.assertGreaterEqual(len(_table()), 8,
                                "the pin table did not parse - has its "
                                "format changed?")

    def test_every_pinned_file_still_hashes_to_its_recorded_value(self):
        for name, expected in sorted(_table().items()):
            with self.subTest(file=name):
                path = VENDOR / name
                self.assertTrue(path.is_file(),
                                f"{name} is pinned but is not in web/vendor/")
                actual = hashlib.sha256(path.read_bytes()).hexdigest()
                self.assertEqual(
                    actual, expected,
                    f"{name} does not match its recorded hash. Either the "
                    "file was re-vendored without updating LICENSES.md, or "
                    "it was modified in place - both are things this table "
                    "exists to make visible.")

    def test_nothing_is_redistributed_without_a_recorded_licence(self):
        """The direction that matters most: a file shipped from web/vendor/
        with no row in the table is a third-party binary going out with no
        recorded licence and no way to identify its build."""
        pinned = set(_table())
        present = {p.name for p in VENDOR.iterdir()
                   if p.is_file() and p.name not in NOT_VENDORED}
        self.assertEqual(
            sorted(present - pinned), [],
            "these files are vendored but carry no hash or licence row")


if __name__ == "__main__":
    unittest.main()
