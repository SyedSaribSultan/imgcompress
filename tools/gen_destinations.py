"""Write the browser's destination table from the Python one.

`pocketsize/destinations.py` is the reference. The browser needs the same
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
import importlib.util
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


def _load_destinations():
    """Load `pocketsize/destinations.py` on its own, not through the package.

    `from pocketsize import destinations` runs the package's `__init__`, which
    imports the engine, which imports Pillow and numpy. That turns "is this
    committed file current?" - a question answered entirely by two files on disk
    - into something that needs the whole dependency tree installed. CI found
    it: the check job installs nothing, so it failed in eight seconds on an
    ImportError rather than on anything about the file.

    `destinations.py` was written to import nothing from the rest of the
    package precisely so it could be read like this. Loading it directly keeps
    this tool dependency-free, which is the right shape for a check that runs on
    every pull request and should never be able to go red because a release of
    Pillow broke.
    """
    path = ROOT / "pocketsize" / "destinations.py"
    spec = importlib.util.spec_from_file_location("pocketsize_destinations", path)
    module = importlib.util.module_from_spec(spec)
    # Registered before it is executed, because @dataclass resolves a field's
    # type by looking its own module up in sys.modules. Skip this and the
    # decorator dies on a None it never expected to see.
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


dest = _load_destinations()

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
 * Written by tools/gen_destinations.py from pocketsize/destinations.py, which
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


# `Path.read_text`/`write_text` only learned `newline=` in 3.13 and 3.10, and
# this package supports 3.9. `Path.open` has always taken it. CI found this:
# every job except ubuntu/3.13 failed on a TypeError, which is the version
# matrix earning its keep.
def _read_exact(path) -> str:
    """File contents with no line-ending translation."""
    with path.open("r", encoding="utf-8", newline="") as fh:
        return fh.read()


def _write_exact(path, text: str) -> None:
    """Write with no line-ending translation, so LF stays LF on Windows."""
    with path.open("w", encoding="utf-8", newline="") as fh:
        fh.write(text)


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

    # Video travels as its own map rather than more keys on `numbers`, because
    # a destination that takes no video has no video numbers at all and an
    # entry of zeroes would read as "no limit" to anything that forgot to
    # check. Absent means absent.
    video_formats = {
        name: list(d.video_formats)
        for name, d in dest.DESTINATIONS.items()
        if d.video_formats
    }
    video_numbers = {
        d.name: {
            "maxDimension": d.video_max_dimension,
            "qualityTarget": d.video_target,
            "sizeCapMb": d.size_cap_mb,
            "audio": d.audio,
        }
        for d in dest.visible()
        if d.video_formats
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
        "/* Which video formats each destination may write, as codec+container",
        " * pairs. A destination missing from this map takes no video. */",
        f"const DESTINATION_VIDEO_FORMATS = {_js(video_formats)};",
        "",
        "/* Video's own frame size, visual match, byte ceiling and sound rule. */",
        f"const DESTINATION_VIDEO_NUMBERS = {_js(video_numbers)};",
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
    raw = _read_exact(OUTPUT) if OUTPUT.is_file() else None
    existing = raw.replace("\r\n", "\n") if raw is not None else None

    if args.check:
        if existing is None:
            print(f"FAIL: {OUTPUT.relative_to(ROOT)} does not exist. "
                  "Run: python tools/gen_destinations.py", file=sys.stderr)
            return 1
        if existing != fresh:
            print(f"FAIL: {OUTPUT.relative_to(ROOT)} is out of date with "
                  "pocketsize/destinations.py.\n"
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
    _write_exact(OUTPUT, fresh)
    print(f"wrote {OUTPUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
