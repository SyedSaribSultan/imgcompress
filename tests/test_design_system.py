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
WEBUI = ROOT / "imgcompress" / "webui"
DESKTOP = WEBUI / "app.html"


def _read(path: Path) -> str:
    with path.open("r", encoding="utf-8", newline="") as fh:
        return fh.read()


def _desktop_css() -> str:
    match = re.search(r"<style>(.*?)</style>", _read(DESKTOP), re.S)
    assert match, "could not find the <style> block in webui/app.html"
    return re.sub(r"/\*.*?\*/", "", match.group(1), flags=re.S)


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
            with self.subTest(file=name):
                head = _read(WEBUI / name)[:200]
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
        html = _read(DESKTOP)
        tokens = html.find("/webui/heyoz-tokens.css")
        faces = html.find("/webui/fonts.css")
        style = html.find("<style>")
        self.assertNotEqual(tokens, -1, "the token layer is not linked")
        self.assertNotEqual(faces, -1, "the face declarations are not linked")
        self.assertLess(tokens, style,
                        "tokens must load before the styles that consume them")
        self.assertLess(faces, style)

    def test_reduced_motion_is_not_handled_here(self):
        """The token layer does it once, for both interfaces, and better - it
        keeps fades, which often carry the meaning."""
        self.assertNotIn("prefers-reduced-motion", _desktop_css())

    def test_it_shares_the_browser_apps_alias_names(self):
        """Same names for the same ideas, so the two are one product."""
        css = _desktop_css()
        for alias in ("--app-radius-sm", "--app-radius-md", "--app-radius-lg",
                      "--app-radius-pill", "--app-control-h", "--app-gap-tight",
                      "--checker-a", "--checker-b"):
            with self.subTest(alias=alias):
                self.assertRegex(css, rf"{re.escape(alias)}\s*:")

    def test_every_token_it_references_is_defined(self):
        defined = set(re.findall(r"^\s*(--oz-[a-z0-9-]+)\s*:",
                                 _read(WEB / "heyoz-tokens.css"), re.M))
        used = set(re.findall(r"var\((--oz-[a-z0-9-]+)", _read(DESKTOP)))
        self.assertTrue(used, "the desktop app references no tokens at all")
        self.assertEqual(sorted(used - defined), [])


class MotionIsTokenised(unittest.TestCase):
    """The rules the brief asked for, enforced on both app layers. The full
    check with its per-declaration reporting is in verify_tokens.mjs; these are
    the two that must never regress.

    The brief proposed a new --oz-motion-* set and a second --oz-ease-exit.
    Deliberately not done: the token layer already ships --oz-duration-*,
    --oz-ease-* and the --oz-spring-* pairs, so a parallel set would be the
    duplication this work removes, and --oz-ease-exit already exists with a
    different curve - redefining it would silently change every exit animation.
    """

    LAYOUT = ("width", "height", "top", "right", "bottom", "left",
              "margin", "padding", "inset")

    def layers(self):
        return [("app.css", re.sub(r"/\*.*?\*/", "", _read(WEB / "app.css"), flags=re.S)),
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
        for name, css in self.layers():
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


if __name__ == "__main__":
    unittest.main()
