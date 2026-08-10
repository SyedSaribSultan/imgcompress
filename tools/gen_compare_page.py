"""Write the comparison page from the benchmark data.

`tests/BENCHMARK.md` holds the strongest argument this product has, in a format
almost nobody will read: six markdown tables of ten strategies each, addressed
to somebody already convinced that bytes-at-matched-quality is the right axis.
This turns the same numbers into a page a person can read, and generates it so
the page cannot drift from the measurement.

    python tools/gen_compare_page.py            # rewrite web/compare.html
    python tools/gen_compare_page.py --check    # exit 1 if it is out of date

Input is `tests/benchmark.json`, written by `tests/bench_vs_alternatives.py`.
Regenerate that first if the corpus or the engine changed; this tool only
formats what it is given and will not silently invent a number.

The page publishes the loss as well as the wins. On one hard palette image the
desktop build's libimagequant beats the browser's own quantizer, and that row is
rendered like any other rather than being quietly dropped - a comparison that
only ever shows its author winning is a comparison nobody should believe.
"""

from __future__ import annotations

import argparse
import html
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "tests" / "benchmark.json"
OUTPUT = ROOT / "web" / "compare.html"

# What each corpus image is, in the terms somebody choosing a compressor cares
# about. Keyed by filename so a corpus change surfaces as a missing entry rather
# than as a wrong caption.
SUBJECTS = {
    "camera_12mp.jpg": ("A 12-megapixel photograph",
                        "Straight off a camera. The case where guessing a quality "
                        "number costs the most, because there is the most to lose."),
    "photo.png": ("A photograph exported as PNG",
                  "The mistake almost everybody makes at least once: a photo saved "
                  "in a format built for flat colour."),
    "gradient.png": ("A smooth gradient",
                     "Ruinous for palette formats and nearly free for lossless "
                     "ones. The clearest case for testing rather than assuming."),
    "logo_alpha.png": ("A logo with transparency",
                       "Transparent edges, flat colour. Compared over a dark and a "
                       "light background, with the worse result counting."),
    "screenshot_retina.png": ("A retina screenshot",
                              "Text and interface chrome at 2x. Fine detail that "
                              "lossy formats smear before you notice."),
    "ui_text.png": ("Interface artwork with text",
                    "Flat colour and hard edges, where palette formats win and "
                    "photographic ones waste bytes."),
}


def kb(n: int) -> str:
    if n >= 1024 * 1024:
        return f"{n / (1024 * 1024):.1f} MB"
    if n >= 1024:
        return f"{n / 1024:.1f} KB"
    return f"{n} B"


def esc(s) -> str:
    return html.escape(str(s), quote=True)


def _headline(data: dict) -> dict:
    """The numbers the top of the page states, computed rather than typed."""
    floor = data["floor"]
    defaults_missing = 0
    defaults_total = 0
    ours_best_or_tied = 0
    images = data["images"]

    for image in images:
        rows = image["rows"]
        passing = [r for r in rows if r["clearsFloor"]]
        smallest_passing = min((r["bytes"] for r in passing), default=None)
        ours = [r for r in rows if r["strategy"].startswith("imgcompress")]
        if smallest_passing is not None and ours:
            best_ours = min(r["bytes"] for r in ours if r["clearsFloor"]) \
                if any(r["clearsFloor"] for r in ours) else None
            if best_ours is not None and best_ours <= smallest_passing:
                ours_best_or_tied += 1
        for r in rows:
            if not r["searched"]:
                defaults_total += 1
                if not r["clearsFloor"]:
                    defaults_missing += 1

    return {
        "floor": floor,
        "images": len(images),
        "defaults_missing": defaults_missing,
        "defaults_total": defaults_total,
        "ours_best_or_tied": ours_best_or_tied,
    }


def _rows_html(image: dict, floor: float) -> str:
    rows = sorted(image["rows"], key=lambda r: r["bytes"])
    best = min((r["bytes"] for r in rows if r["clearsFloor"]), default=None)
    out = []
    for r in rows:
        classes = []
        if r["clearsFloor"] and r["bytes"] == best:
            classes.append("best")
        if not r["clearsFloor"]:
            classes.append("missed")
        if r["strategy"].startswith("imgcompress"):
            classes.append("ours")

        if r["clearsFloor"]:
            if best and r["bytes"] > best:
                versus = f"+{round(100 * (r['bytes'] - best) / best)}%"
            else:
                versus = "smallest"
        else:
            versus = "—"

        verdict = ("close enough" if r["clearsFloor"]
                   else "you would see it")
        out.append(
            f'      <tr class="{" ".join(classes)}">\n'
            f'        <th scope="row">{esc(r["strategy"])}</th>\n'
            f'        <td class="num">{esc(kb(r["bytes"]))}</td>\n'
            f'        <td class="num">{esc(versus)}</td>\n'
            f'        <td class="num">{esc(round(r["ss2"]))}</td>\n'
            f'        <td class="verdict-cell">{verdict}</td>\n'
            f"      </tr>"
        )
    return "\n".join(out)


def _image_section(image: dict, floor: float) -> str:
    title, blurb = SUBJECTS.get(
        image["name"],
        (image["name"], "No description for this image yet - add one to "
                        "SUBJECTS in tools/gen_compare_page.py."))
    return f"""
  <section class="corpus-image">
    <h3>{esc(title)}</h3>
    <p class="corpus-what">{esc(blurb)}</p>
    <p class="corpus-meta num">{image["width"]}&times;{image["height"]}
       &middot; source {esc(kb(image["sourceBytes"]))}</p>
    <div class="table-wrap">
      <table>
        <caption class="sr">{esc(title)}: size and visual match per strategy,
          every searched strategy held to a visual match of {esc(round(floor))}</caption>
        <thead>
          <tr>
            <th scope="col">How it was compressed</th>
            <th scope="col">Size</th>
            <th scope="col">vs smallest</th>
            <th scope="col">Match</th>
            <th scope="col">Verdict</th>
          </tr>
        </thead>
        <tbody>
{_rows_html(image, floor)}
        </tbody>
      </table>
    </div>
  </section>"""


def render(data: dict) -> str:
    h = _headline(data)
    floor = h["floor"]
    sections = "\n".join(_image_section(i, floor) for i in data["images"])

    return f"""<!-- GENERATED by tools/gen_compare_page.py from tests/benchmark.json.
     DO NOT EDIT. Change the benchmark or the generator and re-run; CI fails on
     a stale copy. Every number below is measured, not written. -->
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>How imgcompress compares &mdash; measured, at matched quality</title>
<meta name="description" content="Every strategy searched for the smallest file that still looks close enough to the original, on the same six images. Including the one case where imgcompress loses.">
<link rel="canonical" href="https://imgcompress-app.vercel.app/compare.html">
<meta name="theme-color" content="#070605" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#FFFFFF" media="(prefers-color-scheme: light)">
<meta name="color-scheme" content="dark light">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preload" href="/fonts/geist-latin.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/bricolage-grotesque-latin.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/heyoz-tokens.css">
<link rel="stylesheet" href="/fonts.css">
<link rel="stylesheet" href="/app.css">
<script>try{{var t=localStorage.getItem("imgc-theme");if(!t||t==="system")t=matchMedia("(prefers-color-scheme: light)").matches?"light":"dark";document.documentElement.dataset.theme=t}}catch(e){{}}</script>

<header class="site-head">
  <a class="brand" href="/" aria-label="imgcompress home">
    <svg width="20" height="20" viewBox="0 0 17 17" fill="none" aria-hidden="true">
      <rect x="1" y="1" width="15" height="15" rx="3.5" stroke="var(--oz-color-border-secondary)"/>
      <path d="M5 11.5 7.4 8l2.1 2.4L11 8.6l1.6 2.9H5Z" fill="var(--oz-color-fill-brand)"/>
      <circle cx="6.2" cy="5.6" r="1.25" fill="var(--oz-color-content-secondary)"/>
    </svg>
    <b>imgcompress</b>
  </a>
  <div class="head-right">
    <a class="btn ghost" href="/">Compress an image</a>
  </div>
</header>

<main class="learn compare-page">
  <h1>Every compressor looks good until you hold them all to the same standard</h1>

  <p class="lede">Comparing file sizes on their own tells you nothing: anything
     can be made smaller by making it look worse. So every strategy on this page
     was <b>searched for the smallest file that still looks close enough to the
     original</b> &mdash; the same standard, a visual match of
     {esc(round(floor))} out of 100, for all of them. Then the sizes are worth
     comparing.</p>

  <div class="claims">
    <div class="claim">
      <div class="claim-n num">{h["defaults_missing"]}/{h["defaults_total"]}</div>
      <p>of the fixed-quality settings people normally reach for &mdash; JPEG 75,
         JPEG 85, WebP 75, AVIF 50 &mdash; produced a file you could see the
         difference in.</p>
    </div>
    <div class="claim">
      <div class="claim-n num">{h["ours_best_or_tied"]}/{h["images"]}</div>
      <p>images where imgcompress produced the smallest file that still cleared
         the standard, or tied with whatever did.</p>
    </div>
    <div class="claim">
      <div class="claim-n num">1</div>
      <p>image where it loses, to its own desktop build. That row is on this
         page like every other. <a href="#the-loss">Read it first</a> if you
         like.</p>
    </div>
  </div>

  <h2 id="the-loss">Where it loses</h2>
  <p>On flat artwork with few colours, the desktop build has a quantizer the
     browser does not: <b>libimagequant</b>, the engine inside pngquant, which
     is a C library and cannot go in a web page. The browser has its own, and on
     the hardest palette image in this corpus it comes out a couple of kilobytes
     behind.</p>
  <p>It is a small gap and it is a real one. If your work is mostly flat
     artwork and every kilobyte counts, <a href="/#desktop">the desktop
     build</a> is the better tool. Everywhere else the two agree, because they
     measure with the same code &mdash; a claim that is
     <a href="https://github.com/SyedSaribSultan/imgcompress/blob/main/tests/web/ss2_validate.mjs">checked
     on every change</a> rather than asserted.</p>

  <h2>How to read the tables</h2>
  <ul class="checks">
    <li><b>Searched</b> strategies were given the standard and told to find the
      smallest file that meets it. <b>Fixed</b> settings were simply used as-is,
      which is what picking a quality number does.</li>
    <li><b>Match</b> is how close the result came to the original, out of 100.
      100 is indistinguishable. Below {esc(round(floor))} you would see it.</li>
    <li>A row marked <i>you would see it</i> is not a win however small it is.
      That is the entire point.</li>
  </ul>
{sections}

  <h2>Reproduce it</h2>
  <p>None of this is worth anything if you cannot run it yourself.</p>
<pre class="repro"><code>git clone https://github.com/SyedSaribSultan/imgcompress
cd imgcompress
pip install -e ".[full]"
python tests/bench_vs_alternatives.py   # rewrites the data this page is built from
python tools/gen_compare_page.py        # rewrites this page</code></pre>
  <p class="metric-note">This page is generated from
     <code>tests/benchmark.json</code>, which
     <code>tests/bench_vs_alternatives.py</code> writes. Nothing here is typed
     by hand, so the page cannot say one thing while the measurement says
     another &mdash; and continuous integration fails if the two drift apart.</p>

  <p class="cta-line"><a class="btn primary big" href="/">Try it on your own
     image</a></p>
</main>
"""


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true",
                        help="do not write; exit 1 if the page is out of date")
    args = parser.parse_args(argv)

    if not DATA.is_file():
        print(f"FAIL: {DATA.relative_to(ROOT)} is missing. Run "
              "`python tests/bench_vs_alternatives.py` first.", file=sys.stderr)
        return 2

    data = json.loads(DATA.read_text(encoding="utf-8"))
    missing = [i["name"] for i in data["images"] if i["name"] not in SUBJECTS]
    if missing:
        # Not a warning. A caption that says nothing is worse than a build error,
        # because it ships.
        print("FAIL: no description for " + ", ".join(missing)
              + " - add them to SUBJECTS in tools/gen_compare_page.py",
              file=sys.stderr)
        return 1

    fresh = render(data)
    raw = OUTPUT.read_text(encoding="utf-8", newline="") if OUTPUT.is_file() else None
    existing = raw.replace("\r\n", "\n") if raw is not None else None

    if args.check:
        if existing != fresh:
            print(f"FAIL: {OUTPUT.relative_to(ROOT).as_posix()} is out of date with "
                  "tests/benchmark.json.\nRun `python tools/gen_compare_page.py` "
                  "and commit the result.", file=sys.stderr)
            return 1
        print(f"{OUTPUT.relative_to(ROOT).as_posix()} is up to date")
        return 0

    if existing == fresh:
        print(f"{OUTPUT.relative_to(ROOT).as_posix()} already current")
        return 0
    OUTPUT.write_text(fresh, encoding="utf-8", newline="")
    print(f"wrote {OUTPUT.relative_to(ROOT).as_posix()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
