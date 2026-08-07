/* The set-up step on a phone: does anything overflow, and can it be driven? */
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
  await new Promise((r) => setTimeout(r, 1200));
  await pg.screenshot({ path: path.join(here, "shot-setup-mobile.png"), fullPage: true });

  const fit = await pg.evaluate(() => {
    const doc = document.documentElement;
    const wide = [];
    for (const el of document.querySelectorAll("#app-stage *")) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && (r.right > doc.clientWidth + 1 || r.left < -1)) {
        wide.push(`${el.tagName.toLowerCase()}.${el.className || el.id} ` +
                  `${Math.round(r.left)}..${Math.round(r.right)}`);
      }
    }
    return {
      pageScrollsSideways: doc.scrollWidth > doc.clientWidth,
      viewport: doc.clientWidth,
      overflowing: wide,
      goVisible: !!document.getElementById("setup-go")?.getBoundingClientRect().width,
    };
  });
  console.log(JSON.stringify(fit, null, 1));
} finally { await b.close(); server.kill(); }
