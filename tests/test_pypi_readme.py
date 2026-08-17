"""The README PyPI shows must be current, and must not point at the repo.

`README.pypi.md` is GENERATED from `README.md` by `tools/gen_pypi_readme.py`.
It exists because PyPI renders the long description with no repository behind
it: a relative `docs/screenshot-dark.webp` is a broken image on the project
page, and a relative `CONTRIBUTING.md` is a 404. The generated copy makes those
absolute and leaves the already-absolute badges alone.

Two things are worth a gate. That the copy is not stale - a generated file
nobody regenerates is worse than no generated file, because it is confidently
wrong. And that no relative link survived the rewrite, which is the actual
defect being prevented rather than a proxy for it.
"""

from __future__ import annotations

import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from tools import gen_pypi_readme as gen  # noqa: E402


class TheGeneratedReadmeIsCurrent(unittest.TestCase):
    def test_nothing_is_stale(self):
        self.assertEqual(
            gen.main(["--check"]), 0,
            "README.pypi.md is stale. Run `python tools/gen_pypi_readme.py` "
            "and commit the result.")

    def test_it_exists(self):
        self.assertTrue(gen.TARGET.is_file(), "README.pypi.md is missing")


class ThePackagePointsAtIt(unittest.TestCase):
    def test_pyproject_ships_the_generated_copy(self):
        """Read with a regex, not tomllib: this suite runs on 3.9 in CI and
        tomllib is 3.11+, so importing it here would crash the oldest leg on a
        machine where nothing is actually wrong. One key does not justify a
        dependency or a version floor."""
        text = (ROOT / "pyproject.toml").read_text(encoding="utf-8")
        found = re.search(r'(?m)^\s*readme\s*=\s*"([^"]+)"', text)
        self.assertIsNotNone(found, "pyproject.toml declares no readme")
        self.assertEqual(
            found.group(1), "README.pypi.md",
            "pyproject.toml must ship the generated README, or PyPI gets the "
            "repo-relative one and the screenshots break on the project page.")


class NothingRelativeSurvives(unittest.TestCase):
    """The defect itself: a link PyPI cannot resolve."""

    # Same shapes the generator matches, minus the absolute-URL escape hatches.
    IMAGE = re.compile(r"!\[[^\]]*\]\((?!https?://)([^)]+)\)")
    LINK = re.compile(r"(?<!!)\[[^\]]+\]\((?!https?://|#|mailto:)([^)]+)\)")

    def setUp(self):
        self.text = gen.TARGET.read_text(encoding="utf-8")

    def test_every_image_is_absolute(self):
        bad = self.IMAGE.findall(self.text)
        self.assertEqual(bad, [], f"relative image(s) PyPI cannot show: {bad}")

    def test_every_link_is_absolute(self):
        bad = self.LINK.findall(self.text)
        self.assertEqual(bad, [], f"relative link(s) that would 404: {bad}")

    def test_the_screenshots_are_actually_in_there(self):
        """Guards against a rewrite that 'passes' by dropping the images."""
        self.assertGreaterEqual(
            self.text.count("raw.githubusercontent.com"), 3,
            "the screenshots should be present and served from the raw host")


if __name__ == "__main__":
    unittest.main()
