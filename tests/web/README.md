# Web engine test harness

Browser-level tests for the web app: a real Chrome driven over the real page,
served with production headers (CSP included — a plain static server hides
violations that then only surface in production).

Requires Node 18+, Chrome, and `puppeteer-core` (either `npm i -D
puppeteer-core` anywhere on the resolution path, or point `PUPPETEER_CORE` at
its `puppeteer-core.js`). `CHROME_PATH` overrides the Chrome binary.

## E2E — the promise suite

```
python tests/web/make_web_fixtures.py     # once: builds fixtures/
node tests/web/e2e.mjs                    # ~44 asserts against the local build
E2E_URL=https://pocketsize.vercel.app/ node tests/web/e2e.mjs   # against prod
```

What it holds the engine to, among other things: the fresh-profile quality
floor is exactly 90 (an init bug once clamped it to 99 and every search
silently over-preserved); the winner is the smallest candidate that passed the
floor; lossy candidates on 5 MP frames are measured, not forfeited to
lossless by a memory failure; nothing ever ships bigger than its source;
corrupt files fail gracefully; the console stays clean under the strict CSP.

## bench — performance + snapshot gate

```
node tests/web/setup_bench.mjs            # once: builds bench/ from committed fixtures
node tests/web/bench.mjs mylabel          # documents, gated on snap-documents.json
BENCH_TARGET=web node tests/web/bench.mjs mylabel
node tests/web/make_batch.mjs             # builds batch/ (the 4 fixtures × 6)
BENCH_DIR=batch SNAP=batch node tests/web/bench.mjs mylabel
```

Timings are hostage to thermal state — treat them as min-of-N and trust the
**deterministic operation counts** instead. The snapshot is the no-compromise
gate: an optimisation may move the timings, it may not move a single output
byte. If output legitimately changes (an engine improvement), regenerate with
`BENCH_WRITE=1` and commit the new snapshots with the change that caused them.

## What each Format choice costs

```
node tests/web/speed_by_choice.mjs        # idle machine only
```

Drives the real app across every Format choice on the benchmark corpus and
reports the app's own per-image clock. Run it on an idle machine — timings
taken under load are fiction. What it found (2026-08-06) is worth knowing
before optimising anything: restricting to JPEG saves only 1.1–1.4× against
the design-tool set, because JPEG's own quality search is nearly the entire
cost; the ~2× wins from WebP-only and AVIF-only come partly from failing to
reach the floor; and "Best for the web" costs 1.9–3.1× while producing
byte-identical output to the design-tool preset on photographs.

`probe_controls.mjs` is a focused probe of the Format and Quality controls,
including the flatten-onto-white answer to the transparency dialog that the
E2E does not cover (the E2E takes the keep-as-PNG branch).

## Focused probes

```
node tests/web/probe_flow.mjs       # the drop sequence, candidate chips, copy, zoom
node tests/web/probe_controls.mjs   # Format/Quality controls, transparency dialog
node tests/web/probe_a11y.mjs       # accessible names, live regions, focus, Enter
node tests/web/probe_mobile.mjs     # 390px: does anything overhang the viewport
node tests/web/probe_zoom.mjs       # traces stage/frame geometry through zoom steps
```

`drive.mjs` holds `uploadAndStart` / `uploadAndFinish`. Since v2.6.0 a drop
starts the run on its own, so there is nothing to press — but **dispatch is
held for one animation frame** so the untouched original is painted first, and
these helpers wait on the frames rather than on a status. Use them rather than
hand-rolling it: "the items exist" is one frame too early to call the run
started, and a small file can finish before the first poll.

Three things worth knowing before writing a probe here:

- **To see the anchor frame, stub `dispatch`.** The app only holds it for a
  frame, which is not long enough to inspect; `probe_flow.mjs` and the E2E
  both swap in a no-op, assert the original-only state, then restore and call
  it. Both live in the page's global scope, so plain assignment works.

- **Chrome refuses clipboard writes to an automated browser** whatever you pass
  to `overridePermissions`. Grant `clipboardReadWrite` and
  `clipboardSanitizedWrite` over CDP (`Browser.grantPermissions`) instead.
- **Settings pushes are debounced**, so "everything is done" stays true of the
  previous run until the new one starts. Wait for `state.settingsRev` to move
  before waiting for completion, or you will assert against stale results.

## Metric validation + design gates

```
python tests/web/make_ss2_vectors.py      # 60 (ref, distorted) pairs + reference scores
node tests/web/ss2_validate.mjs           # JS port must match within 0.25 pt
node tests/web/verify_tokens.mjs          # tokens resolve; no literals; weight <= 600
node tests/web/verify_fonts.mjs           # faces load and paint; nothing renders > 600
```

Any change to `web/ss2.js` must re-run the validation harness — the port's
whole claim is agreement with the Python reference (float32 planes: mean
|Δ| 0.0045, worst 0.0229 on the 100-point scale).

The corpus-level quality benchmark (desktop vs web vs single-format
strategies, all searched to the same SSIMULACRA 2 floor) is separate:
`python tests/bench_vs_alternatives.py`, which regenerates
[../BENCHMARK.md](../BENCHMARK.md) and expects the web outputs in
`tests/bench_web_out` from `node tests/bench_web_out.mjs`.
