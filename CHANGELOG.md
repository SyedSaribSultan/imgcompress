# Changelog

All notable changes to this project are documented here.
This project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed
- **The interface speaks English.** Eleven invented words for three ideas meant
  it was possible to look at this product and not know what it was telling you.
  One concept now gets one word everywhere a person can see it — the browser
  app, the desktop app, the command line, every error message and the README:

  | Was | Is |
  | --- | --- |
  | bake-off | the comparison |
  | candidate | version |
  | floor / quality floor | your target / minimum visual match |
  | passes, still passes | close enough to the original |
  | survives | wins |
  | untouched | left exactly as it is |
  | force a format | always use |
  | redo just this image | try different settings |
  | SSIMULACRA 2 82.8 | visual match 83 out of 100 |

  The measure's real name moved into the details panel, where it belongs: which
  measure produced the number is a fact about our implementation, and how close
  the result came is the fact somebody is actually here for. The SSIM fallback
  keeps its name, because that scale runs 0–1 and calling it the same thing
  would mislead.
- **What the tool does is described as a benefit, not as machinery.** "Every
  image is encoded several different ways, scored against the original with a
  perceptual metric, and only the smallest version that still passes survives"
  became "every image comes out as small as it can go without you being able to
  see the difference — and you get the side-by-side to check that for
  yourself."
- **Every version that lost now says why**, in one sentence: bigger than your
  original, too different from it (with both numbers), lost too much colour
  detail, or close enough but larger than the one chosen. A list of rejects
  with no reasons showed the machinery working without saying anything. The
  sentence for whichever version is on screen is shown under the row rather
  than hidden in a tooltip.
- **Error messages say what happened, then what to do next.** No apology, no
  blame, no error code as the headline. "Error: unsupported format" became
  "Those file types aren't supported yet. Try PNG, JPEG, WebP, AVIF, GIF, BMP
  or TIFF."
- **"How this was measured" is written for a person.** It explains that the
  comparison looks at local contrast and detail the way eyes do rather than
  counting pixel differences, and that 100 means indistinguishable — and it now
  carries the fact that makes this tool beat the obvious alternative: colour is
  never thrown away, because matching the same quality with colour detail
  discarded needed setting 97 instead of 76, a file 3.8× larger.

  Zero output bytes changed; both byte snapshots are identical.

- **Presets are now destinations, and the default is no longer a design tool.**
  There used to be two overlapping settings — `--preset` chose size and
  quality, `--target` chose which formats were allowed — and both defaulted to
  `figma`. That meant a person compressing a photograph for their website got
  JPEG or PNG and nothing else, for a reason that is true of Figma and of
  nothing they were doing. The restriction was researched and correct; making
  it everyone's default was not.

  One list replaces both, named after the only question somebody can answer
  without knowing anything about compression — where is this image going?

  | `--for` | Formats | Size | Visual match |
  | --- | --- | --- | --- |
  | `web` *(new default)* | all, incl. WebP and AVIF | 2560px | 90 |
  | `documents` | JPEG / PNG only | 2560px, ceiling 4096px | 90 |
  | `email` | JPEG / PNG only | 1920px | 88 |
  | `thumbnail` | all | 512px | 80 |
  | `original` | all | never resized | 95 |

  `--preset` still works as a synonym and the old names (`figma` → `documents`,
  `archive` → `original`) still resolve, so existing scripts do not break. The
  CLI says out loud when you have used one.
- **`documents` keeps every restriction `figma` had**, because the restriction
  is the feature: those tools re-encode WebP to PNG on import, so a beautifully
  compressed 40 KB file becomes a multi-megabyte one inside the saved document.
  What changed is who pays for it — the people actually sending images there.
- **Choosing a destination applies all three of its numbers**, in both
  interfaces. Setting only the format list would make "Thumbnail or avatar"
  mean nothing but a shorter list, and leave the person to work out that two
  more controls in Advanced needed changing for it to do what it says. Both
  remain editable afterwards; this moves the starting point, it does not lock
  it.
- **The desktop app builds its destination list from the server's table**
  rather than carrying its own copy of five numbers that have to agree.
- **`imgcompress --help` no longer names a specific product**, and prints what
  each destination actually does. Its output is ASCII, because a middot that
  arrives as a replacement character on a cp1252 console undoes the point of
  writing readable help.

### Added
- **The two engines are held together by CI on every pull request.** The claim
  that the browser scores an image the way the Python reference does had
  nothing enforcing it — `ss2_validate.mjs` existed and had to be remembered.
  A drift there is the worst kind of break: the app keeps working, it just
  stops being right. The job runs on every PR rather than only ones touching
  `ss2.js`, because the case that actually worries us is `quality.py` or a
  pinned dependency moving the numbers out from under a file nobody edited.
- **AVIF is a Python encoder**, feature-detected. Pillow only carries AVIF
  where the wheel was built against libavif, so on most machines this changes
  nothing; where it is present, AVIF now competes in the bake-off on the same
  terms as everything else — it ships only if it is both smaller and still
  clears the floor. This is what lets the destination table be literally the
  same in all four places rather than "the same except Python."
- **The browser's destination table is generated, not maintained.**
  `tools/gen_destinations.py` writes `web/destinations.js` from
  `imgcompress/destinations.py`; `worker.js` imports it, `index.html` loads it
  before `app.js`, and the Format control's options are rendered from it rather
  than typed into the markup. The generated file is committed, because `web/`
  has no build step and should not grow one — CI regenerates it and fails on
  any difference, so the commit is the check. Testing copies catches drift
  afterwards; not having copies prevents it.
- **A parity test for the destination table**, `tests/test_destination_parity.py`.
  The table now exists in Python, in `worker.js`, in `app.js` and in the
  markup, and nothing checked that they agreed — the same hazard `ss2.js` had
  before the CI job above, and it bit immediately: `app.js` was already
  claiming 4096px for `documents` and quality 85 for `thumbnail` while Python
  said 2560 and 80, so every browser compression would have used numbers the
  reference had already rejected, silently. Now that the copies are generated,
  the test guards the generator instead: the committed file must be current,
  and no consumer may hand-write a destination's name, frame size or format
  list. It found one more copy while being written — `app.js` restated the
  default destination's numbers in its initial state, where a stale value would
  have been wrong for exactly the people arriving for the first time.
- **`tests/web/check_ss2_corpus.py`**, wired into CI. `make_ss2_vectors.py`
  skips AVIF where Pillow cannot write it, which is right on a Windows laptop
  and wrong in CI: a failed plugin install would run 48 vectors instead of 60,
  print VALIDATED, and show the same green tick with AVIF parity untested from
  then on. The plugin install is no longer allowed to fail, and the vector
  count and codec coverage are asserted rather than merely reported.
- Tests pinning every destination's formats, size cap and minimum visual
  match, that only `documents` enforces a ceiling, that an explicit `-m 8000`
  is clamped to 4096 rather than refused, that a smaller request is never
  inflated, and that the old names still resolve. Previously the 4096px cap was
  tested but *only* the half that fires — nothing asserted that `original`
  leaves an image alone. The Python suite goes from 24 tests to 64; the browser
  suite from 72 assertions to 76.

### Fixed
- `make_ss2_vectors.py` no longer dies on a Pillow built without libavif. It
  says the twelve AVIF pairs are missing instead of quietly shrinking the
  corpus and still printing VALIDATED.

### Notes for anyone measuring this
- **Output is byte-identical at matched settings.** `bench.mjs` passes clean on
  both `documents` and `web`, at the real defaults — it takes the destination's
  own frame rather than a pinned one, which it can do because `documents` and
  `web` agree on 2560 and the format list is genuinely the only difference.
- **`--preset thumbnail` changed** from 800px to 512px. The quality target
  stays at 80. Nothing in the history records why 800 was chosen — it arrived
  in the initial import — so 512 is the change that can be argued for and the
  target was left alone: artefacts are *less* visible at a smaller size, so if
  anything it could fall, and raising it would have been a second change with
  no reason behind it.

- **A rule, in CONTRIBUTING.md: every new gate must be observed failing.**
  Four checks on this branch reported success while checking nothing — a
  snapshot with a hand-pinned frame, an AVIF skip that still printed
  `VALIDATED`, parser-based assertions that could match zero lines, and a
  `diff` against a file the job had not written yet. Two were caught in review
  and one by a file timestamp, which is not a process. Breaking a gate and
  watching it go red costs a minute and is the only thing separating it from a
  comment.
- **`tests/test_corpus_guard.py`**, because `check_ss2_corpus.py` was itself
  only verified by hand — the same posture `ss2_validate.mjs` was in before it
  was wired into CI. Nine tests, including the argparse bug it shipped with:
  `action="append"` adds to a list default rather than replacing it, so
  `--require-codec jpeg` meant "jpeg *and* the three defaults" and the
  narrowing path had never run.

### Fixed since
- **The clamp announces itself.** `-m 8000 --for documents` printed
  `up to 8000px` and produced 4096 — a dimension changing without saying so,
  which is the defect this whole rework exists to remove, surviving on the
  override path because that path is rarer. The rule now lives in one function,
  `destinations.effective_limit`, which both the engine and the CLI header
  call, so they cannot disagree. The header states the real limit and, when it
  differs from the request, says which destination clamped it and why.

### A bug this branch introduced and then removed
Recorded because the shape of it is worth remembering, not because it shipped.

`documents` briefly carried **one** size number where the old `figma` preset
had two. `figma` downscaled to 2560 and separately clamped at 4096 — the clamp
being the thing that fires when somebody explicitly asks for more, which is why
the original code described it as applying *regardless*. Collapsing them handed
the ceiling over as the everyday setting, so every design-asset compression
would have shipped roughly 2.5× the pixels it should, and downscaling saves
more than the encoder does.

`bench.mjs` caught the resulting byte change immediately, and it was
misdiagnosed as a test-isolation problem: the fix applied was to pin the frame
size so the comparison stayed clean. That was a correct testing instinct
reached for at the wrong moment. It isolated the variable and certified a
configuration no user would ever run — a green gate over a setting that does
not exist, which is worse than a red one. The pin is gone and the two numbers
are back to doing two jobs.

## [2.6.0] - 2026-08-07

### Changed
- **The set-up step is gone; dropping a file starts the work immediately.**
  2.5.0 added a step between "here are your images" and "here is the work"
  because starting unasked spends someone's laptop before they have been told
  they had a choice. That diagnosis was right and the remedy was wrong: a gate
  answers the question "may I?" by making everybody answer it, including the
  overwhelming majority who only ever wanted the default. The two real fears —
  *is this safe* and *would I ever find out I had a say* — are now answered by
  what is on screen and what happens when you touch it:
  - The **untouched original is painted first**, full size and labelled as
    such, and the encoders are not asked for anything until the frame after
    the browser has actually painted it.
  - A **plain sentence** says what is happening while it happens — "Trying a
    few ways to shrink this, keeping only the one that still looks right" —
    which is the landing page's promise in the present tense rather than a
    spinner.
  - The result **arrives beside the original**, not over it. The split
    comparison is the state you land in, not a tab to be discovered.
  - The sentence then **ends in a real action**: "Went with WebP — smallest
    option that still passes. *Prefer something else?*"
- **Every encode that was tried is a chip beside the picture, and tapping one
  swaps the preview instantly.** The bake-off already produced those files and
  used to throw all but one away, so changing format meant running the whole
  search again — seconds of waiting for work already done. The candidates now
  travel home with the result, and a tap is a relabel: the picture, the
  weights, the split view, the heatmap and the download all follow inside the
  click. That immediacy is the point. A control that answers the moment you
  touch it teaches that it exists; a dropdown pre-filled with what already
  happened reads as status, and nobody pulls it.
- **Keeping your original is one of the chips.** It sits at the end as the
  yardstick and is selectable, so "the original is one action away from being
  the only thing kept" is literally true rather than reassuring copy.
- **Renaming moved to the filename in the result view**, editable in place. It
  was only ever possible inside the set-up step.
- The per-image **Format and Quality overrides are still there**, in the
  detail panel, as a dropdown — where a dropdown belongs. It can name a format
  the bake-off never tried, which no chip can, and anything set there is a
  genuine re-run rather than a swap.

### Fixed
- Lifetime savings followed the file you actually kept. Choosing a different
  encode after the fact used to leave the total describing a file you no
  longer had.

## [2.5.0] - 2026-08-06

### Added
- **A set-up step between dropping images and compressing them.** Dropping
  files used to start the work immediately, which spent a minute of someone's
  laptop before they had been told they could pick a format, a quality, or a
  name. A drop into an empty queue now lands on a step that shows what was
  picked up, hands over the settings, and waits. Images can be renamed there
  (the extension is not editable — the format decides it) and dropped from the
  list. Adding more files while it is open extends the list; a drop onto a run
  that is already configured joins it rather than asking again, and the demo
  button skips it, because someone who pressed "see it work" asked to see it.
  The settings bar is *moved* into the step rather than copied, so there is
  still exactly one Format control and one Quality control in the document.
- **Copy** beside Save on each image, for pasting straight into Figma, Slack or
  a document. Clipboards accept `image/png` and nothing else, so a JPEG or WebP
  result is re-encoded losslessly for the paste and the toast says so rather
  than implying the compressed bytes travelled.

### Fixed
- **Zooming threw the image off the stage.** CSS alignment silently switches
  from `center` to `start` once an item is larger than its container — the
  "safe" behaviour — so the moment you zoomed past the frame the image snapped
  to the top-left and the rest hung off the bottom, which is why scrolling felt
  like it jumped to the top and needed a long drag back. The frame is now
  centred by transform, which has no such rule. Zoom is also anchored to the
  pointer, so whatever is under the cursor stays under it, and panning is
  clamped to the frame's own overhang so the image can no longer be dragged
  into empty space.
- The toast sat exactly on the toolbar and covered the Quality control while
  reporting on the file you had just saved. It now sits at the bottom, clear of
  every control.
- Thumbnails in the set-up list stayed blank when they finished decoding after
  the list had rendered.

### Changed
- The keyboard lands on the start button when the set-up step opens, and Enter
  starts the run from anywhere in the step except a name field, where it
  commits the rename instead.

## [2.4.0] - 2026-08-06

### Added
- **Both decisions are now the person's to make, and both still default to
  "let the app work it out".** The toolbar carries two controls:
  - **Format** spans the range from delegation to instruction. *Let the app
    choose* keeps the bake-off (design tools, web, or lossless-only sets);
    *Use one format* runs JPEG, WebP, PNG or AVIF alone. The group labels say
    which is which, so the trade-off is legible without knowing what a
    bake-off is. A format this browser cannot encode is disabled with the
    reason on the label rather than failing later. The single-format group is
    deliberately **not** sold as "faster": measured on the benchmark corpus,
    restricting to JPEG saves only 1.1–1.4× against the design-tool set,
    because JPEG's own quality search is nearly the entire cost.
  - **Quality** is now words — *Maximum, for masters you'll re-edit* through
    *Smallest, fine for thumbnails*. The 60–99 SSIMULACRA 2 floor stays in
    Advanced, and the two are one setting seen two ways: a named quality sets
    the floor, and a floor set between the names reads back as *Custom — floor
    87* instead of being snapped to the nearest preset.
- **Choosing JPEG for transparent artwork asks instead of assuming.** JPEG has
  no alpha channel, so the request is a question with two defensible answers,
  and the app puts it in a modal: keep those images as PNG, or flatten the
  transparency onto white and take the JPEG. Both answers say what they did on
  the affected image; cancelling restores the setting actually in force rather
  than leaving the control displaying one the engine never received.
  Transparency is measured from the decoded pixels, never inferred from the
  file extension, so an opaque PNG never triggers the question. Flattening
  happens before anything is encoded or scored, so the result is measured
  against the flattened original — the image that was actually asked for.
- **Every image reports how long it took.** The time appears on the image's
  row in the queue, in the "How this was measured" drawer alongside the
  candidate count, and as `time_ms` in exported CSV/JSON reports. The
  completion toast reports the run's wall clock. Per-image times are
  deliberately never summed into a batch total: images compress several at a
  time, so adding them up would claim a wait several times longer than the
  one that actually happened. The clock starts when an image reaches a
  worker, not when it was dropped, so time spent queued behind other images
  is not billed to it.

### Fixed
- **The broken-image glyph on the stage.** A file this browser cannot decode
  — a damaged export, or a format it has no decoder for — left an `<img>`
  pointing at something that would never paint, so Chrome drew its torn-page
  icon and the alt text over the artwork; a second `<img>` with no source at
  all laid out its alt text next to it. An image element with nothing to show
  is now out of the layout entirely, and the stage says what happened instead
  ("No preview — this browser can't read this file"). The E2E suite now fails
  on any visible image box with nothing decoded in it.
- Exported reports claimed version 2.2.0 regardless of the running version.
  The footer is now the single source of that string and the report reads it
  from there.

## [2.3.2] - 2026-08-05

### Changed
- **Web: JPEG quantisation tables now compete instead of being guessed.**
  Which mozjpeg table wins is content-dependent: on the benchmark's real
  photograph the default (ImageMagick) ships 371 KB where Annex K needs
  ~430 KB, and on the hard synthetic it is the other way round — Annex K
  passes at 461 KB where the default needs 597 KB. After the quality search
  converges, the alternate table is encoded at the chosen rung and the one
  below, verified with the same scorer, and the smallest passing file
  ships. At most two extra encodes, and an alternate that is not smaller
  is discarded without paying for verification.

## [2.3.1] - 2026-08-05

### Fixed
- **Web: the quality floor actually defaulted to 99, not 90.** Settings init
  still scaled the floor as if it were an SSIM fraction (`90 * 100`), which
  pinned the slider at its maximum. Every search then demanded SSIMULACRA 2
  >= 99, almost no lossy candidate could pass, and the app quietly
  over-shipped lossless files several times larger than needed (a 1.3 MP
  photograph shipped as a 1.5 MB lossless WebP; at the intended floor it
  ships as a 598 KB JPEG at score 90.6). Floors persisted while the bug was
  live are reset to the default once; targets and dimension caps are kept.
  The e2e suite now asserts the fresh-profile floor is exactly 90.

## [2.3.0] - 2026-08-05

### Added
- **SSIMULACRA 2 in the browser.** The web app now searches with the same
  perceptual metric as the desktop version — a JavaScript port
  (`web/ss2.js`) validated against the Python reference implementation to
  |Δ| = 0.0000 across a 60-pair corpus of codec-distorted images. The default
  quality floor is 90, the metric's published "not noticeable in a flicker
  test" line, and the UI speaks the same scale as the desktop app.
- **Real lossless WebP** in the web app (libwebp via WASM), competing in the
  Web and Lossless targets — the candidate that wins on flat artwork.
- `tests/bench_vs_alternatives.py` + `tests/BENCHMARK.md`: a reproducible
  head-to-head against single-format strategies and fixed-quality defaults,
  every strategy searched to the same SSIMULACRA 2 >= 90 floor.

### Changed
- Lossy ladders reach the high 90s (JPEG to 99, WebP to 98, AVIF to 96) in
  both engines. With the old ceilings, hard content could fail every lossy
  rung and a multi-megabyte lossless PNG won by forfeit.
- The web quantizer adds two Lloyd refinement iterations after median cut,
  and the shipped PNG gets a deeper oxipng pass — palette outputs now beat
  the pngquant + zopfli sizes from the previous benchmark.
- The per-channel chroma guard now applies only under the SSIM fallback
  metric; SSIMULACRA 2 weighs chroma natively.

### Fixed
- **Desktop selection bug:** a candidate that failed the quality floor could
  ship over one that passed, purely because it was smaller — an early failing
  JPEG would hold the winner's spot against a passing lossless PNG. Passing
  candidates now always outrank failing ones, matching the web engine.

## [2.2.0] - 2026-08-05

### Added
- **Web version** at [imgcompress-app.vercel.app](https://imgcompress-app.vercel.app) —
  the same encode-several-ways / score-every-candidate / keep-the-smallest engine,
  ported to run entirely in the browser (`web/`). SSIM at the 5th percentile,
  dual-backdrop transparency scoring, a palette-PNG encoder with exact-palette
  detection, per-image overrides, and zip download. Images never leave the
  device; the page makes no network requests after load.

### Security
- The desktop server now rejects requests whose `Host` header isn't loopback,
  closing the DNS-rebinding hole that could have exposed the API token via
  `GET /`.
- Request bodies are capped at 512 MB and oversized uploads answer `413`.
- Uploaded filenames are sanitised for Windows-hostile characters.
- Responses carry `Referrer-Policy: no-referrer`.

## [2.1.0] - 2026-08-05

### Added
- **Desktop app** (`imgcompress-gui`). Drag-and-drop queue with live progress, a
  before/after split slider with zoom, the full candidate bake-off per image,
  per-image format and quality overrides, and folder watching.
- Nothing is written to disk until you press Save — a whole batch can be
  reviewed and then saved or discarded.
- `compress()` and `write_result()` in the public API, for compressing into
  memory without touching the filesystem.
- Packaging: installable from PyPI or a checkout, with `imgcompress` and
  `imgcompress-gui` entry points.

### Changed
- `compress_file()` is now a thin wrapper over `compress()` + `write_result()`.

## [2.0.0] - 2026-08-05

Rewritten after benchmarking the first version against the state of the art.

### Added
- **Format bake-off.** Every image is encoded as JPEG *and* palette PNG *and*
  lossless PNG; each is searched independently and the smallest passing result
  wins. On the test corpus the winner differs by content type, with up to a 40x
  spread between best and worst candidate.
- **SSIMULACRA 2** as the default quality metric.
- `libimagequant` (pngquant's engine) for palette PNGs, `zopfli` for PNG
  recompression, `mozjpeg` for a lossless JPEG pass.
- `--target figma | web | lossless`, `--check`, `--fast`, `--metric`.

### Changed
- **Default output is now JPEG/PNG, not WebP.** Figma's plugin API only knows
  PNG/JPEG/GIF and the standing community answer is that WebP is transcoded to
  PNG on import, which would undo the compression entirely.
- **JPEG is always 4:4:4.** With chroma subsampling on, matching 4:4:4's quality
  on saturated content needed quality 97 instead of 76 — a 3.8x larger file.
- The SSIM fallback aggregates at the 5th percentile rather than the mean.
- Transparent images are scored over both a dark and a light backdrop, worse
  score wins.

### Fixed
- Alpha channels are composited before scoring. Comparing them raw produced
  meaningless numbers (the upstream `ssimulacra2` package has a dead alpha path).

## [1.0.0] - 2026-08-04

Initial version. WebP output, quality chosen by binary search on mean luminance
SSIM.
