# Changelog

All notable changes to this project are documented here.
This project follows [Semantic Versioning](https://semver.org/).

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
