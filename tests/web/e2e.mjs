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

  /* Dropping files starts the work at once — but the untouched original is on
     screen before any of it runs. That ordering is the promise now, so it is
     asserted at the only moment it is observable: the frame the drop lands. */
  await page.waitForFunction(() => typeof state !== "undefined");
  // Freeze dispatch for one beat so the anchor frame can be inspected. The app
  // holds it for a frame by design; this holds it long enough to look.
  await page.evaluate(() => {
    window.__realDispatch = dispatch;
    window.dispatch = async () => { window.__dispatched = true; };
  });
  const inputEl = await page.$("#file-input");
  await inputEl.uploadFile(...files);
  await new Promise((r) => setTimeout(r, 400));

  const anchor = await page.evaluate(() => {
    const before = document.getElementById("img-before");
    return {
      dispatched: !!window.__dispatched,
      studio: !document.getElementById("app-full").hidden,
      showingOriginal: before.getAttribute("src") === state.items[0].beforeURL,
      afterSrc: document.getElementById("img-after").getAttribute("src"),
      badge: document.getElementById("stage-badge").textContent,
      narration: document.getElementById("narration").textContent,
      listed: state.items.length,
    };
  });
  console.log("  anchor frame:", JSON.stringify(anchor));
  ok(anchor.studio && anchor.showingOriginal,
     "the drop paints the untouched original first");
  ok(!anchor.afterSrc, "nothing compressed is on the stage yet");
  ok(/untouched/i.test(anchor.badge), `the original is labelled as such (${anchor.badge})`);
  // Frame 2's sentence is the landing page's promise, in the present tense.
  // It is copy that ships, not copy that gets approximated.
  ok(anchor.narration ===
     "Trying a few ways to shrink this, keeping only the one that still looks right.",
     `the narration mirrors the promise (${JSON.stringify(anchor.narration)})`);
  ok(anchor.listed === files.length,
     `every dropped image is queued (${anchor.listed}/${files.length})`);

  await page.evaluate(() => { window.dispatch = window.__realDispatch; dispatch(); });

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
  /* This used to assert png8 outright, which quietly pinned the old default
     rather than the promise: flat UI artwork wins on a palette or lossless
     format, and *which* one depends on what the destination allows. Under the
     design-tool set it is png8; with the web set on the table webp-lossless
     takes it, which is exactly what moving the default to `web` was for.
     What must hold either way is that the smallest version that still looks
     right is the one that ships, and that flat artwork never lands in a
     photographic codec. */
  {
    const ui = by["ui.png"];
    const passing = ui.candidates.filter((c) => c.lossless || c.score >= 90);
    const smallest = Math.min(...passing.map((c) => c.bytes));
    ok(ui.fmt !== "jpeg", `flat UI artwork does not go to a lossy photo codec (${ui.fmt})`);
    ok(ui.newBytes === smallest,
       `ui winner is the smallest version that passed (${ui.fmt} ${ui.newBytes} vs ${smallest})`);
  }

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

  // ---- every image reports how long it took --------------------------------
  {
    const t = await page.evaluate(() => ({
      elapsed: state.items.filter((i) => i.status === "done" || i.status === "saved")
        .map((i) => i.elapsedMs),
      phases: [...document.querySelectorAll("#queue-list .phase")].map((e) => e.textContent),
      rows: reportRows(),
    }));
    ok(t.elapsed.length > 0 && t.elapsed.every((ms) => ms > 0),
       `every finished image recorded a duration (${t.elapsed.length} images)`);
    ok(t.phases.some((p) => /\d+(\.\d+)?\s?(ms|s)\b/.test(p)),
       "the queue shows each image's time");
    ok(t.rows.every((r) => typeof r.time_ms === "number" && r.time_ms > 0),
       "the exported report carries time_ms per image");
  }

  /* ---- nothing ever paints the browser's broken-image glyph ---------------
   * A file this browser cannot decode (a damaged export, or a format with no
   * decoder) used to leave a torn-page icon and the alt text sitting on the
   * stage, which reads as "this app is broken". An <img> with nothing to show
   * must be out of the layout, and the stage must say what happened. */
  const ghosts = () => {
    const out = [];
    for (const id of ["img-before", "img-after"]) {
      const el = document.getElementById(id);
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      if (cs.display !== "none" && cs.visibility !== "hidden" &&
          el.naturalWidth === 0 && r.width > 0 && r.height > 0) {
        out.push(`${id} ${Math.round(r.width)}x${Math.round(r.height)}`);
      }
    }
    return out;
  };
  {
    await page.evaluate(() => selectItem(state.items.find((i) => i.name === "corrupt.png").id));
    await new Promise((r) => setTimeout(r, 400));
    const g = await page.evaluate(ghosts);
    ok(g.length === 0, `undecodable file paints no broken-image box (${g.join(", ") || "clean"})`);
    const msg = await page.evaluate(() => {
      const el = document.getElementById("stage-none");
      return { hidden: el.hidden, text: el.textContent.trim() };
    });
    ok(!msg.hidden && msg.text.length > 0, `the stage says why there is no preview ("${msg.text}")`);

    await page.evaluate(() => selectItem(state.items.find((i) => i.name === "photo.png").id));
    await new Promise((r) => setTimeout(r, 400));
    const g2 = await page.evaluate(ghosts);
    ok(g2.length === 0, `a normal image paints no broken-image box (${g2.join(", ") || "clean"})`);
    ok(await page.evaluate(() => document.getElementById("stage-none").hidden),
       "the placeholder is gone once there is a preview");
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

  /* ---- the candidate chips ARE the format control -----------------------
   * And they answer instantly: every encode came home with the run, so a tap
   * is a relabel, not another bake-off. Measured, because "immediately" is the
   * whole reason this control teaches itself. */
  await page.evaluate(() => selectItem(state.items.find((i) => i.name === "ui.png").id));
  await new Promise((r) => setTimeout(r, 200));
  const swap = await page.evaluate(() => {
    const it = () => state.items.find((i) => i.name === "ui.png");
    const was = { fmt: it().fmt, bytes: it().newBytes, url: it().afterURL };
    const card = document.querySelector('#cands .cand[data-format="jpeg"]');
    if (!card) return { found: false };
    const t0 = performance.now();
    card.click();
    return {
      found: true, was, ms: performance.now() - t0,
      fmt: it().fmt, bytes: it().newBytes, status: it().status,
      urlChanged: it().afterURL !== was.url,
      pick: it().pick,
    };
  });
  console.log("  chip swap:", JSON.stringify(swap));
  ok(swap.found, "the jpeg chip is present and clickable");
  ok(swap.fmt === "jpeg" && swap.status === "done",
     `tapping a chip shows that encode at once (${swap.fmt}/${swap.status})`);
  ok(swap.ms < 250, `and it happens in the click, not after a re-run (${swap.ms?.toFixed(0)} ms)`);
  ok(swap.urlChanged && swap.bytes === (await page.evaluate(() =>
      state.items.find((i) => i.name === "ui.png").candidates
        .find((c) => c.format === "jpeg").bytes)),
     "the shown bytes are that candidate's own");
  await new Promise((r) => setTimeout(r, 200));
  ok(await page.evaluate(() =>
      !!document.querySelector('#cands .cand.current[data-format="jpeg"]')),
     "the chosen chip is marked as the one on screen");
  ok(/because you picked it/.test(await page.evaluate(() =>
      document.getElementById("narration").textContent)),
     "the narration says why this one is showing");

  // And the winner chip is the way back to the automatic answer.
  const back = await page.evaluate(() => {
    const it = () => state.items.find((i) => i.name === "ui.png");
    document.querySelector("#cands .cand.win")?.click();
    return { fmt: it().fmt, pick: it().pick };
  });
  ok(back.pick === null, `the winner chip restores the automatic choice (${JSON.stringify(back)})`);

  const uiForced = await page.evaluate(() => {
    const it = state.items.find((i) => i.name === "ui.png");
    return { fmt: it.fmt, n: it.newBytes, o: it.originalBytes };
  });
  ok(uiForced.n <= uiForced.o, "the automatic answer is still never bigger");

  /* ---- the two decisions the toolbar offers ------------------------------
   * Quality is words on top of one number, and Format spans "let the app
   * choose" to "use this one". Both must survive round-tripping, because the
   * engine reads the DOM: a control that displays one thing while the engine
   * runs another is the exact shape of the floor-99 bug. */
  {
    const roundTrip = await page.evaluate(() => {
      const sel = document.getElementById("quality-preset");
      const slider = document.getElementById("quality");
      const out = {};
      sel.value = "80";
      sel.dispatchEvent(new Event("change"));
      out.wordsSetTheNumber = slider.value;
      slider.value = "87";
      slider.dispatchEvent(new Event("input"));
      out.offPreset = sel.value;
      sel.value = "90";
      sel.dispatchEvent(new Event("change"));
      out.backTo90 = slider.value;
      return out;
    });
    ok(roundTrip.wordsSetTheNumber === "80",
       `a named quality sets the floor (${roundTrip.wordsSetTheNumber})`);
    ok(roundTrip.offPreset === "custom",
       `a floor between the names reads as Custom (${roundTrip.offPreset})`);
    ok(roundTrip.backTo90 === "90", "and it goes back");

    const one = await page.evaluate(() => {
      const t = document.getElementById("target");
      t.value = "one-webp";
      t.dispatchEvent(new Event("change"));
      return { has: !!t.querySelector('option[value="one-jpeg"]') };
    });
    await new Promise((r) => setTimeout(r, 600));
    const restricted = await page.evaluate(() => state.settings.formats);
    ok(one.has, "the Format control offers single formats");
    ok(JSON.stringify(restricted) === '["webp"]',
       `choosing one format restricts the engine to it (${JSON.stringify(restricted)})`);

    /* JPEG cannot store transparency, and the fixture set contains a logo that
     * has it. Choosing JPEG must therefore ask rather than silently produce
     * black boxes or silently ignore the request. */
    await page.evaluate(() => {
      const t = document.getElementById("target");
      t.value = "one-jpeg";
      t.dispatchEvent(new Event("change"));
    });
    await new Promise((r) => setTimeout(r, 400));
    ok(await page.evaluate(() => document.getElementById("alpha-ask").open),
       "choosing JPEG with transparent artwork queued asks first");
    await page.click("#alpha-cancel");
    await new Promise((r) => setTimeout(r, 400));
    const afterCancel = await page.evaluate(() => document.getElementById("target").value);
    ok(afterCancel === "one-webp",
       `cancelling restores the setting actually in force (${afterCancel})`);

    // Answer it this time, and check the logo is kept rather than mangled.
    const rev = await page.evaluate(() => state.settingsRev);
    await page.evaluate(() => {
      const t = document.getElementById("target");
      t.value = "one-jpeg";
      t.dispatchEvent(new Event("change"));
    });
    await new Promise((r) => setTimeout(r, 400));
    await page.click("#alpha-keep");
    await page.waitForFunction((r) => state.settingsRev > r &&
      state.items.every((i) => ["done", "failed", "saved"].includes(i.status)),
      { timeout: 900_000, polling: 300 }, rev);
    const logo = await page.evaluate(() => {
      const it = state.items.find((i) => i.name === "logo.png");
      return { fmt: it.fmt, warnings: it.warnings || [] };
    });
    ok(logo.fmt !== "jpeg", `transparent artwork is not forced into JPEG (${logo.fmt})`);
    ok(logo.warnings.some((w) => /transparen/i.test(w)),
       `and the reason is stated (${JSON.stringify(logo.warnings)})`);

    // Back to automatic for the rest of the suite.
    const rev2 = await page.evaluate(() => state.settingsRev);
    await page.evaluate(() => {
      const t = document.getElementById("target");
      t.value = "documents";
      t.dispatchEvent(new Event("change"));
    });
    await page.waitForFunction((r) => state.settingsRev > r &&
      state.items.every((i) => ["done", "failed", "saved"].includes(i.status)),
      { timeout: 900_000, polling: 300 }, rev2);
  }

  /* ---- copy to clipboard --------------------------------------------------
   * Chrome refuses clipboard writes to an automated browser unless these
   * permissions are granted over CDP, so a denial here is the harness, not
   * the app. The check is still worth having: it catches the button being
   * wired to nothing, or throwing. */
  {
    const cdp = await browser.target().createCDPSession();
    await cdp.send("Browser.grantPermissions", {
      origin: new URL(BASE).origin,
      permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
    }).catch(() => {});
    await page.evaluate(() => selectItem(state.items.find((i) => i.name === "ui.png").id));
    await new Promise((r) => setTimeout(r, 300));
    ok(!(await page.evaluate(() => document.getElementById("copy-one").disabled)),
       "the copy button is live for a finished image");
    await page.bringToFront();
    await page.click("#copy-one");
    await new Promise((r) => setTimeout(r, 1200));
    const said = await page.evaluate(() => document.getElementById("toast").textContent);
    ok(/^Copied/.test(said), `copying reports success (${said})`);
  }

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
