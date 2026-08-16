"""The installers must not carry GPL-licensed engines.

Two of this project's dependencies ship compiled GPL code inside an
otherwise-permissive wheel:

* `av` (PyAV) carries a complete FFmpeg including x264 and x265.
* `imagequant` carries libimagequant, which upstream dual-licenses as GPL
  v3-or-later for open-source use or a paid commercial licence. Only the
  Wanadev binding's BSD text is in the wheel, which is what made it look
  permissive for a long time.

Depending on either through pip is untouched and is the default: the user's
own package manager fetches the wheel, this project distributes nothing, and
`pip install "pocketsize[full,video]"` gets both engines. Putting either
*inside* a downloadable installer makes us the distributor, and GPL's terms
would then attach to this whole MIT-licensed bundle.

So the exclusion is enforced in three independent places, and this file
covers the two that can be checked without building an installer:
the PyInstaller spec, and `--check`'s ability to report the absence at all.
The third is the release gate itself, which reads that report.
"""

from __future__ import annotations

import re
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SPEC = ROOT / "packaging" / "pocketsize.spec"
RELEASE = ROOT / ".github" / "workflows" / "release.yml"

# The engines whose compiled payload is GPL, and so must never be collected
# into a shipped binary.
GPL_ENGINES = ("av", "imagequant")


class TheInstallerExcludesGplEngines(unittest.TestCase):
    def test_the_spec_excludes_every_gpl_engine(self):
        """PyInstaller collects what it can reach, so the exclusion has to be
        stated. Read out of the `excludes` list specifically - the names
        appear elsewhere in the file in prose, and matching those would pass
        while the build still bundled them."""
        text = SPEC.read_text(encoding="utf-8")
        block = re.search(r"excludes\s*=\s*\[(.*?)\n\]", text, re.S)
        self.assertIsNotNone(block, "could not find the excludes list")
        excluded = set(re.findall(r'"([^"]+)"', block.group(1)))
        for engine in GPL_ENGINES:
            with self.subTest(engine=engine):
                self.assertIn(
                    engine, excluded,
                    f"{engine} ships GPL code and must be excluded from the "
                    "installers; it stays available through pip.")

    def test_no_gpl_engine_is_a_hidden_import(self):
        """A hidden import is an instruction to collect. Naming one of these
        there would undo the exclusion in the most confusing possible way."""
        text = SPEC.read_text(encoding="utf-8")
        block = re.search(r"hiddenimports\s*=\s*\[(.*?)\n\]", text, re.S)
        self.assertIsNotNone(block, "could not find the hiddenimports list")
        named = set(re.findall(r'"([^"]+)"', block.group(1)))
        for engine in GPL_ENGINES:
            with self.subTest(engine=engine):
                self.assertNotIn(engine, named)

    def test_check_names_the_video_engine_even_when_it_is_absent(self):
        """The release gate proves the GPL engines are absent by reading
        `--check`. A row that says only "not installed" omits the name, which
        leaves the gate unable to tell "correctly absent" from "no longer
        reported at all" - and an unreported engine cannot be gated. This
        exact wording was what a dry run of the gate refused a healthy build
        over, so it is pinned rather than left to style."""
        proc = subprocess.run(
            [sys.executable, "-m", "pocketsize.cli", "--check"],
            capture_output=True, text=True, cwd=ROOT,
            # An interpreter that cannot import `av` is the case being
            # described; the other branch is exercised on a dev machine.
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        rows = re.findall(r"^\s*\[( |x)\]\s+(.+?)\s*$", proc.stdout, re.M)
        labels = [label.lower() for _mark, label in rows]
        self.assertTrue(
            any("pyav" in label for label in labels),
            f"--check never names pyav, so its absence cannot be gated: {labels}")
        self.assertTrue(
            any("imagequant" in label for label in labels),
            f"--check never names imagequant: {labels}")

    def test_the_release_gate_still_refuses_a_gpl_bundle(self):
        """The gate lives in YAML and runs only on a tag, so nothing else
        would notice it being weakened. Checked as text: the workflow must
        still name both engines and still exit on finding one."""
        text = RELEASE.read_text(encoding="utf-8")
        self.assertIn("gpl_free", text,
                      "the release gate no longer checks for GPL engines")
        for engine in ("pyav", "imagequant"):
            with self.subTest(engine=engine):
                self.assertIn(f'"{engine}"', text)
        self.assertIn("bundled_gpl", text)


if __name__ == "__main__":
    unittest.main()
