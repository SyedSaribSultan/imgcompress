/* Runtime proof, in a real browser: the self-hosted faces load, they are the
 * faces actually used to paint, nothing renders above 600, and no request
 * leaves the origin. */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer, { CHROME } from "./resolve_puppeteer.mjs";

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
  const paints = await pg.evaluate(async () => {
    await document.fonts.ready;
    const check = (family, weight, size) => document.fonts.check(`${weight} ${size}px "${family}"`);
    return {
      fraunces600: check("Fraunces", 600, 17),
      fraunces400: check("Fraunces", 400, 15),
      geistMono: check("Geist Mono", 500, 14),
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
  });
  console.log("  paints:", JSON.stringify(paints));
  ok(paints.fraunces600, "Fraunces 600 is available");
  ok(paints.fraunces400, "Fraunces 400 is available at body size");
  ok(paints.geistMono, "Geist Mono is available");
  ok(/Fraunces/.test(paints.bodyFamily),
     `body resolves to Fraunces first (${paints.bodyFamily})`);
  ok(/Geist Mono/.test(paints.numFamily), "figures resolve to Geist Mono first");
  ok(/Fraunces/.test(paints.brandFamily),
     `the wordmark resolves to Fraunces first (${paints.brandFamily})`);
  ok(/Fraunces/.test(paints.aboutFamily),
     `and so does the about strip's lead heading (${paints.aboutFamily})`);
  ok(/Fraunces/.test(paints.labelFamily),
     `and every field label (${paints.labelFamily})`);
  ok(/Fraunces/.test(paints.buttonFamily),
     `and the buttons, which do not inherit it (${paints.buttonFamily})`);
  /* The region labels are the hardest case for this face: 13px, uppercase,
     tracked. They are IN Fraunces now by decision, which makes the thing worth
     asserting not "which family" but that the optical-size axis survived the
     subset - a face pinned to a display optical size would render those labels
     with display-sized serifs, which is the failure that would actually look
     wrong. */
  const opsz = await pg.evaluate(async () => {
    const face = [...document.fonts].find((f) => f.family === "Fraunces");
    return face ? face.variationSettings || "normal" : null;
  });
  console.log("  Fraunces variation settings:", opsz);
  const axes = await pg.evaluate(async () => {
    /* Rendered width at two sizes, normalised. An optical-size axis changes the
       letterforms between them; a pinned face merely scales, so the ratio would
       be exactly the size ratio. */
    const m = (px) => {
      const el = document.createElement("span");
      el.textContent = "Handgloves shrink";
      el.style.cssText = `position:absolute;visibility:hidden;font-family:Fraunces;font-size:${px}px`;
      document.body.append(el);
      const w = el.getBoundingClientRect().width / px;
      el.remove();
      return w;
    };
    return { small: m(13), large: m(72) };
  });
  console.log("  normalised widths:", JSON.stringify(axes));
  ok(Math.abs(axes.small - axes.large) > 0.005,
     `the optical-size axis survived the subset, so 13px labels get their own `
     + `cut rather than a shrunken display one (${axes.small.toFixed(4)} vs ${axes.large.toFixed(4)})`);

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
