"""The destination table lives in more than one language. This makes them agree.

`imgcompress/destinations.py` is the reference. The same five entries are
restated in `web/worker.js` (which formats each destination may write),
`web/app.js` (the frame size and the minimum visual match) and
`web/index.html` (the names offered in the control). Nothing checked that they
matched, which is the same shape of hazard `ss2.js` had before the CI parity
job existed: two hand-maintained statements of one fact, and a disagreement
that shows up as wrong behaviour rather than as a crash.

The failure this catches is quiet and cheap to cause. Within an hour of the
copies being created, `app.js` was already claiming 4096px for `documents`
where Python said 2560, and quality 85 for `thumbnail` where Python said 80 -
so every browser compression would have used numbers the reference had already
rejected. Nothing failed. Nothing looked wrong.

Generating the JavaScript from the Python at build time would be better than
checking it afterwards, and the desktop UI already works that way: the server
sends its table and the page renders it. The browser app cannot do that - it
is static files with no server - so it gets this instead.

Note on the parsing below: every extractor raises if it finds nothing. A
regex that silently matches zero entries would turn this file into a test that
passes because it checked nothing, which is worse than not having it.
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

WORKER_JS = ROOT / "web" / "worker.js"
APP_JS = ROOT / "web" / "app.js"
INDEX_HTML = ROOT / "web" / "index.html"
DESKTOP_HTML = ROOT / "imgcompress" / "webui" / "app.html"


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _block(text: str, declaration: str, source: Path) -> str:
    """The body of a top-level `const NAME = { ... };` declaration."""
    match = re.search(
        r"^const\s+" + re.escape(declaration) + r"\s*=\s*\{(.*?)^\};",
        text, re.S | re.M)
    if not match:
        raise AssertionError(
            f"could not find `const {declaration} = {{...}};` in {source.name}. "
            "If it was renamed or reshaped, update this parser - do not delete "
            "the check.")
    return match.group(1)


def _string_array(text: str, name: str, source: Path) -> list:
    match = re.search(r"^const\s+" + re.escape(name) + r"\s*=\s*\[(.*?)\];",
                      text, re.S | re.M)
    if not match:
        raise AssertionError(f"could not find `const {name} = [...]` in {source.name}")
    found = re.findall(r'"([^"]+)"', match.group(1))
    if not found:
        raise AssertionError(f"`{name}` in {source.name} parsed as empty")
    return found


def worker_formats() -> dict:
    """`web/worker.js` -> {destination: [format, ...]}"""
    text = _read(WORKER_JS)
    named = {n: _string_array(text, n, WORKER_JS)
             for n in ("EVERY_FORMAT", "STORED_AS_GIVEN")}

    out = {}
    for line in _block(text, "TARGETS", WORKER_JS).splitlines():
        line = line.split("//")[0].strip()
        match = re.match(r'"?([A-Za-z0-9_-]+)"?\s*:\s*(.+?),?$', line)
        if not match:
            continue
        name, value = match.group(1), match.group(2).strip().rstrip(",")
        if value.startswith("["):
            out[name] = re.findall(r'"([^"]+)"', value)
        elif value in named:
            out[name] = list(named[value])
        else:
            raise AssertionError(
                f"TARGETS.{name} in worker.js is `{value}`, which this parser "
                "does not understand")
    if not out:
        raise AssertionError("parsed no entries out of worker.js TARGETS")
    return out


def worker_hard_cap() -> int:
    text = _read(WORKER_JS)
    match = re.search(r"^const\s+DOCUMENTS_MAX_DIMENSION\s*=\s*(\d+)\s*;", text, re.M)
    if not match:
        raise AssertionError("could not find DOCUMENTS_MAX_DIMENSION in worker.js")
    return int(match.group(1))


def app_numbers() -> dict:
    """`web/app.js` -> {destination: {label, maxDimension, qualityTarget}}"""
    out = {}
    for line in _block(_read(APP_JS), "DESTINATIONS", APP_JS).splitlines():
        line = line.split("//")[0]
        match = re.match(r'\s*([A-Za-z0-9_]+)\s*:\s*\{(.+)\}\s*,?\s*$', line)
        if not match:
            continue
        name, fields = match.group(1), match.group(2)
        label = re.search(r'label:\s*"([^"]*)"', fields)
        frame = re.search(r"maxDimension:\s*(\d+)", fields)
        quality = re.search(r"qualityTarget:\s*([0-9.]+)", fields)
        if not (label and frame and quality):
            raise AssertionError(f"app.js DESTINATIONS.{name} is missing a field")
        out[name] = {
            "label": label.group(1),
            "maxDimension": int(frame.group(1)),
            "qualityTarget": float(quality.group(1)),
        }
    if not out:
        raise AssertionError("parsed no entries out of app.js DESTINATIONS")
    return out


def js_aliases(path: Path) -> dict:
    match = re.search(r"^const\s+OLD_TARGET_NAMES\s*=\s*\{(.*?)\};",
                      _read(path), re.S | re.M)
    if not match:
        raise AssertionError(f"could not find OLD_TARGET_NAMES in {path.name}")
    return dict(re.findall(r'([A-Za-z0-9_]+)\s*:\s*"([^"]+)"', match.group(1)))


def index_options() -> list:
    """The destination names offered by the Format control, in order."""
    text = _read(INDEX_HTML)
    select = re.search(r'<select id="target".*?</select>', text, re.S)
    if not select:
        raise AssertionError("could not find the #target select in index.html")
    values = re.findall(r'<option value="([^"]+)"', select.group(0))
    named = [v for v in values if not v.startswith("one-")]
    if not named:
        raise AssertionError("the #target select offered no destinations")
    return named


class WorkerParity(unittest.TestCase):
    """web/worker.js — which formats each destination may write."""

    def test_it_offers_the_same_destinations(self):
        # `lossless` is reachable in both but offered in neither.
        self.assertEqual(sorted(worker_formats()), sorted(dest.DESTINATIONS))

    def test_every_format_list_matches(self):
        found = worker_formats()
        for name, d in dest.DESTINATIONS.items():
            with self.subTest(destination=name):
                mine = list(found[name])
                theirs = list(d.formats)
                if name == "lossless":
                    # The browser has one extra: png8x, a palette PNG kept only
                    # where it comes out pixel-exact. Python has no equivalent.
                    mine = [f for f in mine if f != "png8x"]
                self.assertEqual(mine, theirs)

    def test_the_documents_ceiling_matches(self):
        self.assertEqual(worker_hard_cap(), dest.get("documents").hard_cap)

    def test_it_resolves_the_same_old_names(self):
        theirs = js_aliases(WORKER_JS)
        for old, new in dest.ALIASES.items():
            with self.subTest(alias=old):
                self.assertEqual(theirs.get(old), new)


class AppParity(unittest.TestCase):
    """web/app.js — the frame size and the minimum visual match."""

    def test_it_offers_exactly_the_visible_destinations(self):
        self.assertEqual(list(app_numbers()), dest.names())

    def test_every_frame_and_target_matches(self):
        found = app_numbers()
        for name in dest.names():
            d = dest.get(name)
            with self.subTest(destination=name):
                self.assertEqual(found[name]["maxDimension"], d.max_dimension)
                self.assertEqual(found[name]["qualityTarget"], d.ss2_target)
                self.assertEqual(found[name]["label"], d.label)

    def test_it_resolves_the_old_names_too(self):
        theirs = js_aliases(APP_JS)
        for old, new in dest.ALIASES.items():
            with self.subTest(alias=old):
                self.assertEqual(theirs.get(old), new)


class MarkupParity(unittest.TestCase):
    def test_the_control_offers_the_visible_destinations_in_order(self):
        self.assertEqual(index_options(), dest.names())

    def test_the_desktop_control_is_generated_not_typed(self):
        """The desktop page renders the server's table. If somebody ever types
        the list back into the HTML it becomes a fourth copy, and this file
        cannot see it - so catch it here instead."""
        text = _read(DESKTOP_HTML)
        select = re.search(r'<select id="target"[^>]*>(.*?)</select>', text, re.S)
        self.assertIsNotNone(select, "could not find the #target select in app.html")
        self.assertEqual(select.group(1).strip(), "",
                         "the desktop destination list is hardcoded again; it "
                         "should be rendered from the server's table")


class TheReferenceIsReachable(unittest.TestCase):
    """If the parsers ever silently match nothing, these fail first."""

    def test_the_parsers_actually_found_something(self):
        self.assertGreaterEqual(len(worker_formats()), 5)
        self.assertGreaterEqual(len(app_numbers()), 5)
        self.assertGreaterEqual(len(index_options()), 5)

    def test_the_table_is_json_serialisable_for_the_desktop_ui(self):
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
