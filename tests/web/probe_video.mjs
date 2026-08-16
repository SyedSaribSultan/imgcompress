/* Does the browser tier actually compress a video?
 *
 * Run against the real page, served with the real CSP, in real Chrome - the
 * only place the answer is worth anything. A worker that imports a module,
 * asks WebCodecs for an encoder and writes an MP4 has four separate ways to
 * fail silently in a mocked environment and none of them are interesting.
 *
 *   node tests/web/probe_video.mjs
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer, { CHROME } from "./resolve_puppeteer.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const fixture = path.join(root, "tests", "video_fixtures", "still.mp4");

if (!fs.existsSync(fixture)) {
  console.error("build the corpus first: python tests/make_video_fixtures.py");
  process.exit(1);
}

const PORT = 8197;
const server = spawn("node", [path.join(here, "serve.mjs"), String(PORT)], {
  stdio: "ignore",
});
await new Promise((r) => setTimeout(r, 700));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  /* No SharedArrayBuffer flag: this architecture deliberately does not need
     cross-origin isolation, and launching the test browser with a capability
     the real site never has would be testing a different product. */
  args: ["--no-sandbox"],
});

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failures += 1;
};

try {
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: "networkidle0" });

  const bytes = fs.readFileSync(fixture);
  const base64 = bytes.toString("base64");

  const caps = await page.evaluate(async () => {
    const worker = new Worker("/video-worker.js", { type: "module" });
    const answer = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("probe timed out")), 20000);
      worker.onmessage = (e) => {
        if (e.data.type === "caps") { clearTimeout(timer); resolve(e.data.caps); }
      };
      worker.onerror = (e) => { clearTimeout(timer); reject(new Error(e.message)); };
      worker.postMessage({ type: "probe" });
    });
    worker.terminate();
    return answer;
  });

  check("the module worker loads and answers", caps && caps.webcodecs === true,
    JSON.stringify(caps));
  check("this browser reports at least one encoder",
    Array.isArray(caps.formats) && caps.formats.length > 0,
    (caps.formats || []).join(", "));

  const run = await page.evaluate(async (b64, formats) => {
    const binary = atob(b64);
    const buffer = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) buffer[i] = binary.charCodeAt(i);
    const file = new File([buffer], "still.mp4", { type: "video/mp4" });

    const worker = new Worker("/video-worker.js", { type: "module" });
    const stages = [];
    const out = await new Promise((resolve) => {
      const timer = setTimeout(
        () => resolve({ error: "job timed out", stages }), 180000);
      worker.onmessage = (e) => {
        if (e.data.type === "progress") { stages.push(e.data.stage); return; }
        if (e.data.type === "done") {
          clearTimeout(timer);
          resolve({ result: e.data.result, size: e.data.blob.size, stages });
        }
        if (e.data.type === "failed") {
          clearTimeout(timer);
          resolve({ error: e.data.error, stages });
        }
      };
      worker.onerror = (e) => { clearTimeout(timer); resolve({ error: e.message, stages }); };
      worker.postMessage({
        type: "job", id: "one", file,
        settings: { maxDimension: 1920, qualityTarget: 92, formats },
      });
    });
    worker.terminate();
    return out;
  }, base64, caps.formats || []);

  if (run.error) {
    check("a video compresses in the browser", false, run.error);
  } else {
    check("a video compresses in the browser", true,
      `${bytes.length} -> ${run.size} bytes as ${run.result.format}`);
    check("the result is smaller than the source", run.size < bytes.length,
      `${run.size} vs ${bytes.length}`);
    check("it measured what it made", run.result.score > 0,
      `score ${run.result.score.toFixed(1)}`);
    check("it reported progress while working", run.stages.length >= 3,
      run.stages.join(" -> "));
    check("it says which tier this is",
      typeof run.result.note === "string" && run.result.note.includes("desktop"));
  }

  check("no console errors (a CSP violation lands here)",
    consoleErrors.length === 0, consoleErrors.slice(0, 2).join(" | "));
} finally {
  await browser.close();
  server.kill();
}

console.log(failures ? `\n${failures} failed` : "\nall good");
process.exit(failures ? 1 : 0);
