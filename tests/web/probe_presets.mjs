/* The use-case pages' presets, and the persistence they exposed.
 *
 *   node tests/web/probe_presets.mjs
 *
 * Two families of assertion:
 *
 *   1. A generated page's preset lands in REAL app state: /compress-to-200kb
 *      boots with sizeTarget 204800 and Advanced settings open (a preset the person
 *      cannot see would be the disclosure rule broken one level up),
 *      /compress-jpeg boots pinned to JPEG, /compress-for-email boots on the
 *      email destination - and pages without a preset, the homepage included,
 *      boot exactly as before.
 *
 *   2. A pinned file type survives a reload. It did not: renderFormatOptions
 *      restores the select's own previous value - empty at boot - and clears
 *      state.settings.formats when the select ends up empty, so a stored pin
 *      silently died on every load. The page-preset work exposed it; this
 *      probe is the gate that would have caught it.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer, { CHROME } from "./resolve_puppeteer.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8199;

const server = spawn("node", [path.join(here, "serve.mjs"), String(PORT)], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 900));

const b = await puppeteer.launch({
  executablePath: CHROME, headless: true, protocolTimeout: 3_600_000,
});
let bad = 0;
const ok = (c, n) => { if (c) console.log(`  ok ${n}`); else { console.error(`FAIL ${n}`); bad++; } };

const page = await b.newPage();
const boot = async (file) => {
  await page.goto(`http://127.0.0.1:${PORT}/${file}`, { waitUntil: "networkidle0" });
  return page.evaluate(() => ({
    size: window.state.settings.sizeTarget,
    formats: window.state.settings.formats,
    target: window.state.settings.target,
    moreOpen: document.getElementById("more-choices").open,
    goal: document.getElementById("plan-goal").value,
    capShown: document.getElementById("plan-cap").value,
    pinShown: document.getElementById("plan-format").value,
  }));
};

/* ------------------------- 1. presets land, visibly ----------------------- */

let s = await boot("compress-to-200kb.html");
ok(s.size === 204800, `200kb page: the engine's target is 204800 (${s.size})`);
ok(s.goal === "cap" && /200/.test(s.capShown), `200kb page: the control says it ("${s.capShown}")`);
ok(s.moreOpen, "200kb page: Advanced settings is open, so the preset is on screen");

s = await boot("compress-jpeg.html");
ok(s.formats?.[0] === "jpeg" && s.pinShown === "jpeg",
  `jpeg page: pinned to JPEG in state and on the control (${JSON.stringify(s.formats)}, "${s.pinShown}")`);
ok(s.moreOpen, "jpeg page: Advanced settings is open");

s = await boot("compress-for-email.html");
ok(s.target === "email", `email page: destination is email (${s.target})`);

s = await boot("bulk-image-compressor.html");
ok(!s.size && !s.formats, "bulk page: carries no preset, gets none");

s = await boot("index.html");
ok(!s.size && !s.formats, "homepage: untouched by the preset machinery");

/* --------------------- 2. a stored pin survives a reload ------------------- */

await page.select("#plan-format", "webp");
/* The save is debounced behind the change (main.js pushSettings, 350ms), so
   wait for the RECEIPT - the pin in storage - never a stopwatch. */
await page.waitForFunction(() => {
  try {
    return JSON.parse(localStorage.getItem("imgc-settings") || "{}").formats?.[0] === "webp";
  } catch { return false; }
});
s = await boot("index.html");
ok(s.formats?.[0] === "webp" && s.pinShown === "webp",
  `a pinned file type survives a reload (${JSON.stringify(s.formats)}, "${s.pinShown}")`);

/* And a page's preset outranks what was stored - the address is the newer,
   more explicit ask. The webp pin from above is still in storage. */
s = await boot("compress-jpeg.html");
ok(s.formats?.[0] === "jpeg", `the page's own preset outranks the stored pin (${JSON.stringify(s.formats)})`);

await b.close();
server.kill();
if (bad) { console.error(`\n${bad} failed`); process.exit(1); }
console.log("\nOK — presets land, are visible, and pins survive reloads");
