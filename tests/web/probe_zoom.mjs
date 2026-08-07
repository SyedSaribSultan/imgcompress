/* Does the stage grow when the frame is zoomed past it? That is the layout
 * fault behind "scrolling jumps me to the top and I have to drag back". */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer, { CHROME } from "./resolve_puppeteer.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(here, "fixtures");
const server = spawn("node", [path.join(here, "serve.mjs"), "8192"], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 900));
const b = await puppeteer.launch({
  executablePath: CHROME, headless: true, protocolTimeout: 3_600_000,
});
try {
  const pg = await b.newPage();
  await pg.setViewport({ width: 1440, height: 940 });
  pg.on("pageerror", (e) => console.log("[pageerror]", String(e)));
  await pg.goto("http://127.0.0.1:8192/", { waitUntil: "networkidle0" });
  const input = await pg.$("#file-input");
  await input.uploadFile(path.join(FIX, "photo.png"));
  await pg.waitForFunction(() => state.items.every((i) =>
    ["done", "failed", "saved"].includes(i.status)), { timeout: 900000, polling: 300 });
  await new Promise((r) => setTimeout(r, 600));

  const report = await pg.evaluate(() => {
    const out = [];
    const stage = document.getElementById("stage");
    const vp = document.getElementById("viewport");
    const snap = (label) => {
      const s = stage.getBoundingClientRect(), v = vp.getBoundingClientRect();
      out.push({
        label, zoom, pan: { x: Math.round(pan.x), y: Math.round(pan.y) },
        stage: `${Math.round(s.width)}x${Math.round(s.height)} @${Math.round(s.top)}`,
        frame: `${Math.round(v.width)}x${Math.round(v.height)} @${Math.round(v.top)}`,
        pageH: Math.round(document.documentElement.scrollHeight),
        scrollY: Math.round(window.scrollY),
      });
    };
    snap("fit");
    const box = stage.getBoundingClientRect();
    const x = box.left + box.width * 0.3, y = box.top + box.height * 0.3;
    for (const n of [1, 2, 3, 4]) {
      stage.dispatchEvent(new WheelEvent("wheel", {
        deltaY: -100, clientX: x, clientY: y, bubbles: true, cancelable: true }));
      snap(`wheel x${n}`);
    }
    return out;
  });
  for (const r of report) {
    console.log(`  ${r.label.padEnd(9)} zoom=${String(r.zoom).padEnd(4)} ` +
      `pan=(${String(r.pan.x).padStart(6)},${String(r.pan.y).padStart(6)})  ` +
      `stage ${r.stage.padEnd(18)} frame ${r.frame.padEnd(20)} ` +
      `pageH=${r.pageH} scrollY=${r.scrollY}`);
  }
} finally { await b.close(); server.kill(); }
