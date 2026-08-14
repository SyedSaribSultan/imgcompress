# figma-probe

The smallest plugin that answers, from inside Figma's real plugin iframe, whether
this project's WebAssembly codecs could live there.

Read [`docs/figma-plugin-spike.md`](../../docs/figma-plugin-spike.md) first. It
holds the question, what was already settled without running anything, and the
recommendation. This directory is just the instrument.

**This is not part of the product.** Nothing imports it, no test covers it, CI
does not know it exists, and it does not read or modify your document. Four files,
no build step, no dependencies.

## Running it

You need the Figma **desktop** app; plugin development does not work in the
browser.

1. Menu → **Plugins** → **Development** → **Import plugin from manifest...**
2. Pick `spike/figma-probe/manifest.json`.
3. Open any design file — an empty one is fine — and run **pocketsize wasm
   probe** from Plugins → Development.
4. Wait for `probe finished`, then press **Copy report**.

The report also goes to the developer console (Plugins → Development → **Open
console**), which is the copy still there if the plugin window dies partway
through.

If Figma refuses the manifest, the likely culprit is the `id` field: it is a
placeholder here, because Figma assigns real ids. Create a throwaway plugin
through Figma's own **New plugin** flow and copy the `id` it writes into this
manifest, or copy these four fields into the manifest it generated.

## Reading the report

Every line is tagged with where it was measured, because the three places have
genuinely different capabilities and conflating them is the mistake this whole
spike is guarding against.

| Tag | Where | What to expect |
| --- | --- | --- |
| `[main]` | Figma's plugin sandbox | Not a browser. No `Worker`, no `fetch`, no `OffscreenCanvas`. `WebAssembly` may well be absent here and that is fine — it is not where the codecs would go. |
| `[ui]` | the plugin's UI iframe | A real browser realm at a `null` origin. This is where the codecs would live, so this is the block that decides the spike. |
| `[worker]` | a worker spawned from a `blob:` URL | The port's actual home. `blob:` workers were broken in Figma until Version 1 Update 76, August 2023. |
| `[bridge]` | `figma.ui.postMessage` | Buffers copied between the two realms, timed, and checked for damage on arrival. |

### What a good result looks like

```
[ui] typeof WebAssembly: object
[ui] window.origin: null
[ui] wasm SIMD: detected
[ui] instantiate from base64: ok, add(2,3)=5
[ui] wasm memory grow: 65536 B -> 131072 B
[worker] blob:: spawned
[worker] blob:: importScripts(blob: URL): ok, the glue ran
[worker] blob:: instantiate from base64: ok, add(2,3)=5
[worker] blob:: createImageBitmap: ok, 8x8
[worker] blob:: getImageData first pixel: 10,20,30,255 (as drawn)
[bridge] 16777216 B: intact, 84 ms, 190.2 MiB/s round trip
```

`window.origin: null` is not a fault — it is the confirmation that relative
`fetch` and relative `importScripts` are off the table, which is the finding that
shapes the port.

### The lines that decide things

- **`typeof WebAssembly` under `[ui]`.** If this is `undefined`, the spike is over
  and the answer is no.
- **`[worker] blob:: spawned`.** If it is missing, or you see `onerror` or `no
  answer within 8000 ms`, the codecs cannot go in a worker and would have to run
  on the iframe's main thread — which means every encode freezes the plugin
  window. Check whether `data::` spawned, because that is the second door.
- **`wasm SIMD`.** Not detected means `webp_enc_simd.wasm` is 345,584 bytes that
  buy nothing, and the glue will fall back.
- **`canvas.toBlob(image/webp)`.** If this reports a real `image/webp` blob, the
  browser already has a WebP encoder and libwebp may not be worth shipping.
  Measure before assuming. A line saying it *fell back to* `image/png` means
  there is no encoder — `toBlob` is allowed to hand back a format you did not ask
  for, which is why the returned MIME type is what gets printed rather than a
  yes.
- **The `[bridge]` ladder at 16777216 B.** This is the number the spike exists
  for. `no reply within 20 s` means the plugin is wedged at that size. If Figma
  itself dies here, *that is the result* — write down which size, and whether the
  tab went with it.

Absences are printed, never skipped. A missing capability produces a line saying
so; a silent gap in the report means the probe stopped, and the last line printed
tells you where.

## What it deliberately does not do

- **No real codec is inlined.** The wasm module is 52 hand-assembled bytes
  exporting `add(i32,i32)` and a memory. Instantiation either works in that
  sandbox or it does not, and 3,485,872 bytes of libaom would turn a capability
  check into a download test. Throughput is a separate measurement that needs the
  real encoders to mean anything.
- **It does not touch your document.** No node is read, created or changed.
- **It does not answer the memory question.** Four real codecs plus a 12 MP RGBA
  buffer is the thing that might take the tab down, and that needs a real port.
  This measures the bridge and prints the renderer's heap limit, which is the
  evidence you want before spending a day on one.

## Extending it

- **Push the bridge harder:** `ECHO_SIZES` at the top of `code.js`. Adding
  `67108864` is a one-line change and a fair question.
- **Settle the `GUIDE.md` WebP claim:** import a WebP into the file, select it,
  and call `Image.getBytesAsync()` on the fill's image. Bytes starting `RIFF`
  mean Figma stored the original; a PNG signature means it transcoded. That single
  reading is the hinge the `documents` format policy hangs on, and it needs
  `documentAccess` and a selection, which is why it is not in the probe as built.

## Two things that look like sloppiness and are not

**No design system.** Every other surface here renders from
`web/heyoz-tokens.css`, and the standing rule is that nothing hand-types a
colour, a corner radius or a duration. `ui.html` cannot import that stylesheet:
the manifest takes exactly one UI HTML file and the iframe has a `null` origin, so
there is no relative URL to load it from. Hand-copying values out of the token
layer is the exact drift that rule exists to prevent, so this page declares no
colours of its own and borrows Figma's `--figma-color-*` variables instead. If
those are ever absent, the declarations fall back to the browser default and a
diagnostic textarea is still perfectly readable.

**Everything printed is ASCII.** The report gets pasted into terminals and commit
messages, and a middot arriving as a replacement character on a Windows console
defeats the point of writing it down.

## How this was checked without Figma

Figma is the only place the answers are real, but the page was driven in headless
Chrome over `http` with a stubbed bridge before anyone wasted a plugin import on a
typo. That run confirms the page runs clean, every branch reports something, and
the report stays ASCII. It cannot confirm anything about the `null` origin or the
plugin CSP.

It was also broken on purpose, four ways, to check it says so: a corrupted base64
module, a CSP that forbids `blob:` workers, `OffscreenCanvas` deleted inside the
worker, and `WebAssembly` deleted outright. Each produced a legible red line
rather than silence. `code.js`'s buffer check was run against buffers that came
back truncated, mangled, as a plain object, as an `Array`, and as nothing at all.
A probe that only ever prints good news is indistinguishable from one that prints
nothing.
