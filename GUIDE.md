# Guide to this repository

About 1,600 lines total, four source files that matter. Here's the tour.

## The mental model

Everything follows one rule: **never assume quality, measure it.** The tool
encodes an image several different ways, decodes each result back, scores it
against the original, and keeps the smallest file that still clears your quality
floor. Every design decision falls out of that.

The second rule follows from the first: **the best format is content-dependent.**
A photograph wants JPEG, a screenshot wants palette PNG, a smooth gradient wants
lossless PNG. So the tool doesn't pick — it tries them all and keeps the winner.

## The four files that matter

### `imgcompress/quality.py` — "how good does this look?"

Two metrics behind one interface:

* **SSIMULACRA 2** (default). XYB colour space, multi-scale, sees chroma.
  Correlates with human judgement at r≈0.88. Scale runs to 100; 90 is
  "visually lossless".
* **SSIM** (fallback). numpy-only, roughly 5× faster, luminance only — so it is
  structurally blind to chroma damage. Aggregated at the 5th percentile rather
  than the mean, so a large flat background can't hide a damaged subject.

Two things here are subtle and worth not breaking:

* `score_sampled()` scores a grid of **native-resolution tiles** rather than the
  whole frame during the search. Never a downscaled copy — compression artefacts
  live at full resolution, so shrinking the image hides exactly what you're
  looking for. Measured drift versus the full-frame score is under 0.5 points
  anywhere near the useful thresholds.
* `flatten()` composites transparent images over a backdrop before scoring,
  twice — dark and light — and the worse score wins. Fully transparent pixels
  carry arbitrary RGB, so comparing them raw produces nonsense. The upstream
  `ssimulacra2` package has a dead alpha branch and gets this wrong, which is
  why it's handled here instead of delegated.

### `imgcompress/encoders.py` — "how do I write the bytes?"

Five candidates — `jpeg`, `png8`, `png`, `webp`, `webp-lossless` — each exposing
an ascending ladder of quality levels, so the search can bisect over any of them
generically without knowing what the levels mean.

`TARGETS` maps `figma` / `web` / `lossless` to which candidates are allowed.
**This is the single place the Figma format policy lives.**

`JpegEncoder` is hardcoded to 4:4:4 chroma. That's deliberate: on saturated
content, matching 4:4:4's quality-76 score with 4:2:0 required quality 97 and
produced a file 3.8× larger. Luma-only SSIM cannot see this, which is how the
mistake survives in most hand-rolled compressors.

Three optional pip packages do real work when installed, and all three ship
Windows wheels:

| Package | What it does | Worth |
| --- | --- | --- |
| `imagequant` | libimagequant, the engine inside pngquant | Large. Pillow's own quantizers hit SSIMULACRA 2 87 at 256 colours where this hits 90 at 64 |
| `zopflipy` | zopflipng-grade deflate | ~10% off any PNG, lossless |
| `mozjpeg-lossless-optimization` | mozjpeg's lossless pass | ~1%, free, never changes a pixel |

### `imgcompress/core.py` — the engine

The pipeline per image:

```
_normalise()      EXIF rotate -> resize -> strip metadata
_search_one()     once per allowed candidate format
  -> pick the smallest result that cleared the floor
guardrails        never bigger than source; animated passthrough; error capture
write
```

`_search_one()` is the heart of it:

1. Probe the top quality level first. If even maximum quality misses the target,
   there's nothing to search for — take it and move on.
2. Bisect over the level ladder, scoring on sampled tiles with a fast encoder
   setting. Cheap.
3. Re-encode the winning level at full encoder effort and verify at full
   resolution. If the honest check misses, step up until it clears — the tool
   never ships something that fails the promise it just printed.

`compress_tree()` uses **processes, not threads**. The metric is numpy/scipy
bound, and this is the difference between using one core and using all of them.

### `imgcompress/cli.py` — arguments and the report

Also home to `PRESETS` and to `--check`, which reports which optional engines are
actually installed. Worth running first on any new machine.

## Where to make changes

| You want to… | Go to |
| --- | --- |
| Change what formats Figma gets | `encoders.py` → `TARGETS` |
| Add a format (AVIF, JPEG XL) | Subclass `Encoder`, add to `ALL` and to a target |
| Change quality or size defaults | `cli.py` → `PRESETS` |
| Change how quality is judged | `quality.py` → `Metric` |
| Change the search strategy | `core.py` → `_search_one` |
| Change resize / metadata behaviour | `core.py` → `_normalise` |

## Running it

```bash
python compress.py --check                # which engines are live
python compress.py input/ -o output/ -v   # -v shows every candidate, not just the winner
python -m unittest discover -s tests      # 20 tests, ~20 seconds

python tests/make_fixtures.py             # build the benchmark corpus
python tests/bench_formats.py             # reproduce the format table (~4 min)
python tests/bench_versions.py            # reproduce the v1-vs-v2 claim (~6 min)
```

`-v` is the flag to reach for when a result surprises you. It prints every
candidate's size, so you can see *why* a format won rather than guessing.

## What the tests actually cover

Beyond the obvious (output is smaller, folder structure mirrors, corrupt files
don't crash the run), the suite pins down the decisions that were expensive to
learn:

* the percentile aggregation really is stricter than the mean
* transparent pixels are composited, not dropped
* JPEG output is 4:4:4, asserted by reading the sampling factors back out
* the `figma` target never offers WebP
* images with alpha are never routed to JPEG
* the `figma` target caps at 4096px even when you ask for unlimited
* the bake-off winner is the smallest passing candidate, not just any candidate

If you change behaviour and one of these fails, read the README section it maps
to before "fixing" the test.

## Two things to know before extending it

**The Figma format policy rests on one unverified claim** — that Figma
transcodes WebP to PNG on import. It comes from a Figma forum expert, not a
changelog. The downside if it's true is severe and the upside is a few percent,
so JPEG/PNG is the right default either way. But if you ever add a format or
loosen `TARGETS`, re-check that first: it's the hinge the whole policy turns on.
To settle it: import a WebP into Figma and have any plugin call
`getBytesAsync()` on it. Bytes starting `RIFF` mean WebP survived.

**Keep dependencies pip-only.** This runs on Windows with plain Python. Every
engine was chosen because it has a Windows wheel. The moment something shells out
to `cwebp`, `pngquant` or `avifenc`, `run.bat` stops working.

---

# The desktop app

Added in 2.1. Three files, plus the packaging around them.

### `imgcompress/server.py` — state and the local API

Standard library only: `http.server`, threads, a `queue`. A tool people install
to compress a folder should not drag a web framework along with it.

* **`Session`** is the whole application state — the item list, the settings, the
  compressed bytes, the watched folder. One per running app, guarded by an
  `RLock`, with a `rev` counter the UI polls against.
* Compressed bytes live in `Session.results` and **never touch disk** until
  `save()` is called. That's what makes "review the batch, then decide" possible.
* Worker threads pull from a `queue.Queue`. Threads rather than processes because
  the state is shared and the metric is numpy/scipy-bound, which releases the GIL.
* Bound to `127.0.0.1` with a per-run token, checked on every API route. The
  token is injected into the HTML at serve time, replacing `__TOKEN__`.
* `pick_folder()` opens the OS folder chooser through stdlib `tkinter`, and
  returns `""` when that isn't available so the UI can fall back to a prompt.

### `imgcompress/gui.py` — the launcher

Opens a real window via `pywebview` when it's installed, and the browser
otherwise. The fallback is the same full application, which is why pywebview is a
soft dependency rather than a hard one.

### `imgcompress/webui/app.html` — the interface

One self-contained file: no build step, no CDN, no framework. Polls
`/api/state` (400ms while working, 1200ms idle) and re-renders on `rev` change.

Design notes that are decisions rather than accidents:

* **The UI is achromatic except for one brass accent**, spent on exactly two
  things: the primary action and the badge on the winning encoding. The interface
  is chrome around photographs; if it has opinions about colour, it competes with
  the images.
* **The viewport is sized in JavaScript** to the image's fitted box, so the split
  divider lines up with the visible image edges rather than with a letterboxed
  container. `applyZoom()` handles both fit and fixed zoom levels.
* **Desktop-first, with a 720px floor.** A three-pane inspector doesn't become
  useful at phone width by stacking; below the floor the app scrolls rather than
  pretending.
* `[hidden] { display: none !important; }` is load-bearing — several elements set
  an explicit `display`, which otherwise beats the user-agent `[hidden]` rule.
* **An `<img>` with nothing to show must leave the layout.** With no `src` it
  lays out its `alt` text; with a `src` that will not decode it paints the
  browser's broken-image glyph beside it. Both landed on the comparison stage
  — a torn-page icon and the words "Original image" over the artwork — for any
  file this browser has no decoder for. `.viewport img:not([src])` and
  `img.dead` are display-none, and `#stage-none` explains the absence in the
  product's own words. The E2E fails on any visible image box with
  `naturalWidth === 0`, which is what that class of bug looks like from
  outside.

### Where to change things

| You want to… | Go to |
| --- | --- |
| Add an API route | `server.py` → `Handler.do_GET` / `do_POST` |
| Change what the UI shows per image | `server.py` → `Item` + `app.html` → `renderInspector` |
| Change polling or worker counts | `server.py` → `Session.__init__`, `app.html` → `poll` |
| Restyle | `app.html` → the `:root` / `[data-theme="light"]` variable blocks |

### Packaging

`pyproject.toml` defines two entry points — `imgcompress` (CLI) and
`imgcompress-gui` — with optional extras: `full` (the good engines), `app`
(pywebview), `dev` (ruff). CI runs the tests on Linux, macOS and Windows across
Python 3.9–3.13, plus a **core-only job** that proves the tool still works with
every optional engine absent. Keep that job passing: silently requiring an extra
is how a "no dependencies to compile" promise quietly breaks.

---

# The web version (`web/`)

A static port of the same engine that runs entirely in the browser, deployed at
[imgcompress-app.vercel.app](https://imgcompress-app.vercel.app). Five files:
`index.html` (landing + app shell), `app.css`, `app.js` (UI, worker pool, zip
download), `ss2.js` (the metric), `worker.js` (the engine: ladder bisection,
the bake-off, dual-backdrop transparency scoring, the never-bigger rule — a
port of `quality.py` + `core.py` + `encoders.py`).

### The set-up step

`#app-stage` sits between the landing page and the dashboard. A drop into an
empty queue creates items at status **`staged`** — neither busy nor ready, so
nothing dispatches and no result is claimed — and `startStagedRun()` is the
only thing that promotes them to `queued`.

* `placeControls()` **moves** `#bar-controls` and `#advanced` between the
  set-up panel and the dashboard toolbar. Do not clone them: two live copies
  of a control the engine reads from is the floor-99 bug waiting to happen.
* `pushSettings()` records the choice but **does not requeue** while staging,
  and `requeue()` skips `staged` items outright. Between them, nothing can
  start the work except the button.
* A drop onto a queue that already has items joins that run instead of asking
  again, and `addFiles(files, {immediate: true})` opts out entirely — the demo
  uses it.
* Set-up rows are built once and reused (`list.dataset.ids`); rebuilding them
  on every render would wipe out a half-typed rename, and a settings change
  triggers a render.

### Zoom

Two rules, both learned the hard way:

* **The frame is centred by transform, never by CSS alignment.** Grid and flex
  silently switch a centred item to `start` once it overflows its container —
  the "safe" behaviour — so the instant you zoomed past the stage the image
  snapped to the top-left and the rest hung off the bottom. `translate(-50%,
  -50%)` has no such rule.
* **Zoom is anchored to the pointer and panning is clamped to the overhang.**
  `zoomAt()` keeps whatever is under the cursor under the cursor; `clampPan()`
  allows movement only as far as the frame overhangs the stage, so an axis that
  still fits stays centred and the image can never be dragged into empty space.

### The two controls, and why they are shaped that way

The toolbar asks for two decisions and defaults both to delegation.

* **Format** is one `<select>` spanning `figma` / `web` / `lossless` (the
  automatic sets) and `one-jpeg` / `one-webp` / `one-png` / `one-avif`. The
  `one-` prefix is parsed in `parseFormatChoice`, which is also why the value
  space *extends* the old target names rather than replacing them — every
  saved setting and every test that drives `#target` still means what it did.
  A single pick sets `settings.formats` and moves the target to `web`, the
  same thing the per-image format override has always done, which also drops
  the design-tool dimension cap along with the preset.
* **Quality** is `#quality-preset` (words) sitting on top of `#quality` (the
  60–99 floor, in Advanced). *One setting, two views* — the words write the
  number and `reflectQualityHint` writes back, showing a hidden `custom`
  option when the floor lands between the landmarks. **Never make the words
  the source of truth:** the engine reads the floor from the DOM, and a
  control that displays one thing while the engine runs another is exactly
  the shape of the floor-99 bug.
* **JPEG cannot store alpha**, so choosing it with transparent artwork queued
  opens `#alpha-ask` rather than resolving it silently in either direction.
  *Invariants:* `item.alpha` is measured from decoded pixels in the worker and
  reports the **source**, so it does not move when flattening rewrites those
  pixels; dismissing the dialog by any route (Esc, backdrop, Cancel) restores
  the control to the setting actually in force; flattening runs before any
  encode or score, so the reference the result is measured against is the
  flattened original rather than transparency the output could never carry.
  A chosen format that gets filtered out — no alpha channel, or no codec in
  this browser — falls back to the automatic set with a warning rather than
  failing the image.

### The metric is SSIMULACRA 2 itself

`web/ss2.js` is a JavaScript port of the Python `ssimulacra2` package — the
implementation the desktop scores with. Anyone touching it must know:

* **It is validated, not trusted.** `tests/web/ss2_validate.mjs` scores a
  60-pair corpus (four content types × jpeg/webp/avif/palette distortions ×
  quality levels, plus small-image cases) against Python-reference scores.
  Float64 planes matched to |Δ| = 0.0000; the shipped Float32 planes match to
  mean |Δ| 0.0045, worst 0.0229, on the 100-point scale. Any change to ss2.js
  must re-run that harness.
* **Two boundary quirks are deliberate.** The reference transposes to (W, H)
  before scoring, so its blur zero-pads along the image's *x* axis and
  reflects along *y*; the port keeps row-major planes and swaps the boundary
  treatment to compensate. And the Gaussian is scipy's exact construction:
  radius `int(3.33 × 1.5 + 0.5) = 5`, discrete-sampled, normalised. "Fixing"
  either breaks agreement with the desktop.
* **Memory is budgeted, and that is load-bearing.** Full-frame scoring above
  `VERIFY_BUDGET` (2.75MP) runs on a 3×3 spread of native-resolution 512px
  tiles instead. Float64 full-frame on a 12MP image needed ~1.8GB, the
  allocations threw inside the worker, every lossy candidate died silently,
  and multi-megabyte lossless files won by forfeit. The 5MP E2E fixture exists
  to catch exactly that: it asserts lossy candidates are *measured* past the
  budget, not forfeited. The plane pool also refuses to retain buffers above
  ~12MB (`SS2_POOL_MAX_LEN`), or one 12MP job could pin hundreds of megabytes.
* The per-channel SSIM chroma guard applies **only under the `ssim` fallback
  metric** — SSIMULACRA 2 works in XYB and weighs chroma natively, and the
  reference has no such extra pass.

What's honestly different from the desktop version now:

* **Workflow** — folder watching, batch saves to disk, a scriptable CLI.
* **libimagequant / zopfli** — the browser quantizer is median-cut with two
  Lloyd refinement iterations plus an oxipng pass, which measures competitive
  with pngquant+zopfli on flat art but can still trail on photographic
  palettes.
* Everything else is at parity: same metric, same floors, same candidate
  ladders, mozjpeg / oxipng / libwebp (incl. lossless) / libaom via WASM.

Deploys from `web/` as the Vercel project root (`vercel.json` holds the strict
CSP and cache headers — no third-party requests of any kind). The browser test
harness lives in `tests/web/`: the promise-suite E2E, the perf bench with its
snapshot gates, the fixture generators, and a static server that replays
production's headers. `tests/web/README.md` has the run instructions.

### Design system

`web/heyoz-tokens.css` is a **vendored copy** of `dist/tokens.css` from the
HeyOz design-token system (`~/Downloads/heyoz-ds`, commit `3556f78`). Do not
edit it — it is generated by that repo's `node build/build.mjs`, and a change
here is silently overwritten on the next sync. To change a value, change it
upstream, rebuild, and re-copy.

`web/app.css` consumes those tokens and hand-types nothing: no hex, no
`rgb()`, no `cubic-bezier`. Four of the system's rules are load-bearing here:

* **Adjacent regions never share a surface rung.** Separation is a surface step
  or space, never a border — `background` → `surface-primary` (toolbar, queue,
  panes) → `surface-secondary` (header, results bar, advanced tray) →
  `surface-tertiary` (inputs, fills). Every remaining border says what job it
  does; only `affordance` and `state` are legal.
* **Spatial travel goes through `--oz-motion-spatial-scale`**, so reduced
  motion collapses movement and keeps fades. `.btn:active` is the documented
  exception — that transform *is* the state, so it keeps its distance.
* **Effects springs must not overshoot, spatial springs must.** Colour and
  opacity take `--oz-spring-effects-*`; transform and size take
  `--oz-spring-spatial-*`.
* **Two elements are scoped dark islands** (`class="dark"`): the stage tags and
  the split divider. Both sit on a photograph behind a scrim that is dark in
  both themes, so their colour must not follow the page. A mode-specific
  override was the alternative and the system forbids it, because the two modes
  then drift.

### Typography

The faces the tokens name are **self-hosted**, in `web/fonts/` and declared by
`web/fonts.css`: Bricolage Grotesque (display, heading), Geist (body, label),
Geist Mono. Upstream fetches these from Google Fonts by `<link>`; this app
cannot, because a third-party request would break both the CSP
(`default-src 'none'`) and the promise that nothing leaves the device. Six
variable `woff2` faces, latin and latin-ext, 191 KB total, each keeping the
exact `unicode-range` Google ships so an out-of-subset glyph falls through the
token stack instead of rendering tofu. The two above-the-fold faces are
preloaded.

**Nothing renders above semibold (600), anywhere.** Three things enforce it,
because there are three ways to break it:

* Call sites use `--oz-weight-semibold`; the two heavier steps
  (`--oz-default-weight-display` at 800, `--oz-weight-bold` at 700) are simply
  never referenced. The tokens are *not* redefined — a token that no longer
  means what it says is worse than a call site that picked a different one.
* The self-hosted faces are cut to `wght 400..600`, so there is no heavier
  master to render even if something asked.
* `b, strong, th, h1–h6, optgroup` are reset to 600, because the user agent
  renders those at `bold` and a stylesheet that never writes 700 otherwise
  still gets 700. This is the one that actually bit — it is invisible to source
  grepping and was caught only by measuring computed styles in the browser.

### The app shell is flex, deliberately

`.app` and `#inspector-body` are flex columns, not grid row templates, and that
is load-bearing. Both contain children toggled with `hidden` — the advanced tray
and the detail panel — and a hidden element generates no grid box, so
auto-placement silently shifts every later child up a track. That bug shipped:
the body fell into an `auto` row while the results bar inherited the `1fr`,
leaving ~185px of empty track under the panes and a 130px-tall results bar. Flex
ignores absent children, so the growing region stays the growing region.

Two related rules, both straight out of the system's layout primitives:

* `.workspace` needs a **definite** `height`, not a `min-height`. `height: 100%`
  on a child cannot resolve against a parent that only has a minimum, so the
  `1fr` had no definite space to claim.
* Its `grid-template-columns` is wrapped in `minmax(0, 1fr)`. An implicit grid
  column is `max-content`, so without it the widest descendant sets the shell's
  width and the whole page scrolls sideways on a phone.

### Speed, and the invariants that make it safe

The engine got about **2.2× faster** (min-of-3 on a mixed corpus with a 12MP
photograph: 30.9s → 14.1s) with **byte-identical output** on both the Figma and
Web targets. Four changes did it, and each rests on an invariant that must hold
if anyone touches this code:

* **oxipng runs only where it could change the winner.** It was 37% of all
  worker CPU, most of it spent losslessly shrinking a 25MB PNG of a photograph
  that loses to JPEG by 34×. It now runs after ranking, on PNG-family
  candidates where `size × 0.7 ≤ best`. *Invariant:* oxipng never takes more
  than 30% off a canvas-written PNG. If that were ever false the constant is
  `OXI_BEST_CASE`.
* **The per-channel chroma check runs on the winner only**, not on every
  candidate — it costs three to six extra full-frame passes each and only one
  candidate ships. If the winner fails it is escalated up its ladder, or
  dropped and the next-best checked. *Invariant:* the gate applies only when
  something cleared the floor; a best-effort result is never rejected over
  chroma, or a usable file would become a failed one.
* **Encodes are memoised per (level, effort).** Only AVIF's output depends on
  the effort flag, so `fastAffects` is set there and nowhere else. *Invariant:*
  if any other encoder is ever given a real fast path, it must set that flag,
  or the shipped bytes will silently be the probe's cheap encode.
* **The search bisects the whole ladder** instead of probing the top rung
  first. Score rises with quality, so a rung that passes proves every rung
  above it would — that first probe bought nothing and cost the most expensive
  encode of the image. Note the scores are *not* perfectly monotonic (tiled
  sampling), so a different probe order can land on a different rung; both old
  and new only guarantee that the chosen rung passes the full-frame check.
* **JPEG quantisation tables compete at the finish line.** Which mozjpeg
  table wins is content-dependent — the benchmark's real photograph ships
  smaller with the default ImageMagick table, its hard synthetic ships 23%
  smaller with Annex K — so after the search converges, the alternate table
  is encoded at the chosen rung and the rung below, verified with the same
  scorer, and the smallest passing file ships (`encoder.alternates` in
  `worker.js`). *Invariants:* at most two extra encodes; an alternate that
  is not smaller is discarded before verification; a best-effort failure is
  never "improved", only a passing result.

`tests/web/bench.mjs` measures all of it and doubles as the regression gate:
it writes a snapshot of every fixture's winner, level, bytes and score, and
fails on any change to them. It also reports **deterministic operation counts**
(encodes, oxipng passes, SSIM passes), which is what an algorithmic claim should
rest on — wall-clock on a thermally throttled laptop varied 2.3× across
identical runs, so timings are reported as min-of-N.

### Gates

Both live in `tests/web/`:

* `verify_tokens.mjs` — fails on a `var(--oz-*)` the token layer does not
  define, any colour literal in `app.css`, a leftover pre-migration variable, a
  weight above 600 reaching the app layer, and a declared face missing from
  disk.
* `verify_fonts.mjs` — loads the real page in Chrome and asserts the six faces
  register and parse, that Bricolage and Geist are what actually paint, that
  **no rendered element** computes above 600 (checked twice: empty state, then
  with the app populated), and that every request stays on this origin.
