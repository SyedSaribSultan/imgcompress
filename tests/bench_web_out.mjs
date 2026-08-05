/* Produce the web app's own output for the benchmark corpus, from the real page
 * in a real browser, and write it to disk for scoring.
 *
 * The app is driven the way a person drives it - drop files in, wait, take what
 * comes out - rather than by calling the engine directly, so what gets scored is
 * genuinely what a user would download. The dimension cap is set to 0 because
 * the corpus has already been normalised; letting the app resize again would
 * mean it was compressing different pixels from everything else.
 *
 *   node tests/bench_web_out.mjs [--ref tests/bench_ref] [--out tests/bench_web_out]
 */

import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

/* puppeteer-core is a test-only dependency and is not vendored. Resolve it from
 * wherever it lives: the repo, or a path given in PUPPETEER_CORE. */
const puppeteer = await (async () => {
  const explicit = process.env.PUPPETEER_CORE;
  for (const spec of [explicit && pathToFileURL(explicit).href, "puppeteer-core"].filter(Boolean)) {
    try { return (await import(spec)).default; } catch { /* try the next */ }
  }
  console.error(
    "puppeteer-core not found. Install it (npm i -D puppeteer-core) or set\n" +
    "PUPPETEER_CORE to the path of its index.js.");
  process.exit(2);
})();

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.dirname(here);

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : dflt;
};
const REF = path.resolve(arg("ref", path.join(here, "bench_ref")));
const OUT = path.resolve(arg("out", path.join(here, "bench_web_out")));
const CHROME = process.env.CHROME_PATH ||
  "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 8188;

const files = readdirSync(REF).filter((f) => f.endsWith(".png")).map((f) => path.join(REF, f));
if (!files.length) {
  console.error(`no reference PNGs in ${REF} — run bench_vs_alternatives.py first`);
  process.exit(2);
}

// Serve web/ exactly as production does, headers included.
const server = spawn(process.execPath, ["-e", `
  const http = require("http"), fs = require("fs"), p = require("path");
  const ROOT = ${JSON.stringify(path.join(repo, "web"))};
  const TYPES = { ".html":"text/html", ".js":"text/javascript", ".css":"text/css",
    ".json":"application/json", ".wasm":"application/wasm", ".svg":"image/svg+xml",
    ".png":"image/png", ".ico":"image/x-icon", ".webmanifest":"application/manifest+json",
    ".woff2":"font/woff2", ".txt":"text/plain", ".xml":"application/xml", ".md":"text/markdown" };
  http.createServer((req, res) => {
    let rel = decodeURIComponent(req.url.split("?")[0]);
    if (rel.endsWith("/")) rel += "index.html";
    const f = p.join(ROOT, rel);
    if (!f.startsWith(p.resolve(ROOT))) return res.writeHead(403).end();
    fs.readFile(f, (e, b) => e
      ? res.writeHead(404).end("nope")
      : res.writeHead(200, { "Content-Type": TYPES[p.extname(f)] || "application/octet-stream" }).end(b));
  }).listen(${PORT}, "127.0.0.1");
`], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 900));

// protocolTimeout: a waitForFunction rides a single CDP call until it
// resolves, and a 12MP image searched at full effort takes longer than the
// 180s default.
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, protocolTimeout: 3_600_000,
});
try {
  for (const target of ["figma", "web"]) {
    const dir = path.join(OUT, target);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });

    const pg = await browser.newPage();
    pg.on("pageerror", (e) => console.error("[pageerror]", String(e)));
    await pg.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "networkidle0" });

    // Same floor as the benchmark; no second resize.
    await pg.select("#target", target);
    await pg.evaluate(() => {
      document.getElementById("target").dispatchEvent(new Event("change"));
      const md = document.getElementById("maxdim");
      md.value = "0";
      md.dispatchEvent(new Event("change"));
    });
    await new Promise((r) => setTimeout(r, 600));

    const input = await pg.$("#file-input");
    await input.uploadFile(...files);
    await pg.waitForFunction(
      (n) => typeof state !== "undefined" && state.items.length === n &&
             state.items.every((i) => ["done", "saved", "failed"].includes(i.status)),
      { timeout: 1_800_000, polling: 400 }, files.length);

    const results = await pg.evaluate(async () => {
      const b64 = (buf) => {
        let s = "";
        const b = new Uint8Array(buf);
        for (let i = 0; i < b.length; i += 0x8000) {
          s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
        }
        return btoa(s);
      };
      const out = [];
      for (const it of state.items) {
        if (!it.afterBlob) { out.push({ name: it.name, error: it.error || "no output" }); continue; }
        out.push({
          name: it.name, fmt: it.fmt, ext: it.result?.ext || "",
          score: it.score, lossless: !!it.lossless,
          warnings: it.warnings || [],
          bytes: b64(await it.afterBlob.arrayBuffer()),
        });
      }
      return out;
    });

    for (const r of results) {
      if (r.error) { console.error(`  ${target}/${r.name}: ${r.error}`); continue; }
      const stem = path.basename(r.name, path.extname(r.name));
      const dest = path.join(dir, stem + (r.ext || ".bin"));
      const buf = Buffer.from(r.bytes, "base64");
      writeFileSync(dest, buf);
      console.log(`  ${target.padEnd(5)} ${stem.padEnd(24)} ${String(r.fmt).padEnd(5)} ` +
        `${String(buf.length).padStart(9)} B  ` +
        `${r.lossless ? "lossless" : "ss2 " + (r.score ?? 0).toFixed(1)}` +
        // A silent forfeit must never look like a considered choice again.
        (r.warnings.length ? `  WARN: ${r.warnings.join("; ")}` : ""));
    }
    await pg.close();
  }
} finally {
  await browser.close();
  server.kill();
}
console.log(`\nwritten to ${OUT}`);
