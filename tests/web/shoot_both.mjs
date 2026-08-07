/* Screenshot both interfaces at the same size, in both themes, so "the two are
 * recognisably the same product" is something you can look at rather than a
 * claim. Writes into tests/web/ (gitignored) - a review aid, not a gate.
 *
 *   node tests/web/shoot_both.mjs
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer, { CHROME } from "./resolve_puppeteer.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, "..", "..");
const FIX = path.join(here, "fixtures");
const PYTHON = process.env.PYTHON || "python";

const webServer = spawn("node", [path.join(here, "serve.mjs"), "8181"], { stdio: "ignore" });
const deskServer = spawn(PYTHON, ["-u", "-m", "imgcompress.gui", "--no-open", "--port", "8182"],
                         { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });

let out = "";
const deskUrl = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`no URL in 30s:\n${out}`)), 30_000);
  const scan = (c) => {
    out += c.toString();
    const m = out.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/);
    if (m) { clearTimeout(t); resolve(m[0]); }
  };
  deskServer.stdout.on("data", scan);
  deskServer.stderr.on("data", scan);
});
await new Promise((r) => setTimeout(r, 900));

const b = await puppeteer.launch({ executablePath: CHROME, headless: true,
                                   protocolTimeout: 3_600_000 });
const shots = [];
try {
  for (const theme of ["dark", "light"]) {
    // ---- the browser app ------------------------------------------------
    {
      const pg = await b.newPage();
      await pg.setViewport({ width: 1280, height: 860 });
      await pg.goto("http://127.0.0.1:8181/", { waitUntil: "networkidle0" });
      await pg.evaluate((t) => {
        try { localStorage.setItem("imgc-theme", t); } catch {}
        document.documentElement.dataset.theme = t;
      }, theme);
      const input = await pg.$("#file-input");
      await input.uploadFile(path.join(FIX, "photo.png"), path.join(FIX, "ui.png"));
      await pg.waitForFunction(() => state.items.length > 0 && state.items.every(
        (i) => ["done", "failed", "saved"].includes(i.status)),
        { timeout: 900_000, polling: 300 });
      await new Promise((r) => setTimeout(r, 700));
      const f = path.join(here, `same-product-web-${theme}.png`);
      await pg.screenshot({ path: f });
      shots.push(f);
      await pg.close();
    }
    // ---- the desktop app ------------------------------------------------
    {
      const pg = await b.newPage();
      await pg.setViewport({ width: 1280, height: 860 });
      await pg.goto(deskUrl, { waitUntil: "networkidle0" });
      await pg.evaluate((t) => {
        try { localStorage.setItem("imgc-theme", t); } catch {}
        document.documentElement.dataset.theme = t;
      }, theme);
      await pg.evaluate(async (paths) => {
        // The desktop app takes real paths, not a file input.
        await fetch(`/api/add?token=${TOKEN}`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ paths }),
        });
      }, [path.join(FIX, "photo.png"), path.join(FIX, "ui.png")]);
      await pg.waitForFunction(() => state.items && state.items.length > 0 &&
        state.items.every((i) => ["done", "failed", "saved"].includes(i.status)),
        { timeout: 900_000, polling: 400 });
      await new Promise((r) => setTimeout(r, 900));
      const f = path.join(here, `same-product-desktop-${theme}.png`);
      await pg.screenshot({ path: f });
      shots.push(f);
      await pg.close();
    }
  }
} finally {
  await b.close();
  webServer.kill();
  deskServer.kill();
}

for (const f of shots) console.log(`wrote ${path.relative(REPO, f)}`);
