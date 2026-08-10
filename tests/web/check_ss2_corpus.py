"""Assert the validation corpus is the full one, not a quietly shortened one.

`make_ss2_vectors.py` skips the AVIF pairs where Pillow cannot write AVIF,
which is right on a developer's Windows laptop and wrong in CI. Without this,
a failed `pip install pillow-avif-plugin` would produce 48 vectors instead of
60, `ss2_validate.mjs` would print VALIDATED, and the job would go green with
AVIF parity untested from then on - indefinitely, and invisibly.

Reporting the shortfall is not enough. A warning in a passing job's log is a
warning nobody reads. The count has to be able to fail the build.

    python tests/web/check_ss2_corpus.py --expect 60
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

VECTORS = Path(__file__).resolve().parent / "ss2_vectors" / "vectors.json"


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--expect", type=int, required=True,
                        help="how many (original, distorted) pairs there must be")
    # `action="append"` adds to a list default rather than replacing it, so the
    # default has to be applied after parsing or `--require-codec jpeg` would
    # mean "jpeg AND the three defaults".
    parser.add_argument("--require-codec", action="append", default=None,
                        help="a codec that must appear among the distortions; "
                             "repeat to require several (default: jpeg webp avif)")
    args = parser.parse_args(argv)
    required = args.require_codec or ["jpeg", "webp", "avif"]

    if not VECTORS.is_file():
        print(f"no vectors at {VECTORS} - run make_ss2_vectors.py first",
              file=sys.stderr)
        return 2

    vectors = json.loads(VECTORS.read_text(encoding="utf-8"))
    kinds = Counter(v["dist"].rsplit("-", 1)[-1].rstrip("0123456789") for v in vectors)

    print(f"{len(vectors)} vectors; distortions: "
          + ", ".join(f"{k}x{n}" for k, n in sorted(kinds.items())))

    problems = []
    if len(vectors) != args.expect:
        problems.append(
            f"expected {args.expect} vectors, found {len(vectors)}. "
            "A short corpus still validates - that is the danger. If the "
            "corpus legitimately changed, change --expect in ci.yml in the "
            "same commit.")
    for codec in required:
        if not kinds.get(codec):
            problems.append(
                f"no {codec} pairs in the corpus - the encoder is missing, so "
                f"{codec} parity is not being tested at all.")

    for line in problems:
        print(f"FAIL: {line}", file=sys.stderr)
    if problems:
        return 1
    print("corpus is complete")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
