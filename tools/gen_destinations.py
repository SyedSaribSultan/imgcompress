"""Write the browser's destination table from the Python one.

`imgcompress/destinations.py` is the reference. The browser needs the same
table, and for one commit it had two hand-written copies of it - which drifted
within the hour, in the same branch, immediately after the hazard had been
written down. A test that compares copies catches that afterwards. Not having
copies prevents it.

`web/` has no build step and should not grow one, so the generated file is
committed like any other source file. CI regenerates it and fails on any
difference, which makes the commit the check:

    python tools/gen_destinations.py            # rewrite web/destinations.js
    python tools/gen_destinations.py --check    # exit 1 if it is out of date

Two things the browser has that Python does not, declared here rather than
hand-patched into the output:

* `png8x` - a palette PNG the browser keeps only where it comes out
  pixel-exact. There is no Python equivalent, so it cannot live in the
  reference table.
* `lossless` as an *old name*. The browser used to offer a pixel-exact
  destination and no longer does, so a setting saved by an older visit has to
  land somewhere real. `original` is the nearest thing on offer. It is not an
  exact substitute - `original` permits lossy encodes that clear a visual match
  of 95 - which is why it is written down here instead of being quietly
  assumed.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from imgcompress import destinations as dest  # noqa: E402

OUTPUT = ROOT / "web" / "destinations.js"

# Formats the browser can write that the Python reference cannot. Keyed by
# destination; appended in order after the reference's own list.
BROWSER_ONLY_FORMATS = {
    # Palette PNG, kept only where it is pixel-identical to the source.
    "lossless": ["png8x"],
}

# Old names the browser must resolve that Python does not carry, because the
# browser dropped a destination Python kept. See the module docstring.
BROWSER_ONLY_ALIASES = {
    "lossless": "original",
}

BANNER = """/* GENERATED FILE - DO NOT EDIT.
 *
 * Written by tools/gen_destinations.py from imgcompress/destinations.py, which
 * is the reference for every value here. Edit that file and re-run the
 * generator; CI regenerates this one and fails if it differs from what is
 * committed.
 *
 * Loaded by both engines: worker.js pulls it in with importScripts, and
 * index.html loads it before app.js. Both share one global scope per context,
 * so these bindings are visible to whichever file needs them.
 */

"use strict";
"""


def _js(value) -> str:
    """JSON is a subset of JS object-literal syntax for the shapes used here."""
    return json.dumps(value, indent=2, ensure_ascii=True)


def render() -> str:
    formats = {}
    for name, d in dest.DESTINATIONS.items():
        formats[name] = list(d.formats) + BROWSER_ONLY_FORMATS.get(name, [])

    numbers = {
        d.name: {
            "label": d.label,
            "maxDimension": d.max_dimension,
            "qualityTarget": d.ss2_target,
            "help": d.help,
        }
        for d in dest.visible()
    }

    aliases = dict(dest.ALIASES)
    aliases.update(BROWSER_ONLY_ALIASES)

    parts = [
        BANNER,
        f"const DEFAULT_DESTINATION = {json.dumps(dest.DEFAULT)};",
        "",
        "/* The order the control offers them in. */",
        f"const DESTINATION_ORDER = {_js(dest.names())};",
        "",
        "/* Which formats each destination may write. Includes the hidden ones. */",
        f"const DESTINATION_FORMATS = {_js(formats)};",
        "",
        "/* Frame size and minimum visual match. Offered destinations only. */",
        f"const DESTINATION_NUMBERS = {_js(numbers)};",
        "",
        "/* Pre-2.7 names, so a saved setting still lands somewhere real. */",
        f"const OLD_TARGET_NAMES = {_js(aliases)};",
        "",
        "/* A ceiling, not a setting: it clamps even an explicit larger request,",
        " * because design tools rescale above it destructively on import. */",
        f"const DOCUMENTS_MAX_DIMENSION = {dest.get('documents').hard_cap};",
        "",
        "/* Resolve a possibly-old, possibly-unknown name to a real destination. */",
        "function destinationOf(name) {",
        "  const resolved = OLD_TARGET_NAMES[name] || name;",
        "  return DESTINATION_FORMATS[resolved] ? resolved : DEFAULT_DESTINATION;",
        "}",
        "",
    ]
    return "\n".join(parts)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true",
                        help="do not write; exit 1 if the committed file is stale")
    args = parser.parse_args(argv)

    fresh = render()
    # newline="" on both sides so Python does not translate anything, then
    # compare with line endings normalised.
    #
    # This repo is developed with core.autocrlf=true, so a fresh Windows clone
    # gets CRLF on disk while the generator emits LF. Comparing raw bytes
    # reported "out of date" on a file that was perfectly current, and the diff
    # it printed looked empty - every line differing by an invisible character.
    # .gitattributes pins this file to LF as well; this is the half that keeps
    # the tool honest if that is ever lost.
    raw = OUTPUT.read_text(encoding="utf-8", newline="") if OUTPUT.is_file() else None
    existing = raw.replace("\r\n", "\n") if raw is not None else None

    if args.check:
        if existing is None:
            print(f"FAIL: {OUTPUT.relative_to(ROOT)} does not exist. "
                  "Run: python tools/gen_destinations.py", file=sys.stderr)
            return 1
        if existing != fresh:
            print(f"FAIL: {OUTPUT.relative_to(ROOT)} is out of date with "
                  "imgcompress/destinations.py.\n"
                  "Run `python tools/gen_destinations.py` and commit the result.",
                  file=sys.stderr)
            import difflib
            sys.stderr.writelines(difflib.unified_diff(
                existing.splitlines(keepends=True), fresh.splitlines(keepends=True),
                fromfile="committed", tofile="generated"))
            return 1
        print(f"{OUTPUT.relative_to(ROOT)} is up to date")
        return 0

    if existing == fresh:
        print(f"{OUTPUT.relative_to(ROOT)} already current")
        return 0
    OUTPUT.write_text(fresh, encoding="utf-8", newline="")
    print(f"wrote {OUTPUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
