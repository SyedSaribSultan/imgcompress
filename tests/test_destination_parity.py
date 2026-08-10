"""The destination table has one author. This keeps it that way.

`imgcompress/destinations.py` is the reference. `web/destinations.js` is
generated from it by `tools/gen_destinations.py` and committed, because `web/`
has no build step and should not grow one. Everything else - `worker.js`,
`app.js`, the markup - reads that generated file rather than restating it.

This started as a test that compared three hand-written copies, written after
`app.js` drifted from Python inside an hour. Comparing copies catches drift
afterwards; not having copies prevents it. So the checks here changed shape:

* the generated file must be current with the reference (the real guard);
* no consumer may hand-write a destination name, frame size or format list;
* the two controls a person sees must be rendered, not typed.

Every extractor raises if it finds nothing. A regex that silently matches zero
lines turns a file like this into a test that passes because it checked
nothing, which is the exact failure this suite keeps finding elsewhere.
"""

from __future__ import annotations

import json
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from imgcompress import destinations as dest  # noqa: E402
from tools import gen_destinations  # noqa: E402

WORKER_JS = ROOT / "web" / "worker.js"
APP_JS = ROOT / "web" / "app.js"
INDEX_HTML = ROOT / "web" / "index.html"
GENERATED_JS = ROOT / "web" / "destinations.js"
DESKTOP_HTML = ROOT / "imgcompress" / "webui" / "app.html"


def _read(path: Path) -> str:
    with path.open("r", encoding="utf-8", newline="") as fh:
        return fh.read()


def _write(path: Path, text: str) -> None:
    """No line-ending translation, so an LF file stays LF on Windows. `newline=`
    on Path.write_text is 3.10+, and this package supports 3.9."""
    with path.open("w", encoding="utf-8", newline="") as fh:
        fh.write(text)


class TheGeneratedFileIsCurrent(unittest.TestCase):
    """The one check that makes the rest unnecessary."""

    def test_it_matches_the_reference(self):
        self.assertEqual(
            gen_destinations.main(["--check"]), 0,
            "web/destinations.js is stale. Run `python tools/gen_destinations.py` "
            "and commit the result.")

    def test_it_carries_every_value_the_reference_has(self):
        """Not a copy comparison - a check that the generator emits all of it,
        so a destination cannot be added to Python and silently not reach the
        browser."""
        text = _read(GENERATED_JS)
        for d in dest.DESTINATIONS.values():
            with self.subTest(destination=d.name):
                self.assertIn(f'"{d.name}"', text)
        for d in dest.visible():
            with self.subTest(numbers=d.name):
                self.assertIn(f'"label": {json.dumps(d.label)}', text)
                self.assertIn(f'"maxDimension": {d.max_dimension}', text)
        self.assertIn(f"const DOCUMENTS_MAX_DIMENSION = {dest.get('documents').hard_cap};",
                      text)
        self.assertIn(f"const DEFAULT_DESTINATION = {json.dumps(dest.DEFAULT)};", text)

    def test_it_says_it_is_generated(self):
        """Anyone opening it should know editing is pointless before they do."""
        head = _read(GENERATED_JS)[:400]
        self.assertIn("GENERATED FILE - DO NOT EDIT", head)
        self.assertIn("tools/gen_destinations.py", head)


class NoConsumerRestatesTheTable(unittest.TestCase):
    """The copies are gone; this is what stops them coming back."""

    def _source(self, path: Path) -> str:
        """File contents with the generated file's own name filtered out, so a
        comment pointing at destinations.js is not mistaken for a copy."""
        return "\n".join(line for line in _read(path).splitlines()
                         if "destinations.js" not in line)

    def test_the_worker_declares_no_table_of_its_own(self):
        source = self._source(WORKER_JS)
        for banned in ("const TARGETS", "const EVERY_FORMAT", "const STORED_AS_GIVEN",
                       "const OLD_TARGET_NAMES", "const DOCUMENTS_MAX_DIMENSION"):
            with self.subTest(declaration=banned):
                self.assertNotIn(banned, source)

    def test_the_worker_pulls_in_the_generated_file(self):
        self.assertIn('importScripts("destinations.js")', _read(WORKER_JS))

    def test_the_ui_declares_no_table_of_its_own(self):
        source = self._source(APP_JS)
        for banned in ("const DESTINATIONS", "const OLD_TARGET_NAMES"):
            with self.subTest(declaration=banned):
                self.assertNotIn(banned, source)

    def test_no_consumer_hardcodes_a_frame_size(self):
        """2560, 1920, 512 and 4096 are the reference's to state."""
        sizes = {str(d.max_dimension) for d in dest.visible() if d.max_dimension}
        sizes.add(str(dest.get("documents").hard_cap))
        for path in (WORKER_JS, APP_JS):
            source = self._source(path)
            # A destination name and one of its numbers on the same line is the
            # signature of a restated table; either alone is innocent.
            for line in source.splitlines():
                if not any(re.search(rf"\b{n}\b", line) for n in dest.names()):
                    continue
                for size in sizes:
                    with self.subTest(file=path.name, line=line.strip()[:70]):
                        self.assertNotRegex(line, rf"\b{size}\b")

    def test_the_markup_offers_no_typed_destination_list(self):
        """#target is now generated end to end, so it must be empty in the markup.

        It used to hold a second group of hand-typed `one-<format>` options, and
        this check read those to prove no destination name had been typed
        alongside them. Format is its own control now, so there is nothing left
        to type here and the stronger assertion is available: the element is
        empty and every option comes from the table.
        """
        text = _read(INDEX_HTML)
        select = re.search(r'<select id="target".*?</select>', text, re.S)
        self.assertIsNotNone(select, "could not find the #target select in index.html")
        self.assertEqual(
            re.findall(r"<option", select.group(0)), [],
            "#target has typed options again; every one of them belongs to the "
            "generated table, not to the markup")

    def test_the_format_control_types_no_destination_names(self):
        """The control that *is* hand-typed must not name a destination.

        Splitting format out of #target moved the risk rather than removing it:
        this list is written by hand, so it is the one that could now grow a
        `documents` or an `email` entry and quietly restate the table.
        """
        text = _read(INDEX_HTML)
        select = re.search(r'<select id="plan-format".*?</select>', text, re.S)
        self.assertIsNotNone(select, "could not find the #plan-format select")
        values = re.findall(r'<option value="([^"]*)"', select.group(0))
        for name in dest.names():
            with self.subTest(destination=name):
                self.assertNotIn(name, values)

    def test_the_ui_renders_the_options(self):
        self.assertIn("function renderDestinationOptions", _read(APP_JS))
        self.assertIn("DESTINATION_ORDER", _read(APP_JS))

    def test_the_page_loads_the_generated_file_before_the_app(self):
        text = _read(INDEX_HTML)
        gen = text.find('src="/destinations.js"')
        app = text.find('src="/app.js"')
        self.assertNotEqual(gen, -1, "index.html does not load destinations.js")
        self.assertNotEqual(app, -1, "index.html does not load app.js")
        self.assertLess(gen, app,
                        "destinations.js must load before app.js, which reads its "
                        "bindings at start-up")

    def test_the_desktop_control_is_generated_not_typed(self):
        """The desktop page renders the server's table instead. Different
        mechanism, same rule."""
        text = _read(DESKTOP_HTML)
        select = re.search(r'<select id="target"[^>]*>(.*?)</select>', text, re.S)
        self.assertIsNotNone(select, "could not find the #target select in app.html")
        self.assertEqual(select.group(1).strip(), "",
                         "the desktop destination list is hardcoded again; it "
                         "should be rendered from the server's table")


class TheGeneratorItself(unittest.TestCase):
    def test_check_mode_fails_on_a_stale_file(self):
        """The guard is only worth having if it has been seen to fail."""
        original = _read(GENERATED_JS)
        try:
            _write(GENERATED_JS, original.replace("2560", "9999"))
            self.assertEqual(gen_destinations.main(["--check"]), 1)
        finally:
            _write(GENERATED_JS, original)
        self.assertEqual(gen_destinations.main(["--check"]), 0,
                         "the file was not restored")

    def test_check_mode_fails_when_the_file_is_missing(self):
        original = _read(GENERATED_JS)
        try:
            GENERATED_JS.unlink()
            self.assertEqual(gen_destinations.main(["--check"]), 1)
        finally:
            _write(GENERATED_JS, original)

    def test_a_crlf_checkout_is_not_mistaken_for_staleness(self):
        """This repo is developed with core.autocrlf=true, so a fresh Windows
        clone has CRLF on disk while the generator emits LF. Comparing raw bytes
        called a perfectly current file stale, over a diff that looked empty
        because every difference was invisible."""
        original = _read(GENERATED_JS)
        try:
            _write(GENERATED_JS, original.replace("\n", "\r\n"))
            self.assertEqual(gen_destinations.main(["--check"]), 0,
                             "a CRLF working copy was reported as out of date")
        finally:
            _write(GENERATED_JS, original)

    def test_line_endings_are_pinned_in_gitattributes(self):
        """The other half of the fix: checkout should not vary in the first
        place. Losing this would leave the tolerance above carrying it alone."""
        attrs = _read(ROOT / ".gitattributes")
        self.assertIn("text=auto eol=lf", attrs)
        for binary in (".wasm", ".woff2", ".png", ".rgb"):
            with self.subTest(suffix=binary):
                self.assertRegex(attrs, rf"\*{re.escape(binary)}\s+binary")

    def test_writing_is_idempotent(self):
        """Two runs must not produce two different files, or --check would fail
        on a freshly generated one."""
        before = _read(GENERATED_JS)
        gen_destinations.main([])
        self.assertEqual(_read(GENERATED_JS), before)

    def test_the_browser_only_extras_are_declared_not_smuggled(self):
        """png8x and the lossless alias exist only in the browser. They are
        allowed, but only from the one place that documents why."""
        self.assertEqual(gen_destinations.BROWSER_ONLY_FORMATS, {"lossless": ["png8x"]})
        self.assertEqual(gen_destinations.BROWSER_ONLY_ALIASES, {"lossless": "original"})
        for name, extras in gen_destinations.BROWSER_ONLY_FORMATS.items():
            for fmt in extras:
                self.assertNotIn(fmt, dest.formats_for(name),
                                 f"{fmt} is in the reference too; it is not browser-only")


class TheTableIsSendable(unittest.TestCase):
    def test_it_is_json_serialisable_for_the_desktop_ui(self):
        """The server sends this over HTTP; a non-primitive would 500 at runtime
        rather than here."""
        json.dumps([
            {"name": d.name, "label": d.label, "help": d.help,
             "formats": list(d.formats), "max_dimension": d.max_dimension,
             "quality_target": d.ss2_target}
            for d in dest.visible()
        ])


if __name__ == "__main__":
    unittest.main()
