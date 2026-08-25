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

import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SPEC = ROOT / "packaging" / "pocketsize.spec"
RELEASE = ROOT / ".github" / "workflows" / "release.yml"

# The engines whose compiled payload is GPL, and so must never be collected
# into a shipped binary.
GPL_ENGINES = ("av", "imagequant")


def _spec_lists(env: dict) -> tuple:
    """Execute the spec's exclude/hiddenimport logic under a given environment
    and return what it actually decided.

    Read as text, this file's own comments were enough to fool a regex: the
    prose mentions `"av"` and `"imagequant"` while explaining why they are
    excluded, and a `"([^"]+)"` scan over the block cannot tell a package name
    from a quoted word in a sentence. The earlier version of this test broke
    that way, which was luck - the same version could not see a conditional
    at all, so a spec that removed both engines from `excludes` at build time
    would have passed it unchanged.

    So the logic is executed rather than parsed. The spec is a Python file, but
    it cannot simply be imported: PyInstaller injects `Analysis`, `EXE`,
    `COLLECT` and friends as globals, and it reads the installed distribution.
    Only the part above `a = Analysis(` is needed to know what the lists hold,
    and that part is plain Python, so it is executed on its own.
    """
    text = SPEC.read_text(encoding="utf-8")
    head = text[:text.index("a = Analysis(")]
    saved = dict(os.environ)
    os.environ.update(env)
    with tempfile.TemporaryDirectory() as tmp:
        # `workpath` and `SPECPATH` are injected by PyInstaller, not defined in
        # the file. The spec writes its entry-point shims under `workpath`, so
        # it gets a throwaway directory - the point here is the two lists, and
        # a test should not leave build scratch in the tree.
        namespace: dict = {
            "__name__": "spec",
            "SPECPATH": str(SPEC.parent),
            "workpath": tmp,
            "DISTPATH": str(Path(tmp) / "dist"),
        }
        try:
            exec(compile(head, str(SPEC), "exec"), namespace)
        finally:
            os.environ.clear()
            os.environ.update(saved)
    return set(namespace["excludes"]), set(namespace["hiddenimports"])


class TheInstallerExcludesGplEngines(unittest.TestCase):
    def test_the_spec_excludes_every_gpl_engine(self):
        """PyInstaller collects what it can reach, so the exclusion has to be
        stated - and it has to survive whatever the spec does after stating
        it. This runs the spec with a distributable environment and reads the
        list it ended up with."""
        excluded, _ = _spec_lists({})
        for engine in GPL_ENGINES:
            with self.subTest(engine=engine):
                self.assertIn(
                    engine, excluded,
                    f"{engine} ships GPL code and must be excluded from the "
                    "installers; it stays available through pip.")

    def test_no_gpl_engine_is_a_hidden_import(self):
        """A hidden import is an instruction to collect. Naming one of these
        there would undo the exclusion in the most confusing possible way."""
        _, named = _spec_lists({})
        for engine in GPL_ENGINES:
            with self.subTest(engine=engine):
                self.assertNotIn(engine, named)

    def test_a_private_build_is_the_only_thing_that_admits_them(self):
        """`POCKETSIZE_PRIVATE_BUILD` exists so somebody can build a bundle
        for their own machine with video and the better quantizer in it.
        Running GPL code you installed yourself is what the licence is for;
        the exclusion is about *distribution*.

        That switch is also the one way this project's own build can produce a
        bundle it must not publish, so it is pinned from both sides: the flag
        admits both engines, and its absence - the default, and what every
        release build uses - still excludes them. If this ever passes with the
        environment empty, the default has silently become undistributable."""
        excluded, named = _spec_lists({"POCKETSIZE_PRIVATE_BUILD": "1"})
        for engine in GPL_ENGINES:
            with self.subTest(engine=engine):
                self.assertNotIn(engine, excluded)
                self.assertIn(engine, named)

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
