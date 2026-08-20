/* Does a big video stay inside a memory budget, and stay interruptible?
 *
 * The owner froze a laptop with a 300 MB video. The cause was not CPU: the
 * browser tier assembled the whole output in RAM (`BufferTarget` plus
 * `fastStart: "in-memory"`), held every probe rung's output blobs, kept the
 * losing format's full-size output until the winner was picked, and cached
 * decoded reference frames - 4 bytes per pixel, uncompressed - with no bound.
 * Peak went past a gigabyte, the OS started swapping, and swapping is what
 * stops a machine.
 *
 * TWO ASSERTIONS, AND WHY IT TAKES TWO.
 *
 * The first is the streaming invariant: the largest single buffer the muxer
 * hands over. It is deterministic, it is exactly what the fix changed, and it
 * is what a regression would undo.
 *
 * The second is resident memory, reported as a number and bounded generously
 * rather than tightly. That is a deliberate retreat: this probe originally
 * asserted a tight resident-memory budget, and the budget was wrong in a way
 * worth recording. Run-to-run spread on ONE file measured about 19% (1,824 /
 * 2,011 / 2,144 / 2,176 MB on the same 663 MB input) because resident memory is
 * sampled on an interval against a garbage-collected runtime. A budget tight
 * enough to catch the whole-file-buffer regression also failed honest builds;
 * a budget loose enough to be stable let the regression through - verified by
 * reintroducing `fastStart: "in-memory"` and watching the gate stay green.
 * So the RSS figure is kept for its diagnostic value, with a ceiling set only
 * where a genuine runaway lives, and the real guard is the invariant above.
 *
 * WHY RESIDENT MEMORY IS READ FROM OUTSIDE THE PAGE.
 *
 * The number the operating system acts on when it decides to swap is resident
 * memory across the whole renderer, including the worker, the codecs and the
 * muxer's buffers. Three in-page options were tried and rejected, each for a
 * specific reason:
 *
 *   - `performance.measureUserAgentSpecificMemory()` needs cross-origin
 *     isolation. This site deliberately ships no COOP/COEP - avoiding it is
 *     recorded as an architectural win in the video plan, because the
 *     ffmpeg.wasm route would have forced it site-wide. Serving this probe
 *     with those headers would measure a product we do not ship.
 *   - `performance.memory.usedJSHeapSize` and CDP's `JSHeapTotalSize` are JS
 *     heap only. Encoded blobs, decoder frames and muxer buffers are platform
 *     memory the JS heap cannot see, so they report tens of megabytes while
 *     the tab dies. Asserting on them would produce a green gate over a broken
 *     product, which is worse than no gate.
 *   - `Memory.getAllTimeSamplingProfile` over CDP is browser-process-wide and
 *     cumulative, not a live resident figure.
 *
 * So the probe reads resident set size from the OS, summed over the Chrome
 * process tree it launched itself - and only that tree, found by walking
 * parent pids from the browser it started. A plain "sum every chrome.exe"
 * would silently include the developer's own browser windows; measured here,
 * that was 3,267 MB of other people's tabs against 395 MB of ours.
 *
 * It also asserts the two behaviours that make a slow job survivable: that
 * progress keeps arriving while the encode runs (a worker that never yields
 * cannot report, and a UI that cannot report looks hung), and that progress
 * never runs backwards.
 *
 * Needs the big fixture, which is not committed - it is hundreds of megabytes,
 * and tests/video_fixtures/ is gitignored entirely:
 *
 *   python tests/make_big_video_fixture.py
 *   node tests/web/probe_video_memory.mjs
 *
 * Windows-only as written, because RSS comes from `Get-CimInstance
 * Win32_Process`. On a POSIX runner the same shape works with `ps -o rss=`;
 * the probe says so and skips rather than reporting a wrong number.
 */

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer, { CHROME } from "./resolve_puppeteer.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
/* `big.mp4` is the pathological shape - ten seconds at a near-lossless
   bitrate, which is where a probe rung used to cost a whole re-encode. Set
   FIXTURE to measure a different one (`real.mp4` is the ordinary shape: long,
   ordinary bitrate) without editing this file. */
const fixture = path.join(root, "tests", "video_fixtures",
  process.env.FIXTURE || "big.mp4");

if (!fs.existsSync(fixture)) {
  console.error("build the big fixture first: python tests/make_big_video_fixture.py");
  process.exit(1);
}

const sourceBytes = fs.statSync(fixture).size;

/* The budget: how much the ENCODE may add, as a multiple of the input.
 *
 * A flat ceiling either passes a small file trivially or fails a large one for
 * being large. A multiple asserts the property that actually matters - that
 * peak does not scale with the file until the machine swaps.
 *
 * What is deliberately NOT charged here is Chrome's own cost for holding the
 * file at all (about 2.3x its size, measured with the job still queued), for
 * two reasons. It is not ours to give back: intake already uses
 * `preload="metadata"` and `createObjectURL` rather than a copy, and the image
 * path's whole-file `arrayBuffer()` read is correctly skipped for video by
 * engine.js's `!i.isVideo` filter. And including it drowns the signal - with
 * that overhead in the total, reintroducing the whole-file output buffer moved
 * the number by 3%, which no honest gate can call a failure.
 *
 * Measured on two deliberately different shapes, after the fixes:
 *
 *   big.mp4   287 MB in 10 s, near-lossless. The pathological case, because a
 *             probe rung has to cover most of so short a file.
 *             Encode adds ~1,150-1,300 MB -> 4.0-4.5x.
 *   real.mp4  663 MB over 120 s, ordinary bitrate. The shape a phone or a
 *             screen recorder actually produces.
 *             Encode adds 1,824-2,176 MB -> 2.75-3.3x.
 *
 * The cost is plainly NOT proportional to the file: 2.3x the bytes bought about
 * 1.6x the memory. It behaves as a large fixed cost - the codec pipeline, one
 * window's frames, one chunk buffer - plus a modest per-byte term, which is why
 * the ceiling below is fixed-plus-per-byte rather than a flat multiple.
 *
 * The ceiling is set to catch a RUNAWAY - memory that scales with the file until
 * the machine swaps, which is the failure the owner hit - and not to catch a
 * regression of a few hundred megabytes. The invariant above catches those. */
const CEILING_FIXED = 2000 * 1024 * 1024;   // pipeline, frames, chunk buffers
const CEILING_PER_BYTE = 2.5;               // the part that does scale
const ceiling = CEILING_FIXED + sourceBytes * CEILING_PER_BYTE;

/* --------------------------------------------------------------- RSS reading */

/** Resident bytes across a process tree, from the OS rather than the page.
 *  Returns null where the platform is not supported, so the caller can skip
 *  loudly instead of asserting on a wrong number. */
function treeRss(rootPid) {
  if (os.platform() !== "win32") return null;
  /* Walk children from the root pid. Six generations is far more than
     Chrome's renderer/gpu/utility layout needs and costs nothing. */
  const script = [
    `$root=${rootPid}`,
    "$procs=Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize",
    "$want=New-Object System.Collections.Generic.HashSet[int]",
    "[void]$want.Add($root)",
    "for($i=0;$i -lt 6;$i++){ foreach($p in $procs){ if($want.Contains([int]$p.ParentProcessId)){ [void]$want.Add([int]$p.ProcessId) } } }",
    "$tot=0; foreach($p in $procs){ if($want.Contains([int]$p.ProcessId)){ $tot+=$p.WorkingSetSize } }",
    "$tot",
  ].join("; ");
  try {
    const out = execFileSync("powershell", ["-NoProfile", "-Command", script],
      { encoding: "utf8" });
    const n = Number(String(out).trim());
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}

const PORT = 8199;
const server = spawn("node", [path.join(here, "serve.mjs"), String(PORT)], {
  stdio: "ignore",
});
await new Promise((r) => setTimeout(r, 700));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  /* No isolation flags, and no SharedArrayBuffer flag: this architecture
     deliberately does not need cross-origin isolation, and launching the test
     browser with a capability the real site never has would be testing a
     different product - the same rule that removed that flag from
     probe_video.mjs. */
  args: ["--no-sandbox"],
});

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failures += 1;
};
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

try {
  const chromePid = browser.process().pid;
  if (treeRss(chromePid) == null) {
    console.log("  skip  RSS is not readable on this platform "
      + `(${os.platform()}) - not asserting a number we cannot measure`);
    await browser.close();
    server.kill();
    process.exit(0);
  }

  const page = await browser.newPage();
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: "networkidle0" });

  await new Promise((r) => setTimeout(r, 1500));
  const empty = treeRss(chromePid);
  console.log(`  ..    ${mb(empty)} with the page loaded, no file`);

  /* The file goes in through the real file input rather than as a base64
     argument to evaluate(): a 287 MB file is ~380 MB of base64, and the probe
     would be measuring its own argument. */
  const input = await page.$("#file-input");
  const started = Date.now();
  await input.uploadFile(fixture);

  /* THE BASELINE IS TAKEN AFTER THE FILE LANDS, not before, and that choice is
     what makes this gate mean something.
     Handing a 287 MB file to the page costs about 2.3x its size in Chrome's
     own blob and upload handling, with the job still sitting queued - measured
     at +667 MB. Charging that to the encode buries the thing being guarded:
     with it included, reintroducing the whole-file output buffer moved the
     total by only 3%, which is inside the noise a gate has to live with. From
     here, what is measured is what OUR code adds on top of a file the browser
     is already holding - and the same regression is unmissable.
     The wait is for the queue to settle, since intake decodes a poster frame
     and reads metadata before the worker is handed anything. */
  await page.waitForFunction(() => window.state?.items?.length > 0,
    { timeout: 120000 });
  await new Promise((r) => setTimeout(r, 2500));
  const baseline = treeRss(chromePid);
  console.log(`  ..    ${mb(baseline)} once the file has landed, job not started`
    + `  (Chrome's own cost for holding it: ${mb(baseline - empty)})`);

  await page.evaluate(() => {
    window.__seen = [];
    window.__watch = setInterval(() => {
      const it = window.state?.items?.[0];
      /* `frac` is the number and `progress` is the sentence - engine.js sets
         both on every progress message. An earlier version of this probe read
         `progress.fraction`, which does not exist, and so reported "0 distinct
         fractions" whatever the product did. A gate that cannot pass is as
         useless as one that cannot fail. */
      if (it) {
        window.__seen.push({ status: it.status,
                             frac: typeof it.frac === "number" ? it.frac : null,
                             say: it.progress || "" });
      }
    }, 250);
  });

  /* Poll for the peak. Reading once at the end would be a lie about what the
     machine went through - by then the interesting bytes are freed. */
  let peak = 0;
  let done = false;
  const deadline = Date.now() + 25 * 60 * 1000;
  while (!done && Date.now() < deadline) {
    const now = treeRss(chromePid);
    if (now != null) peak = Math.max(peak, now);
    done = await page.evaluate(() => {
      const it = window.state?.items?.[0];
      return !!it && ["done", "failed", "saved"].includes(it.status);
    });
    if (!done) await new Promise((r) => setTimeout(r, 1000));
  }

  const seen = await page.evaluate(() => {
    clearInterval(window.__watch);
    return window.__seen;
  });
  const outcome = await page.evaluate(() => {
    const it = window.state?.items?.[0];
    return it ? { status: it.status, error: it.error || "",
                  bytes: it.newBytes || 0, score: it.score ?? null,
                  isVideo: !!it.isVideo } : null;
  });
  const elapsed = ((Date.now() - started) / 1000).toFixed(0);
  const growth = Math.max(0, peak - baseline);

  /* THE STREAMING INVARIANT, asserted on the mechanism rather than on resident
     memory. The worker reports the largest single buffer the muxer handed it;
     with a chunked stream target that stays at the chunk size, and restoring
     `BufferTarget` or `fastStart: "in-memory"` makes it the whole output in one
     allocation. Deterministic, so unlike the RSS figure below it cannot pass or
     fail by luck. */
  const invariant = await page.evaluate(async () => {
    /* The same File the page already holds, driven through a worker of this
       probe's own so the number can be read off the result directly - the
       product does not carry it onto the item, and adding product state for a
       test's benefit would be the wrong trade. */
    const file = window.state.items[0].file;
    const worker = new Worker("/video-worker.js", { type: "module" });
    const caps = await new Promise((resolve) => {
      worker.onmessage = (e) => { if (e.data.type === "caps") resolve(e.data.caps); };
      worker.postMessage({ type: "probe" });
    });
    const out = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ error: "timed out" }), 20 * 60 * 1000);
      worker.onmessage = (e) => {
        if (e.data.type === "done") {
          clearTimeout(timer);
          resolve({ largestWrite: e.data.result.largestWrite,
                    bytes: e.data.result.bytes });
        }
        if (e.data.type === "failed") { clearTimeout(timer); resolve({ error: e.data.error }); }
      };
      worker.postMessage({
        type: "job", id: "inv", file,
        /* One format only: the invariant is about how bytes leave the muxer,
           and a bake-off would just do it twice. */
        settings: { maxDimension: 1920, qualityTarget: 92,
                    formats: [caps.formats[0]] },
      });
    });
    worker.terminate();
    return out;
  });

  const chunkCeiling = 8 * 1024 * 1024;   // the worker stages 4 MB; allow slack
  check("output leaves the muxer in chunks, not one whole-file buffer",
    !invariant.error && invariant.largestWrite > 0
      && invariant.largestWrite <= chunkCeiling,
    invariant.error
      || `largest single write ${mb(invariant.largestWrite)} of a `
         + `${mb(invariant.bytes)} result (ceiling ${mb(chunkCeiling)})`);

  /* The reassembly itself, against a reference implementation.
     The muxer's writes carry byte POSITIONS, arrive out of order, overlap, and
     patch each other; the worker resolves them newest-write-wins and hands the
     pieces to a Blob. Two bugs already came out of that and both produced a
     file of plausible SIZE that no demuxer would open - which reads as a
     quality failure, not a corruption. Encoding cannot localise this, so the
     algorithm is checked directly against the obvious-but-wasteful version:
     write everything into one flat buffer in arrival order. They must agree
     byte for byte.
     The gap case is the one that regressed: a Blob concatenates its pieces, so
     a hole between two writes silently CLOSES, shifting every byte after it. */
  const agrees = await page.evaluate(() => {
    const resolve = (parts) => {
      const newestFirst = [...parts].sort((a, b) => b.seq - a.seq);
      const claimed = [], owned = [];
      for (const { at, bytes } of newestFirst) {
        let from = at;
        const to = at + bytes.byteLength;
        const overlaps = claimed
          .filter((c) => c[1] > from && c[0] < to).sort((a, b) => a[0] - b[0]);
        for (const [cFrom, cTo] of overlaps) {
          if (cFrom > from) {
            owned.push({ at: from, bytes: bytes.subarray(from - at, cFrom - at) });
          }
          from = Math.max(from, cTo);
        }
        if (from < to) owned.push({ at: from, bytes: bytes.subarray(from - at, to - at) });
        claimed.push([at, to]);
      }
      owned.sort((a, b) => a.at - b.at);
      const pieces = [];
      let cursor = 0;
      for (const p of owned) {
        if (p.at > cursor) pieces.push(new Uint8Array(p.at - cursor));
        pieces.push(p.bytes);
        cursor = p.at + p.bytes.byteLength;
      }
      const out = [];
      for (const b of pieces) for (const v of b) out.push(v);
      return out;
    };
    const reference = (parts) => {
      let end = 0;
      for (const p of parts) end = Math.max(end, p.at + p.bytes.byteLength);
      const buf = new Uint8Array(end);
      for (const p of [...parts].sort((a, b) => a.seq - b.seq)) buf.set(p.bytes, p.at);
      return [...buf];
    };
    const mk = (at, vals, seq) => ({ at, bytes: new Uint8Array(vals), seq });
    const cases = {
      "the muxer's real shape: a big write then a tiny later patch":
        [mk(0, [1, 2, 3, 4, 5, 6, 7, 8], 1), mk(4, [99, 98], 2)],
      "a newer write fully covering an older one":
        [mk(2, [7, 7, 7], 1), mk(0, [1, 2, 3, 4, 5, 6], 2)],
      "an older write around a newer one - both its ends must survive":
        [mk(0, [1, 2, 3, 4, 5, 6], 1), mk(2, [9, 9], 2)],
      "three writes overlapping each other":
        [mk(0, [1, 1, 1, 1, 1, 1, 1, 1], 1), mk(2, [2, 2, 2, 2], 2), mk(4, [3, 3], 3)],
      "a gap between two writes must stay a gap":
        [mk(0, [1, 2], 1), mk(5, [3, 4], 2)],
      "the same range written twice - the later one wins":
        [mk(0, [1, 1, 1], 1), mk(0, [2, 2, 2], 2)],
      "writes arriving out of position order":
        [mk(8, [8, 8], 1), mk(0, [1, 1, 1, 1], 2), mk(4, [4, 4, 4, 4], 3)],
    };
    const bad = [];
    for (const [name, parts] of Object.entries(cases)) {
      if (JSON.stringify(resolve(parts)) !== JSON.stringify(reference(parts))) {
        bad.push(name);
      }
    }
    return { total: Object.keys(cases).length, bad };
  });
  check(`reassembling the muxer's writes matches a flat-buffer reference `
    + `(${agrees.total} cases)`,
    agrees.bad.length === 0, agrees.bad.join("; "));

  check("the big video was taken as a video", !!outcome && outcome.isVideo,
    outcome ? JSON.stringify(outcome).slice(0, 120) : "no item");
  check("the job finished rather than dying", !!outcome && outcome.status === "done",
    outcome ? `${outcome.status} ${outcome.error}`.trim() : "no item");

  /* THE assertion. Everything else in this file is context for it. */
  check("the encode's memory does not run away with the file",
    growth > 0 && growth <= ceiling,
    `grew ${mb(growth)} (peak ${mb(peak)} - baseline ${mb(baseline)}) `
    + `vs ceiling ${mb(ceiling)} on a ${mb(sourceBytes)} input `
    + `[${(growth / sourceBytes).toFixed(2)}x]`);

  /* A job that never yields cannot report, and one report at the end is not
     progress. Several distinct fractions is the evidence it comes up for air. */
  const fractions = seen.map((s) => s.frac).filter((v) => typeof v === "number");
  const distinct = new Set(fractions.map((v) => v.toFixed(3)));
  const said = new Set(seen.map((s) => s.say).filter(Boolean));
  check("progress keeps arriving while it works", distinct.size >= 3,
    `${distinct.size} distinct fractions over ${elapsed}s`);
  check("and it says what it is doing, in words", said.size >= 2,
    [...said].slice(0, 3).join(" | "));
  check("progress never runs backwards",
    fractions.every((v, i) => i === 0 || v >= fractions[i - 1]));

  check("no console errors", consoleErrors.length === 0,
    consoleErrors.slice(0, 2).join(" | "));

  console.log(`\n  input ${mb(sourceBytes)}  baseline ${mb(baseline)}  `
    + `peak ${mb(peak)}  growth ${mb(growth)}  ${elapsed}s`);
} catch (error) {
  check("the probe ran", false, String((error && error.message) || error));
} finally {
  await browser.close();
  server.kill();
}

console.log(failures ? `\n${failures} failed` : "\nall good");
process.exit(failures ? 1 : 0);
