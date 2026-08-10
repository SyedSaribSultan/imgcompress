/* The new Format and Quality controls, driven the way a person drives them. */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer, { CHROME } from "./resolve_puppeteer.mjs";
import { uploadAndFinish } from "./drive.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(here, "fixtures");
const server = spawn("node", [path.join(here, "serve.mjs"), "8188"], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 900));
const b = await puppeteer.launch({
  executablePath: CHROME, headless: true, protocolTimeout: 3_600_000,
});
let bad = 0;
const ok = (c, n) => { if (c) console.log(`  ok ${n}`); else { console.error(`FAIL ${n}`); bad++; } };
const settle = (ms = 700) => new Promise((r) => setTimeout(r, ms));

/* Settings pushes are debounced, so "everything is done" is true of the run
 * that already finished until the new one starts. Waiting for the revision to
 * move first is the difference between reading the new result and re-reading
 * the old one. */
async function rerun(pg, act) {
  const before = await pg.evaluate(() => state.settingsRev);
  await act();
  await pg.waitForFunction((rev) => state.settingsRev > rev &&
    state.items.every((i) => ["done", "failed", "saved"].includes(i.status)),
    { timeout: 600000, polling: 250 }, before);
}

try {
  const pg = await b.newPage();
  await pg.setViewport({ width: 1440, height: 940 });
  const errs = [];
  pg.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
  pg.on("pageerror", (e) => errs.push(String(e)));
  await pg.goto("http://127.0.0.1:8188/", { waitUntil: "networkidle0" });

  // ---- defaults ---------------------------------------------------------
  const d = await pg.evaluate(() => ({
    format: document.getElementById("target").value,
    preset: document.getElementById("quality-preset").value,
    floor: document.getElementById("quality").value,
    settings: JSON.parse(JSON.stringify(state.settings)),
  }));
  console.log("  defaults:", JSON.stringify(d));
  ok(d.format === "web" && d.preset === "90" && d.floor === "90",
     "defaults: going to the web, High quality, floor 90");
  ok(d.settings.formats === null, "defaults: no format restriction");

  // ---- the words drive the number, and back -----------------------------
  await pg.select("#quality-preset", "80");
  await settle();
  const q80 = await pg.evaluate(() => ({
    floor: document.getElementById("quality").value,
    out: document.getElementById("quality-out").textContent,
    note: document.getElementById("quality-note").textContent,
    target: state.settings.qualityTarget,
  }));
  ok(q80.floor === "80" && q80.out === "80" && q80.target === 80,
     `picking "Smaller" sets the floor to 80 (${JSON.stringify(q80)})`);

  const custom = await pg.evaluate(() => {
    const el = document.getElementById("quality");
    el.value = "87";
    el.dispatchEvent(new Event("input"));
    const opt = document.getElementById("quality-preset");
    return { preset: opt.value, label: opt.querySelector('option[value="custom"]').textContent,
             hidden: opt.querySelector('option[value="custom"]').hidden };
  });
  ok(custom.preset === "custom" && /87/.test(custom.label) && !custom.hidden,
     `an off-preset floor shows as Custom (${JSON.stringify(custom)})`);
  await pg.select("#quality-preset", "90");
  await settle();

  // ---- choosing one format ----------------------------------------------
  await pg.select("#target", "one-webp");
  await settle();
  const w = await pg.evaluate(() => JSON.parse(JSON.stringify(state.settings)));
  ok(JSON.stringify(w.formats) === '["webp"]' && w.target === "web",
     `"WebP only" restricts the engine to webp (${JSON.stringify(w.formats)})`);

  // ---- transparency: the question, both answers, and cancel -------------
  await uploadAndFinish(pg, [path.join(FIX, "logo.png"), path.join(FIX, "ui.png")], 600_000);
  const alphaSeen = await pg.evaluate(() => state.items.map((i) => ({ n: i.name, a: i.alpha })));
  console.log("  alpha detected:", JSON.stringify(alphaSeen));
  ok(alphaSeen.find((x) => x.n === "logo.png").a === true &&
     alphaSeen.find((x) => x.n === "ui.png").a === false,
     "transparency is measured per image, not guessed from the extension");

  // Cancel must leave the control on what is actually in force.
  await pg.select("#target", "one-jpeg");
  await settle(400);
  ok(await pg.evaluate(() => document.getElementById("alpha-ask").open),
     "choosing JPEG with transparent art asks first");
  const body = await pg.evaluate(() => document.getElementById("alpha-ask-body").textContent);
  console.log("  dialog says:", JSON.stringify(body));
  await pg.click("#alpha-cancel");
  await settle(400);
  const afterCancel = await pg.evaluate(() => ({
    open: document.getElementById("alpha-ask").open,
    control: document.getElementById("target").value,
    formats: state.settings.formats,
  }));
  ok(!afterCancel.open && afterCancel.control === "one-webp" &&
     JSON.stringify(afterCancel.formats) === '["webp"]',
     `cancel puts the control back to what is in force (${JSON.stringify(afterCancel)})`);

  // Keep-as-PNG: the logo must not come out as JPEG, and must say why.
  await rerun(pg, async () => {
    await pg.select("#target", "one-jpeg");
    await settle(400);
    await pg.click("#alpha-keep");
  });
  const keep = await pg.evaluate(() => state.items.map((i) =>
    ({ n: i.name, fmt: i.fmt, w: i.warnings, alpha: i.alpha, pass: i.passthrough })));
  console.log("  keep-as-png:", JSON.stringify(keep));
  const logoKeep = keep.find((x) => x.n === "logo.png");
  ok(logoKeep.fmt !== "jpeg", `transparent logo did not become JPEG (${logoKeep.fmt})`);
  ok((logoKeep.w || []).some((x) => /transparen/i.test(x)),
     `and it says why (${JSON.stringify(logoKeep.w)})`);
  ok(keep.find((x) => x.n === "ui.png").fmt === "jpeg",
     `the opaque image still honours the JPEG choice (${keep.find((x) => x.n === "ui.png").fmt})`);

  // Flatten: same choice, other answer.
  await rerun(pg, () => pg.select("#target", "documents"));
  await rerun(pg, async () => {
    await pg.select("#target", "one-jpeg");
    await settle(400);
    await pg.click("#alpha-flatten");
  });
  const flat = await pg.evaluate(() => state.items.map((i) =>
    ({ n: i.name, fmt: i.fmt, w: i.warnings, score: i.score, pass: i.passthrough })));
  console.log("  flatten:", JSON.stringify(flat));
  const logoFlat = flat.find((x) => x.n === "logo.png");
  ok(logoFlat.fmt === "jpeg", `flatten produces the JPEG that was asked for (${logoFlat.fmt})`);
  ok((logoFlat.w || []).some((x) => /flatten/i.test(x)),
     `and says the transparency went (${JSON.stringify(logoFlat.w)})`);
  // A flat logo as JPEG is bigger than the PNG it came from, and the app
  // refuses to ship a bigger file - so a passthrough here is the never-bigger
  // rule working, not a missing measurement.
  ok(logoFlat.pass || logoFlat.score >= 90,
     `and it is measured, or passed through for being bigger (${
       logoFlat.pass ? "passthrough" : logoFlat.score})`);

  await pg.screenshot({ path: path.join(here, "shot-controls.png") });
  ok(errs.length === 0, `no console errors${errs.length ? ": " + errs.join(" | ") : ""}`);
} finally { await b.close(); server.kill(); }
console.log(bad ? `\n${bad} failed` : "\nall good");
process.exit(bad ? 1 : 0);
