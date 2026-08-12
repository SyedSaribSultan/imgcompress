/* Does the stage grow when the frame is zoomed past it? That is the layout
 * fault behind "scrolling jumps me to the top and I have to drag back".
 *
 * This printed a table and exited 0 whatever the table said, which made it the
 * last gate in the suite that could not fail. It matters here more than most:
 * the comparison view is the thing the product is *for*, and zoom geometry is
 * exactly what a layout change disturbs. A gate that cannot fail is no help
 * during the change most likely to break it.
 *
 * The four promises, none of which depend on how the page is laid out:
 *   1. the wheel actually magnifies;
 *   2. the frame grows when it does;
 *   3. the stage does NOT grow with it - it is a window, not a sleeve;
 *   4. so the document never gets taller and the page never scrolls.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer, { CHROME } from "./resolve_puppeteer.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(here, "fixtures");

let bad = 0;
const ok = (c, n) => { if (c) console.log(`  ok ${n}`); else { console.error(`FAIL ${n}`); bad++; } };

const server = spawn("node", [path.join(here, "serve.mjs"), "8192"], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 900));
const b = await puppeteer.launch({
  executablePath: CHROME, headless: true, protocolTimeout: 3_600_000,
});
try {
  const pg = await b.newPage();
  await pg.setViewport({ width: 1440, height: 940 });
  pg.on("pageerror", (e) => console.log("[pageerror]", String(e)));
  await pg.goto("http://127.0.0.1:8192/", { waitUntil: "networkidle0" });
  const input = await pg.$("#file-input");
  await input.uploadFile(path.join(FIX, "photo.png"));
  await pg.waitForFunction(() => state.items.every((i) =>
    ["done", "failed", "saved"].includes(i.status)), { timeout: 900000, polling: 300 });
  await new Promise((r) => setTimeout(r, 600));

  const report = await pg.evaluate(() => {
    const out = [];
    const stage = document.getElementById("stage");
    /* The transformed layer used to be #viewport and is #frame since the UI was
       rebuilt. Same thing: the box that holds both images at natural size and
       carries the zoom. `zoom` and `pan` were script globals when the app was one
       classic script; they are module state now and come through the harness seam
       the app declares for exactly this. */
    const vp = document.getElementById("frame");
    const snap = (label) => {
      const s = stage.getBoundingClientRect(), v = vp.getBoundingClientRect();
      const zoom = imgc.zoom(), pan = imgc.pan();
      out.push({
        label, zoom, pan: { x: Math.round(pan.x), y: Math.round(pan.y) },
        stage: `${Math.round(s.width)}x${Math.round(s.height)} @${Math.round(s.top)}`,
        frame: `${Math.round(v.width)}x${Math.round(v.height)} @${Math.round(v.top)}`,
        stageW: Math.round(s.width), stageH: Math.round(s.height),
        frameW: Math.round(v.width), frameH: Math.round(v.height),
        // Centres, so "is it still centred" is measurable rather than eyeballed.
        stageCx: Math.round(s.left + s.width / 2),
        stageCy: Math.round(s.top + s.height / 2),
        frameCx: Math.round(v.left + v.width / 2),
        frameCy: Math.round(v.top + v.height / 2),
        pageH: Math.round(document.documentElement.scrollHeight),
        scrollY: Math.round(window.scrollY),
      });
    };
    snap("fit");
    const box = stage.getBoundingClientRect();
    const x = box.left + box.width * 0.3, y = box.top + box.height * 0.3;
    for (const n of [1, 2, 3, 4]) {
      stage.dispatchEvent(new WheelEvent("wheel", {
        deltaY: -100, clientX: x, clientY: y, bubbles: true, cancelable: true }));
      snap(`wheel x${n}`);
    }
    return out;
  });
  for (const r of report) {
    console.log(`  ${r.label.padEnd(9)} zoom=${String(r.zoom).padEnd(4)} ` +
      `pan=(${String(r.pan.x).padStart(6)},${String(r.pan.y).padStart(6)})  ` +
      `stage ${r.stage.padEnd(18)} frame ${r.frame.padEnd(20)} ` +
      `pageH=${r.pageH} scrollY=${r.scrollY}`);
  }

  const fit = report[0], last = report[report.length - 1];
  const TOL = 2;   // rounding only

  ok(report.length === 5, `every zoom step was measured (${report.length})`);
  ok(last.zoom > fit.zoom, `the wheel magnifies (${fit.zoom} -> ${last.zoom})`);
  ok(last.frameW > fit.frameW,
     `the frame grows with it (${fit.frameW} -> ${last.frameW}px wide)`);

  /* THE one. The frame is centred on the stage by `left/top: 50%` plus a
     `translate(-50%, -50%)`, then panned, so at every scale:

         frame centre - pan == stage centre

     It is done that way on purpose. CSS alignment silently switches from
     `center` to `start` the moment an item is bigger than its container - the
     "safe" behaviour, meant to stop content being scrolled out of reach - so
     grid centring snapped the frame to the top-left the instant you zoomed
     past the stage, and the rest of the picture hung off the bottom. That was
     the original "scrolling takes me to the top and I have to drag a long way
     back". A transform has no such rule.

     This is the assertion that notices if anyone goes back to centring by
     alignment, and it is written against the promise rather than against the
     mechanism, so it survives the layout being rebuilt around it. */
  const offCentre = report.filter((r) =>
    Math.abs((r.frameCx - r.pan.x) - r.stageCx) > TOL ||
    Math.abs((r.frameCy - r.pan.y) - r.stageCy) > TOL);
  ok(offCentre.length === 0,
     `the frame stays centred on the stage at every scale (${
       offCentre.length
         ? offCentre.map((r) => `${r.label}: off by ${
             (r.frameCx - r.pan.x) - r.stageCx},${
             (r.frameCy - r.pan.y) - r.stageCy}`).join("; ")
         : "centred throughout"})`);

  /* The stage is a window onto the frame, not a sleeve around it: it holds its
     size while the frame grows inside. A stage that stretches is what makes the
     document taller, and a taller document is what scrolls the picture out
     from under the pointer - so the next two are the same fault seen further
     downstream. */
  const stageHeights = report.map((r) => r.stageH);
  ok(Math.max(...stageHeights) - Math.min(...stageHeights) <= TOL,
     `the stage holds its height through every zoom step (${stageHeights.join(" -> ")})`);

  const pageHeights = report.map((r) => r.pageH);
  ok(Math.max(...pageHeights) - Math.min(...pageHeights) <= TOL,
     `the document never gets taller (${pageHeights.join(" -> ")})`);
  ok(report.every((r) => r.scrollY === 0),
     `the page never scrolls (${report.map((r) => r.scrollY).join(",")})`);
} finally { await b.close(); server.kill(); }

console.log(bad === 0 ? "\nOK — the stage is a window, not a sleeve" : `\n${bad} problem(s)`);
process.exit(bad ? 1 : 0);
