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

  // ---- the words are the control; the number is the engine's copy ---------
  // #quality-out is gone with the slider it annotated: the floor is a hidden
  // input now, because a raw 60-99 number is a fact about the metric rather
  // than a question for a person.
  await pg.select("#quality-preset", "80");
  await settle();
  const q80 = await pg.evaluate(() => ({
    floor: document.getElementById("quality").value,
    visible: document.getElementById("quality").type !== "hidden",
    note: document.getElementById("quality-note").textContent,
    /* The words a person actually reads. This used to be dug out of
       `.plan-shadow`, a hidden span that existed to measure text so an inline
       <select> could be sized to its own current value. The plan is labelled
       fields now, so the words are simply the selected option - which is the
       thing the promise was always about, read from the control itself rather
       than from a ruler standing next to it. */
    words: document.getElementById("quality-preset").selectedOptions[0]?.textContent,
    target: state.settings.qualityTarget,
  }));
  ok(q80.floor === "80" && q80.target === 80,
     `picking a lower bar sets the floor to 80 (${JSON.stringify(q80)})`);
  ok(!q80.visible, "the raw floor is not a control anyone can see");
  ok(/at a glance/.test(q80.words || ""),
     `and the control says so in words (${JSON.stringify(q80.words)})`);
  // The readout under the plan restates what the whole plan will now do, so the
  // words and the floor cannot drift apart unnoticed.
  ok(/at a glance/.test(q80.note || ""),
     `and the plan's own summary agrees (${JSON.stringify(q80.note)})`);

  // A floor between the landmarks arrives from a saved setting or a
  // destination, never from a click, and gets the hidden entry rather than
  // being snapped to a word it did not mean.
  const custom = await pg.evaluate(() => {
    document.getElementById("quality").value = "87";
    imgc.reflectQualityWords();
    const opt = document.getElementById("quality-preset");
    return { preset: opt.value, label: opt.querySelector('option[value="custom"]').textContent,
             hidden: opt.querySelector('option[value="custom"]').hidden };
  });
  ok(custom.preset === "custom" && !custom.hidden && !/87/.test(custom.label),
     `an off-preset floor shows in words, not as a number (${JSON.stringify(custom)})`);
  await pg.select("#quality-preset", "90");
  await settle();

  // ---- pinning one format ------------------------------------------------
  // Its own axis now. It used to share #target with the destination, and
  // picking a format there kept the destination while the control stopped
  // naming it.
  await pg.select("#plan-format", "webp");
  await settle();
  const w = await pg.evaluate(() => JSON.parse(JSON.stringify(state.settings)));
  ok(JSON.stringify(w.formats) === '["webp"]' && w.target === "web",
     `pinning WebP restricts the engine to webp and leaves the destination alone (${JSON.stringify(w.formats)})`);
  const stillNamed = await pg.evaluate(() => document.getElementById("target").value);
  ok(stillNamed === "web",
     `and the destination is still named on screen (${stillNamed})`);

  // ---- transparency: the question, both answers, and cancel -------------
  await uploadAndFinish(pg, [path.join(FIX, "logo.png"), path.join(FIX, "ui.png")], 600_000);
  const alphaSeen = await pg.evaluate(() => state.items.map((i) => ({ n: i.name, a: i.alpha })));
  console.log("  alpha detected:", JSON.stringify(alphaSeen));
  ok(alphaSeen.find((x) => x.n === "logo.png").a === true &&
     alphaSeen.find((x) => x.n === "ui.png").a === false,
     "transparency is measured per image, not guessed from the extension");

  // Cancel must leave the control on what is actually in force.
  await pg.select("#plan-format", "jpeg");
  await settle(400);
  ok(await pg.evaluate(() => document.getElementById("alpha-ask").open),
     "choosing JPEG with transparent art asks first");
  const body = await pg.evaluate(() => document.getElementById("alpha-ask-body").textContent);
  console.log("  dialog says:", JSON.stringify(body));
  await pg.click("#alpha-cancel");
  await settle(400);
  const afterCancel = await pg.evaluate(() => ({
    open: document.getElementById("alpha-ask").open,
    control: document.getElementById("plan-format").value,
    formats: state.settings.formats,
  }));
  ok(!afterCancel.open && afterCancel.control === "webp" &&
     JSON.stringify(afterCancel.formats) === '["webp"]',
     `cancel puts the control back to what is in force (${JSON.stringify(afterCancel)})`);

  // Keep-as-PNG: the logo must not come out as JPEG, and must say why.
  await rerun(pg, async () => {
    await pg.select("#plan-format", "jpeg");
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
    await pg.select("#plan-format", "jpeg");
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
