# Vendored codec licences

These files are self-hosted builds of open-source encoders, bundled from the
[jSquash](https://github.com/jamsinclair/jSquash) project (Apache-2.0 / MIT),
which packages the [Squoosh](https://github.com/GoogleChromeLabs/squoosh)
codecs (Apache-2.0, Google LLC):

| File | Project | Licence |
| --- | --- | --- |
| `mozjpeg.js`, `mozjpeg_enc.wasm` | @jsquash/jpeg → [mozjpeg](https://github.com/mozilla/mozjpeg) | Apache-2.0 glue; mozjpeg is BSD-3-Clause/IJG |
| `oxipng.js`, `squoosh_oxipng_bg.wasm` | @jsquash/oxipng → [oxipng](https://github.com/shssoichiro/oxipng) | Apache-2.0 glue; oxipng is MIT |
| `avif.js`, `avif_enc.wasm` | @jsquash/avif → [libaom](https://aomedia.googlesource.com/aom/) | Apache-2.0 glue; libaom is BSD-2-Clause + AOM Patent License 1.0 |
| `webp.js`, `webp_enc_simd.wasm` | @jsquash/webp → [libwebp](https://chromium.googlesource.com/webm/libwebp) | Apache-2.0 glue; libwebp is BSD-3-Clause |

No modifications were made to the codecs; the `.js` glue files are esbuild
IIFE bundles of the packages' published ES modules.

# Icons

The interface glyphs (inline `<svg>` in `index.html` and the select chevron
data URI in `css/base.css`) are from [Lucide](https://lucide.dev)
(ISC licence, © Lucide contributors), copied as plain SVG paths - no script,
no font, no requests.
