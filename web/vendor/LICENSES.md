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

## Pinned builds

Vendored 2026-08-05 from the then-current @jsquash npm releases. If an
advisory lands against jSquash or an upstream codec, these hashes are how to
tell whether the shipped builds are the affected ones. Recompute with
`Get-FileHash -Algorithm SHA256` (or `sha256sum`); any change to these files
must update this table in the same commit.

| SHA-256 | File |
| --- | --- |
| `af50ac1b4e622b7441c26a98103f92fd7a8c549b6a8c6ee8535a3cebf4e12706` | `mozjpeg.js` |
| `24d4177f1c4963e2058b107189249651c61fdef125570e79b1dfb63c8bb49326` | `mozjpeg_enc.wasm` |
| `243e84f1e632e4f5d2b602ddf33e4987fb9e0a377369ba418d52413a1dbe3d35` | `oxipng.js` |
| `5ea3e53c0b4fc1b4e8d1511d35b89329d9376bec75a9c4d3c054774487e5f9a3` | `squoosh_oxipng_bg.wasm` |
| `8aecdb7782191a2e376a195b5038330c31636e327d48f52b5815fac375556723` | `avif.js` |
| `d9f2a95164362af48558d176e619becfd49dd97b50b86c679b47100860522b3d` | `avif_enc.wasm` |
| `ed231f933ddaa112b51ee4df8117b5fa4245ce1b370be0b2f8ef688f1f36c9e1` | `webp.js` |
| `39c279269ec1163b987b6d69749458e3d5b03b9585f58b6ca5455b76b504a305` | `webp_enc_simd.wasm` |
| `5881915aa16d4a45b9eac06e3826e1ef10f10ae5d09499c13f235d56f8f4f7ab` | `mediabunny.min.js` |
| `3f3d9e0024b1921b067d6f7f88deb4a60cbe7a78e76c64e3f1d7fc3b779b9d04` | `mediabunny-LICENSE.txt` |

# Mediabunny

`mediabunny.min.js` is [Mediabunny](https://mediabunny.dev) 1.54.0 by
Vanilagy and contributors, **MPL-2.0**, copied from the npm package unmodified
(`npm pack mediabunny@1.54.0`, `dist/bundles/mediabunny.min.mjs`),
renamed to `.js` because a module served as `application/octet-stream` under
`nosniff` is refused outright, and `.mjs` is missing from more static hosts'
MIME tables than is comfortable. Module-ness comes from the worker's
`type: "module"`, never from the extension. The full
licence text sits beside it in `mediabunny-LICENSE.txt`.

It reads and writes the containers - MP4, QuickTime, WebM, Matroska - and does
nothing else here: every frame is decoded and encoded by the browser's own
WebCodecs, so no codec ships in this file and none is bundled with the site.
MPL-2.0 is file-level copyleft, which is satisfied by shipping this file
unmodified alongside its licence; the rest of the site stays MIT.

The alternative was compiling FFmpeg to WebAssembly, and it was rejected on
three counts, each sufficient: it runs roughly twelve to twenty-five times
slower than native, its default build links x264 and x265 and is therefore
GPL, and its threaded build needs cross-origin isolation - which would mean
setting COEP across the whole site and breaking any cross-origin resource that
does not opt in. Reading containers in JavaScript and encoding with the
browser's codecs needs none of that.

# Icons

The interface glyphs (inline `<svg>` in `index.html` and the select chevron
data URI in `css/base.css`) are from [Lucide](https://lucide.dev)
(ISC licence, © Lucide contributors), copied as plain SVG paths - no script,
no font, no requests.
