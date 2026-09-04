"""The design system has one place for values, and the page consumes names.

This file used to cover two interfaces. The desktop app is gone, and with it
the copies, the sync tool that produced them, and the five test classes that
policed a second visual identity for the same product. What remains is the rule
that mattered on the browser side all along and still does:

    base.css defines. Every other sheet consumes.

Without it the sheets drift back into scattered literals within a few edits,
which is the state this rule was written out of - and a value with no name is
one nobody can change everywhere at once.
"""

from __future__ import annotations

import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
WEB = ROOT / "web"
WEB_CSS_DIR = WEB / "css"

from tools import gen_fonts  # noqa: E402
from tools import gen_tokens_subset as gen_tokens

WEB_SHEETS = ("base.css", "layout.css", "controls.css",
              "queue.css", "compare.css")

# Custom properties written by JavaScript rather than defined in a sheet, so
# neither the base-defines rule nor the palette prune should expect to find
# them declared. --side-w and --queue-h are the person's own panel sizes
# (js/panels.js); --split-* is the picture's live rectangle and --clip its
# derived split, both written by js/compare.js; --bar-h is measured from the
# real bar by js/main.js; --picker-max and --picker-wide are the room a dropdown
# has below and to the right of its button, measured by js/picker.js when the
# list opens.
_JS_SET_TOKENS = frozenset({
    "--clip", "--bar-h", "--side-w", "--queue-h",
    "--split-x", "--split-y", "--split-w", "--split-h",
    "--picker-max", "--picker-wide",
})


def _read(path: Path) -> str:
    with path.open("r", encoding="utf-8", newline="") as fh:
        return fh.read()


def _web_css(name: str) -> str:
    return re.sub(r"/\*.*?\*/", "", _read(WEB_CSS_DIR / name), flags=re.S)


class TheBrowserAppHasOnePlaceForValues(unittest.TestCase):
    """base.css aliases the app's six-name vocabulary onto the HeyOz token
    layer (--c-bg is --oz-color-background, and so on), and every other sheet
    consumes only those aliases. One indirection, enforced here: base.css
    defines; the rest consume.
    """

    def test_every_sheet_exists(self):
        for name in WEB_SHEETS:
            with self.subTest(sheet=name):
                self.assertTrue((WEB_CSS_DIR / name).is_file(),
                                f"web/css/{name} is missing")

    def test_index_links_them_all_with_base_first(self):
        html = _read(WEB / "index.html")
        seen = [html.find(f"/css/{name}") for name in WEB_SHEETS]
        for name, at in zip(WEB_SHEETS, seen):
            with self.subTest(sheet=name):
                self.assertNotEqual(at, -1, f"index.html does not link {name}")
        self.assertEqual(seen, sorted(seen),
                         "base.css must load before the sheets that consume it")

    def test_only_base_defines_colour_literals(self):
        """A colour outside base.css is a value with no name, and a value with
        no name is one nobody can change everywhere at once. That now includes
        the over-the-photograph furniture: the transparency checkerboard and
        the caliper's glass deliberately ignore the page theme, but their
        values are still NAMED - the --c-checker-* and --c-over-* tokens in
        base.css - so even the deliberate exceptions have exactly one home.
        The net catches every way CSS spells a raw colour, not just hex."""
        raw = re.compile(r"#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(")
        for name in WEB_SHEETS[1:]:
            with self.subTest(sheet=name):
                found = raw.findall(_web_css(name))
                self.assertEqual(found, [], f"{name} hand-types {found}")

    def test_every_token_used_is_defined_in_base(self):
        defined = set(re.findall(r"^\s*(--[a-z0-9-]+)\s*:",
                                 _web_css("base.css"), re.M))
        for name in WEB_SHEETS[1:]:
            used = set(re.findall(r"var\((--[a-z0-9-]+)", _web_css(name)))
            # Locally-set custom properties, written by JS or by a sibling rule.
            # --side-w and --queue-h are the person's own panel sizes, written
            # by js/panels.js onto <html>. --split-* is the picture's own live
            # rectangle, written onto the range by js/compare.js so the caliper
            # cannot leave the image.
            used -= _JS_SET_TOKENS
            with self.subTest(sheet=name):
                self.assertEqual(sorted(used - defined), [],
                                 f"{name} uses tokens base.css does not define")

    def test_the_page_carries_no_inline_executable_script(self):
        """The CSP forbids inline script outright rather than allow-listing a
        hash. An inline <script> here fails only in production, and only after a
        deploy, which is the worst way to find out.

        The one deliberate exception: <script type="application/ld+json">, the
        page's description of itself for search engines. That is a DATA block -
        the HTML spec says browsers never fetch or execute it, so the CSP never
        comes into play. Anything else inline is still a failure."""
        html = _read(WEB / "index.html")
        inline = re.findall(r"<script(?![^>]*\bsrc=)[^>]*>", html)
        allowed = [t for t in inline if 'type="application/ld+json"' in t]
        self.assertEqual(inline, allowed,
                         "inline <script> that is not a JSON-LD data block")

    def test_no_inline_style_attributes(self):
        """The other way a private palette comes back: one element at a time,
        in the place least likely to be read as a stylesheet. The production
        CSP blocks these anyway, so this catches it before the deploy does."""
        html = _read(WEB / "index.html")
        self.assertEqual(
            re.findall(r"""\sstyle\s*=\s*["'][^"']*["']""", html), [],
            "index.html carries an inline style attribute")


class TheTypefaceIsGenerated(unittest.TestCase):
    """The interface font is one value, and everything it implies is derived.

    Changing the face touches five files - the @font-face blocks, the preload,
    the service worker's precache and its version, and the token in base.css -
    and misses on any of them are silent. Two faces have shipped in this app
    while painting no glyphs at all, each preloaded at the top of the critical
    path, because a face was replaced and its files were left behind. So the
    swap is a generator, and this is what stops the derived files drifting from
    it.
    """

    def test_everything_the_font_choice_implies_is_current(self):
        self.assertEqual(
            gen_fonts.main(["--check"]), 0,
            "the font files are stale. Run `python tools/gen_fonts.py` "
            "and commit the result.")

    def test_only_the_faces_in_use_are_shipped(self):
        cfg = gen_fonts.load_config()
        stale = [p.name for p in gen_fonts.stale_faces(cfg["display"], cfg["mono"])]
        self.assertEqual(
            stale, [],
            "web/fonts/ ships faces nothing references - exactly the state "
            "Bricolage and then Geist were left in")


class TheTokenSheetIsGenerated(unittest.TestCase):
    """web/heyoz-tokens.css is pruned from the vendored palette, not hand-cut.

    The vendored sheet carries an entire design system; this app reaches a
    small fraction of it, and the rest is dead weight on a render-blocking
    resource. Cutting it by hand would work exactly once - the next re-vendor
    would restore it silently - so the cut is a generator and this is what
    stops it rotting.
    """

    def test_the_shipped_sheet_matches_the_generator(self):
        self.assertEqual(
            gen_tokens.main(["--check"]), 0,
            "web/heyoz-tokens.css is stale. Run "
            "`python tools/gen_tokens_subset.py` and commit the result.")

    def test_the_full_palette_is_kept_for_regeneration(self):
        self.assertTrue(
            gen_tokens.SOURCE.is_file(),
            f"{gen_tokens.SOURCE.relative_to(ROOT)} is missing - the pruned "
            "sheet cannot be rebuilt or re-vendored without it.")

    def test_the_prune_keeps_every_token_the_app_reads(self):
        """The real invariant: nothing the app reaches may be cut.

        A generator that pruned too eagerly would leave a var() resolving to
        nothing, which CSS reports by silently dropping the declaration - no
        error, just an unstyled control. So the check is direct: every token
        named anywhere outside the sheet is defined inside the shipped one.
        """
        shipped = _read(WEB / "heyoz-tokens.css")
        defined = set(re.findall(r"^\s*(--[a-z0-9-]+)\s*:", shipped, re.M))
        # base.css is the app's own vocabulary and defines its own names; the
        # palette only has to satisfy what is left.
        own = set(re.findall(r"^\s*(--[a-z0-9-]+)\s*:", _web_css("base.css"), re.M))
        missing = sorted(gen_tokens.used_tokens() - defined - own - _JS_SET_TOKENS)
        self.assertEqual(
            missing, [],
            "the pruned sheet drops tokens the app still asks for")


class MotionIsTokenised(unittest.TestCase):
    """Two rules about performance, and they hold anywhere.

    A transition on a layout property forces the browser to recompute layout on
    every frame, where transform and opacity are composited and cannot. `all`
    animates properties nobody chose. Three progress bars animated `width`
    before this existed.
    """

    LAYOUT = ("width", "height", "top", "right", "bottom", "left",
              "margin", "padding", "inset")

    def layers(self):
        return [(f"css/{name}", _web_css(name)) for name in WEB_SHEETS]

    def test_no_transition_touches_a_layout_property(self):
        for name, css in self.layers():
            for value in re.findall(r"transition\s*:\s*([^;{}]+);", css):
                for prop in self.LAYOUT:
                    with self.subTest(file=name, prop=prop):
                        self.assertNotRegex(
                            value, rf"(^|,)\s*{prop}(\s|$|,)",
                            f"{name} transitions {prop}, which forces layout on "
                            f"every frame; animate transform or opacity")

    def test_no_transition_uses_all(self):
        for name, css in self.layers():
            for value in re.findall(r"transition\s*:\s*([^;{}]+);", css):
                with self.subTest(file=name):
                    self.assertNotEqual(value.strip().split()[0], "all",
                                        f"{name}: name the properties")


if __name__ == "__main__":
    unittest.main(verbosity=2)
