"""Change the app's typeface in one command.

    python tools/gen_fonts.py --display "Instrument Serif"
    python tools/gen_fonts.py --display "Space Grotesk" --mono "JetBrains Mono"
    python tools/gen_fonts.py --check

The app names exactly two families - one for everything the interface says, one
for its figures - and every sheet consumes those through `--font-ui` and
`--font-num` in web/css/base.css. So changing the face is a one-line CSS edit,
and this script is everything ELSE that one line implies:

    * fetch the family from Google Fonts and subset it (latin, latin-ext)
    * write the @font-face blocks in web/fonts.css
    * repoint the <link rel=preload> in web/index.html
    * repoint the precache list in web/sw.js and bump its VERSION
    * set --font-ui / --font-num in web/css/base.css
    * delete the woff2 files nothing references any more

That last one is not tidiness. Two faces have shipped in this app while
painting no glyphs at all - Bricolage Grotesque for months, then Geist the
moment Fraunces replaced it - each preloaded at the top of the critical path.
A generator that adds a face without removing the one it displaced would make
that the default outcome rather than an accident.

Why self-hosted at all: the CSP is `default-src 'none'` and the product's
headline promise is that nothing leaves your device. A <link> to
fonts.googleapis.com is a third-party request on every visit, so the files are
served from this origin instead.

Why the weights stop at 600: nothing in this interface renders heavier, and
tests/web/verify_fonts.mjs enforces that on the rendered page. Shipping the
bold masters would be bytes that can never be drawn.

VARIABLE AXES. Google's CSS API serves a build carrying only the axes its URL
asks for, and for some families that is fewer than the font has. Fraunces is
the example: the API exposes opsz and wght, while SOFT and WONK - the two axes
that give it its character - exist only in the upstream release. Pass
`--axes` to pin or range them and the script fetches from the upstream GitHub
release instead, instancing the axes down before subsetting:

    --axes "wght=400:600,opsz=36,SOFT=0,WONK=1"

A range keeps the axis variable; a single value pins it and drops the machinery
for it, which is usually a large saving - pinning Fraunces' opsz halved the
file. tests/test_design_system.py gates `--check`.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
FONT_DIR = WEB / "fonts"
CONFIG = ROOT / "tools" / "fonts.json"

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")

# The two subsets this app ships, with the exact unicode-range Google publishes
# for each. Keeping their ranges verbatim is what lets a glyph outside them fall
# through to the next family in the stack instead of rendering a tofu box.
SUBSETS = {
    "latin": (
        "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA,\n"
        "    U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193,\n"
        "    U+2212, U+2215, U+FEFF, U+FFFD"
    ),
    "latin-ext": (
        "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF,\n"
        "    U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020,\n"
        "    U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF"
    ),
}

WEIGHT_RANGE = "400 600"

# The fallback each stack degrades to while the face loads, or if it never
# arrives. Chosen by ROLE rather than by family: a serif that falls back to a
# sans changes the page's voice mid-load, and figures that fall back to a
# proportional face lose the tabular alignment the whole `.num` class exists
# for. The generator cannot infer which a new family is, so it is told.
FALLBACKS = {
    "serif": "ui-serif, Georgia, 'Times New Roman', serif",
    "sans": ("ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, "
             "'Helvetica Neue', Arial, sans-serif"),
    "mono": ("ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, "
             "'Liberation Mono', monospace"),
}


def slug(family: str) -> str:
    """'Instrument Serif' -> 'instrument-serif', which is the filename stem."""
    return re.sub(r"[^a-z0-9]+", "-", family.lower()).strip("-")


def fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as fh:
        return fh.read()


def google_css(family: str, axes: str | None) -> str:
    """The @font-face CSS Google serves for a family, as a modern browser."""
    spec = family.replace(" ", "+")
    # No axes given: ask for the weight range this app renders, variable.
    tail = axes if axes else "wght@400..600"
    url = f"https://fonts.googleapis.com/css2?family={spec}:{tail}&display=swap"
    try:
        return fetch(url).decode("utf-8")
    except urllib.error.HTTPError as exc:
        raise SystemExit(
            f"Google Fonts has no '{family}' with those axes ({exc.code}).\n"
            f"  tried: {url}\n"
            f"  check the spelling, or pass --axes matching what the family has."
        ) from exc


def subset_urls(css: str) -> dict[str, str]:
    """Map subset name -> woff2 URL, from the commented blocks Google emits."""
    out = {}
    parts = re.split(r"/\*\s*([a-z-]+)\s*\*/", css)
    for i in range(1, len(parts), 2):
        name = parts[i]
        if name not in SUBSETS:
            continue
        m = re.search(r"url\((https://[^)]+\.woff2)\)", parts[i + 1])
        if m:
            out[name] = m.group(1)
    return out


def upstream_ttf(family: str) -> bytes:
    """The full variable font from Google's own repository.

    Needed when the CSS API's build is missing axes the family actually has -
    it only ships what the URL asked for, and its axis list is not the font's.
    """
    repo_dir = slug(family).replace("-", "")
    for owner in ("googlefonts", "google"):
        api = (f"https://api.github.com/repos/{owner}/{repo_dir}"
               f"/git/trees/master?recursive=1")
        try:
            tree = json.loads(fetch(api))
        except Exception:
            continue
        for node in tree.get("tree", []):
            p = node.get("path", "")
            if (p.startswith("fonts/") and p.endswith(".ttf")
                    and "[" in p and "Italic" not in p):
                raw = f"https://raw.githubusercontent.com/{owner}/{repo_dir}/master/{p}"
                return fetch(urllib.parse.quote(raw, safe=":/"))
    raise SystemExit(
        f"could not find an upstream variable font for '{family}'.\n"
        f"  --axes needs the full release, and only Google-hosted families\n"
        f"  under github.com/googlefonts are looked up automatically."
    )


def build_face(family: str, axes: str | None) -> dict[str, int]:
    """Write both subsets for one family. Returns subset -> bytes written."""
    from fontTools.ttLib import TTFont  # noqa: PLC0415 - optional dep
    from fontTools.varLib import instancer  # noqa: PLC0415

    FONT_DIR.mkdir(parents=True, exist_ok=True)
    stem = slug(family)
    written: dict[str, int] = {}

    if axes:
        # Axes to pin or range means the CSS API's build will not do.
        src = ROOT / ".fontcache" / f"{stem}.ttf"
        src.parent.mkdir(exist_ok=True)
        if not src.is_file():
            src.write_bytes(upstream_ttf(family))
        limits: dict[str, object] = {}
        for part in axes.split(","):
            tag, _, value = part.partition("=")
            if ":" in value:
                lo, _, hi = value.partition(":")
                limits[tag.strip()] = (float(lo), float(hi))
            else:
                limits[tag.strip()] = float(value)
        inst = instancer.instantiateVariableFont(
            TTFont(src), limits, inplace=False, updateFontNames=False)
        staged = ROOT / ".fontcache" / f"{stem}-instanced.ttf"
        inst.save(staged)
        source_for = dict.fromkeys(SUBSETS, staged)
    else:
        css = google_css(family, None)
        urls = subset_urls(css)
        missing = set(SUBSETS) - set(urls)
        if missing:
            raise SystemExit(
                f"'{family}' has no {', '.join(sorted(missing))} subset on Google Fonts")
        source_for = {}
        for name, url in urls.items():
            staged = ROOT / ".fontcache" / f"{stem}-{name}.woff2"
            staged.parent.mkdir(exist_ok=True)
            staged.write_bytes(fetch(url))
            source_for[name] = staged

    for name, unicodes in SUBSETS.items():
        out = FONT_DIR / f"{stem}-{name}.woff2"
        ranges = ",".join(unicodes.replace("\n", " ").split())
        cmd = [sys.executable, "-m", "fontTools.subset", str(source_for[name]),
               f"--output-file={out}", "--flavor=woff2",
               f"--unicodes={ranges}", "--layout-features=*"]
        r = subprocess.run(cmd, capture_output=True, text=True)
        if r.returncode:
            tail = (r.stderr or r.stdout).strip().splitlines()[-1:]
            raise SystemExit(f"subsetting {family} {name} failed: {' '.join(tail)}")
        written[name] = out.stat().st_size
    return written


def face_block(family: str, subset: str) -> str:
    return (
        "@font-face {\n"
        f"  font-family: '{family}';\n"
        "  font-style: normal;\n"
        f"  font-weight: {WEIGHT_RANGE};\n"
        "  font-display: swap;\n"
        f"  src: url('/fonts/{slug(family)}-{subset}.woff2') format('woff2');\n"
        f"  unicode-range: {SUBSETS[subset]};\n"
        "}\n"
    )


def fonts_css(display: str, mono: str, sizes: dict[str, dict[str, int]]) -> str:
    total = sum(n for f in sizes.values() for n in f.values())
    return f"""/* GENERATED by tools/gen_fonts.py - do not edit.
   Run `python tools/gen_fonts.py --display "<family>"` and commit the result.

   Self-hosted webfaces for the app's two type tokens: '{display}' sets
   everything the interface says, '{mono}' sets its figures. Both are named
   by web/css/base.css as --font-ui and --font-num, and every other sheet
   consumes those names - so the interface font is one value in one file.

   Self-hosted rather than linked, because the CSP is `default-src 'none'` and
   the product's promise is that nothing leaves your device. A <link> to
   fonts.googleapis.com would be a third-party request on every visit.

   Held to `wght {WEIGHT_RANGE}` rather than a family's full range: nothing here
   renders above semibold - tests/web/verify_fonts.mjs measures that on the
   rendered page - so the heavier masters would be bytes that can never be
   drawn. {total:,} bytes for the set.

   Latin and latin-ext only, each keeping the exact unicode-range Google
   publishes, so a glyph outside them falls through to the next family in the
   stack rather than rendering a tofu box.

   `font-display: swap` - text paints immediately in the fallback and swaps when
   the face arrives. `size-adjust` is deliberately absent: these are the real
   families the tokens name, so there is no metric mismatch to compensate for.
   --------------------------------------------------------------------------- */

/* ------------------------------ interface --------------------------------- */
{face_block(display, "latin")}{face_block(display, "latin-ext")}
/* ---------------------------------- figures ------------------------------- */
{face_block(mono, "latin")}{face_block(mono, "latin-ext")}"""


def rewrite_index(display: str, mono: str) -> str:
    """Preload exactly the two latin cuts the page paints with."""
    html = (WEB / "index.html").read_text(encoding="utf-8")
    block = (
        f'<link rel="preload" href="/fonts/{slug(display)}-latin.woff2" '
        'as="font" type="font/woff2" crossorigin>\n'
        f'<link rel="preload" href="/fonts/{slug(mono)}-latin.woff2" '
        'as="font" type="font/woff2" crossorigin>'
    )
    pattern = re.compile(
        r'<link rel="preload" href="/fonts/[^"]+" as="font"[^>]*>\n?'
        r'(?:<link rel="preload" href="/fonts/[^"]+" as="font"[^>]*>\n?)*')
    if not pattern.search(html):
        raise SystemExit("no font preloads found in web/index.html")
    return pattern.sub(block + "\n", html, count=1)


def rewrite_sw(display: str, mono: str, bump_version: bool = True) -> str:
    """Precache both cuts of both faces, and bump the cache version.

    The bump is skipped under --check. A version is a side effect - it says
    "the cached set changed" - so re-deriving it on every check would make the
    file permanently stale against itself and the gate would never pass twice.
    """
    js = (WEB / "sw.js").read_text(encoding="utf-8")
    names = [f'"/fonts/{slug(f)}-{s}.woff2"'
             for f in (display, mono) for s in ("latin", "latin-ext")]
    line = "  " + ", ".join(names) + ",\n"
    pattern = re.compile(r'(?:  "/fonts/[^\n]*\n)+')
    if not pattern.search(js):
        raise SystemExit("no font entries found in web/sw.js")
    js = pattern.sub(line, js, count=1)

    if not bump_version:
        return js

    def bump(m: re.Match[str]) -> str:
        return f'const VERSION = "v{int(m.group(1)) + 1}"'
    js, n = re.subn(r'const VERSION = "v(\d+)"', bump, js, count=1)
    if not n:
        raise SystemExit("could not find VERSION in web/sw.js to bump")
    return js


def rewrite_base(display: str, mono: str, kind: str) -> str:
    """The one line the whole interface reads its face from.

    Both stacks are written as literals rather than as var(--oz-font-*). The
    token layer is vendored and generated upstream, it still names families
    this app replaced, and it is pruned to what the app references - so a
    generator that pointed at it would be pointing at something it does not
    control and cannot update. Naming the family here is the one place this app
    is allowed to disagree with that layer.
    """
    css = (WEB / "css" / "base.css").read_text(encoding="utf-8")
    css, n1 = re.subn(
        r"(  --font-ui: )[^;]*;",
        lambda m: f"{m.group(1)}'{display}', {FALLBACKS[kind]};", css, count=1)
    css, n2 = re.subn(
        r"(  --font-num: )[^;]*;",
        lambda m: f"{m.group(1)}'{mono}', {FALLBACKS['mono']};", css, count=1)
    if not (n1 and n2):
        raise SystemExit("could not find --font-ui / --font-num in web/css/base.css")
    return css


def stale_faces(display: str, mono: str) -> list[Path]:
    """woff2 files no longer named by either family.

    Deleting these is the point, not housekeeping. Two faces have shipped in
    this app while rendering nothing - each one preloaded at the top of the
    critical path - because a face was replaced and its files were left behind.
    """
    keep = {f"{slug(f)}-{s}.woff2" for f in (display, mono)
            for s in ("latin", "latin-ext")}
    return sorted(p for p in FONT_DIR.glob("*.woff2") if p.name not in keep)


def planned(display: str, mono: str, kind: str, sizes,
            bump_version: bool = True) -> list[tuple[Path, str]]:
    return [
        (WEB / "fonts.css", fonts_css(display, mono, sizes)),
        (WEB / "index.html", rewrite_index(display, mono)),
        (WEB / "sw.js", rewrite_sw(display, mono, bump_version)),
        (WEB / "css" / "base.css", rewrite_base(display, mono, kind)),
    ]


def load_config() -> dict[str, str]:
    if CONFIG.is_file():
        return json.loads(CONFIG.read_text(encoding="utf-8"))
    return {}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--display", help="the family that sets the interface")
    ap.add_argument("--mono", help="the family that sets the figures")
    ap.add_argument("--axes", help='e.g. "wght=400:600,opsz=36" - forces the '
                                   "upstream release rather than the CSS API")
    ap.add_argument("--kind", choices=sorted(k for k in FALLBACKS if k != "mono"),
                    help="what the interface face degrades to while it loads: "
                         "serif or sans. A serif that falls back to a sans "
                         "changes the page's voice mid-load.")
    ap.add_argument("--check", action="store_true",
                    help="exit 1 if the generated files are stale")
    args = ap.parse_args(argv)

    cfg = load_config()
    display = args.display or cfg.get("display")
    mono = args.mono or cfg.get("mono")
    axes = args.axes if args.axes is not None else cfg.get("axes")
    kind = args.kind or cfg.get("kind", "sans")
    if not display or not mono:
        ap.error("no families known - pass --display and --mono once, and "
                 "tools/fonts.json will remember them")

    if args.check:
        # Sizes are only used in a comment; read them off what is on disk so a
        # check does not need the network.
        sizes = {f: {s: (FONT_DIR / f"{slug(f)}-{s}.woff2").stat().st_size
                     for s in SUBSETS if (FONT_DIR / f"{slug(f)}-{s}.woff2").is_file()}
                 for f in (display, mono)}
        stale = [p.relative_to(ROOT)
                 for p, want in planned(display, mono, kind, sizes, bump_version=False)
                 if p.read_text(encoding="utf-8") != want]
        extra = [p.relative_to(ROOT) for p in stale_faces(display, mono)]
        if stale or extra:
            for p in stale:
                print(f"{p} is stale", file=sys.stderr)
            for p in extra:
                print(f"{p} is shipped but no longer used", file=sys.stderr)
            print("run: python tools/gen_fonts.py", file=sys.stderr)
            return 1
        print(f"fonts are current ({display} / {mono})")
        return 0

    sizes = {}
    for family in (display, mono):
        sizes[family] = build_face(family, axes if family == display else None)
        for subset, n in sizes[family].items():
            print(f"  {slug(family)}-{subset}.woff2  {n:,} bytes")

    for path, content in planned(display, mono, kind, sizes):
        path.write_text(content, encoding="utf-8", newline="\n")
        print(f"wrote {path.relative_to(ROOT)}")

    for path in stale_faces(display, mono):
        path.unlink()
        print(f"removed {path.relative_to(ROOT)} - nothing references it")

    CONFIG.write_text(json.dumps(
        {"display": display, "mono": mono, "kind": kind,
         **({"axes": axes} if axes else {})},
        indent=2) + "\n", encoding="utf-8", newline="\n")

    print(f"\n{display} sets the interface, {mono} sets the figures.")
    print("Next: python tools/gen_seo_pages.py   (the preload propagates to all "
          "ten use-case pages)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
