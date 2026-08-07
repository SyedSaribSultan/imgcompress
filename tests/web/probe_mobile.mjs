/* The studio on a phone: does anything overflow, and are the chips reachable
 * and finger-sized? They are the primary control now, so on the surface where
 * a control is hardest to hit they are the thing worth measuring. */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer, { CHROME } from "./resolve_puppeteer.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(here, "fixtures");
const server = spawn("node", [path.join(here, "serve.mjs"), "8195"], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 900));
const b = await puppeteer.launch({
  executablePath: CHROME, headless: true, protocolTimeout: 3_600_000,
});
try {
  const pg = await b.newPage();
  await pg.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
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
} finally { await b.close(); server.kill(); }
