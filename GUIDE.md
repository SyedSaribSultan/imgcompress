# Guide to this repository

About 3,400 lines total, six source files that matter. Here's the tour.

## The mental model

Everything follows one rule: **never assume quality, measure it.** The tool
encodes an image several different ways, decodes each result back, scores it
against the original, and keeps the smallest file that still clears your quality
floor. Every design decision falls out of that.

The second rule follows from the first: **the best format is content-dependent.**
A photograph wants JPEG, a screenshot wants palette PNG, a smooth gradient wants
lossless PNG. So the tool doesn't pick — it tries them all and keeps the winner.

Video, added later, is that same rule with time in it. Nothing about the model
changes; what changes is that you cannot afford to encode the whole file to find
out what a setting does, and that a per-frame metric cannot see time. Both show
up in the shape of `video.py` below.

## The six files that matter

### `pocketsize/destinations.py` — "where is this going?"

Seven offered entries — `web` (the default), `documents`, `email`, `chat`,
`social`, `thumbnail`, `original` — each naming the formats it may write, how
large the frame may be, and how close the result has to look; plus one hidden
entry, `lossless`, which backs the "identical — every pixel kept" choice in the
UIs and `--lossless` on the CLI (pixel-exact formats only, never resized). It is
deliberately the smallest file here and imports nothing from the rest of the
package, because three other engines mirror it and a table with logic in it is
a table that cannot be mirrored.

A video answers the same question an image does, so video lives in the same
table rather than a parallel one — as extra fields on the same rows:
`video_formats` (codec+container pairs, best-first), `video_max_dimension`,
`video_target`, `size_cap_mb` and `audio`. The numbers differ from the image
ones because the right answers differ: 2560px is a sensible photograph for a
website and a needlessly expensive video for one. An empty `video_formats` is
the honest way to say "this is a place to send a picture" — `thumbnail` has one,
and a video sent there is reported and left alone rather than guessed at.

`size_cap_mb` is the field images never needed. An image destination is defined
by where it is going; a video destination is usually defined by a number
somebody else chose — Discord's 10 MB, a mail server's 25 — and missing it by a
byte means the file is refused. That is also why `email` and `chat` are two
rows: they are one destination for a picture and two for a video, because the
two numbers come from different companies.

A destination is the one question a person can answer without knowing anything
about compression. Before 2.7 there were two overlapping ideas — `--preset` set
size and quality, `--target` set the format list — and both defaulted to
`figma`, so someone compressing a photograph for their website silently got no
WebP for a reason about design tools.

`hard_cap` is the only conditional behaviour: `documents` enforces 4096px even
when asked for more. Aliases keep `figma` and `archive` working.

### `pocketsize/quality.py` — "how good does this look?"

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

### `pocketsize/encoders.py` — "how do I write the bytes?"

Six candidates — `jpeg`, `png8`, `png`, `webp`, `webp-lossless`, `avif` — each
exposing an ascending ladder of quality levels, so the search can bisect over any
of them generically without knowing what the levels mean. `avif` only reports
`available()` where Pillow was built against libavif, which most Windows wheels
are not; the browser engine has had it since the WASM codec tier landed.

Which candidates a run is allowed to use comes from `destinations.py`, not from
here. **That is the single place the format policy lives**, and it is shared with
`web/worker.js`, the browser UI's `web/js/` modules and the desktop UI — the same
entries with the same numbers in all four. The browser's copy is
`web/destinations.js`, generated by `tools/gen_destinations.py` and committed; CI
regenerates it and fails on a diff.

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

### `pocketsize/core.py` — the engine

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

### `pocketsize/video.py` — the same idea, with time in it

The largest file in the package, and most of it is `core.py`'s idea restated:
encode the thing several ways, open every result back up, measure it against the
source, keep the smallest one that still measures close enough. Nothing here
guesses a quality number either. Three things are genuinely different, and each
one is visible in the code.

**You cannot afford to encode the whole file to learn what a setting does.** A
ten-minute clip takes minutes per attempt and the search needs several of them.
So the search runs on **samples**: `sample_windows()` returns 20-second windows,
evenly spaced through the runtime, roughly one per twelve minutes, and only the
winning setting is ever applied to the whole file. Windows are evenly spaced
rather than scene-aware on purpose — scene detection buys encode *efficiency*,
not probe accuracy, and its accuracy is worst on exactly the handheld consumer
footage this tool sees most. Short clips are not sampled at all: once the
windows would cover 85% of the runtime, sampling costs more than it saves and
measures less, so the whole file is used.

`_search_quality()` then bisects the CRF ladder over those windows, the same
shape as the image tier's bisection over a JPEG quality ladder and for the same
reason — the ladder is ordered, the metric is monotone enough across it, and
four probes settle sixteen rungs. The top rung is probed first so that a source
no setting can satisfy (already heavily compressed, or pure noise) costs one
probe rather than a whole search. Probes score three frames per window with a
fast encoder preset; the finished file is verified at eight, and if the honest
check misses the floor the search climbs a rung and re-encodes. Sampled probes
are allowed to be optimistic; the shipped file is not.

**A per-frame metric cannot see time**, so `pooled()` reports the low percentile
of the frame scores rather than their mean. SSIMULACRA 2 scores a still — it
cannot see flicker, or quality sagging between keyframes and snapping back — and
an average calls "perfect for four seconds, falls apart for one" fine, which is
precisely the clip a person notices. Reporting the worst end means the promise
covers the whole runtime. The mean is carried alongside it and is itself
evidence: a mean sitting far above the reported score is what metric-pumping
looks like from outside.

`frame_times()` insets the sampled moments from both ends of each window,
because the first frame after a cut is a keyframe and the most flattering frame
in the encode; measuring there would systematically overstate quality. And
`read_frames_at()` pairs frames **by timestamp, never by position**. Two encodes
of one source do not necessarily hold the same number of frames, and pairing the
Nth of one with the Nth of the other silently compares frame 40 against frame
39 — which reported SSIMULACRA 2 of −295 where the truth was about 72.

**The witness is a different metric from the one the search steers on.**
`xpsnr()` runs FFmpeg's XPSNR filter over the finished file and records a dB
figure on every result. The search watches SSIMULACRA 2, so SSIMULACRA 2 alone
would be a claim rather than evidence — encoders now ship modes tuned to score
well on named metrics, which makes this rule load-bearing rather than
ceremonial. XPSNR comes from a different family, carries a temporal term, and
fails differently. When the build has no `xpsnr` filter the function returns
0.0 and the result simply carries one number instead of two; that is a missing
second opinion, not a failure.

Two shapes of answer, and the rule that ranks them:

* `_at_quality()` is the ordinary case — the smallest file that still measures
  at or above the destination's floor.
* `_under_cap()` is the hard-ceiling case — rate-targeted rather than
  quality-targeted, because you cannot promise a quality *and* a size. One
  encode, one measurement, one retry at a tighter rate if the first overshoots.
  It aims at 95% of the cap, because a file that misses Discord's limit by 40 KB
  is as useless as one that misses it by 4 MB.
* **Quality is searched first even when a cap exists.** A limit is not an
  instruction to spend it: if the honest answer is 3 MB, `--for chat` ships 3 MB
  rather than inflating to 10. The cap only takes over when the quality answer
  does not fit, and then `capped` is set and the result line says the picture is
  not as sharp as the original.
* `_beats()` inverts under a cap, and that inversion is the whole reason it is a
  function. With no cap everything on the table already measures close enough,
  so the smallest file wins; under a cap everything on the table already fits,
  so the best-looking one wins. A candidate that met the floor always beats one
  that only met the byte limit, whatever the numbers say — the first kept the
  promise and the second is a compromise about to be disclosed.

What the engine does to the picture before any of that:

* **Rotation is baked into the pixels**, not passed along as a flag. A phone
  held upright records a landscape frame and sets a display-matrix flag, and a
  flag is advice: some players honour it, plenty of upload forms and editors do
  not, and the person who compressed the video has no way to know which kind
  they are dealing with until it is already sideways in front of an audience.
  Non-square pixels are resolved the same way — output is always square-pixel.
  `display_shape()` is what everything downstream works in; the stored frame is
  only how the picture was filed away.
* **The source is straightened before it is scored, too.** Our output carries no
  rotation flag because it no longer needs one, so scoring it against an
  unstraightened source measures the rotation rather than the encode and reports
  a catastrophe that is not there.
* **HDR is tone mapped, not flattened.** A PQ or HLG transfer — what a modern
  phone records by default — is detected by `_looks_hdr()` and converted by the
  `colour` section: the standard inverse transfer to linear light, BT.2020
  primaries to BT.709, a documented tone curve, then the ordinary transfer back.
  This wheel ships no `zscale` and its colour filters cannot read those
  transfers, so the arithmetic is done here rather than in a filter graph, and
  it is pinned by tests against the standards themselves — the curve's own
  identity, its inverse, the join in HLG's two halves, BT.2408 reference white —
  rather than against itself. The result says the colour was converted.
  A transfer that cannot be named is still refused rather than guessed at, and
  `_looks_hdr()` errs cautious on purpose: a refused file costs one explanation,
  and the other way costs a ruined one with no hint why.
* **Sound is copied where it can be.** Re-encoding lossy audio only ever loses
  and audio is a small share of the bytes, so `_open_audio()` copies the track
  whenever the destination allows it and the container can carry the codec, and
  re-encodes to AAC (or Opus in WebM) when it must. Which of the two happened is
  reported explicitly, never inferred. A second soundtrack and any subtitle
  track are dropped — and *said*, because losing content in silence is the
  failure mode here.

Two details that look like housekeeping and are not. `_output_path()` puts the
format's name in each candidate's filename, because AV1 and H.264 both live in
`.mp4`: name candidates after the source alone and every competitor in a
multi-format destination gets the same path, they overwrite each other, and the
loser's cleanup deletes the winner — leaving the engine reporting a size for a
file that is no longer there. And `_sws_flags()` returns `"LANCZOS"` in capitals
because PyAV looks the resampler up in an enum by name; the lowercase spelling
raises `KeyError`, which surfaces as "every encoder failed on this file" and
nothing more specific.

Finally, `Progress` and `Cancelled`. A video encode is the first thing this
project does that can run for minutes, and silence for minutes is
indistinguishable from a hang. `compress()` takes `on_progress` and
`should_stop`; the engine calls `step()` only where it genuinely knows something
new, the same points where cancellation is checked, so a stopped job dies at a
known boundary rather than mid-mux. Everything written so far is removed when it
does — a half-encoded file that looks finished is the one outcome worse than no
file at all.

Everything in this file degrades. PyAV is an optional install; without it every
function still imports, `available()` says no, and a video is reported and
skipped with the command that would fix it. Never a crash, and never a silent
pass-through of an uncompressed file.

### `pocketsize/cli.py` — arguments and the report

Also home to `PRESETS` and to `--check`, which reports which optional engines are
actually installed. Worth running first on any new machine. It has a `video`
block of its own listing whether PyAV is present, which of the codec pairs this
build can actually *write*, and whether the `xpsnr` filter exists — the last one
is reported as a fact rather than a fault, because its absence means this build
has no second opinion to offer rather than that something is broken.

Pictures and videos travel through the same run: `iter_videos()` walks the same
tree as the image intake, a folder of both is one command, and `describe_video()`
prints a video in the same shape as an image line. The differences on that line
are the ones a person would ask about — how long the clip was, whether the sound
was touched, and, when a size limit is what decided the answer, that the picture
is not as sharp as the original. That last one goes on the result line and not a
later one, for exactly the reason resizing does: a disclosure that arrives after
the number has been read is not a disclosure.

## Where to make changes

| You want to… | Go to |
| --- | --- |
| Change what formats a destination gets | `destinations.py` → `DESTINATIONS` |
| Add a format (JPEG XL) | Subclass `Encoder`, add to `ALL` and to a destination |
| Change quality or size defaults | `destinations.py` → `DESTINATIONS` |
| Add or rename a destination | `destinations.py`, then `python tools/gen_destinations.py` (the browser and desktop UIs read the result; nothing is mirrored by hand) |
| Change how quality is judged | `quality.py` → `Metric` |
| Change the search strategy | `core.py` → `_search_one` |
| Change resize / metadata behaviour | `core.py` → `_normalise` |
| Change which video formats a destination gets | `destinations.py` → `video_formats` on the entry |
| Add a video codec | `video.py` → `FORMATS`, with its own CRF ladder, then list the pair on a destination |
| Change the video search or how it samples | `video.py` → `_search_quality`, `sample_windows` |
| Change how a video's frame scores become one number | `video.py` → `pooled` |
| Change what a size cap does | `video.py` → `_under_cap`, `_beats` |

## Running it

```bash
python compress.py --check                # which engines are live, video included
python compress.py input/ -o output/ -v   # -v shows every candidate, not just the winner
python -m unittest discover -s tests      # 201 tests, ~6 minutes

python tests/make_fixtures.py             # build the benchmark corpus
python tests/bench_formats.py             # reproduce the format table (~4 min)
python tests/bench_versions.py            # reproduce the v1-vs-v2 claim (~6 min)

python tests/make_video_fixtures.py       # four clips, by content type
python tests/make_real_world_fixtures.py  # six clips, by awkward shape
python tests/bench_video.py               # reproduce tests/VIDEO_BENCHMARK.md
```

The two video corpora exist for different reasons and neither replaces the
other. `make_video_fixtures.py` varies the *content* — motion, screen
recording, heavy grain, near-static — which is what decides how well anything
compresses. `make_real_world_fixtures.py` varies the *container and the
metadata* — a phone held upright, one held upside down, non-square pixels, HDR,
variable frame rate, two soundtracks — which is where a video compressor
silently produces wrong output rather than merely a large file. Building the
second one found five defects on its first run.

`-v` is the flag to reach for when a result surprises you. It prints every
candidate's size, so you can see *why* a format won rather than guessing.

## What the tests actually cover

Beyond the obvious (output is smaller, folder structure mirrors, corrupt files
don't crash the run), the suite pins down the decisions that were expensive to
learn:

* the percentile aggregation really is stricter than the mean
* transparent pixels are composited, not dropped
* JPEG output is 4:4:4, asserted by reading the sampling factors back out
* every destination's formats, size cap and minimum visual match, entry by entry
* the `documents` destination never offers WebP or AVIF
* images with alpha are never routed to JPEG
* `documents` caps at 4096px even when you ask for unlimited — and no other
  destination does, which is the half that used to be untested when the cap
  applied to the default and therefore to everybody
* the older names (`figma`, `archive`) still resolve
* the hidden `lossless` destination offers only pixel-exact formats and never
  resizes — identical means identical
* the bake-off winner is the smallest passing candidate, not just any candidate

On the video side, the same posture applied to the things that were expensive to
learn:

* no destination anywhere writes HEVC, asserted over the whole table rather than
  trusted to review
* `thumbnail` refuses video, and says so rather than inventing an answer
* the reported score really is the worst end and not the average
* the winner rule inverts under a size cap, and meeting the quality floor beats
  merely fitting
* a cap that cost quality says so on the result — and falling short of the floor
  is disclosed **even under a cap**, which is the half that used to be
  unreachable because most video destinations carry one
* a bake-off between two formats leaves a real file on disk, which is what
  catches candidates that share a path and delete each other
* a phone held upright does not come out sideways, one held upside down is
  turned back, and non-square pixels are not left squashed — each pinned by a
  pixel assertion, not just by output dimensions, because a squashed picture and
  a straight one can have identical dimensions
* HDR is never silently flattened
* a variable-frame-rate clip keeps its length
* dropping a soundtrack is disclosed
* a long job says what it is doing, and can be stopped

If you change behaviour and one of these fails, read the README section it maps
to before "fixing" the test.

## Two things to know before extending it

**The `documents` format policy rests on one unverified claim** — that Figma
transcodes WebP to PNG on import. It comes from a Figma forum expert, not a
changelog. The downside if it's true is severe and the upside is a few percent,
so JPEG/PNG is the right answer for that destination either way. But if you ever
add a format or loosen it, re-check that first: it's the hinge the whole policy
turns on. Note this is now one destination's rule rather than everyone's — it was
the default until 2.7, which meant people who had never opened a design tool
silently got no WebP.
To settle it: import a WebP into Figma and have any plugin call
`getBytesAsync()` on it. Bytes starting `RIFF` mean WebP survived.

**Keep dependencies pip-only.** This runs on Windows with plain Python. Every
engine was chosen because it has a Windows wheel. The moment something shells out
to `cwebp`, `pngquant` or `avifenc`, `run.bat` stops working.

Video is the rule's hardest test and the reason PyAV is the only video
dependency. Every other route to an encoder means finding an FFmpeg binary,
putting it on `PATH` and shelling out to it — which is exactly what this project
does not do. PyAV ships wheels carrying a complete FFmpeg, x264 and SVT-AV1
included, for Windows x64 and ARM64, macOS and Linux: one `pip install`, no
binaries to find, and the API is in-process rather than a command line to parse
the output of. Two consequences follow from it and both are deliberate. It needs
Python 3.11 while the rest of this package still runs on 3.9, so it is the
separate `video` extra rather than part of `full` — video absent is not video
broken, it degrades like every other optional engine. And that bundled FFmpeg is
GPL, which is fine to depend on and a different act to *bundle*: the standalone
installers must not ship `av` until that is resolved (decision V3 in
`docs/VIDEO_IMPLEMENTATION_PLAN.md`).

---

# The desktop app

Added in 2.1. Three files, plus the packaging around them.

### `pocketsize/server.py` — state and the local API

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

Video runs through the same session and the same queue, with four differences
that are all forced by the files being large:

* **An item knows it is a video the moment it lands**, not after an encode that
  has not started. `Item.kind` is set at intake from the filename, because the
  UI has to show a player where a picture would show a picture, and it has to do
  that before anything has been measured. Folder intake lists videos as well as
  pictures — it listed only pictures at first, so the filter that accepted
  videos never saw one and a dragged-in folder of holiday clips added nothing at
  all.
* **Progress arrives through the ordinary polling**, not a second mechanism. The
  engine's `on_progress` callback writes onto the item and bumps `rev`; the UI
  already re-renders on `rev`. An image finishes fast enough that a bar would be
  noise, and a video does not — silence for minutes reads as a hang.
* **Saving moves the file the engine already wrote** instead of encoding twice,
  and never writes over something already sitting in the folder — it takes the
  next free `-2`, `-3` name. Compressed *images* live in memory until Save, and
  a two-gigabyte video does not.
* **`/api/video/` answers range requests**, streaming off disk in chunks rather
  than reading the file into memory. A `<video>` element asks for ranges, and a
  player that cannot seek cannot be compared against anything — which is the
  entire point of this tier.

### `pocketsize/gui.py` — the launcher

Opens a real window via `pywebview` when it's installed, and the browser
otherwise. The fallback is the same full application, which is why pywebview is a
soft dependency rather than a hard one.

### `pocketsize/webui/app.html` — the interface

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
* **Video is a second pair of layers on the same stage**, not a second stage.
  `#vid-before` and `#vid-after` sit where the two `<img>` layers sit, so the
  split, the divider and the zoom keep working with no branch in any of them.
* **Two players, one clock.** The compressed side follows the original's
  `currentTime` rather than both running free. Two independent players drift
  apart within seconds, and a split showing second 3 against second 5 is not a
  comparison — it is two videos.
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

`pyproject.toml` defines two entry points — `pocketsize` (CLI) and
`pocketsize-gui` — with optional extras: `full` (the good engines), `app`
(pywebview), `video` (PyAV, marked `python_version >= "3.11"`), `dev` (ruff). CI
runs the tests on Linux, macOS and Windows across Python 3.9–3.13, plus a
**core-only job** that proves the tool still works with every optional engine
absent. Keep that job passing: silently requiring an extra is how a "no
dependencies to compile" promise quietly breaks — and `video` is the extra most
likely to break it, because it is the one that cannot be installed at all on two
of the interpreter versions the rest of the package supports.

---

# The web version (`web/`)

A static port of the same engine that runs entirely in the browser, deployed at
[pocketsize.vercel.app](https://pocketsize.vercel.app).

**The engine**, unchanged and independent of any interface: `worker.js` (ladder
bisection, the bake-off, dual-backdrop transparency scoring, the never-bigger
rule — a port of `quality.py` + `core.py` + `encoders.py`), `ss2.js` (the metric)
and `destinations.js` (generated from `destinations.py`).

**The interface**, one page and nothing else. `index.html` is the dashboard;
`web/css/` holds six stylesheets, one per concern, with every colour and space
defined once in `base.css`; `web/js/` holds the ES modules with a strict
dependency direction — `format` and `dom` depend on nothing, `state` holds the
store, `engine` owns the worker pool and the message contract, `queue`/`compare`/
`facts` only render, `render` schedules them, and `main` is the only module that
binds an event listener. The one classic script is `js/theme.js`, loaded from
`<head>` so a saved Light/Dark choice is true before first paint; the cycling
control itself is bound in `main.js` like everything else.

The interface reads the `--oz-*` token layer again — through one indirection.
`web/css/base.css` aliases the app's six-name vocabulary (`--c-*`, `--s-*`,
`--radius`, `--font-*`, `--s-target`) onto HeyOz tokens, and every other sheet
consumes only those aliases; `tests/test_design_system.py` holds them to it.
Theme flips are the token layer's own `data-theme` mechanism: `js/theme.js`
always stamps a RESOLVED theme before first paint (the saved choice, or the
OS's answer for "match my device", re-stamped live when the OS changes),
because the token layer knows nothing about `prefers-color-scheme`.

There is one page. The marketing sections, the `/compare` and `/download` pages,
the synthetic demo, the lifetime savings counter and the CSV/JSON report export
were removed: none of them was part of compressing an image. Two of those ideas
later came back in different, smaller shapes because real users asked: a
three-state theme control (Light / Dark / Match my device, one cycling button),
and a written record — `pocketsize-report.txt` rides in every zip with each
picture's before/after, measured match, and the full versions-tried table.

### The first five seconds after a drop

There is one page, and a drop starts the work with nothing to press. The sequence
that makes that acceptable is an ordering, and the ordering is load-bearing —
`probe_flow.mjs` and `e2e.mjs` assert each step, because every one of them is a
thing someone will later be tempted to collapse.

1. **The untouched original is painted first.** `addFiles()` in `js/intake.js`
   calls the three renderers synchronously — not `scheduleRender()` — so the
   original's `src` is in the document immediately, and then holds `dispatch()`
   until the *next* animation frame so the browser has actually painted before an
   encoder is asked for anything. It costs a frame. Do not "optimise" it away:
   the difference between *here is your image, now watch* and *something happened
   to my file* is entirely in that ordering.
   The harness observes this frame through `imgc.holdWork(true)`, which is why
   that seam exists: `dispatch` is a module binding, so there is no global to
   stub.
2. **What is being tried is named, not spun.** `#stage-work` reports the format
   being measured right now. Never a bare spinner: the wait should be legible
   rather than merely long.
3. **The result appears the moment the first format clears the floor.** The
   worker posts each candidate as it finishes (`candidate` messages); the stage
   adopts the smallest passing one — "Here's the JPEG — still trying 3 more
   ways in the background" — and the chips fill in live, disabled until the run
   settles. The `done` message stays the authority: a later pass (the lossless
   recompressor, the chroma check) may still improve on what the preview
   showed. `mode` starts at `"split"`, and both layers live in one `#frame` at
   natural size so a single transform moves them together. The original never
   leaves the stage.
4. **The evidence appears when there is evidence.** The chips, the measurements
   and the per-image override are three blocks in `#facts`; before any result
   exists the region is hidden rather than sitting as dimmed scaffolding, and
   from the first live candidate onward it is on screen with no drawer to find.
5. **A settings change never blanks a finished result.** The old picture stays
   up, marked "updating to your new settings…", until its replacement lands;
   workers mid-flight get an `abort` message and decline the next probe instead
   of completing an answer nobody will see.

### Candidates: the chips are the format control

`worker.js` used to throw away every encode but the winner. It now carries all
of them home — `attachCandidateBytes()` copies each into its own buffer and
adds it to the transfer list — so `chooseCandidate()` is a relabel and a new
object URL rather than another run of the whole bake-off.

* Copied, not transferred in place. The winner's buffer is already in the
  transfer list and two candidates can be views over one buffer; moving such a
  buffer detaches every other view of it.
* `adoptCandidateBytes()` turns those buffers into **Blobs** on arrival and
  deletes the raw field. Blobs are backed by the browser's own store rather
  than the JS heap, which is what makes holding every encode of every image in
  a large batch affordable. It also keeps `item.candidates` plain JSON, which
  the benchmark and the E2E both serialise.
* Three fields carry the state: `item.auto` (the engine's answer, kept whole
  so it can always be returned to), `item.candBlobs`, and `item.pick` (what
  the person chose to look at instead — `null` while the engine's answer
  stands). `applyView()` points the live fields at one of them, so every
  number, the split view, the heatmap and the download follow from one swap.
* `ORIGINAL_PICK` is a real candidate: keeping the file exactly as it arrived.
  It is what makes "your original is one action away" true rather than
  reassuring.
* **`#ov-format` is deliberately not kept in sync with the chips.** It means
  "run this image again forcing that format", which is a different act from
  showing an encode the run already produced. Making it echo a chip would
  claim a re-run that never happened.
* During a run the same chips render from `item.liveCandidates` — real files,
  streamed in as `candidate` messages with their bytes — but as information,
  not controls: choosing among candidates that are still arriving is a race
  the person cannot win, so they enable when the run settles.

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

### The plan's controls, and why they are shaped that way

Three questions are visible; everything else folds into one named disclosure
("More choices" — a native `<details>`, no script). The first-run flow requires
zero decisions: the defaults compress on drop.

* **Going to** is one `<select>` over the offered destinations. Picking one
  applies all three of its numbers — formats, size cap and minimum visual
  match — because otherwise "Thumbnail or avatar" would mean nothing but a
  shorter format list. Pre-2.7 stored names are mapped by `destinationOf`.
  Format is its own control now ("File type", under More choices); a pinned
  format *keeps* the destination, so someone who chose "Email or chat" and
  then "always JPEG" still gets something that fits in an email.
* **Must still look** is `#quality-preset` (words) sitting on top of
  `#quality` (the hidden 60–99 floor). *One setting, two views* — the words
  write the number and `reflectQualityWords` writes back, showing a hidden
  `custom` option when the floor lands between the landmarks. **Never make the
  words the source of truth:** the engine reads the floor from the DOM, and a
  control that displays one thing while the engine runs another is exactly the
  shape of the floor-99 bug. Its top rung, **"identical — every pixel kept"**,
  is not a floor but a different promise: the bake-off restricts to the
  pixel-exact set (`DESTINATION_FORMATS.lossless`, intersected with what the
  destination can store as-given), shrinking turns off and says why, and
  pixel-changing format pins go dark. The `90` option carries an explicit
  `selected` attribute — a select's initial value is otherwise its FIRST
  option, and a fresh profile must not boot into the lossless promise by
  accident of option order (this shipped as a bug for about an hour and the
  E2E's fresh-profile assertions caught it).
* **Shrink big photos** merges the old pixel-limit and edge-mode pair into one
  row: "to at most [2560] px" or "never — keep every pixel". Which edge the
  number counts is expert nuance and lives under More choices. When the
  `documents` ceiling will override a "never" — design tools crush anything
  over 4096px on import — the plan says so under the control BEFORE it
  happens, and the result carries a warning stated by the worker's own
  `hardCapped` flag, never inferred from the numbers.
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
  failing the image (and under "identical", the fallback is the pixel-exact
  set, never the lossy one).
* **If pixels were removed, the same line that shows the % says so** — stage
  bar, queue row, zip toast, and the full-strength `.note.strong` line above
  the measured stats. A headline number that quietly includes a resize is the
  least trustworthy number on the page; this rule is why it can't happen.

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
* **Video** — the desktop tier compresses video today. The browser has an engine
  of its own, measured in a real browser; the page around it is the piece still
  landing. See below.
* Everything else is at parity: same metric, same floors, same candidate
  ladders, mozjpeg / oxipng / libwebp (incl. lossless) / libaom via WASM.

### Video in the browser

`web/video-worker.js` is the same promise with a different set of hands.
Mediabunny (MPL-2.0, vendored and hash-pinned in `web/vendor/LICENSES.md`) reads
and writes the containers — MP4, QuickTime, WebM, Matroska, iPhone HEVC MOV
included — and does nothing else here. Every frame is decoded and encoded by
**WebCodecs**, which is the browser's own codec: the one the `<video>` element
plays with, generally running on the machine's video hardware.

That choice is the whole architecture, and it buys three things:

* it is fast, because it is silicon rather than a WebAssembly interpreter;
* **no codec ships with the page**, so the download stays small and no patent
  licence travels with it — the browser vendor already holds the ones that
  matter, and a site calling the API distributes nothing;
* and it needs **no cross-origin isolation**, so the site's existing CSP and
  service worker are untouched.

The alternative was FFmpeg compiled to WebAssembly, rejected on three counts
each of which was sufficient: it runs roughly 12–25× slower than native, its
default build links x264 and x265 and is therefore GPL, and its threaded build
needs cross-origin isolation — which would have meant setting COEP across the
whole site and breaking any cross-origin resource that does not opt in.

**What it costs, said plainly here because it is said to the person too.** A
browser's encoder is tuned for video calls, not for archives: Chrome's AV1 is
libaom at realtime speeds, and a hardware encoder is roughly SVT-AV1 preset 9–10
class. A browser encode is realistically **10–30% larger at matched quality**
than the desktop's patient one. The direction of that is well supported; the
magnitude is an estimate, and `docs/VIDEO_RESEARCH.md` records it as such. Two
things stay true regardless: the measured score is real, because we certify what
we actually made rather than what we hoped for, and the desktop app is the tier
that wins on size. That is the same register `tests/BENCHMARK.md` already uses
to concede the 2.5 KB quantizer gap.

Two mechanical details are load-bearing:

* **The rungs are quantizer values, not CRF**, because per-frame QP is the
  handle WebCodecs exposes. The shape is identical — ascending in quality,
  bisected by the same search — so nothing else in the engine has to know.
  `probeSupport()` asks `isConfigSupported()` rather than assuming: encode
  support varies by browser, by operating system, by whether a hardware encoder
  is present and by codec, and the page needs the real answer so it can say
  plainly when nothing works instead of failing halfway through a job.
* **The metric is shared, not copied.** The image worker is a classic worker and
  reads `ss2.js` with `importScripts`; a module worker has no `importScripts` at
  all, and the CSP rules out every runtime escape hatch (`eval`, `new Function`,
  `data:` URLs). Rather than keep a second hand-written copy of a validated
  metric, `tools/gen_ss2_module.py` generates `web/ss2.module.js` from
  `web/ss2.js` and CI checks it — exactly how the destinations table is handled.
  One implementation, two loading mechanisms; drift here would mean the browser's
  two engines quietly disagreeing about what "looks the same" means.

Three smaller things this cost, recorded because they are not obvious:

* The vendored bundle is `mediabunny.min.js`, **not `.mjs`**. A module served as
  `application/octet-stream` under `nosniff` is refused outright, and `.mjs` is
  missing from more static hosts' MIME tables than is comfortable. Module-ness
  comes from the worker's `type: "module"`, never from the extension.
* `media-src 'self' blob:` was added to `vercel.json`'s CSP, because
  `default-src 'none'` blocks playing back a result, and `sw.js` went to `v3`
  with the new files precached.
* `tests/web/probe_video.mjs` originally launched Chrome with a
  SharedArrayBuffer flag, which the real site never has. Testing a browser with
  a capability the product deliberately avoids is testing a different product;
  the flag is gone. As it stands the probe compresses a real clip against the
  real CSP in real Chrome — 18 KB to 6.9 KB as AV1, measured at 74.7 by the same
  SSIMULACRA 2 port the image tier scores with, with progress reported
  throughout and no console errors.

**Where the seam is:** everything above is the engine, and it is finished and
measured. The page's own queue, settings panel and split-compare view
(`web/js/*`) are the surface around it, and they are a separate piece of work —
if you are looking for why a deployed build compresses pictures and not video,
that is where to look rather than in the worker.

Deploys from `web/` as the Vercel project root (`vercel.json` holds the strict
CSP and cache headers — no third-party requests of any kind). The browser test
harness lives in `tests/web/`: the promise-suite E2E, the perf bench with its
snapshot gates, the width-sweep and theme probes, the fixture generators, and a
static server that replays production's headers. `tests/web/README.md` has the
run instructions.

**It is an installable, fully-offline PWA.** `sw.js` precaches the whole
compressor on the first visit — codecs and faces included — with the app shell
network-first (deploys land on the next visit; offline gets the last one seen)
and the heavy `/vendor/` + `/fonts/` payloads cache-first. Bump `VERSION` in
`sw.js` only when the cached SET changes shape; content changes need nothing.
The manifest registers image `file_handlers`, and `main.js` consumes
`window.launchQueue`, so an installed copy appears in the OS "Open with" menu
and launches land straight in the queue. `vercel.json` serves `sw.js` with
`no-cache` so a new worker is picked up promptly.

**The panels are user-sized.** `js/panels.js` binds the two `role="separator"`
handles (sidebar right edge, evidence top edge): pointer-draggable,
arrow-steppable, double-click/Home to reset, persisted in localStorage as
`--side-w` / `--facts-h` on `<html>` — layout.css reads them with automatic
fallbacks, so "never touched" and "reset" are the same state. Focus mode
(`F`, Escape, or the stage button) hides the side and facts regions;
`body[data-focus="1"]` carries it.

### Design system

`web/heyoz-tokens.css` is a **vendored copy** of `dist/tokens.css` from the
HeyOz design-token system (`~/Downloads/heyoz-ds`, commit `3556f78`). Do not
edit it — it is generated by that repo's `node build/build.mjs`, and a change
here is silently overwritten on the next sync. To change a value, change it
upstream, rebuild, and re-copy.

`pocketsize/webui/app.html` consumes those tokens and hand-types nothing: no
hex, no `rgb()`, no `cubic-bezier`. **The browser app consumes them through
`web/css/base.css`**, which aliases its six-name vocabulary onto `--oz-*`
values; the one-place guarantee (values defined once, consumed by name
everywhere else) is enforced by `TheBrowserAppHasOnePlaceForValues` in
`tests/test_design_system.py`, and every other browser sheet may only use the
alias names base.css defines. Four of the system's rules are load-bearing for
the desktop app:

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
photograph: 30.9s → 14.1s) with **byte-identical output** on both the documents
and web destinations. Four changes did it, and each rests on an invariant that
must hold if anyone touches this code:

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

A second round of speed work targets the *perceived* cost — the waits a person
actually sits through — and each piece carries its own invariant:

* **Probe scores are memoised per (format, rung)** on the cached decode
  (`job.scoreMemo`), so a floor nudge re-reads measurements instead of paying
  for five encodes and comparisons per format. *Invariant:* the memo lives on
  the decode-cache entry and dies with it — same pixels, same scores, and a
  frame change (new `frameKey`) starts clean.
* **Stale jobs are aborted, not discarded on arrival.** A settings change sends
  `abort`; the worker checks a flag between probes and between formats and
  declines the next unit of work. A wasm encode cannot be interrupted
  mid-flight, so "stop" means "within one probe". *Invariant:* an abort is
  never a format failure — it rethrows past the per-encoder catch, or a stopped
  run would ship a warnings list full of lies.
* **Codec loads are single-flight** (`CODEC_LOADS` caches the promise, not just
  the result). The idle prefetch and the first job both ask; a second
  `importScripts` of the same glue re-declares its top-level bindings, throws,
  and used to mark the codec unavailable — silently dropping its format from
  every bake-off on that worker. The E2E's format-completeness guard is what
  catches that class of failure.
* **Weak devices (≤3 cores or ≤4GB) drop AVIF from the automatic set** and the
  result says so, with "always AVIF" as the way to insist. *Invariant:* an
  explicit pin or the lossless promise is never overridden — the trim applies
  to delegation only.

`tests/web/bench.mjs` measures all of it and doubles as the regression gate:
it writes a snapshot of every fixture's winner, level, bytes and score, and
fails on any change to them. It also reports **deterministic operation counts**
(encodes, oxipng passes, SSIM passes), which is what an algorithmic claim should
rest on — wall-clock on a thermally throttled laptop varied 2.3× across
identical runs, so timings are reported as min-of-N.

### Gates

Both live in `tests/web/`:

* `verify_tokens.mjs` — the desktop app only, since it is the only consumer of
  the token layer now. Fails on a `var(--oz-*)` the layer does not define, any
  colour literal in `webui/app.html`, a leftover pre-migration variable, a weight
  above 600 reaching the app layer, and a declared face missing from disk. The
  browser app's equivalent rules run in `tests/test_design_system.py`, without
  Chrome and without Node.
* `verify_fonts.mjs` — loads the real page in Chrome and asserts the six faces
  register and parse, that Bricolage and Geist are what actually paint, that
  **no rendered element** computes above 600 (checked twice: empty state, then
  with the app populated), and that every request stays on this origin.
