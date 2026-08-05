# Changelog

All notable changes to this project are documented here.
This project follows [Semantic Versioning](https://semver.org/).

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
