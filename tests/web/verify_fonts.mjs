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
  ok(loaded.length === 6, `six faces registered (${loaded.length})`);
  ok(loaded.every((f) => f.endsWith("loaded") || f.endsWith("unloaded")),
     "no face failed to parse");

  // Are the brand faces the ones actually painting?
  const paints = await pg.evaluate(async () => {
    await document.fonts.ready;
    const check = (family, weight, size) => document.fonts.check(`${weight} ${size}px "${family}"`);
    return {
      bricolage600: check("Bricolage Grotesque", 600, 48),
      geist400: check("Geist", 400, 14),
      geistMono: check("Geist Mono", 500, 12),
      h1Family: getComputedStyle(document.querySelector(".empty h1")).fontFamily,
      h1Weight: getComputedStyle(document.querySelector(".empty h1")).fontWeight,
      bodyFamily: getComputedStyle(document.body).fontFamily,
    };
  });
  console.log("  paints:", JSON.stringify(paints));
  ok(paints.bricolage600, "Bricolage Grotesque 600 is available");
  ok(paints.geist400, "Geist 400 is available");
  ok(paints.geistMono, "Geist Mono is available");
  ok(/Bricolage Grotesque/.test(paints.h1Family), "h1 resolves to Bricolage first");
  ok(/Geist/.test(paints.bodyFamily), "body resolves to Geist first");

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
  await pg.evaluate(() => addSamples());
  await pg.waitForFunction(
    () => state.items.length === 2 && state.items.every((i) => ["done", "saved"].includes(i.status)),
    { timeout: 180000 });
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
