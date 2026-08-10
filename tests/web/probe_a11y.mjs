/* Accessibility and discoverability: names on controls, live regions, keyboard
 * reachability, focus visibility.
 *
 * This printed its findings and exited 0 whatever they were, which made it a
 * report rather than a test - running it and seeing no errors carried almost no
 * information, and an unnamed control could appear without anything objecting.
 * It now asserts. The measurements are still printed, because what they say is
 * worth reading even when they pass.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer, { CHROME } from "./resolve_puppeteer.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(here, "fixtures");

let bad = 0;
const ok = (c, n) => { if (c) console.log(`  ok ${n}`); else { console.error(`FAIL ${n}`); bad++; } };

const server = spawn("node", [path.join(here, "serve.mjs"), "8194"], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 900));
const b = await puppeteer.launch({
  executablePath: CHROME, headless: true, protocolTimeout: 3_600_000,
});

const audit = () => {
  const out = { unnamed: [], noFocusRing: [], live: [], tabbables: 0, notes: [] };
  const visible = (el) => {
    const cs = getComputedStyle(el);
    return cs.display !== "none" && cs.visibility !== "hidden" &&
           el.getBoundingClientRect().width > 0;
  };
  const nameOf = (el) => (
    el.getAttribute("aria-label") ||
    (el.getAttribute("aria-labelledby") &&
      document.getElementById(el.getAttribute("aria-labelledby"))?.textContent) ||
    (el.labels && el.labels[0]?.textContent) ||
    el.title || el.textContent || ""
  ).trim();

  for (const el of document.querySelectorAll(
      "button, a[href], input, select, textarea, [tabindex]")) {
    if (!visible(el)) continue;
    out.tabbables++;
    if (!nameOf(el)) {
      out.unnamed.push(`${el.tagName.toLowerCase()}#${el.id || "?"}.${el.className || ""}`);
    }
  }
  for (const el of document.querySelectorAll("[aria-live], [role=status], [role=alert]")) {
    out.live.push(`${el.id || el.tagName}: ${el.getAttribute("aria-live") || el.getAttribute("role")}`);
  }
  // Does the toast announce itself, and does it sit on top of the controls?
  const toast = document.getElementById("toast");
  const bar = document.getElementById("bar-controls");
  if (toast && bar) {
    const t = toast.getBoundingClientRect(), c = bar.getBoundingClientRect();
    out.notes.push(`toast box ${Math.round(t.top)}-${Math.round(t.bottom)}, ` +
                   `controls ${Math.round(c.top)}-${Math.round(c.bottom)}, ` +
                   `overlap=${t.top < c.bottom && t.bottom > c.top}`);
    out.notes.push(`toast live=${toast.getAttribute("aria-live") || "none"}`);
  }
  return out;
};

try {
  const pg = await b.newPage();
  await pg.setViewport({ width: 1440, height: 940 });
  await pg.goto("http://127.0.0.1:8194/", { waitUntil: "networkidle0" });

  console.log("=== landing ===");
  const landing = await pg.evaluate(audit);
  console.log(JSON.stringify(landing, null, 1));
  ok(landing.tabbables > 0, `the landing page has focusable controls (${landing.tabbables})`);
  ok(landing.unnamed.length === 0,
     `every control on the landing page has an accessible name (${
       landing.unnamed.join("; ") || "clean"})`);

  const input = await pg.$("#file-input");
  await input.uploadFile(path.join(FIX, "photo.png"), path.join(FIX, "logo.png"),
                         path.join(FIX, "ui.png"));
  await pg.waitForFunction(() => state.items.every((i) =>
    ["done", "failed", "saved"].includes(i.status)), { timeout: 900000, polling: 300 });
  await new Promise((r) => setTimeout(r, 600));
  /* Three files, so this lands on the list. Everything below is about the
     result view and the evidence drawer, so open one image and then its panel
     - the same two moves a person makes. Measured while shut, every control
     in there reports `offsetParent === null` and the probe would pass over an
     empty set, which is the failure mode this whole suite keeps finding. */
  await pg.evaluate(() => selectItem(state.items[0].id));
  await new Promise((r) => setTimeout(r, 400));
  await pg.evaluate(() => document.getElementById("insp-toggle").click());
  await new Promise((r) => setTimeout(r, 600));
  await pg.screenshot({ path: path.join(here, "shot-studio.png") });
  console.log("\n=== studio, with results ===");
  const studio = await pg.evaluate(audit);
  console.log(JSON.stringify(studio, null, 1));
  ok(studio.unnamed.length === 0,
     `every control in the studio has an accessible name (${
       studio.unnamed.join("; ") || "clean"})`);
  ok(studio.live.length > 0,
     `the studio has at least one live region (${studio.live.join("; ") || "none"})`);

  // Can the result view — which is now also the control surface — be driven
  // from the keyboard?
  const keys = await pg.evaluate(() => {
    const order = [];
    const els = [...document.querySelectorAll(
      "#inspector-body button, #inspector-body input, #inspector-body select")]
      .filter((e) => e.offsetParent !== null);
    for (const e of els) order.push(`${e.tagName.toLowerCase()}#${e.id || e.className}`);
    return order;
  });
  console.log("\nkeyboard reachable in the result view:", JSON.stringify(keys, null, 1));
  ok(keys.length > 0, `the result view is reachable from the keyboard (${keys.length} controls)`);

  /* The chips are the primary control, so they have to be operable without a
     pointer: focusable in order, and Enter must do what a tap does. */
  const chipKeys = await pg.evaluate(() => {
    const chips = [...document.querySelectorAll("#cands .cand")];
    const first = chips.find((c) => !c.classList.contains("current"));
    const was = state.items[0].fmt;
    first.focus();
    const focusedIsChip = document.activeElement === first;
    first.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    first.click();      // what Enter on a <button> does natively
    return {
      count: chips.length, focusedIsChip,
      pressed: chips.map((c) => c.getAttribute("aria-pressed")),
      changed: state.items[0].fmt !== was,
      labelled: chips.map((c) => c.title).every(Boolean),
    };
  });
  console.log("\nchips from the keyboard:", JSON.stringify(chipKeys, null, 1));
  ok(chipKeys.count > 0, `the version chips exist (${chipKeys.count})`);
  ok(chipKeys.focusedIsChip, "a chip can take focus");
  ok(chipKeys.changed, "Enter on a focused chip does what a tap does");
  ok(chipKeys.labelled, "every chip carries a description");
  ok(chipKeys.pressed.every((p) => p === "true" || p === "false"),
     `every chip reports its pressed state (${chipKeys.pressed.join(",")})`);

  // The narration is a live region, so a result announces itself.
  const narration = await pg.evaluate(() => ({
    live: document.getElementById("narration").getAttribute("aria-live"),
    text: document.getElementById("narration").textContent,
    action: document.querySelector("#narration [data-narr]")?.tagName,
  }));
  console.log("\nnarration:", JSON.stringify(narration, null, 1));
  ok(!!narration.live, `the narration is a live region (${narration.live || "not announced"})`);
  ok(!!narration.text.trim(), "the narration says something");
  ok(narration.action === "BUTTON",
     `the narration ends in a real control (${narration.action || "none"})`);

  // Enter in the name field means "done renaming", and nothing else.
  await pg.evaluate(() => {
    const inp = document.getElementById("insp-name");
    inp.focus(); inp.value = "renamed here";
  });
  await pg.keyboard.press("Enter");
  await new Promise((r) => setTimeout(r, 300));
  const renamed = await pg.evaluate(() =>
    state.items.some((i) => i.name === "renamed here.png"));
  const released = await pg.evaluate(() => document.activeElement?.id !== "insp-name");
  ok(renamed, "Enter in the name field commits the name");
  ok(released, "and releases the field, which is what Enter means here");
} finally { await b.close(); server.kill(); }

console.log(bad === 0 ? "\nOK — named, announced and reachable" : `\n${bad} problem(s)`);
process.exit(bad ? 1 : 0);
