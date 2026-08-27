"""One design system, and the tooling that keeps it that way.

Two interfaces ship in this repo. The browser app reads the token layer from
`web/`; the desktop app reads a copy of the same files, produced by
`tools/sync_webui_assets.py` and committed so a pip install needs no build step
and no network. Before that existed, the desktop app carried its own palette,
its own corners and its own two transition shorthands - a second visual
identity for the same product, and the half of it that no gate could see.

What is checked here is everything reachable without a browser. The rest -
that the stylesheets are actually served, with types a browser accepts, and
that the tokens resolve on the real page - needs Chrome and lives in
`tests/web/verify_desktop.mjs`. Both halves matter: the static checks proved
the desktop app *referenced* the token layer for a while during which every
request for it came back 403 and the app rendered in Times New Roman.
"""

from __future__ import annotations

import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from tools import sync_webui_assets as sync  # noqa: E402

WEB = ROOT / "web"
WEBUI = ROOT / "pocketsize" / "webui"
DESKTOP = WEBUI / "app.html"


def _read(path: Path) -> str:
    with path.open("r", encoding="utf-8", newline="") as fh:
        return fh.read()


def _desktop_css() -> str:
    """Whatever CSS the desktop page defines for itself - which should be none.

    Until 2026-08-26 this page carried the entire interface in one inline
    <style> block, and these tests policed that block: no colour literals, no
    hand-typed easing, no reduced-motion handling of its own. The block is gone.
    The app now loads the same stylesheets the web app does, so the rules those
    tests describe are enforced where the rules live - `css/base.css` and the
    token layer, which have their own gates in this file.

    What is left to check here is stronger and simpler: the page defines no CSS
    at all. An inline <style> block, or a `style=` attribute, is how a private
    palette would come back - one colour at a time, in the file least likely to
    be read as a stylesheet. So this returns everything the page styles
    directly, and every caller asserts on an empty string.
    """
    text = _read(DESKTOP)
    blocks = re.findall(r"<style[^>]*>(.*?)</style>", text, re.S)
    inline = re.findall(r"""\sstyle\s*=\s*["']([^"']*)["']""", text)
    joined = "\n".join(blocks + inline)
    return re.sub(r"/\*.*?\*/", "", joined, flags=re.S)


class TheCopiesAreCurrent(unittest.TestCase):
    def test_nothing_is_stale(self):
        self.assertEqual(
            sync.main(["--check"]), 0,
            "the desktop app's design system is stale. Run "
            "`python tools/sync_webui_assets.py` and commit the result.")

    def test_every_file_it_owns_exists(self):
        for destination, _ in sync.planned():
            with self.subTest(file=destination.name):
                self.assertTrue(destination.is_file(), f"{destination} is missing")

    def test_it_owns_the_tokens_the_faces_and_the_icon(self):
        names = {d.name for d, _ in sync.planned()}
        self.assertIn("heyoz-tokens.css", names)
        self.assertIn("fonts.css", names)
        self.assertIn("favicon.svg", names)
        self.assertEqual(len([n for n in names if n.endswith(".woff2")]), 6)

    def test_the_copies_say_they_are_copies(self):
        for name in sync.STYLESHEETS:
            # Sources may live in a subfolder of web/; the copies are flat.
            with self.subTest(file=name):
                head = _read(WEBUI / Path(name).name)[:200]
                self.assertIn("DO NOT EDIT", head)
                self.assertIn("sync_webui_assets.py", head)


class TheGeneratorItself(unittest.TestCase):
    """A guard nobody has watched fail is a guess about whether it measures."""

    def _restore(self, path: Path, content: bytes):
        path.write_bytes(content)

    def test_check_fails_on_an_edited_copy(self):
        target = WEBUI / "heyoz-tokens.css"
        original = target.read_bytes()
        try:
            target.write_bytes(original + b"\n.sneaked-in { color: red; }\n")
            self.assertEqual(sync.main(["--check"]), 1)
        finally:
            self._restore(target, original)
        self.assertEqual(sync.main(["--check"]), 0, "the copy was not restored")

    def test_check_fails_on_a_missing_copy(self):
        target = WEBUI / "fonts.css"
        original = target.read_bytes()
        try:
            target.unlink()
            self.assertEqual(sync.main(["--check"]), 1)
        finally:
            self._restore(target, original)

    def test_check_fails_on_a_missing_face(self):
        """A face that is not there is text silently falling back to a system
        typeface - which looks like a design regression, not a missing file."""
        face = next(p for p in (WEBUI / "fonts").glob("*.woff2"))
        original = face.read_bytes()
        try:
            face.unlink()
            self.assertEqual(sync.main(["--check"]), 1)
        finally:
            self._restore(face, original)

    def test_a_crlf_checkout_is_not_mistaken_for_staleness(self):
        """Same trap web/destinations.js fell into: this repo is developed with
        core.autocrlf=true, so a fresh Windows clone has CRLF on disk while the
        tool emits LF."""
        target = WEBUI / "heyoz-tokens.css"
        original = target.read_bytes()
        try:
            target.write_bytes(original.replace(b"\n", b"\r\n"))
            self.assertEqual(sync.main(["--check"]), 0,
                             "a CRLF working copy was reported as out of date")
        finally:
            self._restore(target, original)

    def test_writing_is_idempotent(self):
        before = [(d, d.read_bytes()) for d, _ in sync.planned()]
        sync.main([])
        for path, content in before:
            with self.subTest(file=path.name):
                self.assertEqual(path.read_bytes(), content)


class TheFontPathsWork(unittest.TestCase):
    def test_the_copy_uses_relative_face_urls(self):
        """`/fonts/x.woff2` is right at the site root and a 404 under /webui/.
        The copy has to resolve against its own location instead."""
        copied = _read(WEBUI / "fonts.css")
        self.assertNotIn("url('/fonts/", copied)
        self.assertIn("url('fonts/", copied)

    def test_the_source_is_left_alone(self):
        """The deployed site must not be affected by a change made for the
        desktop app."""
        self.assertIn("url('/fonts/", _read(WEB / "fonts.css"))

    def test_every_declared_face_exists_beside_the_copy(self):
        copied = _read(WEBUI / "fonts.css")
        declared = set(re.findall(r"url\('fonts/([^']+)'\)", copied))
        self.assertTrue(declared, "no faces declared in the copied stylesheet")
        for face in declared:
            with self.subTest(face=face):
                self.assertTrue((WEBUI / "fonts" / face).is_file())


class TheDesktopAppHasNoPaletteOfItsOwn(unittest.TestCase):
    """The static half of the design-system gate, in the Python suite so it runs
    without Chrome. `tests/web/verify_tokens.mjs` checks the same things and
    more; this makes the most important ones unmissable."""

    def test_no_colour_literals(self):
        css = _desktop_css()
        self.assertEqual(re.findall(r"#[0-9a-fA-F]{3,8}\b", css), [])
        self.assertEqual(re.findall(r"\b(?:rgba?|hsla?)\(", css), [])

    def test_no_hand_typed_easing_curves(self):
        self.assertEqual(re.findall(r"cubic-bezier\(", _desktop_css()), [])

    def test_no_private_palette_variables_are_defined(self):
        css = _desktop_css()
        for name in ("--surface", "--panel", "--raised", "--line", "--ink",
                     "--accent", "--ok", "--bad", "--shadow",
                     "--r-sm", "--r-md", "--r-lg", "--t-fast", "--t-mid",
                     "--ui", "--mono"):
            with self.subTest(variable=name):
                self.assertNotRegex(css, rf"^\s*{re.escape(name)}\s*:", )

    def test_it_loads_the_shared_stylesheets_tokens_first(self):
        """Order matters: a sheet that consumes a token before the token layer
        has defined it resolves to nothing, and the app renders unstyled.

        This used to assert that the token layer came before the page's own
        <style> block. There is no such block now - the page loads the same
        region sheets the web app does - so the assertion is the real one: the
        token layer and the faces come first, and every region sheet follows in
        the order base.css expects."""
        html = _read(DESKTOP)
        order = []
        for name in ("heyoz-tokens.css", "fonts.css", "base.css", "layout.css",
                     "controls.css", "queue.css", "compare.css", "facts.css"):
            where = html.find(f"/webui/{name}")
            self.assertNotEqual(where, -1, f"{name} is not linked")
            order.append((where, name))
        self.assertEqual([n for _, n in sorted(order)],
                         [n for _, n in order],
                         "the stylesheets are linked out of order; a sheet that "
                         "consumes a token before the token layer defines it "
                         "resolves to nothing")

    def test_reduced_motion_is_not_handled_here(self):
        """The token layer does it once, for both interfaces, and better - it
        keeps fades, which often carry the meaning."""
        self.assertNotIn("prefers-reduced-motion", _desktop_css())

    def test_it_shares_the_browser_apps_alias_names(self):
        """Same names for the same ideas, so the two are one product.

        This once asserted that the desktop page's own <style> block defined
        `--app-radius-sm` and friends. That was the strongest statement
        available while the page carried its own CSS: the names matched even
        though the definitions were duplicated.

        They are not duplicated any more - the page loads css/base.css, which is
        where the vocabulary is defined for both interfaces - so asserting the
        page defines them would now require putting a private palette back. The
        question worth asking is whether the two still speak one language, and
        the honest place to ask it is the shared sheet."""
        base = _read(WEB_CSS_DIR / "base.css")
        for alias in ("--radius-sm", "--radius-lg",
                      "--c-checker-ground", "--c-checker-square"):
            with self.subTest(alias=alias):
                self.assertRegex(base, rf"{re.escape(alias)}\s*:")

    def test_every_token_the_shared_sheets_reference_is_defined(self):
        """A `var()` naming a token that does not exist resolves to nothing, and
        the rule silently does not apply - the failure mode this catches.

        The desktop page used to name tokens itself and this read them out of
        its markup. It no longer names any: the sheets it loads do. So the same
        question is asked of those sheets, which is where a typo would now
        live - and asked of all of them at once, because the desktop app loads
        all of them."""
        defined = set(re.findall(r"^\s*(--oz-[a-z0-9-]+)\s*:",
                                 _read(WEB / "heyoz-tokens.css"), re.M))
        used = set()
        for name in ("base.css",) + WEB_SHEETS[1:]:
            used |= set(re.findall(r"var\((--oz-[a-z0-9-]+)",
                                   _read(WEB_CSS_DIR / name)))
        self.assertTrue(used, "the shared sheets reference no tokens at all")
        self.assertEqual(sorted(used - defined), [])


WEB_CSS_DIR = WEB / "css"

# The browser app's stylesheets, in load order. base.css is where every colour
# and space is *defined*; the others may only consume them by name.
WEB_SHEETS = ("base.css", "layout.css", "controls.css",
              "queue.css", "compare.css", "facts.css")


def _web_css(name: str) -> str:
    return re.sub(r"/\*.*?\*/", "", _read(WEB_CSS_DIR / name), flags=re.S)


class TheBrowserAppHasOnePlaceForValues(unittest.TestCase):
    """base.css aliases the app's six-name vocabulary onto the HeyOz token
    layer (--c-bg is --oz-color-background, and so on), and every other sheet
    consumes only those aliases. One indirection, enforced here: base.css
    defines; the rest consume. Without this the sheets would drift back into
    scattered literals within a few edits, which is the state this rule was
    written out of.
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
        # base.css plus media-accent.css: the second exists only because the
        # desktop app needs that one colour by name too and cannot link
        # base.css, so it is the design system's vocabulary either way.
        defined = set(re.findall(r"^\s*(--[a-z0-9-]+)\s*:",
                                 _web_css("base.css")
                                 + _web_css("media-accent.css"), re.M))
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


class MotionIsTokenised(unittest.TestCase):
    """Two rules on both interfaces, and one that only the desktop app can meet.

    The layout and `all` rules are about performance and hold anywhere: a
    transition on a layout property forces reflow on every frame, and `all`
    animates properties nobody chose. Those apply to the browser app's baseline
    exactly as they did to its predecessor.

    The literal-duration rule is different. It exists to keep one motion
    vocabulary - --oz-duration-*, --oz-ease-* - and only the desktop app reads
    that layer now. Holding the browser app to it would mean inventing a parallel
    motion token set for a baseline whose entire point is not having one, so it is
    scoped to the layer where it means something.
    """

    LAYOUT = ("width", "height", "top", "right", "bottom", "left",
              "margin", "padding", "inset")

    def layers(self):
        return [(f"css/{name}", _web_css(name)) for name in WEB_SHEETS] + [
            ("webui/app.html", _desktop_css())]

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

    def test_no_literal_durations_or_curves(self):
        """Desktop only - see the class docstring. The browser app's baseline has
        no motion vocabulary to be consistent with, by design."""
        for name, css in [("webui/app.html", _desktop_css())]:
            for kind, value in re.findall(r"(transition|animation)\s*:\s*([^;{}]+);", css):
                bare = re.sub(r"var\(\s*--[a-z0-9-]+\s*(,[^)]*)?\)", " ", value)
                with self.subTest(file=name, kind=kind):
                    self.assertEqual(
                        re.findall(r"(?<![\w-])\d+(?:\.\d+)?m?s(?![\w-])", bare), [],
                        f"{name}: hand-typed duration in {kind} -> {value.strip()}")
                    self.assertEqual(
                        re.findall(r"(?<![\w-])(?:ease-in-out|ease-in|ease-out|ease|linear)"
                                   r"(?![\w-])", bare), [],
                        f"{name}: hand-typed easing in {kind} -> {value.strip()}")


class TheDesktopAppRunsTheApprovedInterface(unittest.TestCase):
    """The desktop app must be the same interface as the web app, not a second
    one that happens to share a palette.

    It was the second one for a year. The UX overhaul of 2026-08-13 landed on
    the web app and stopped there, and nothing noticed: the sync carried the
    token layer, so both products passed every design-system gate above while
    one of them was missing the staged sequence, the plan panel, the facts
    blocks and the help card. The owner found it by opening the app and having
    nowhere to go.

    So the structure is asserted, not just the styling. These ids are the
    approved plan made checkable - the sequence from
    docs/UX_IMPLEMENTATION_PLAN.md 5 ("add pictures -> one question -> result ->
    evidence on demand") and the three visible plan fields from constraint 1.
    """

    #: The sequence, the panel, and the evidence-on-demand regions. Every one of
    #: these was absent from the desktop app before 2026-08-26.
    REQUIRED = (
        "stage-empty", "stage-choose", "stage-hero", "stage-work",
        "queue-sec", "plan-sec", "plan-fields", "more-choices",
        "facts", "measured", "versions", "help",
    )

    def test_the_page_carries_the_whole_sequence(self):
        html = _read(DESKTOP)
        for element in self.REQUIRED:
            with self.subTest(element=element):
                self.assertIn(f'id="{element}"', html,
                              f"{element} is missing from the desktop app - the "
                              "interface has diverged from the approved plan")

    def test_the_plan_panel_still_asks_three_questions(self):
        """Constraint 1: visible plan fields stay at 3, everything else under
        More choices. A fourth is a decision added to first run, which is the
        one number this project does not let grow."""
        html = _read(DESKTOP)
        start = html.index('id="plan-fields"')
        end = html.index('id="more-choices"', start)
        visible = html.count('class="field"', start, end)
        self.assertEqual(
            visible, 3,
            f"the plan panel shows {visible} fields, not 3 - first-run "
            "decisions must not grow (UX plan, constraint 1)")

    def test_it_loads_the_shared_modules_rather_than_its_own(self):
        """The interface is the web app's modules, not a reimplementation. A
        page that stopped loading main.js would still pass every check above."""
        html = _read(DESKTOP)
        self.assertIn('src="/webui/main.js"', html)
        self.assertIn('type="module"', html)

    def test_the_desktop_copy_talks_to_the_local_engine(self):
        """The one substitution the sync makes. If it silently stopped, the page
        would ask for /webui/engine.js - which is deliberately not synced - get a
        403, and load no interface at all."""
        for name in sorted(sync.ENGINE_IMPORTERS):
            with self.subTest(module=name):
                copied = _read(WEBUI / Path(name).name)
                self.assertIn('from "./engine-local.js"', copied)
                self.assertNotIn('from "./engine.js"', copied)

    def test_no_inline_executable_script(self):
        """Same rule the web app has, and now achievable here: the token travels
        as a data attribute, so the page's CSP refuses inline script outright."""
        html = _read(DESKTOP)
        blocks = re.findall(r"<script(?![^>]*src=)[^>]*>(.*?)</script>",
                            html, re.S)
        executable = [b for b in blocks if b.strip()]
        self.assertEqual(executable, [],
                         "an inline <script> is back in webui/app.html")

    def test_the_offline_layer_is_not_registered_here(self):
        """There is no sw.js in the package. Registering one 403s on every
        launch and caches nothing - the encoders are native."""
        self.assertNotIn("serviceWorker", _read(WEBUI / "main.js"))


if __name__ == "__main__":
    unittest.main()
