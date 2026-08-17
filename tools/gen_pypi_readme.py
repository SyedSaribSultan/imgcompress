"""Produce the README PyPI shows, from the README GitHub shows.

`README.md` is written for someone reading the repository, so it points at
`docs/screenshot-dark.webp` and `CONTRIBUTING.md` the short way. GitHub resolves
those against the repo; PyPI has no repo to resolve them against, so on the
project page the three screenshots render as broken images and every document
link 404s. The fix is not to spoil the README for its main audience - it is to
hand PyPI its own copy with the links made absolute.

    python tools/gen_pypi_readme.py            # refresh README.pypi.md
    python tools/gen_pypi_readme.py --check    # exit 1 if it is stale

Committed and diffed like `web/destinations.js`, for the same reason: a build
step nobody runs is a build step that rots. `pyproject.toml` points `readme` at
the generated file, so a plain `python -m build` cannot forget this.

Only repo-relative targets are rewritten. Anything already absolute - the CI
badge, the shields.io badge, the vercel link - is left exactly as it is.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "README.md"
TARGET = ROOT / "README.pypi.md"

# The tag the links should point at. A released README pointing at `main` would
# describe whatever main becomes later; pinning it to the tag keeps the page
# honest about the version it shipped with.
REF = "v2.7.0"
RAW = f"https://raw.githubusercontent.com/SyedSaribSultan/pocketsize/{REF}/"
BLOB = f"https://github.com/SyedSaribSultan/pocketsize/blob/{REF}/"

BANNER = (
    "<!-- GENERATED from README.md by tools/gen_pypi_readme.py - DO NOT EDIT.\n"
    "     Edit README.md and re-run the tool. -->\n"
)

# An image needs the raw host to display; a document link wants the rendered
# blob view. Same path, different base, so they are matched separately.
IMAGE = re.compile(r"!\[([^\]]*)\]\((?!https?://|#)([^)]+)\)")
LINK = re.compile(r"(?<!!)\[([^\]]+)\]\((?!https?://|#|mailto:)([^)]+)\)")


def render(text: str) -> str:
    text = IMAGE.sub(lambda m: f"![{m.group(1)}]({RAW}{m.group(2)})", text)
    text = LINK.sub(lambda m: f"[{m.group(1)}]({BLOB}{m.group(2)})", text)
    return BANNER + text


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--check", action="store_true",
                    help="exit 1 if the generated file is stale")
    args = ap.parse_args(argv)

    want = render(SOURCE.read_text(encoding="utf-8"))

    if args.check:
        have = TARGET.read_text(encoding="utf-8") if TARGET.exists() else ""
        if have != want:
            print(f"stale: {TARGET.name} - run `python tools/gen_pypi_readme.py`"
                  " and commit", file=sys.stderr)
            return 1
        print(f"{TARGET.name} is up to date")
        return 0

    TARGET.write_text(want, encoding="utf-8", newline="\n")
    print(f"wrote {TARGET.relative_to(ROOT).as_posix()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
