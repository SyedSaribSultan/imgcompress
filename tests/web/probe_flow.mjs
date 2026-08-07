/* The first five seconds after a drop, the candidate chips, the copy button,
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
   * Dispatch is stubbed out so the anchor frame can be looked at. The app
   * holds it for one frame by design; this holds it long enough to assert. */
  await pg.waitForFunction(() => typeof state !== "undefined");
  await pg.evaluate(() => {
    window.__realDispatch = dispatch;
    window.dispatch = async () => { window.__dispatched = true; };
  });
  const input = await pg.$("#file-input");
  await input.uploadFile(path.join(FIX, "ui.png"), path.join(FIX, "logo.png"));
  await settle(400);

  const anchor = await pg.evaluate(() => ({
    dispatched: !!window.__dispatched,
    empty: document.getElementById("app-empty").hidden,
    studio: !document.getElementById("app-full").hidden,
    statuses: state.items.map((i) => i.status),
    beforeShown: document.getElementById("img-before").getAttribute("src") === state.items[0].beforeURL,
    afterSrc: document.getElementById("img-after").getAttribute("src"),
    badge: document.getElementById("stage-badge").textContent,
    narration: document.getElementById("narration").textContent,
    // Split is the default and is not a tab anyone has to find.
    splitPressed: document.getElementById("mode-split").getAttribute("aria-pressed"),
  }));
  console.log("  anchor:", JSON.stringify(anchor));
  ok(anchor.empty && anchor.studio, "a drop goes straight to the studio — no step in between");
  ok(anchor.beforeShown && !anchor.afterSrc,
     "the original is on the stage and nothing compressed is");
  ok(/untouched/i.test(anchor.badge), `and it is labelled untouched (${anchor.badge})`);
  ok(anchor.narration ===
     "Trying a few ways to shrink this, keeping only the one that still looks right.",
     `the narration is the landing page's promise, verbatim (${JSON.stringify(anchor.narration)})`);
  ok(anchor.splitPressed === "true", "the comparison view is the default, not a tab to find");
  ok(anchor.statuses.every((s) => s === "queued"),
     `everything is queued, nothing gated (${anchor.statuses})`);

  // ---- and then it runs, with no button pressed ---------------------------
  await pg.evaluate(() => { window.dispatch = window.__realDispatch; dispatch(); });
  await pg.waitForFunction(() => state.items.every((i) =>
    ["done", "failed", "saved"].includes(i.status)), { timeout: 900000, polling: 300 });
  ok(true, "the work completes without anything being pressed");

  // The settings bar never moves any more: one of each control, in the toolbar.
  const controls = await pg.evaluate(() => ({
    inToolbar: !!document.querySelector("#app-full > #bar-controls"),
    targets: document.querySelectorAll("#target").length,
    qualities: document.querySelectorAll("#quality").length,
  }));
  ok(controls.inToolbar, "the settings bar lives in the toolbar");
  ok(controls.targets === 1 && controls.qualities === 1,
     `exactly one of each control exists (${JSON.stringify(controls)})`);

  // ---- frame 3: original and result legible at the same time --------------
  await pg.evaluate(() => selectItem(state.items[0].id));
  await settle(400);
  const compare = await pg.evaluate(() => {
    const vp = document.getElementById("viewport");
    return {
      solo: vp.classList.contains("solo"),
      dividerShown: document.getElementById("divider").style.display !== "none",
      left: document.getElementById("tag-l").textContent,
      right: document.getElementById("tag-r").textContent,
      beforeVisible: !!document.getElementById("img-before").getAttribute("src"),
    };
  });
  console.log("  compare:", JSON.stringify(compare));
  ok(!compare.solo && compare.dividerShown && compare.beforeVisible,
     "the result appears beside the original, which is still there");
  ok(/Original/.test(compare.left) && /Compressed/.test(compare.right),
     `both sides are named (${compare.left} | ${compare.right})`);

  // ---- frame 4: the chips are the control, and they answer instantly ------
  const chips = await pg.evaluate(() => {
    const els = [...document.querySelectorAll("#cands .cand")];
    return {
      n: els.length,
      allButtons: els.every((e) => e.tagName === "BUTTON"),
      // Ranked smallest first, and the original is the last chip.
      order: els.map((e) => e.dataset.format),
      bytes: els.map((e) => Number(e.dataset.bytes)),
      current: els.filter((e) => e.classList.contains("current")).length,
      winner: els.filter((e) => e.classList.contains("win")).length,
      // Near the image, not buried in a panel below the fold.
      aboveDetails: els[0].getBoundingClientRect().top <
                    document.getElementById("details").getBoundingClientRect().top,
    };
  });
  console.log("  chips:", JSON.stringify(chips));
  ok(chips.n >= 2 && chips.allButtons, `every candidate is a real button (${chips.n})`);
  ok(chips.aboveDetails, "the chips sit with the image, above the numbers");
  ok(chips.current === 1, `exactly one chip is marked as showing (${chips.current})`);
  ok(chips.winner === 1, `and exactly one as the winner (${chips.winner})`);
  ok(chips.order[chips.order.length - 1] === "__original",
     `the original is the yardstick at the end (${chips.order})`);

  // Ranked smallest first, so the meter and the order agree.
  const encodes = chips.bytes.slice(0, -1);
  ok(encodes.every((v, i) => i === 0 || v >= encodes[i - 1]),
     `the chips are ranked smallest first (${chips.bytes})`);

  // Tapping one has to change the picture inside the click.
  const swap = await pg.evaluate(() => {
    const it = () => state.items[0];
    const cur = document.querySelector("#cands .cand.current")?.dataset.format;
    const target = [...document.querySelectorAll("#cands .cand")]
      .find((e) => e.dataset.format !== cur && e.dataset.format !== "__original");
    if (!target) return { found: false };
    const before = { fmt: it().fmt, url: it().afterURL };
    const t0 = performance.now();
    target.click();
    return {
      found: true, ms: performance.now() - t0, from: before.fmt, to: it().fmt,
      want: target.dataset.format, urlChanged: it().afterURL !== before.url,
      stillDone: it().status === "done",
    };
  });
  console.log("  swap:", JSON.stringify(swap));
  ok(swap.found && swap.to === swap.want,
     `tapping a chip shows that encode (${swap.from} -> ${swap.to})`);
  ok(swap.urlChanged && swap.stillDone, "the preview is rebuilt from that candidate's own bytes");
  ok(swap.ms < 250, `and it lands in the click, not after a re-run (${swap.ms?.toFixed(0)} ms)`);

  // The original chip is a real answer: keep the file exactly as it arrived.
  const keepOriginal = await pg.evaluate(() => {
    document.querySelector('#cands .cand[data-format="__original"]').click();
    const it = state.items[0];
    return { pick: it.pick, bytes: it.newBytes, orig: it.originalBytes, ext: it.ext };
  });
  ok(keepOriginal.pick === "__original" && keepOriginal.bytes === keepOriginal.orig,
     `the original is one tap from being the only thing kept (${JSON.stringify(keepOriginal)})`);

  // The narration's tail is a real action, not decoration. Read after a frame:
  // the render is scheduled, so the sentence is a tick behind the click.
  await pg.evaluate(() => document.querySelector("#cands .cand.win").click());
  await settle(300);
  const invite = await pg.evaluate(() => {
    const link = document.querySelector("#narration [data-narr]");
    return { tag: link?.tagName, text: link?.textContent, act: link?.dataset.narr };
  });
  console.log("  invitation:", JSON.stringify(invite));
  ok(invite.tag === "BUTTON" && invite.act === "chips",
     `the narration ends in a real action (${JSON.stringify(invite)})`);
  ok(/Prefer something else\?/.test(invite.text || ""),
     `and it is the invitation the spec names (${invite.text})`);
  const called = await pg.evaluate(() => {
    document.querySelector("#narration [data-narr]").click();
    return {
      calling: document.getElementById("cands").classList.contains("calling"),
      focused: document.activeElement?.classList.contains("cand"),
    };
  });
  ok(called.calling && called.focused,
     `pressing it surfaces and focuses the chips (${JSON.stringify(called)})`);

  // ---- renaming, which used to live in the set-up step --------------------
  await pg.evaluate(() => {
    const inp = document.getElementById("insp-name");
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
  await settle(1200);
  // Headless Chrome will not always hand a clipboard back to a read(), so the
  // app's own report is the signal: a failure path toasts "Could not copy".
  const copyToast = await pg.evaluate(() => document.getElementById("toast").textContent);
  console.log("  copy said:", JSON.stringify(copyToast));
  ok(/^Copied/.test(copyToast), `copy reports success (${copyToast})`);

  /* ---- zoom: the point under the cursor stays under the cursor ----------
   * Needs a frame bigger than the stage, or the clamp correctly pins it to
   * centre and there is nothing to anchor. */
  await pg.evaluate(() => selectItem(state.items.find((i) => i.name === "logo.png").id));
  await settle(600);
  const zoomRes = await pg.evaluate(() => {
    const stage = document.getElementById("stage");
    const vp = document.getElementById("viewport");
    const box = stage.getBoundingClientRect();
    const x = box.left + box.width * 0.3, y = box.top + box.height * 0.3;
    const imgAt = () => {
      const r = vp.getBoundingClientRect();
      return { ix: (x - r.left) / r.width, iy: (y - r.top) / r.height };
    };
    /* Start already overflowing on both axes. While an axis still fits, the
     * clamp pins it to centre and the anchor cannot hold on that axis - which
     * is correct, not a bug: there is nothing to pan. */
    zoom = 2; pan = { x: 0, y: 0 }; applyZoom();
    const before = imgAt();
    stage.dispatchEvent(new WheelEvent("wheel", {
      deltaY: -100, clientX: x, clientY: y, bubbles: true, cancelable: true }));
    const after = imgAt();
    const r = vp.getBoundingClientRect();
    const overflows = r.width > box.width && r.height > box.height;
    // And the clamp: shoving the pan to infinity must not lose the image.
    pan = { x: 99999, y: 99999 };
    applyZoom();
    const shoved = vp.getBoundingClientRect();
    const stillCovers = shoved.left <= box.left + 1 && shoved.right >= box.right - 1;
    return { zoom, before, after, overflows, stillCovers, pan: { ...pan } };
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
