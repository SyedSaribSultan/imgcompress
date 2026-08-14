/* Browser E2E for the Pocketsize web app: real Chrome, real files, real
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

  ok((await page.title()).includes("Pocketsize"), "page title");

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
  /* Freeze the run for one beat so the anchor frame can be inspected. The app
     holds it for a frame by design; this holds it long enough to look.

     It used to be done by reassigning window.dispatch. That worked when the app
     was one classic script and everything was a global by accident; the app is a
     module graph now, so there is no global to reassign - the pause is a seam the
     app declares, for exactly this assertion. */
  await page.evaluate(() => imgc.holdWork(true));
  const inputEl = await page.$("#file-input");
  await inputEl.uploadFile(...files);
  await new Promise((r) => setTimeout(r, 400));

  const anchor = await page.evaluate(() => {
    const before = document.getElementById("img-before");
    return {
      // Nothing has been handed to a worker: the pause is on, so every item is
      // still sitting at "queued" while its original is already painted.
      noWorkStarted: state.items.every((i) => i.status === "queued"),
      // The dashboard has no separate "landing" and "working" screens to switch
      // between any more - the regions are always present. What still has to be
      // true on the anchor frame is that the picture is up and the queue knows
      // about it before any encoder has been asked for anything.
      stageLive: !document.getElementById("view").hidden &&
                 document.getElementById("stage-empty").hidden,
      showingOriginal: before.getAttribute("src") === state.items[0].beforeURL,
      afterSrc: document.getElementById("img-after").getAttribute("src"),
      rows: document.querySelectorAll("#queue-list .row").length,
      // The two sides are named on the caliper itself, so "which half am I
      // looking at" is answered without a legend.
      tags: [document.getElementById("tag-l").textContent,
             document.getElementById("tag-r").textContent],
      listed: state.items.length,
    };
  });
  console.log("  anchor frame:", JSON.stringify(anchor));
  ok(anchor.stageLive && anchor.showingOriginal,
     "the drop paints the untouched original first");
  ok(anchor.noWorkStarted, "and it is on screen before any encoder is asked for anything");
  ok(!anchor.afterSrc, "nothing compressed is on the stage yet");
  ok(anchor.tags[0] === "Original" && anchor.tags[1] === "Compressed",
     `the two sides are labelled (${anchor.tags.join(" / ")})`);
  ok(anchor.rows === files.length,
     `every dropped image has a row already (${anchor.rows}/${files.length})`);
  ok(anchor.listed === files.length,
     `every dropped image is queued (${anchor.listed}/${files.length})`);

  await page.evaluate(() => imgc.holdWork(false));

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
     rather than the promise: which format wins flat UI artwork depends on what
     the destination allows, and the whole thesis of this project is that the
     winner is content-dependent. An assertion naming a format is an assertion
     about a fixture.

     What replaces it is two guards that are deliberately orthogonal, because
     each one is blind to the other's failure:

       1. the search PICKS correctly - the winner is the smallest version that
          cleared the target;
       2. the search HAD EVERYTHING TO PICK FROM - every format this
          destination permits actually ran.

     (2) is the one that is easy to miss. If an encoder silently stops running,
     (1) still passes with flying colours: the smallest of four candidates is
     still the smallest of four. You would have lost a whole format and nothing
     would say so. */
  {
    const ui = by["ui.png"];
    const passing = ui.candidates.filter((c) => c.lossless || c.score >= 90);
    const smallest = Math.min(...passing.map((c) => c.bytes));
    ok(ui.newBytes === smallest,
       `ui winner is the smallest version that passed (${ui.fmt} ${ui.newBytes} vs ${smallest})`);

    /* `ui.png` is opaque, so nothing is filtered out for want of an alpha
       channel and the full permitted set must be present. The default
       destination is `web`. */
    const got = [...new Set(ui.candidates.map((c) => c.format))].sort();
    const want = ["avif", "jpeg", "png", "png8", "webp", "webp-lossless"];
    ok(want.every((f) => got.includes(f)) && got.length === want.length,
       `web tried every format it permits (got ${got.join(", ")})`);
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
      rowText: [...document.querySelectorAll("#queue-list .sub")].map((e) => e.textContent),
      shownTime: document.getElementById("s-time").textContent,
    }));
    ok(t.elapsed.length > 0 && t.elapsed.every((ms) => ms > 0),
       `every finished image recorded a duration (${t.elapsed.length} images)`);
    /* The per-image time moved out of the row and into #facts. The row now spends
       its second line on the result - what it weighed, what it became, what that
       saved - which is what someone scanning a list of twenty is actually reading
       for. The duration is still reported, on the image being looked at.
       The exported-report assertion that used to sit here is gone with the
       feature: CSV/JSON/summary export was not part of compressing an image. */
    ok(/\d+(\.\d+)?\s?(ms|s)\b/.test(t.shownTime),
       `the selected image reports how long it took (${t.shownTime})`);
    ok(t.rowText.every((s) => s.trim().length > 0),
       `every row says what happened to it (${t.rowText.length} rows)`);
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
    await page.evaluate(() => imgc.select(state.items.find((i) => i.name === "corrupt.png").id));
    await new Promise((r) => setTimeout(r, 400));
    const g = await page.evaluate(ghosts);
    ok(g.length === 0, `undecodable file paints no broken-image box (${g.join(", ") || "clean"})`);
    const msg = await page.evaluate(() => {
      const el = document.getElementById("stage-empty");
      return { hidden: el.hidden, text: el.textContent.trim() };
    });
    ok(!msg.hidden && msg.text.length > 0, `the stage says why there is no preview ("${msg.text}")`);

    await page.evaluate(() => imgc.select(state.items.find((i) => i.name === "photo.png").id));
    await new Promise((r) => setTimeout(r, 400));
    const g2 = await page.evaluate(ghosts);
    ok(g2.length === 0, `a normal image paints no broken-image box (${g2.join(", ") || "clean"})`);
    ok(await page.evaluate(() => document.getElementById("stage-empty").hidden),
       "the placeholder is gone once there is a preview");
  }

  // ---- inspector renders ---------------------------------------------------
  await page.evaluate(() => imgc.select(state.items[0].id));
  await page.waitForFunction(() => document.getElementById("img-before").naturalWidth > 0);
  await page.screenshot({ path: path.join(here, "shot-loaded.png") });
  const statText = await page.evaluate(() => ({
    size: document.getElementById("s-size").textContent,
    fmtL: document.getElementById("s-format").textContent,
    score: document.getElementById("s-score").textContent,
    // The before-and-after pair for the whole run lives in the queue's footer;
    // #s-size is the one image's result, so it is a single figure by design.
    totals: document.getElementById("t-sizes").textContent,
  }));
  ok(/\d/.test(statText.size), `the result reports its size (${statText.size})`);
  ok(/→/.test(statText.totals),
     `the run reports what it started and ended at (${statText.totals})`);

  /* ---- the candidate chips ARE the format control -----------------------
   * And they answer instantly: every encode came home with the run, so a tap
   * is a relabel, not another bake-off. Measured, because "immediately" is the
   * whole reason this control teaches itself. */
  await page.evaluate(() => imgc.select(state.items.find((i) => i.name === "ui.png").id));
  await new Promise((r) => setTimeout(r, 200));
  const swap = await page.evaluate(() => {
    const it = () => state.items.find((i) => i.name === "ui.png");
    const was = { fmt: it().fmt, bytes: it().newBytes, url: it().afterURL };
    const card = document.querySelector('#cands .chip[data-format="jpeg"]');
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
      // "Which one is on screen" is carried by aria-pressed rather than by a
      // class, so the styling and the accessibility name cannot drift apart.
      !!document.querySelector('#cands .chip[data-format="jpeg"][aria-pressed="true"]')),
     "the chosen chip is marked as the one on screen");
  /* The sentence explaining the choice moved from the stage to the block the
     chips live in, which is where the question is actually being asked. */
  ok(/because you chose it/.test(await page.evaluate(() =>
      document.getElementById("chip-why").textContent)),
     "the panel says why this one is showing");

  // And the winner chip is the way back to the automatic answer.
  const back = await page.evaluate(() => {
    const it = () => state.items.find((i) => i.name === "ui.png");
    document.querySelector('#cands .chip[data-win="1"]')?.click();
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
      const floor = document.getElementById("quality");
      const out = {};
      sel.value = "80";
      sel.dispatchEvent(new Event("change"));
      out.wordsSetTheNumber = floor.value;
      out.floorIsNotAControl = floor.type === "hidden";
      /* An off-preset floor no longer arrives from a slider - there isn't one.
         It comes from a saved setting, a destination, or a per-image override,
         all of which land on the hidden floor and then call reflectQualityWords
         to bring the words back in step. That reconciliation is what this
         checks, because a floor the words disagree with is the floor-99 bug. */
      floor.value = "87";
      imgc.reflectQualityWords();
      out.offPreset = sel.value;
      out.offPresetWords = sel.querySelector('option[value="custom"]').textContent;
      sel.value = "90";
      sel.dispatchEvent(new Event("change"));
      out.backTo90 = floor.value;
      return out;
    });
    ok(roundTrip.wordsSetTheNumber === "80",
       `a named quality sets the floor (${roundTrip.wordsSetTheNumber})`);
    ok(roundTrip.floorIsNotAControl,
       "the raw floor is not something a person can see or set");
    ok(roundTrip.offPreset === "custom",
       `a floor between the names still reads as its own entry (${roundTrip.offPreset})`);
    ok(!/\d/.test(roundTrip.offPresetWords),
       `and describes itself in words, not a number (${JSON.stringify(roundTrip.offPresetWords)})`);
    ok(roundTrip.backTo90 === "90", "and it goes back");

    /* Format is its own control. It used to be the second half of #target, and
     * pinning one there kept the destination while the control stopped naming
     * it - so the destination went on deciding the frame and the floor with
     * nothing on screen saying which one it was. */
    const one = await page.evaluate(() => {
      const f = document.getElementById("plan-format");
      f.value = "webp";
      f.dispatchEvent(new Event("change"));
      return { has: !!f.querySelector('option[value="jpeg"]'),
               destination: document.getElementById("target").value };
    });
    await new Promise((r) => setTimeout(r, 600));
    const restricted = await page.evaluate(() => state.settings.formats);
    ok(one.has, "the format control offers single formats");
    ok(one.destination === "web",
       `and the destination is still named while one is pinned (${one.destination})`);
    ok(JSON.stringify(restricted) === '["webp"]',
       `choosing one format restricts the engine to it (${JSON.stringify(restricted)})`);

    /* JPEG cannot store transparency, and the fixture set contains a logo that
     * has it. Choosing JPEG must therefore ask rather than silently produce
     * black boxes or silently ignore the request. */
    await page.evaluate(() => {
      const f = document.getElementById("plan-format");
      f.value = "jpeg";
      f.dispatchEvent(new Event("change"));
    });
    await new Promise((r) => setTimeout(r, 400));
    ok(await page.evaluate(() => document.getElementById("alpha-ask").open),
       "choosing JPEG with transparent artwork queued asks first");
    await page.click("#alpha-cancel");
    await new Promise((r) => setTimeout(r, 400));
    const afterCancel = await page.evaluate(() => document.getElementById("plan-format").value);
    ok(afterCancel === "webp",
       `cancelling restores the setting actually in force (${afterCancel})`);

    // Answer it this time, and check the logo is kept rather than mangled.
    const rev = await page.evaluate(() => state.settingsRev);
    await page.evaluate(() => {
      const f = document.getElementById("plan-format");
      f.value = "jpeg";
      f.dispatchEvent(new Event("change"));
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

    /* Back to automatic for the rest of the suite - and releasing the pin is
       now its own step. Format and destination used to be one control, so
       choosing a destination cleared the format as a side effect. They are
       separate axes now: a format someone pinned survives a change of
       destination, because changing where an image is going is not a reason to
       silently stop writing the format they asked for. The next block needs the
       full bake-off, so it has to say so. */
    const rev2 = await page.evaluate(() => state.settingsRev);
    await page.evaluate(() => {
      const f = document.getElementById("plan-format");
      f.value = "";
      f.dispatchEvent(new Event("change"));
      const t = document.getElementById("target");
      t.value = "documents";
      t.dispatchEvent(new Event("change"));
    });
    await page.waitForFunction((r) => state.settingsRev > r &&
      state.items.every((i) => ["done", "failed", "saved"].includes(i.status)),
      { timeout: 900_000, polling: 300 }, rev2);

    /* The other half of the completeness guard, and the half that carries the
       product's most consequential promise: `documents` must try exactly the
       three formats those tools store byte-for-byte, and must NOT try WebP or
       AVIF. A missing format here is a silently dead encoder; an extra one is
       a file that quietly balloons when somebody imports it. */
    const docs = await page.evaluate(() => {
      const it = state.items.find((i) => i.name === "ui.png");
      return { fmt: it.fmt, cands: [...new Set(it.candidates.map((c) => c.format))].sort() };
    });
    console.log("  documents ui.png:", JSON.stringify(docs));
    ok(docs.cands.join(",") === "jpeg,png,png8",
       `documents tried exactly the formats it permits (got ${docs.cands.join(", ")})`);
    for (const banned of ["webp", "webp-lossless", "avif"]) {
      ok(!docs.cands.includes(banned),
         `documents did not reach for ${banned}`);
    }
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
    await page.evaluate(() => imgc.select(state.items.find((i) => i.name === "ui.png").id));
    await new Promise((r) => setTimeout(r, 300));
    ok(!(await page.evaluate(() => document.getElementById("copy-one").disabled)),
       "the copy button is live for a finished image");
    await page.bringToFront();
    /* Copy sits on the stage's bottom bar beside Download - there is no drawer to
       open first any more. Still pressed for real rather than dispatched: a click
       that skips hit testing would not notice the button being covered by
       something. */
    await page.click("#copy-one");
    /* Wait for the receipt, not a stopwatch - the headless clipboard can take
       over a second to hand the promise back. */
    await page.waitForFunction(
      () => /(^|\s)(Copied|Could not copy)/.test(document.getElementById("toast").textContent),
      { timeout: 10_000, polling: 100 });
    const said = await page.evaluate(() => document.getElementById("toast").textContent);
    ok(/Copied/.test(said), `copying reports success (${said})`);
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
  /* "Download all" is in the bar now, which belongs to the run rather than to any
     one image - so there is no view to leave and no selection to clear first. It
     is pressable whenever anything has finished, which is what the button's own
     disabled state is asserted on below. */
  await new Promise((r) => setTimeout(r, 500));
  ok(!(await page.evaluate(() => document.getElementById("save-btn").disabled)),
     "Download all is live once the run has results");
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
