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
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
WEB_CSS_DIR = WEB / "css"

WEB_SHEETS = ("base.css", "layout.css", "controls.css",
              "queue.css", "compare.css", "facts.css")


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
            # --side-w and --facts-h are the person's own panel sizes, written
            # by js/panels.js onto <html>.
            used -= {"--clip", "--bar-h", "--side-w", "--facts-h"}
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
