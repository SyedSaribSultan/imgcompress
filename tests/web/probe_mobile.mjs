/* The studio on a phone: does anything overflow, and are the chips reachable
 * and finger-sized? They are the primary control now, so on the surface where
 * a control is hardest to hit they are the thing worth measuring.
 *
 * This printed its measurements and exited 0 whatever they said, which made it
 * a report rather than a test - running it and seeing no errors carried almost
 * no information. It now asserts, because "probe_mobile passes with no
 * horizontal scrolling at 375px" is not a criterion a script with no pass/fail
 * semantics can meet.
 *
 * 375px, not 390: the narrowest phone width still in common use is the one
 * worth holding the layout to, and it is the width the roadmap names.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer, { CHROME } from "./resolve_puppeteer.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(here, "fixtures");
const WIDTH = Number(process.env.MOBILE_WIDTH || 375);
const TOUCH_FLOOR = 44;   // the system's coarse-pointer minimum

let bad = 0;
const ok = (c, n) => { if (c) console.log(`  ok ${n}`); else { console.error(`FAIL ${n}`); bad++; } };

const server = spawn("node", [path.join(here, "serve.mjs"), "8195"], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 900));
const b = await puppeteer.launch({
  executablePath: CHROME, headless: true, protocolTimeout: 3_600_000,
});
try {
  const pg = await b.newPage();
  const errors = [];
  pg.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  pg.on("pageerror", (e) => errors.push(String(e)));
  await pg.setViewport({ width: WIDTH, height: 844, isMobile: true, hasTouch: true });
  await pg.goto("http://127.0.0.1:8195/", { waitUntil: "networkidle0" });
  const input = await pg.$("#file-input");
  await input.uploadFile(path.join(FIX, "photo.png"), path.join(FIX, "logo.png"));
  await pg.waitForFunction(() => state.items.every((i) =>
    ["done", "failed", "saved"].includes(i.status)), { timeout: 900000, polling: 300 });
  await new Promise((r) => setTimeout(r, 600));
  await pg.screenshot({ path: path.join(here, "shot-studio-mobile.png"), fullPage: true });

  const fit = await pg.evaluate(() => {
    const doc = document.documentElement;
    const wide = [];
    /* The chip strip scrolls sideways inside itself on purpose, so it is
       exempt from the overhang check - what matters is that it does not push
       the page wide, which the first line below measures. */
    for (const el of document.querySelectorAll("#app-full *")) {
      if (el.closest("#cands")) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && (r.right > doc.clientWidth + 1 || r.left < -1)) {
        wide.push(`${el.tagName.toLowerCase()}.${el.className || el.id} ` +
                  `${Math.round(r.left)}..${Math.round(r.right)}`);
      }
    }
    const chips = [...document.querySelectorAll("#cands .cand")];
    return {
      pageScrollsSideways: doc.scrollWidth > doc.clientWidth,
      viewport: doc.clientWidth,
      overflowing: wide,
      chips: chips.length,
      // The system's coarse-pointer floor is 44px; anything under it is a miss
      // waiting to happen on the control the whole redesign rests on.
      chipHeights: chips.map((c) => Math.round(c.getBoundingClientRect().height)),
      narrationVisible: !!document.getElementById("narration").textContent.trim(),
    };
  });
  console.log(JSON.stringify(fit, null, 1));

  ok(fit.viewport === WIDTH, `measured at ${WIDTH}px (${fit.viewport})`);
  ok(!fit.pageScrollsSideways,
     `the page does not scroll sideways at ${WIDTH}px`);
  ok(fit.overflowing.length === 0,
     `nothing overhangs the viewport (${fit.overflowing.join("; ") || "clean"})`);
  ok(fit.chips > 0, `the version chips rendered (${fit.chips})`);
  const small = fit.chipHeights.filter((h) => h < TOUCH_FLOOR);
  ok(small.length === 0,
     `every chip clears the ${TOUCH_FLOOR}px touch floor (${
       small.length ? "short: " + small.join(",") : fit.chipHeights.join(",")})`);
  ok(fit.narrationVisible, "the result is narrated, not just drawn");
  ok(errors.length === 0, `no console errors (${errors.slice(0, 2).join(" | ") || "clean"})`);
} finally { await b.close(); server.kill(); }

console.log(bad === 0 ? `\nOK — the studio fits ${WIDTH}px` : `\n${bad} problem(s)`);
process.exit(bad ? 1 : 0);
