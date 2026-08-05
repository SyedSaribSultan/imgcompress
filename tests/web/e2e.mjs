/* Browser E2E for the imgcompress web app: real Chrome, real files, real
 * downloads. Serves web/ locally with production headers, uploads the fixture
 * set, and checks the engine's promises hold.
 *
 *   python tests/web/make_web_fixtures.py     # once, to build fixtures/
 *   node tests/web/e2e.mjs                    # local build
 *   E2E_URL=https://... node tests/web/e2e.mjs  # against a deployment
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer, { CHROME } from "./resolve_puppeteer.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8137;
const FIX = path.join(here, "fixtures");
const DL = path.join(here, "downloads");

if (!existsSync(path.join(FIX, "photo.png"))) {
  console.error(`fixtures missing in ${FIX} — run: python tests/web/make_web_fixtures.py`);
  process.exit(2);
}

rmSync(DL, { recursive: true, force: true });
mkdirSync(DL, { recursive: true });

let passed = 0, failed = 0;
const ok = (cond, name) => {
  if (cond) { passed++; console.log(`  ok ${name}`); }
  else { failed++; console.error(`FAIL ${name}`); }
};

const BASE = process.env.E2E_URL || `http://127.0.0.1:${PORT}/`;
let server = null;
if (!process.env.E2E_URL) {
  // serve.mjs replays vercel.json's headers, CSP included - a plain static
  // server hides CSP violations that then only surface in production.
  server = spawn("node", [path.join(here, "serve.mjs"), String(PORT)], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 900));
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--no-first-run", "--disable-extensions"],
  // A waitForFunction rides one CDP call until it resolves; heavy frames
  // outlive the 180s default and die at the protocol layer, not the wait.
  protocolTimeout: 3_600_000,
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 920 });

  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push(String(e)));

  await page.goto(BASE, { waitUntil: "networkidle0" });

  ok((await page.title()).includes("imgcompress"), "page title");

  // The floor the engine actually runs with, on a fresh profile. An init
  // scaling bug once set the slider to 9000, which clamped to its max and
  // silently ran every search at floor 99 - lossy candidates all "failed"
  // and the app over-shipped lossless. The UI default IS the promise.
  const freshFloor = await page.$eval("#quality", (el) => Number(el.value));
  ok(freshFloor === 90, `fresh profile floor is 90 (got ${freshFloor})`);
  await page.screenshot({ path: path.join(here, "shot-empty.png") });

  // ---- upload the whole fixture set --------------------------------------
  const files = ["photo.png", "photo5mp.png", "ui.png", "logo.png", "static.gif", "anim.gif",
                 "small.jpg", "corrupt.png", "chromanoise.png"].map((f) => path.join(FIX, f));
  const input = await page.$("#file-input");
  await input.uploadFile(...files);

  await page.waitForFunction(
    (n) => typeof state !== "undefined" && state.items.length === n &&
           state.items.every((i) => ["done", "failed", "saved"].includes(i.status)),
    { timeout: 900_000, polling: 500 }, files.length);

  const items = await page.evaluate(() =>
    state.items.map((i) => ({
      name: i.name, status: i.status, fmt: i.fmt, level: i.level,
      score: i.score, lossless: i.lossless, passthrough: i.passthrough,
      originalBytes: i.originalBytes, newBytes: i.newBytes,
      note: i.note, error: i.error, warnings: i.warnings,
      candidates: i.candidates, outW: i.outW, outH: i.outH,
    })));

  console.log("\nresults:");
  for (const it of items) {
    console.log(`  ${it.name}: ${it.status} ${it.fmt || ""} ` +
      `${it.originalBytes} -> ${it.newBytes ?? "—"} ` +
      `score=${it.lossless ? "lossless" : it.score?.toFixed?.(4) ?? "—"} ${it.note || it.error || ""}`);
    for (const c of it.candidates || []) {
      console.log(`      ${c.format}: ${c.bytes} B  ${c.lossless ? "lossless" : c.score?.toFixed?.(4)}`);
    }
  }
  console.log();

  const by = Object.fromEntries(items.map((i) => [i.name, i]));

  ok(by["photo.png"].status === "done", "photo compressed");
  ok(by["photo.png"].newBytes < by["photo.png"].originalBytes, "photo smaller");
  ok(by["photo.png"].candidates.length >= 3, "photo bake-off tried >=3 candidates");
  // The engine's real promise: the winner is the smallest candidate that
  // passed the floor. Asserting a specific format here was asserting an
  // expectation about a synthetic fixture, and the engine kept being right
  // in ways the fixture wasn't.
  {
    const p = by["photo.png"];
    const passing = p.candidates.filter((c) => c.lossless || c.score >= 90);
    const smallest = Math.min(...passing.map((c) => c.bytes));
    ok(passing.length > 0 && p.newBytes === smallest,
       `photo winner is the smallest passing candidate (${p.fmt} ${p.newBytes} vs min ${smallest})`);
    ok(p.candidates.some((c) => !c.lossless && c.score != null),
       "a lossy candidate was measured for the photo");
  }

  // The 5MP frame crosses the metric's full-frame verification budget: lossy
  // candidates must be MEASURED there, not die on memory and forfeit to
  // lossless - which is exactly what happened on 12MP frames once.
  {
    const p5 = by["photo5mp.png"];
    ok(p5.status === "done", "5MP photo compressed");
    ok(p5.candidates.some((c) => !c.lossless && c.score != null && c.score > 0),
       `5MP frame: lossy candidates were measured, not forfeited (${
         p5.candidates.map((c) => `${c.format}:${c.lossless ? "ll" : c.score?.toFixed(1)}`).join(" ")})`);
    ok(!(p5.warnings || []).some((w) => /failed/.test(w)),
       `5MP frame: no candidate crashed (${(p5.warnings || []).join("; ") || "clean"})`);
  }
  // With mozjpeg forcing 4:4:4, jpeg may legitimately win here - but only by
  // actually clearing the floor. What must never happen is a sub-floor jpeg.
  const cn = by["chromanoise.png"];
  ok(cn.status === "done" && (cn.fmt !== "jpeg" || cn.lossless || cn.score >= 90),
     `chroma-noise ships only if verified (${cn.fmt} ${cn.lossless ? "lossless" : cn.score?.toFixed(1)})`);

  ok(by["ui.png"].status === "done" && by["ui.png"].newBytes < by["ui.png"].originalBytes, "ui compressed smaller");
  ok(by["ui.png"].fmt === "png8", `ui winner is png8 (got ${by["ui.png"].fmt})`);

  ok(by["logo.png"].status === "done", "alpha logo compressed");
  ok(by["logo.png"].fmt !== "jpeg", "alpha never routed to jpeg");
  ok(!by["logo.png"].candidates.some((c) => c.format === "jpeg"), "jpeg not even tried on alpha");

  ok(by["anim.gif"].passthrough && /animated/.test(by["anim.gif"].note), "animated gif passes through");
  ok(by["static.gif"].status === "done", "static gif handled");
  ok(by["corrupt.png"].status === "failed" && by["corrupt.png"].error, "corrupt file fails gracefully");

  for (const it of items) {
    if (it.status === "done") ok(it.newBytes <= it.originalBytes, `${it.name} never bigger`);
  }

  const floor = 90;   // SSIMULACRA 2 default
  for (const it of items) {
    if (it.status === "done" && !it.passthrough && it.score != null && !it.lossless) {
      const cleared = it.score >= floor || (it.warnings || []).some((w) => /could not reach/.test(w));
      ok(cleared, `${it.name} clears floor or warns (${it.score?.toFixed(1)})`);
    }
  }

  // ---- inspector renders ---------------------------------------------------
  await page.evaluate(() => selectItem(state.items[0].id));
  await page.waitForFunction(() => document.getElementById("img-before").naturalWidth > 0);
  await page.screenshot({ path: path.join(here, "shot-loaded.png") });
  const statText = await page.evaluate(() => ({
    size: document.getElementById("s-size").textContent,
    fmtL: document.getElementById("s-format").textContent,
    score: document.getElementById("s-score").textContent,
  }));
  ok(/from/.test(statText.size), "stats panel shows sizes");

  // ---- override: force jpeg on the ui screenshot ---------------------------
  await page.evaluate(() => selectItem(state.items.find((i) => i.name === "ui.png").id));
  // A candidate card IS the format control now: click the jpeg row.
  const cardClicked = await page.evaluate(() => {
    const card = [...document.querySelectorAll('#cands .cand[data-format="jpeg"]')][0];
    if (!card) return false;
    card.click();
    return true;
  });
  ok(cardClicked, "jpeg candidate card is present and clickable");
  await page.waitForFunction(
    () => { const it = state.items.find((i) => i.name === "ui.png");
            return it.status === "done" && it.fmt === "jpeg"; },
    { timeout: 600_000 });
  ok(true, "clicking a candidate card forces that format");
  ok(await page.evaluate(() =>
      !!document.querySelector('#cands .cand.forced[data-format="jpeg"]')),
     "the chosen card is marked as forced");
  const uiForced = await page.evaluate(() => {
    const it = state.items.find((i) => i.name === "ui.png");
    return { fmt: it.fmt, n: it.newBytes, o: it.originalBytes };
  });
  ok(uiForced.n <= uiForced.o, "forced jpeg still never bigger");

  // ---- settings change requeues -------------------------------------------
  await page.evaluate(() => {
    document.getElementById("quality").value = "92";
    document.getElementById("quality").dispatchEvent(new Event("change"));
  });
  await new Promise((r) => setTimeout(r, 600)); // debounce
  await page.waitForFunction(
    () => state.items.every((i) => ["done", "failed", "saved"].includes(i.status)),
    { timeout: 900_000, polling: 500 });
  ok(true, "settings change requeues and completes");

  // ---- wasm codecs ---------------------------------------------------------
  const caps1 = await page.evaluate(() => state.caps);
  ok(caps1.mozjpeg === true, "mozjpeg wasm loaded and active");
  ok(caps1.oxipng === true, "oxipng wasm loaded and active");

  // Switch to the web target: AVIF joins the bake-off.
  await page.select("#target", "web");
  await page.evaluate(() => document.getElementById("target").dispatchEvent(new Event("change")));
  await new Promise((r) => setTimeout(r, 600));
  await page.waitForFunction(
    () => state.items.every((i) => ["done", "failed", "saved"].includes(i.status)),
    { timeout: 1_500_000, polling: 500 });
  const webRun = await page.evaluate(() => ({
    caps: state.caps,
    logo: (() => { const it = state.items.find((i) => i.name === "logo.png");
                   return { fmt: it.fmt, cands: it.candidates.map((c) => c.format) }; })(),
  }));
  console.log("  web-target logo:", JSON.stringify(webRun.logo));
  ok(webRun.caps.avif === true, "avif wasm loaded and active");
  ok(webRun.logo.cands.includes("avif"), "avif competed in the web-target bake-off");

  // ---- download all → zip --------------------------------------------------
  const cdp = await page.createCDPSession();
  await cdp.send("Browser.setDownloadBehavior", {
    behavior: "allow", downloadPath: DL, eventsEnabled: true,
  });
  const downloadDone = new Promise((resolve) => {
    cdp.on("Browser.downloadProgress", (e) => { if (e.state === "completed") resolve(); });
  });
  await page.click("#save-btn");
  await downloadDone;
  const zips = readdirSync(DL).filter((f) => f.endsWith(".zip"));
  ok(zips.length === 1, `zip downloaded (${zips.join(", ")})`);
  if (zips.length) {
    const size = statSync(path.join(DL, zips[0])).size;
    ok(size > 1000, `zip has content (${size} B)`);
  }

  // ---- console must be clean ----------------------------------------------
  ok(consoleErrors.length === 0,
     `no console errors${consoleErrors.length ? ": " + consoleErrors.join(" | ") : ""}`);

  // ---- capability line / caps probe -----------------------------------------
  const caps = await page.evaluate(() => state.caps);
  console.log("  caps:", JSON.stringify(caps));
  ok(caps.png8 === true, "png8 engine available (CompressionStream)");
  ok(caps.webp === true, "webp encoder available in Chrome");

} finally {
  await browser.close();
  if (server) server.kill();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
