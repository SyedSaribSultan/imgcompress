# The Figma plugin spike

Roadmap phase 6.3. A fixed amount of time spent on one question:

> Can the WebAssembly codecs load inside Figma's plugin sandbox?

If yes, compress-on-export is a better distribution story than any install — the
tool arrives where the images already are, and nobody has to find a folder. If
no, we spent a spike and nothing else changes.

**This is a spike.** Nothing in the shipping product depends on it. No CI job
runs it, no test imports it, and the probe under `spike/figma-probe/` is not part
of either interface. The honest outcome may be "not yet", and that outcome is
worth the same hour as a yes.

---

## The verdict, up front

**Technically yes, with one real risk left; and the product idea is not the one
we started with.**

Three things came out of this that matter more than the wasm question:

1. **Wasm will run.** It runs in the plugin's UI iframe, which is a normal
   browser realm with `'unsafe-eval'`. There is no doubt left about compiling and
   instantiating a module — the probe confirms it in the real sandbox in seconds.
2. **"Compress on export" cannot mean what it sounds like.** There is no export
   hook in the plugin API. A plugin cannot sit behind Figma's Export panel. It
   can only own its own export flow.
3. **This is two products, not one**, because `figma.createImage` takes PNG, JPEG
   and GIF and nothing else. JPEG and PNG can go back into the document and
   shrink the `.fig` file. WebP and AVIF can only ever leave as a download.

The one open risk is memory, and it is not a small one. See
[The decisive unknown](#the-decisive-unknown-memory).

---

## What is settled, and how firmly

The distinction matters more than usual here, because a spike that quietly mixes
documentation with forum posts produces a plan nobody can audit later.

### Documented by Figma

| Claim | Consequence for us |
| --- | --- |
| WebAssembly runs in the plugin UI iframe | The codecs live in `ui.html`, never in the main plugin thread |
| The iframe CSP is `script-src 'unsafe-inline' 'unsafe-eval' figma.com` | `'unsafe-eval'` is what permits `WebAssembly.compile` / `instantiate` |
| Web Workers can be created from `blob:` and `data:` URLs | The port keeps its worker; this was broken and fixed in **Version 1 Update 76, August 2023** |
| `Uint8Array` is the one binary type that crosses `figma.ui.postMessage` | It is also exactly what `exportAsync` returns and `createImage` accepts, so no conversion layer is needed |
| `figma.on()` covers selection, page, document, drop and run | There is no export event. None. |
| `ExportSettingsImage` has no quality or compression parameter | This is precisely the gap this product fills |
| `figma.createImage` accepts PNG, JPEG and GIF only | WebP and AVIF cannot return to the document |
| The manifest takes one UI HTML file and one main JS file | Everything is inlined, or fetched from an absolute allow-listed URL |

### Measured in this repository

Codec payload, as the files sit in `web/vendor/` today:

| File | Bytes | Share |
| --- | --- | --- |
| `avif_enc.wasm` | 3,485,872 | 82.1% |
| `webp_enc_simd.wasm` | 345,584 | 8.1% |
| `mozjpeg_enc.wasm` | 251,524 | 5.9% |
| `squoosh_oxipng_bg.wasm` | 164,172 | 3.9% |
| **total** | **4,247,152** | |

Base64 costs a third on top, so a fully inlined single `ui.html` lands near
**6 MB**: 5,662,872 characters of encoded wasm, plus 124,957 bytes of codec glue,
plus `worker.js` (62,824), `ss2.js` (13,141) and `destinations.js` (2,902), plus
the plugin's own interface.

Drop libaom and the same build is **about 1.2 MB**: 1,015,040 characters of
base64 for the three small codecs, and the same glue and worker on top. That one
decision is 82% of the payload.

### Reported by developers, not documented

| Claim | How to treat it |
| --- | --- |
| The plugin publish size ceiling is ~15 MB | **User-reported. Not in Figma's docs.** A 6 MB bundle is comfortable against it and a 1.2 MB bundle is not close to it, so nothing in the plan below leans on this number being exact. |
| A shipped wasm plugin has been observed hitting `RuntimeError: memory access out of bounds` inside Figma | Enough to take the memory question seriously. Not enough to predict where our wall is. |

---

## Two facts that change what the product is

### There is no export hook

`figma.on()` has no export event, no before-export event, no
after-export event. A plugin cannot intercept the native Export panel and it
cannot post-process the panel's output. `exportAsync` is the only export path a
plugin controls.

So **"compress on export" has to mean the plugin owns its own export flow** — its
own button, its own settings, its own download — not that it decorates Figma's.
That is a worse story than "your existing export just gets smaller", and it is
the story that is available.

The probe turns this from a reading of the docs into something observed: it calls
`figma.on()` with `"export"`, `"beforeexport"` and `"exportcomplete"` alongside
two names that do exist, and prints whatever comes back. Run against a stubbed
sandbox the shape is already clear:

```
[main] figma.on("run"): accepted
[main] figma.on("selectionchange"): accepted
[main] figma.on("export"): refused - Unknown event type
```

A refusal from the real sandbox is the evidence. The two accepted names are the
control that makes a refusal mean something.

### `figma.createImage` takes PNG, JPEG and GIF

This splits the work cleanly in half, and the halves have different value.

**Product A — shrink the document.** Read an image fill's own bytes with
`Image.getBytesAsync()`, compress them with mozjpeg or oxipng, hand the result to
`figma.createImage()` and re-point the fill. The `.fig` file gets smaller, every
export from it gets smaller, and the whole team downstream benefits without
installing anything. Constrained to JPEG and PNG — which is *the same constraint
the `documents` destination already lives under*, for the same reason. The
restriction we ship is a fact about the tool, and here it is again.

**Product B — export to a download.** `exportAsync` a node, compress to WebP or
AVIF, and hand the bytes to the iframe to save. Modern formats, best byte counts,
and the result can never come back into the document.

Two audiences, two flows, two sets of formats. Building both at once is how this
gets confusing; see [Sequencing](#sequencing).

There is a bonus hiding in Product A. `Image.getBytesAsync()` is also the one
call that settles the unverified claim `GUIDE.md` hangs the whole `documents`
format policy on: import a WebP into Figma and read its bytes back. Bytes
starting `RIFF` mean Figma stored the original and the policy can be revisited.
Bytes starting with a PNG signature mean the policy is right and now proven. The
probe as built does **not** do this — it needs a document with an imported WebP in
it — but the scaffold is the vehicle for it, and it is a one-node addition.

---

## The iframe is a null origin

`window.origin` in the plugin iframe is literally `null`. That is not a detail,
it is a constraint that shapes every file:

- **No relative `fetch`.** `fetch("vendor/avif_enc.wasm")` has nothing to resolve
  against.
- **No relative `importScripts`.** Same reason.
- **The manifest takes one HTML file and one JS file.** There is no second file
  to point at.

So every byte is either inlined into `ui.html`, or fetched from an absolute
`https` URL on a domain listed in `networkAccess.allowedDomains`. And that server
**must** send `Access-Control-Allow-Origin: *` — a specific-origin value can
never match a `null` origin, so the usual careful CORS configuration is the one
that will not work.

There is a second-order cost worth naming now: a lazy-fetched codec means the
plugin no longer runs offline, and it means the plugin's privacy story acquires a
footnote. The web app's claim is that images never leave the device. A plugin that
downloads a codec still never uploads an image, but it does make a network
request, and that is a sentence somebody has to write honestly on a listing page.

---

## What the port would cost

Small, and localised. `web/worker.js` already has the exact shape needed: it
loads codecs lazily, degrades to `false` when one is unavailable, and never
touches the network. Three relative-URL patterns have to change and nothing else
does.

| Where | Today | In a plugin |
| --- | --- | --- |
| `web/worker.js:148-168` — `loadCodec()` | ``importScripts(`vendor/${script}`)`` and ``fetch(`vendor/${wasmFile}`)`` | `importScripts(blobUrl)` for the glue, base64 for the wasm |
| `web/worker.js:26` | `importScripts("ss2.js")` | inlined into the worker source |
| `web/worker.js:48` | `importScripts("destinations.js")` | inlined into the worker source |
| `web/app.js:286` | `new Worker("worker.js")` | `new Worker(URL.createObjectURL(blob))` |

The probe checks the two mechanics this table depends on: that a worker spawns
from a `blob:` URL at all, and that a blob URL minted on the page can be pulled
into that worker with `importScripts` — which is the direct replacement for
`loadCodec`'s first line.

`loadCodec`'s existing `try`/`catch`, which sets `CODECS[name] = false` and warns,
is already the right behaviour for a plugin where a codec might be absent for a
new reason. Nothing about the metric, the search, the ladders or the destination
policy changes. `ss2.js` is pure JavaScript and does not care where it runs.

---

## The decisive unknown: memory

Everything above is either documented or arithmetic. This is the part only a real
run answers, and it is the part that decides whether this ships.

The plugin iframe would be asked to hold, at once:

- a ~6 MB HTML parse (or ~1.2 MB, which is the argument for the smaller build)
- up to four instantiated wasm modules, each with its own linear memory
- full-resolution RGBA buffers for the image being worked on
- multi-megabyte `Uint8Array`s **copied, not transferred**, across the plugin
  bridge — there is no transfer list on `figma.ui.postMessage`, so a 16 MB buffer
  going one way means 16 MB allocated again on the other side

— inside a browser tab that is already holding the user's Figma document.

**The question is not "can wasm run".** It is: *does running out of memory kill
just the plugin, or the user's whole Figma tab, with unsaved work in it.* Those
two outcomes are separated by a support burden we would deserve. A crash that
loses somebody's afternoon is not a bug you fix in a patch release; it is a
reason not to have shipped.

`RuntimeError: memory access out of bounds` has been observed in a shipped wasm
plugin inside Figma, so the failure mode is real rather than theoretical. What is
unknown is where our wall is and what happens when we hit it.

---

## The probe

`spike/figma-probe/` is the smallest plugin that answers the capability questions
from inside the real iframe. Its README covers running it and reading the output.
What it reports:

- `typeof WebAssembly`, in both the main sandbox and the iframe — they are
  different realms and only one of them matters
- whether a `blob:` URL worker spawns with the manifest asking for
  `allowedDomains: ["none"]`, and whether a `data:` URL worker does
- whether `OffscreenCanvas` and `createImageBitmap` exist inside that worker, and
  a real encode/decode/read-pixels round trip through them
- whether wasm SIMD is detected — without it, `webp_enc_simd.wasm` is 345,584
  bytes that buy nothing
- a successful `WebAssembly.instantiate` from base64, including a call across the
  boundary and a memory grow
- wall-clock timing for round-tripping 1 MB, 4 MB and 16 MB `Uint8Array`s through
  `figma.ui.postMessage`, with the bytes checked for damage on return
- `performance.memory.jsHeapSizeLimit`, which is the renderer's limit and
  therefore shared with the document — an upper bound on headroom, never a budget

It deliberately inlines a hand-written 52-byte wasm module rather than a real
codec. Instantiation either works in that sandbox or it does not; 3.5 MB of
libaom would turn a capability check into a download test and tell us nothing
extra. Throughput is a separate measurement that needs the real codecs to mean
anything.

**What the probe does not answer:** the memory question above. It measures the
bridge and the headroom, which is the evidence you need *before* deciding to
spend a day on a real port — but the wall only shows up with four real codecs and
a real 12 MP image, and finding it is the next spike, not this one.

---

## Recommendation

**Build Product A first, with the three small codecs inlined. Leave AVIF out of
version one entirely.**

The reasoning:

- **761,280 bytes of wasm, about 1.0 MB base64.** That covers in-place JPEG and
  PNG fill compression (Product A, complete) plus WebP export-to-download
  (Product B's best format). It is a fifth of the full payload and it fits
  comfortably under any reported ceiling.
- **libaom is 82% of the payload for a format `createImage` cannot accept back.**
  AVIF can only ever be a download. Paying 3.5 MB of parse and instantiation cost
  in every session, for the flow that benefits the document least, is the wrong
  first trade. Lazy-fetch it later, from an allow-listed absolute URL with a
  wildcard CORS header, once there is evidence anyone wants it.
- **Product A is the better story anyway.** "Your Figma file gets smaller, and so
  does every export anybody takes from it" beats "here is a second export
  button". How much smaller is a number we do not have yet and should not
  invent — it is one of the first things a working port would measure.

And one measurement to take before writing any encoder code:
`canvas.toBlob('image/webp', q)` is natively available in the iframe — the probe
confirms it and prints the byte count. If the browser's own WebP encoder is
within a few percent of libwebp at matched quality, we should not pay 345,584
bytes to ship libwebp at all, and the small build drops to 415,696 bytes of wasm.
Measure it against `webp_enc_simd.wasm` on the existing fixture corpus before
deciding. The probe also checks `image/avif`, which is expected to be absent —
worth confirming rather than assuming.

## Sequencing

1. **Run the probe in Figma.** Half an hour. Paste the report into this document.
   If wasm or blob workers are absent, stop here and the spike is finished.
2. **Measure native WebP against libwebp** on `tests/fixtures/`, at matched
   quality. Decides whether the payload is 761,280 or 415,696 bytes.
3. **Settle the `GUIDE.md` WebP claim** with `Image.getBytesAsync()` on an
   imported WebP. Costs one node and one line, and it either confirms the
   `documents` format policy or unblocks a change to it. Do this while the
   scaffold is warm regardless of what happens next.
4. **Port the worker** behind the three small codecs, and find the memory wall on
   purpose: a 12 MP image, all three codecs instantiated, and watch what dies.
   This is the go/no-go, and it must be run on a machine with a real document
   open, not an empty file.
5. **Product A only** for version one. `getBytesAsync` in, `createImage` out,
   undo-safe, one selection at a time before any batch flow.
6. **Product B, WebP only**, once A is stable.
7. **AVIF, lazy-fetched**, only if asked for.

## If the answer is no

Then the write-up above is the deliverable, `spike/figma-probe/` stays as a
record of what was asked and how, and the install-based distribution story is
unchanged. Nothing was built on top of this. That is the point of doing it as a
spike and the reason it was scoped to a fixed amount of time.

The two facts about the export hook and about `createImage` are worth keeping
either way: they are already the reason `--for documents` refuses WebP, and now
they are written down somewhere other than a comment.
