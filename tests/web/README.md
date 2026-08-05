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
E2E_URL=https://imgcompress-app.vercel.app/ node tests/web/e2e.mjs   # against prod
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
node tests/web/bench.mjs mylabel          # figma target, gated on snap-figma.json
BENCH_TARGET=web node tests/web/bench.mjs mylabel
node tests/web/make_batch.mjs             # builds batch/ (the 4 fixtures × 6)
BENCH_DIR=batch SNAP=batch node tests/web/bench.mjs mylabel
```

Timings are hostage to thermal state — treat them as min-of-N and trust the
**deterministic operation counts** instead. The snapshot is the no-compromise
gate: an optimisation may move the timings, it may not move a single output
byte. If output legitimately changes (an engine improvement), regenerate with
`BENCH_WRITE=1` and commit the new snapshots with the change that caused them.

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
