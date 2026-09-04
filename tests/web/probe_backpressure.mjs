/* Backpressure: a big drop must not read the whole batch into memory at once.
 *
 * The engine used to start every queued file's arrayBuffer() read together.
 * That was itself a fix - reads had been sequential, and the last worker sat
 * idle through eleven of them - but it made peak memory a function of how many
 * files were dropped rather than of what the machine can hold: two hundred
 * five-megabyte photographs is a gigabyte of ArrayBuffer resident before a
 * single one has been encoded.
 *
 * Reads are windowed at pool+2 now, and this is what stops that regressing.
 * Nothing else would catch it: the batch still finishes, every file still
 * compresses, and the only symptom is a tab that dies on somebody else's
 * machine.
 *
 * Two things learned writing it, both worth keeping:
 *
 *   The peak is read from the engine, not sampled from outside. Polling
 *   `state.items.filter(i => i.bytesPromise)` measures the wrong thing - the
 *   promise stays set after it resolves - and polling the real counter at
 *   120ms caught nothing at all and reported a peak of zero, which passed.
 *   A gate that measures nothing is worse than no gate, so the assertion
 *   below refuses a peak that low.
 *
 *   Bounding the window turned dispatch's re-entrancy from theoretical into
 *   observed: every finished read calls dispatch, dispatch awaits mid-loop,
 *   and two overlapping walks each awaited the same bytesPromise and each
 *   posted it - DataCloneError, buffer already detached. Hence the guard in
 *   engine.js, and hence this running a real 24-file batch rather than three
 *   small files.
 *
 *   node tests/web/probe_backpressure.mjs
 */
import { spawn } from "node:child_process";
import { readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer, { CHROME } from "./resolve_puppeteer.mjs";
import { uploadAndStart } from "./drive.mjs";
const here = path.dirname(fileURLToPath(import.meta.url));
const BATCH = path.join(here, "batch");
if (!existsSync(BATCH)) {
  /* The corpus is built, not committed. Saying so beats a stack trace, and
     exiting 2 keeps it distinct from a real failure. */
  console.error(`${BATCH} missing - run: node tests/web/make_batch.mjs`);
  process.exit(2);
}
const server = spawn("node", [path.join(here, "serve.mjs"), "8283"], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 900));
const b = await puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: 3600000 });
let bad=0; const ok=(c,n)=>{ if(c) console.log("  ok  "+n); else { console.error("  FAIL "+n); bad++; } };
try {
  const pg = await b.newPage();
  pg.on("pageerror", e => { console.log("[pageerror]", String(e)); bad++; });
  await pg.setViewport({ width: 1440, height: 940 });
  await pg.goto("http://127.0.0.1:8283/", { waitUntil: "networkidle0" });
  const files = readdirSync(BATCH).map(f => path.join(BATCH, f));
  console.log(`dropping ${files.length} files`);
  const t0 = Date.now();
  await uploadAndStart(pg, files);
  // sample how many ArrayBuffers are resident at once
  let peak = 0;
  const poll = setInterval(async () => {
    try {
      const n = await pg.evaluate(() => imgc.readingCount ? imgc.readingCount() : -1);
      if (n > peak) peak = n;
    } catch {}
  }, 120);
  await pg.waitForFunction(() => state.items.length > 0 &&
      state.items.every(i => ["done","failed","saved"].includes(i.status)),
      { timeout: 1800000, polling: 400 });
  clearInterval(poll);
  const wall = Date.now() - t0;
  const res = await pg.evaluate(() => ({
    n: state.items.length,
    done: state.items.filter(i => i.status === "done").length,
    failed: state.items.filter(i => i.status === "failed").length,
    pool: imgc.pool.length,
    stuck: state.items.filter(i => i.status === "queued" || i.status === "working").length,
  }));
  console.log("result:", JSON.stringify(res), `wall=${(wall/1000).toFixed(1)}s`);
  const truePeak = await pg.evaluate(() => imgc.readingPeakSeen());
  console.log("peak concurrent reads:", truePeak, "(polled:", peak, ") window = pool+2 =", res.pool+2);
  ok(truePeak > 1, `the gate actually saw concurrent reads (${truePeak}) - a peak of 0 or 1 would mean it measured nothing`);
  ok(res.n === files.length, `all ${files.length} items present`);
  ok(res.stuck === 0, `nothing stuck queued or working (${res.stuck})`);
  ok(res.done + res.failed === res.n, "every item reached a terminal state");
  ok(res.failed === 0, `nothing failed (${res.failed})`);
  ok(truePeak <= res.pool + 2, `reads stayed inside the window (peak ${truePeak} <= ${res.pool+2})`);
} finally { await b.close(); server.kill(); }
console.log(bad===0 ? "\nOK" : `\n${bad} problem(s)`);
process.exit(bad?1:0);
