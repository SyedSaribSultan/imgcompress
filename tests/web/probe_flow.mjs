/* The first five seconds after a drop, the candidate encodes, the copy button,
 * and cursor-anchored zoom.
 *
 * The sequence this asserts is the product's answer to two fears a person has
 * when something happens to their file without them agreeing to it: is it
 * safe, and would I ever find out I had a say. Neither is answered by a
 * dialog. They are answered by what is on screen and what happens when you
 * touch it, which is exactly what can be probed here. */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer, { CHROME } from "./resolve_puppeteer.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(here, "fixtures");
const server = spawn("node", [path.join(here, "serve.mjs"), "8191"], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 900));
const b = await puppeteer.launch({
  executablePath: CHROME, headless: true, protocolTimeout: 3_600_000,
  args: ["--enable-features=ClipboardAPI"],
});
let bad = 0;
const ok = (c, n) => { if (c) console.log(`  ok ${n}`); else { console.error(`FAIL ${n}`); bad++; } };
const settle = (ms = 500) => new Promise((r) => setTimeout(r, ms));

try {
  const pg = await b.newPage();
  await pg.setViewport({ width: 1440, height: 940 });
  const errs = [];
  pg.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
  pg.on("pageerror", (e) => errs.push(String(e)));
  // Chrome refuses clipboard writes under automation unless these exact
  // permission names are granted over CDP.
  const cdp = await b.target().createCDPSession();
  await cdp.send("Browser.grantPermissions", {
    origin: "http://127.0.0.1:8191",
    permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
  }).catch(() => {});
  await pg.goto("http://127.0.0.1:8191/", { waitUntil: "networkidle0" });

  /* ---- frame 1: the untouched original, before anything runs -------------
   * The run is held so the anchor frame can be looked at. The app holds it for one
   * frame by design; this holds it long enough to assert. It used to be done by
   * reassigning window.dispatch, which worked while the app was one classic script
   * and everything was a global by accident - there is nothing to reassign now, so
   * the pause is a seam the app declares. */
  await pg.waitForFunction(() => typeof state !== "undefined");
  await pg.evaluate(() => imgc.holdWork(true));
  const input = await pg.$("#file-input");
  await input.uploadFile(path.join(FIX, "ui.png"), path.join(FIX, "logo.png"));
  await settle(400);

  const anchor = await pg.evaluate(() => ({
    /* The empty prompt gives way to the list, and the stage lights up. There is no
       "studio" to arrive at any more - the regions are always on screen - so what
       is asserted is the swap from prompt to content. */
    emptyGone: document.getElementById("queue-empty").hidden,
    listed: !document.getElementById("queue-list").hidden,
    stageLive: document.getElementById("stage-empty").hidden,
    statuses: state.items.map((i) => i.status),
    beforeShown: document.getElementById("img-before").getAttribute("src") === state.items[0].beforeURL,
    afterSrc: document.getElementById("img-after").getAttribute("src"),
    // The two sides are named on the caliper, which replaced the corner badge.
    tags: [document.getElementById("tag-l").textContent,
           document.getElementById("tag-r").textContent],
    // Split is the default and is not a tab anyone has to find.
    splitPressed: document.getElementById("mode-split").getAttribute("aria-pressed"),
  }));
  console.log("  anchor:", JSON.stringify(anchor));
  ok(anchor.emptyGone && anchor.listed && anchor.stageLive,
     "a drop goes straight to the work — no step in between");
  ok(anchor.beforeShown && !anchor.afterSrc,
     "the original is on the stage and nothing compressed is");
  ok(anchor.tags[0] === "Original" && anchor.tags[1] === "Compressed",
     `and the two sides are named (${anchor.tags.join(" / ")})`);
  ok(anchor.splitPressed === "true", "the comparison view is the default, not a tab to find");
  ok(anchor.statuses.every((s) => s === "queued"),
     `everything is queued, nothing gated (${anchor.statuses})`);

  // ---- and then it runs, with no button pressed ---------------------------
  await pg.evaluate(() => imgc.holdWork(false));
  await pg.waitForFunction(() => state.items.every((i) =>
    ["done", "failed", "saved"].includes(i.status)), { timeout: 900000, polling: 300 });
  ok(true, "the work completes without anything being pressed");

  /* Where the settings live has changed three times; what has never changed is
     the claim underneath it: exactly one of each control, in one place, and the
     PRIMARY questions on screen without anything being opened first. Since the
     plan folded its expert fields away, the shape of that claim is: the three
     visible questions (destination, quality, shrink) sit outside any
     disclosure, everything else sits inside exactly one, and that one is named
     in words rather than being an icon to guess at. */
  const controls = await pg.evaluate(() => ({
    inPlan: !!document.querySelector("#plan-sec #plan-fields #target"),
    targets: document.querySelectorAll("#target").length,
    qualities: document.querySelectorAll("#quality").length,
    disclosures: document.querySelectorAll("#plan-sec details").length,
    primariesOpen: ["target", "quality-preset", "shrink-mode"].every((id) =>
      !document.getElementById(id).closest("details")),
    restFolded: ["plan-goal", "plan-format", "plan-fit", "suffix-toggle"].every((id) =>
      !!document.getElementById(id).closest("details#more-choices")),
    summaryNamed: /advanced settings/i.test(
      document.querySelector("#more-choices > summary")?.textContent || ""),
    // The plan is on screen without anything being opened first.
    planVisible: document.getElementById("plan-fields").getBoundingClientRect().height > 0,
  }));
  ok(controls.inPlan, "the settings live in the one plan region");
  ok(controls.planVisible, "and are on screen without anything being opened first");
  ok(controls.targets === 1 && controls.qualities === 1,
     `exactly one of each control exists (${JSON.stringify(controls)})`);
  ok(controls.primariesOpen,
     "the three primary questions are not behind any disclosure");
  ok(controls.disclosures === 1 && controls.restFolded,
     "everything else is inside exactly one disclosure");
  ok(controls.summaryNamed, "and it is named in words (Advanced settings)");

  // ---- frame 3: original and result legible at the same time --------------
  await pg.evaluate(() => imgc.select(state.items[0].id));
  await settle(400);
  const compare = await pg.evaluate(() => {
    // #viewport became #frame when the UI was rebuilt: same box, same job.
    const vp = document.getElementById("frame");
    return {
      /* Both layers are in the frame and the top one is clipped, which is what
         "beside each other" means here - one #frame holds both at natural size and
         a clip on the upper layer is where the caliper cuts. The old check was for
         a `solo` class the stage no longer has. */
      bothLayers: !!vp.querySelector("#img-before") && !!vp.querySelector(".after #img-after"),
      clipped: (getComputedStyle(vp.querySelector(".after")).clipPath || "").includes("inset"),
      dividerShown: getComputedStyle(document.getElementById("divider")).display !== "none",
      left: document.getElementById("tag-l").textContent,
      right: document.getElementById("tag-r").textContent,
      beforeVisible: !!document.getElementById("img-before").getAttribute("src"),
    };
  });
  console.log("  compare:", JSON.stringify(compare));
  ok(compare.bothLayers && compare.clipped && compare.dividerShown && compare.beforeVisible,
     "the result appears beside the original, which is still there");
  ok(/Original/.test(compare.left) && /Compressed/.test(compare.right),
     `both sides are named (${compare.left} | ${compare.right})`);

  // ---- frame 4: every encode came home, and choosing one is instant ------
  /* The chips that used to present this are gone with the details panel. What
     they presented is not: the run still brings every encode home ranked
     smallest first, the untouched original is still one of the answers, and
     switching between them is still a relabel rather than another bake-off.
     Those are properties of the model, so that is where they are measured now. */
  await settle(500);
  const cands = await pg.evaluate(() => {
    const it = state.items[0];
    const rows = it.candidates || [];
    const passing = rows.filter((c) => c.bytes < it.originalBytes);
    const smallest = passing.reduce((a, c) => (!a || c.bytes < a.bytes ? c : a), null);
    return {
      n: rows.length,
      order: rows.map((c) => c.format),
      bytes: rows.map((c) => c.bytes),
      hasAuto: !!it.auto,
      pick: it.pick,
      autoFmt: it.fmt,
      autoBytes: it.newBytes,
      passing: passing.map((c) => `${c.format}:${c.bytes}`).join(" "),
      autoIsSmallestPassing: !!smallest && it.newBytes === smallest.bytes,
    };
  });
  console.log("  candidates:", JSON.stringify(cands));
  ok(cands.n >= 2, `the run brought every encode home (${cands.n})`);
  ok(cands.hasAuto, "and named one of them the automatic answer");
  ok(cands.pick === null, "which is what is showing until someone says otherwise");

  /* The chips sorted for display; the model's array is in encoder order, so
     the orderable fact is not the array but the choice made from it: the
     automatic answer is the smallest candidate that cleared the floor. That is
     the property the bake-off exists to produce. */
  ok(cands.autoIsSmallestPassing,
     `the automatic answer is the smallest encode that passed (${cands.autoFmt} at ${cands.autoBytes}, passing: ${cands.passing})`);

  // Choosing one has to change the picture inside the call.
  const swap = await pg.evaluate(() => {
    const it = () => state.items[0];
    const cur = it().fmt;
    const target = (it().candidates || []).find((c) => c.format !== cur);
    if (!target) return { found: false };
    const before = { fmt: it().fmt, url: it().afterURL };
    const t0 = performance.now();
    imgc.chooseCandidate(target.format);
    return {
      found: true, ms: performance.now() - t0, from: before.fmt, to: it().fmt,
      want: target.format, urlChanged: it().afterURL !== before.url,
      stillDone: it().status === "done",
    };
  });
  console.log("  swap:", JSON.stringify(swap));
  ok(swap.found && swap.to === swap.want,
     `choosing a candidate shows that encode (${swap.from} -> ${swap.to})`);
  ok(swap.urlChanged && swap.stillDone, "the preview is rebuilt from that candidate's own bytes");
  ok(swap.ms < 250, `and it lands in the call, not after a re-run (${swap.ms?.toFixed(0)} ms)`);

  // The original is a real answer: keep the file exactly as it arrived.
  const keepOriginal = await pg.evaluate(() => {
    imgc.chooseCandidate("__original");
    const it = state.items[0];
    return { pick: it.pick, bytes: it.newBytes, orig: it.originalBytes, ext: it.ext };
  });
  ok(keepOriginal.pick === "__original" && keepOriginal.bytes === keepOriginal.orig,
     `the original is one call from being the only thing kept (${JSON.stringify(keepOriginal)})`);

  /* And the automatic answer is the way back: choosing the encode that won
     clears the manual pick rather than recording the winner as one. */
  await pg.evaluate(() => imgc.chooseCandidate(state.items[0].auto.fmt));
  await settle(300);
  const backToAuto = await pg.evaluate(() => ({
    pick: state.items[0].pick,
    shown: document.getElementById("s-saved").textContent,
  }));
  console.log("  back to auto:", JSON.stringify(backToAuto));
  ok(backToAuto.pick === null,
     `the winning encode restores the automatic choice (pick=${backToAuto.pick})`);
  ok(!!backToAuto.shown.trim(),
     "and the stage still says what the picture became");

  // ---- renaming, which used to live in the set-up step --------------------
  await pg.evaluate(() => {
    const inp = document.getElementById("out-name");
    inp.value = "hero banner";
    inp.dispatchEvent(new Event("change"));
  });
  const renamed = await pg.evaluate(() => state.items.map((i) => i.name));
  ok(renamed.some((n) => n === "hero banner.png"),
     `renaming in place keeps the extension (${JSON.stringify(renamed)})`);

  // ---- copy button --------------------------------------------------------
  const copyable = await pg.evaluate(() => !document.getElementById("copy-one").disabled);
  ok(copyable, "the copy button is live for a finished image");
  await pg.bringToFront();   // clipboard writes need a focused document
  await pg.click("#copy-one");
  /* Wait for the RECEIPT, not a stopwatch: the headless clipboard can take
     over a second to hand the promise back, and the app only toasts once it
     has. A fixed sleep here was a race that happened to win. */
  await pg.waitForFunction(
    () => /(^|\s)(Copied|Could not copy)/.test(document.getElementById("toast").textContent),
    { timeout: 10_000, polling: 100 });
  // Headless Chrome will not always hand a clipboard back to a read(), so the
  // app's own report is the signal: a failure path toasts "Could not copy".
  const copyToast = await pg.evaluate(() => document.getElementById("toast").textContent);
  console.log("  copy said:", JSON.stringify(copyToast));
  ok(/^Copied/.test(copyToast), `copy reports success (${copyToast})`);

  /* ---- zoom: the point under the cursor stays under the cursor ----------
   * Needs a frame bigger than the stage, or the clamp correctly pins it to
   * centre and there is nothing to anchor. */
  await pg.evaluate(() => imgc.select(state.items.find((i) => i.name === "logo.png").id));
  await settle(600);
  const zoomRes = await pg.evaluate(() => {
    const stage = document.getElementById("stage");
    // #viewport became #frame when the UI was rebuilt: same box, same job.
    const vp = document.getElementById("frame");
    const box = stage.getBoundingClientRect();
    const x = box.left + box.width * 0.3, y = box.top + box.height * 0.3;
    const imgAt = () => {
      const r = vp.getBoundingClientRect();
      return { ix: (x - r.left) / r.width, iy: (y - r.top) / r.height };
    };
    /* Start already overflowing on both axes. While an axis still fits, the
     * clamp pins it to centre and the anchor cannot hold on that axis - which
     * is correct, not a bug: there is nothing to pan. */
    imgc.setView({ zoom: 2, pan: { x: 0, y: 0 } });
    const before = imgAt();
    stage.dispatchEvent(new WheelEvent("wheel", {
      deltaY: -100, clientX: x, clientY: y, bubbles: true, cancelable: true }));
    const after = imgAt();
    const r = vp.getBoundingClientRect();
    const overflows = r.width > box.width && r.height > box.height;
    // And the clamp: shoving the pan to infinity must not lose the image.
    imgc.setView({ pan: { x: 99999, y: 99999 } });
    const shoved = vp.getBoundingClientRect();
    const stillCovers = shoved.left <= box.left + 1 && shoved.right >= box.right - 1;
    return { zoom: imgc.zoom(), before, after, overflows, stillCovers, pan: imgc.pan() };
  });
  console.log("  zoom:", JSON.stringify(zoomRes));
  ok(zoomRes.overflows, `zoomed past the stage (${zoomRes.zoom}x)`);
  ok(Math.abs(zoomRes.after.ix - zoomRes.before.ix) < 0.02 &&
     Math.abs(zoomRes.after.iy - zoomRes.before.iy) < 0.02,
     `the point under the cursor stayed under it (${
       JSON.stringify(zoomRes.before)} -> ${JSON.stringify(zoomRes.after)})`);
  ok(zoomRes.stillCovers,
     `panning cannot throw the image off the stage (pan ${JSON.stringify(zoomRes.pan)})`);

  await pg.screenshot({ path: path.join(here, "shot-flow.png") });
  ok(errs.length === 0, `no console errors${errs.length ? ": " + errs.join(" | ") : ""}`);
} finally { await b.close(); server.kill(); }
console.log(bad ? `\n${bad} failed` : "\nall good");
process.exit(bad ? 1 : 0);
