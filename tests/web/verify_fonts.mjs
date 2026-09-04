/* Runtime proof, in a real browser: the self-hosted faces load, they are the
 * faces actually used to paint, nothing renders above 600, and no request
 * leaves the origin. */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer, { CHROME } from "./resolve_puppeteer.mjs";

/* Which families the app is set in, read from the same file that generated
   them. This gate used to name Fraunces in nine places, so swapping the
   interface font made it fail nine times while describing the previous
   design - which is a gate asserting its own history rather than the app's
   rules. The rules are: the configured interface face paints everything, the
   configured mono paints the figures, and nothing renders above semibold. */
const FONTS = JSON.parse(readFileSync(
  path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "tools", "fonts.json"),
  "utf8"));
const UI = FONTS.display;
const MONO = FONTS.mono;

const here = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.E2E_URL || "http://127.0.0.1:8155/";
let server = null;
if (!process.env.E2E_URL) {
  server = spawn("node", [path.join(here, "serve.mjs"), "8155"], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 900));
}

const b = await puppeteer.launch({ executablePath: CHROME, headless: true });
let bad = 0;
const ok = (c, n) => { if (c) console.log(`  ok ${n}`); else { console.error(`FAIL ${n}`); bad++; } };

try {
  const pg = await b.newPage();
  const origins = new Set();
  const cspErrors = [];
  pg.on("request", (r) => { try { origins.add(new URL(r.url()).origin); } catch {} });
  pg.on("console", (m) => { if (m.type() === "error") cspErrors.push(m.text()); });
  pg.on("pageerror", (e) => cspErrors.push(String(e)));

  await pg.setViewport({ width: 1440, height: 940 });
  await pg.goto(BASE, { waitUntil: "networkidle0" });
  await pg.evaluate(() => document.fonts.ready);

  const loaded = await pg.evaluate(() =>
    [...document.fonts].map((f) => `${f.family} ${f.weight} ${f.status}`).sort());
  console.log("  faces:", JSON.stringify(loaded, null, 0));
  ok(loaded.length === 4, `four faces registered (${loaded.length})`);
  ok(loaded.every((f) => f.endsWith("loaded") || f.endsWith("unloaded")),
     "no face failed to parse");

  /* Are the brand faces the ones actually painting? The page sets ALL of its
     type in Fraunces and its figures in Geist Mono, both through the base.css
     aliases - --font-ui and --font-num - onto the token layer.

     Every assertion below reads the face off an element that renders it rather
     than merely checking the file parses. Two faces have now been removed from
     this app for failing exactly that distinction: Bricolage, which was
     preloaded for months without painting a glyph, and then Geist, which was
     the interface font right up until Fraunces took the job and stayed shipped
     and precached afterwards. A gate that only proves a face LOADS cannot tell
     you either of those. */
  const paints = await pg.evaluate(async (fam) => {
    await document.fonts.ready;
    const check = (family, weight, size) => document.fonts.check(`${weight} ${size}px "${family}"`);
    return {
      ui600: check(fam.ui, 600, 17),
      ui400: check(fam.ui, 400, 15),
      mono: check(fam.mono, 500, 14),
      bodyFamily: getComputedStyle(document.body).fontFamily,
      numFamily: getComputedStyle(document.getElementById("queue-count")).fontFamily,
      brandFamily: getComputedStyle(document.querySelector("#bar .brand")).fontFamily,
      aboutFamily: getComputedStyle(document.getElementById("about-h")).fontFamily,
      labelFamily: getComputedStyle(
        document.querySelector('#plan-fields label[for="target"]')).fontFamily,
      /* A <button> does not inherit the page's font - the user agent gives it
         one - so a control is where an interface-wide face is most likely to
         be quietly missing. Dropping font-family from the wordmark once put it
         in Arial while every other element on the page was correct. */
      buttonFamily: getComputedStyle(document.getElementById("add-btn")).fontFamily,
    };
  }, { ui: UI, mono: MONO });
  console.log("  paints:", JSON.stringify(paints));
  const isUI = (v) => v.startsWith(`${UI},`) || v.startsWith(`"${UI}"`) || v === UI;
  ok(paints.ui600, `${UI} 600 is available`);
  ok(paints.ui400, `${UI} 400 is available at body size`);
  ok(paints.mono, `${MONO} is available`);
  ok(isUI(paints.bodyFamily), `body resolves to ${UI} first (${paints.bodyFamily})`);
  ok(paints.numFamily.includes(MONO), `figures resolve to ${MONO} first`);
  ok(isUI(paints.brandFamily), `the wordmark resolves to ${UI} first`);
  ok(isUI(paints.aboutFamily), "and so does the about strip's lead heading");
  ok(isUI(paints.labelFamily), "and every field label");
  ok(isUI(paints.buttonFamily),
     `and the buttons, which do not inherit it (${paints.buttonFamily})`);
  /* The region labels are the hardest case for this face: 13px, uppercase,
     tracked. They are IN Fraunces now by decision, which makes the thing worth
     asserting not "which family" but that the optical-size axis survived the
     subset - a face pinned to a display optical size would render those labels
     with display-sized serifs, which is the failure that would actually look
     wrong. */
  console.log(`  interface face: ${UI}, figures: ${MONO}`);
  const axes = await pg.evaluate(async (ui) => {
    /* Rendered width at two sizes, normalised. An optical-size axis changes the
       letterforms between them; a pinned face merely scales, so the ratio would
       be exactly the size ratio. */
    const m = (px) => {
      const el = document.createElement("span");
      el.textContent = "Handgloves shrink";
      el.style.cssText = `position:absolute;visibility:hidden;font-family:${ui};font-size:${px}px`;
      document.body.append(el);
      const w = el.getBoundingClientRect().width / px;
      el.remove();
      return w;
    };
    return { small: m(13), large: m(72) };
  }, UI);
  /* Only meaningful for a face that HAS an optical-size axis. Where one does,
     a 13px label gets a sturdier cut than a shrunken 72px one and the
     normalised widths differ; where the family has no opsz, they are identical
     and that is correct rather than a regression - so this reports the reading
     and only asserts when the axis is supposed to be there. */
  const hasOpsz = /opsz/.test(FONTS.axes || "");
  const spread = Math.abs(axes.small - axes.large);
  console.log(`  normalised widths 13px vs 72px: ${axes.small.toFixed(4)} / ${axes.large.toFixed(4)}`
    + (hasOpsz ? "" : `  (${UI} has no optical-size axis)`));
  if (hasOpsz) {
    ok(spread > 0.005,
       `the optical-size axis survived the subset, so 13px labels get their own `
       + `cut rather than a shrunken display one (${spread.toFixed(4)} apart)`);
  }

  // The ceiling, measured on every rendered element rather than in source.
  const heavy = await pg.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll("*")) {
      const w = getComputedStyle(el).fontWeight;
      const n = w === "bold" ? 700 : w === "normal" ? 400 : Number(w);
      if (Number.isFinite(n) && n > 600) {
        out.push(`${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}${
          el.className && typeof el.className === "string" ? "." + el.className.split(" ")[0] : ""} = ${n}`);
      }
    }
    return [...new Set(out)];
  });
  ok(heavy.length === 0, `no element renders above 600${heavy.length ? ": " + heavy.slice(0, 8).join(", ") : ""}`);

  // Compress something so the whole UI (queue, stats, verdict, buttons) exists,
  // then re-measure: most of the app does not exist on the empty state.
  const { uploadAndFinish } = await import("./drive.mjs");
  await uploadAndFinish(pg, [
    path.join(here, "fixtures", "ui.png"),
    path.join(here, "fixtures", "logo.png"),
  ], 900_000);
  const heavy2 = await pg.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll("*")) {
      const w = getComputedStyle(el).fontWeight;
      const n = w === "bold" ? 700 : w === "normal" ? 400 : Number(w);
      if (Number.isFinite(n) && n > 600) out.push(`${el.tagName.toLowerCase()} = ${n}`);
    }
    return [...new Set(out)];
  });
  ok(heavy2.length === 0, `still nothing above 600 with the app populated${heavy2.length ? ": " + heavy2.join(", ") : ""}`);

  // Privacy: everything must come from this origin.
  const base = new URL(BASE).origin;
  const foreign = [...origins].filter((o) => o !== base && o !== "null");
  ok(foreign.length === 0, `no third-party requests${foreign.length ? ": " + foreign.join(", ") : ""}`);
  ok(cspErrors.length === 0, `no console/CSP errors${cspErrors.length ? ": " + cspErrors[0] : ""}`);

  await pg.screenshot({ path: path.join(here, "fonts-live.png") });
} finally {
  await b.close();
  if (server) server.kill();
}
console.log(bad ? `\n${bad} failed` : "\nall font checks passed");
process.exit(bad ? 1 : 0);
