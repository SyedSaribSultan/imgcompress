"""The use-case pages: generated, current, and telling the truth.

web/ carries three kinds of page: index.html (the app, hand-written), the
use-case front doors (GENERATED from index.html by tools/gen_seo_pages.py -
never hand-edited), and the hand-written proof page. The generator pattern
means a use-case page can never drift from the app it fronts; what is gated
here is everything that would otherwise rot silently:

  - the generated set matches what the generator would write today;
  - every page carries its own canonical URL and exactly one <h1>;
  - page titles are unique - two pages with one title compete with each other
    in the exact place these pages exist to win;
  - the only inline <script> anywhere is a JSON-LD data block, and every
    FAQPage block mirrors questions the page visibly shows - schema for
    content a page does not show is the kind of cleverness that gets sites
    penalised;
  - the sitemap lists exactly the pages that exist, and every page the
    sitemap names is really there.
"""

from __future__ import annotations

import json
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from tools import gen_seo_pages as gen  # noqa: E402

WEB = ROOT / "web"
BASE = "https://pocketsize.vercel.app"

GENERATED = [f"{p['slug']}.html" for p in gen.PAGES]
HANDWRITTEN = ["nothing-is-uploaded.html"]
ALL_PAGES = ["index.html"] + GENERATED + HANDWRITTEN


def _read(name: str) -> str:
    return (WEB / name).read_text(encoding="utf-8")


class TheGeneratedPagesAreCurrent(unittest.TestCase):
    def test_nothing_is_stale(self):
        self.assertEqual(
            gen.main(["--check"]), 0,
            "use-case pages are stale. Run `python tools/gen_seo_pages.py` "
            "and commit the result.")

    def test_every_generated_page_exists(self):
        for name in GENERATED + HANDWRITTEN:
            with self.subTest(page=name):
                self.assertTrue((WEB / name).is_file(), f"web/{name} is missing")


class EveryPageStandsAlone(unittest.TestCase):
    def test_one_h1_each(self):
        for name in ALL_PAGES:
            with self.subTest(page=name):
                self.assertEqual(len(re.findall(r"<h1[\s>]", _read(name))), 1)

    def test_canonical_matches_the_address(self):
        for name in ALL_PAGES:
            expected = BASE + "/" if name == "index.html" else f"{BASE}/{name[:-5]}"
            with self.subTest(page=name):
                m = re.search(r'<link rel="canonical" href="([^"]+)"', _read(name))
                self.assertIsNotNone(m, f"{name} carries no canonical")
                self.assertEqual(m.group(1), expected)

    def test_titles_are_unique(self):
        titles = {}
        for name in ALL_PAGES:
            title = re.search(r"<title>(.*?)</title>", _read(name), re.S).group(1)
            self.assertNotIn(title, titles,
                             f"{name} and {titles.get(title)} share a title")
            titles[title] = name

    def test_no_inline_executable_script_anywhere(self):
        for name in ALL_PAGES:
            with self.subTest(page=name):
                inline = re.findall(r"<script(?![^>]*\bsrc=)[^>]*>", _read(name))
                allowed = [t for t in inline
                           if 'type="application/ld+json"' in t]
                self.assertEqual(inline, allowed)

    def test_faq_schema_mirrors_the_visible_page(self):
        for name in GENERATED:
            html = _read(name)
            blocks = re.findall(
                r'<script type="application/ld\+json">\s*(\{.*?\})\s*</script>',
                html, re.S)
            faq = next((json.loads(b) for b in blocks
                        if '"FAQPage"' in b), None)
            with self.subTest(page=name):
                self.assertIsNotNone(faq, f"{name} carries no FAQPage block")
                for item in faq["mainEntity"]:
                    self.assertIn(item["name"], html,
                                  f"{name} schema asks a question the page "
                                  f"does not visibly show")


class TheSitemapIsTheSetOfPages(unittest.TestCase):
    def test_every_page_and_no_ghosts(self):
        locs = re.findall(r"<loc>([^<]+)</loc>", _read("sitemap.xml"))
        expected = {BASE + "/"} | {
            f"{BASE}/{n[:-5]}" for n in GENERATED + HANDWRITTEN}
        self.assertEqual(set(locs), expected)
        self.assertEqual(len(locs), len(set(locs)), "sitemap repeats a URL")


if __name__ == "__main__":
    unittest.main()
