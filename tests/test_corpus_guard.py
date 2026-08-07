"""Tests for the thing that checks the checker.

`tests/web/check_ss2_corpus.py` exists because `ss2_validate.mjs` prints
VALIDATED just as happily over 48 vectors as over 60, so a failed AVIF plugin
install would have shown a green tick with AVIF parity untested forever.

That guard was itself only ever verified by hand - which is precisely the
posture `ss2_validate.mjs` was in before it was wired into CI, and the reason
this whole thread exists. So it gets tests, and they include watching it fail:
a guard nobody has seen go red is a guess about whether it measures anything.

It also had a real bug found by hand and fixed: argparse's `action="append"`
adds to a list default rather than replacing it, so `--require-codec jpeg`
meant "jpeg *and* the three defaults" and the exclusion path had never run.
That case is pinned below.
"""

from __future__ import annotations

import contextlib
import io
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tests" / "web"))

import check_ss2_corpus  # noqa: E402


def _vectors(n_jpeg=2, n_webp=1, n_avif=1):
    out = []
    for kind, count in (("jpeg", n_jpeg), ("webp", n_webp), ("avif", n_avif)):
        for i in range(count):
            out.append({"ref": "src", "dist": f"src-{kind}{i}", "w": 8, "h": 8,
                        "score": 90.0})
    return out


class CorpusGuard(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(self.enterContext(__import__("tempfile").TemporaryDirectory()))
        self.vectors_path = self.tmp / "vectors.json"
        # The module resolves the path at import time; point it at a temp file.
        self._real = check_ss2_corpus.VECTORS
        check_ss2_corpus.VECTORS = self.vectors_path

    def tearDown(self):
        check_ss2_corpus.VECTORS = self._real

    def write(self, vectors):
        self.vectors_path.write_text(json.dumps(vectors), encoding="utf-8")

    def run_guard(self, *args):
        """Returns (exit_code, stdout+stderr)."""
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = check_ss2_corpus.main(list(args))
        return code, out.getvalue() + err.getvalue()

    # -- it passes when it should ------------------------------------------ #

    def test_a_complete_corpus_passes(self):
        self.write(_vectors())
        code, said = self.run_guard("--expect", "4")
        self.assertEqual(code, 0, said)
        self.assertIn("complete", said)

    # -- and fails when it should ------------------------------------------ #

    def test_a_short_corpus_fails(self):
        """The failure the guard was written for: AVIF silently absent."""
        self.write(_vectors(n_avif=0))
        code, said = self.run_guard("--expect", "4")
        self.assertEqual(code, 1)
        self.assertIn("expected 4", said)
        self.assertIn("avif", said)

    def test_the_right_count_with_a_missing_codec_still_fails(self):
        """Count alone is not enough - a corpus can be the right size and still
        have lost a whole codec."""
        self.write(_vectors(n_jpeg=3, n_avif=0))
        code, said = self.run_guard("--expect", "4")
        self.assertEqual(code, 1)
        self.assertIn("avif", said)
        self.assertNotIn("expected 4", said)

    def test_a_long_corpus_fails_too(self):
        """Not just a minimum. An unexpected extra means the corpus changed and
        nobody updated the number."""
        self.write(_vectors(n_jpeg=5))
        code, _ = self.run_guard("--expect", "4")
        self.assertEqual(code, 1)

    def test_missing_vectors_file_fails_rather_than_passing_vacuously(self):
        code, said = self.run_guard("--expect", "4")
        self.assertEqual(code, 2)
        self.assertIn("run make_ss2_vectors", said)

    # -- the argparse bug --------------------------------------------------- #

    def test_require_codec_replaces_the_defaults_it_does_not_extend_them(self):
        """`action="append"` appends to a list default. With `default=[...]`,
        `--require-codec jpeg` silently meant "jpeg and avif and webp too", so
        the narrowing path never actually narrowed."""
        self.write(_vectors(n_avif=0))
        code, said = self.run_guard("--expect", "3", "--require-codec", "jpeg",
                                    "--require-codec", "webp")
        self.assertEqual(code, 0, f"avif was still required despite being excluded: {said}")

    def test_the_default_requirement_is_all_three(self):
        self.write(_vectors(n_webp=0, n_avif=0))
        code, said = self.run_guard("--expect", "2")
        self.assertEqual(code, 1)
        self.assertIn("webp", said)
        self.assertIn("avif", said)


class TheRealCorpusScriptIsWiredUp(unittest.TestCase):
    def test_ci_runs_it_with_an_explicit_count(self):
        """A guard nothing calls is decoration."""
        ci = (ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
        self.assertIn("check_ss2_corpus.py", ci)
        self.assertIn("--expect", ci)

    def test_ci_does_not_tolerate_a_failed_avif_install(self):
        """`continue-on-error` on that step is what made the whole corpus
        optional in the first place."""
        ci = (ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
        block = ci.split("pillow-avif-plugin")[0].rsplit("- name:", 1)[-1]
        self.assertNotIn("continue-on-error", block)


if __name__ == "__main__":
    unittest.main()
