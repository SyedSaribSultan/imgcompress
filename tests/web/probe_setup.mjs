/* The set-up step, the copy button, and cursor-anchored zoom. */
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

  // ---- dropping images stops for set-up instead of compressing ------------
  const input = await pg.$("#file-input");
  await input.uploadFile(path.join(FIX, "ui.png"), path.join(FIX, "logo.png"));
  await settle(900);

  const panes = await pg.evaluate(() => ({
    empty: document.getElementById("app-empty").hidden,
    setup: document.getElementById("app-stage").hidden,
    full: document.getElementById("app-full").hidden,
    staging: state.staging,
    statuses: state.items.map((i) => i.status),
    title: document.getElementById("setup-title").textContent,
    go: document.getElementById("setup-go").textContent,
    rows: document.querySelectorAll("#setup-list .setup-row").length,
  }));
  console.log("  after drop:", JSON.stringify(panes));
  ok(!panes.setup && panes.full && panes.empty, "the drop lands on the set-up step, not the dashboard");
  ok(panes.statuses.every((s) => s === "staged"), `nothing started (${panes.statuses})`);
  ok(panes.rows === 2 && /2 images/.test(panes.title), "both images are listed");
  ok(/Compress 2 images/.test(panes.go), `the button says what it will do (${panes.go})`);

  // The settings live here now, and there is still only one of each control.
  const controls = await pg.evaluate(() => ({
    inSetup: !!document.querySelector("#setup-controls #bar-controls"),
    targets: document.querySelectorAll("#target").length,
    qualities: document.querySelectorAll("#quality").length,
  }));
  ok(controls.inSetup, "the settings bar is inside the set-up step");
  ok(controls.targets === 1 && controls.qualities === 1,
     `exactly one of each control exists (${JSON.stringify(controls)})`);

  // Changing a setting here must NOT start work.
  await pg.select("#quality-preset", "80");
  await settle(700);
  const afterSetting = await pg.evaluate(() => ({
    statuses: state.items.map((i) => i.status),
    floor: state.settings.qualityTarget,
  }));
  ok(afterSetting.statuses.every((s) => s === "staged"),
     `changing a setting during set-up starts nothing (${afterSetting.statuses})`);
  ok(afterSetting.floor === 80, `and it is recorded (${afterSetting.floor})`);

  // ---- renaming ----------------------------------------------------------
  await pg.evaluate(() => {
    const inp = document.querySelector("#setup-list .setup-row .setup-name");
    inp.value = "hero banner";
    inp.dispatchEvent(new Event("change"));
  });
  const renamed = await pg.evaluate(() => state.items.map((i) => i.name));
  ok(renamed.some((n) => n === "hero banner.png"),
     `renaming keeps the extension (${JSON.stringify(renamed)})`);

  // ---- adding more while staged stays in set-up --------------------------
  const input2 = await pg.$("#file-input");
  await input2.uploadFile(path.join(FIX, "photo.png"));
  await settle(900);
  const after3 = await pg.evaluate(() => ({
    staging: state.staging, n: document.querySelectorAll("#setup-list .setup-row").length,
    statuses: state.items.map((i) => i.status),
  }));
  ok(after3.staging && after3.n === 3 && after3.statuses.every((s) => s === "staged"),
     `adding more while staged stays in set-up (${JSON.stringify(after3)})`);

  // ---- removing one -------------------------------------------------------
  await pg.evaluate(() => document.querySelector("#setup-list .setup-drop").click());
  await settle(400);
  ok(await pg.evaluate(() => document.querySelectorAll("#setup-list .setup-row").length) === 2,
     "an image can be dropped from the list");

  // ---- starting the run ---------------------------------------------------
  await pg.click("#setup-go");
  await pg.waitForFunction(() => state.items.every((i) =>
    ["done", "failed", "saved"].includes(i.status)), { timeout: 900000, polling: 300 });
  const started = await pg.evaluate(() => ({
    setup: document.getElementById("app-stage").hidden,
    full: document.getElementById("app-full").hidden,
    barBack: !!document.querySelector("#app-full > #bar-controls"),
    floorUsed: state.items.map((i) => i.score),
    names: state.items.map((i) => i.name),
  }));
  console.log("  after start:", JSON.stringify(started));
  ok(started.setup && !started.full, "starting moves on to the dashboard");
  ok(started.barBack, "and the settings bar goes back to the toolbar");

  // ---- copy button --------------------------------------------------------
  await pg.evaluate(() => selectItem(state.items[0].id));
  await settle(400);
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
  await pg.evaluate(() => selectItem(state.items.find((i) => i.name === "photo.png").id));
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

  await pg.screenshot({ path: path.join(here, "shot-setup.png") });
  ok(errs.length === 0, `no console errors${errs.length ? ": " + errs.join(" | ") : ""}`);
} finally { await b.close(); server.kill(); }
console.log(bad ? `\n${bad} failed` : "\nall good");
process.exit(bad ? 1 : 0);
