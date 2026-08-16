"""Copy the design system into the desktop app, so there is only one of it.

`web/` holds the token layer and the self-hosted faces. The desktop app used to
carry its own palette, its own radii, its own two transition shorthands and its
own system-font stack - a second visual identity for the same product, and the
half of it that no gate could see.

The desktop app is served by `pocketsize/server.py` out of `pocketsize/webui/`
and has to work from a pip install with no network, so it needs its own copy of
the files on disk. That copy is produced here and committed, exactly like
`web/destinations.js`: no build step at runtime, and CI re-runs this with
`--check` so a stale copy fails the build rather than quietly diverging.

    python tools/sync_webui_assets.py            # refresh the copies
    python tools/sync_webui_assets.py --check    # exit 1 if any are stale

One transformation is applied on the way across. `web/fonts.css` points at
`/fonts/...`, which is right when the stylesheet is served from the site root
and wrong when it is served from `/webui/`. The copy gets relative `fonts/...`
URLs, which resolve correctly against the stylesheet's own location in both
places. The source file is left alone so the deployed site cannot be affected
by a change made for the desktop app.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
WEBUI = ROOT / "pocketsize" / "webui"

BANNER = (
    "/* COPIED from web/{name} by tools/sync_webui_assets.py - DO NOT EDIT.\n"
    " * Edit the file in web/ and re-run the tool; CI fails on a stale copy. */\n"
)

# Text files, banner-stamped so nobody edits the copy by mistake.
#
# `css/media-accent.css` is here rather than being retyped into the desktop
# app's own <style> block for the reason that block is forbidden from naming a
# colour at all: two copies of a value drift, and this one has to mean the same
# thing in both interfaces or a video is purple in one product and not the
# other. It is the only file from `css/` the desktop app needs, because it is
# the only one that names a colour the token layer does not carry.
STYLESHEETS = ["heyoz-tokens.css", "fonts.css", "css/media-accent.css"]

# The faces themselves. Binary, copied verbatim.
FONT_DIR = WEB / "fonts"

# The product's icon. Without one linked, the browser asks for /favicon.ico,
# which is not a static route and so answered 403 - one console error on every
# launch, for years, saying nothing useful.
ICONS = ["favicon.svg"]


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


def stylesheet(name: str) -> str:
    text = _read_exact(WEB / name)
    if name == "fonts.css":
        # Root-absolute -> relative, so it resolves under /webui/ too.
        text = text.replace("url('/fonts/", "url('fonts/")
    return BANNER.format(name=name) + text


def planned() -> list:
    """[(destination, expected bytes)] for everything this tool owns.

    Sources may sit in a subfolder of `web/` but the copies are always flat in
    `webui/`, because the desktop app serves that directory as one place and
    its links are written accordingly.
    """
    out = [(WEBUI / Path(name).name, stylesheet(name).encode("utf-8"))
           for name in STYLESHEETS]
    for face in sorted(FONT_DIR.glob("*.woff2")):
        out.append((WEBUI / "fonts" / face.name, face.read_bytes()))
    for icon in ICONS:
        out.append((WEBUI / icon, (WEB / icon).read_bytes()))
    return out


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true",
                        help="do not write; exit 1 if any copy is stale or missing")
    args = parser.parse_args(argv)

    stale = []
    for destination, expected in planned():
        current = destination.read_bytes() if destination.is_file() else None
        # Normalise line endings on text so a CRLF checkout is not mistaken for
        # a stale copy - the same trap web/destinations.js fell into.
        if destination.suffix == ".css" and current is not None:
            current = current.replace(b"\r\n", b"\n")
        if current == expected:
            continue
        stale.append(destination)
        if not args.check:
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(expected)

    rel = lambda p: p.relative_to(ROOT).as_posix()  # noqa: E731
    if args.check:
        if stale:
            print("FAIL: the desktop app's copy of the design system is out of date:",
                  file=sys.stderr)
            for d in stale:
                print(f"  {rel(d)}", file=sys.stderr)
            print("Run `python tools/sync_webui_assets.py` and commit the result.",
                  file=sys.stderr)
            return 1
        print(f"desktop design system is current ({len(planned())} files)")
        return 0

    if stale:
        for d in stale:
            print(f"wrote {rel(d)}")
    else:
        print(f"already current ({len(planned())} files)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
