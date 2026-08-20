/* Is a person told how big a job is BEFORE it starts?
 *
 * A video encode in a browser tab can run for minutes and hold well over a
 * gigabyte, and the owner of this project froze a laptop finding that out. The
 * memory itself is bounded now (probe_video_memory.mjs), but bounded is not
 * free: past a certain size the honest thing is to say so first, and past a
 * larger one the honest thing is to not start at all and name the tier that
 * can.
 *
 * That makes three behaviours worth pinning, and the middle one is the one
 * most likely to be "fixed" into something worse:
 *
 *   ordinary  - nothing said, nothing in the way
 *   heavy     - said plainly, AND THEN DONE ANYWAY. Warning a person and then
 *               refusing on their behalf is not a warning, it is a veto.
 *   too big   - not started, with the desktop app named as the route
 *
 * The sizes are asserted from the app's own constants rather than from numbers
 * copied into this file, so moving a threshold does not silently move what is
 * being tested. Files are synthesised at the boundaries - a real 2 GB fixture
 * on disk to test a 2 GB limit would be absurd, and what is under test here is
 * the decision, not the decoding.
 *
 *   node tests/web/probe_video_size.mjs
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer, { CHROME } from "./resolve_puppeteer.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const small = path.join(root, "tests", "video_fixtures", "still.mp4");

if (!fs.existsSync(small)) {
  console.error("build the corpus first: python tests/make_video_fixtures.py");
  process.exit(1);
}

const PORT = 8211;
const server = spawn("node", [path.join(here, "serve.mjs"), String(PORT)], {
  stdio: "ignore",
});
await new Promise((r) => setTimeout(r, 700));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
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

  /* The thresholds and the words, read off the module the product uses. If
     these are not exported, the rest of this probe is meaningless - so it is
     checked rather than assumed. */
  const limits = await page.evaluate(async () => {
    const m = await import("/js/state.js");
    return {
      heavy: m.HEAVY_VIDEO_BYTES,
      tooBig: m.TOO_BIG_VIDEO_BYTES,
      heavyWords: m.HEAVY_VIDEO_WARNING,
      tooBigWords: m.TOO_BIG_VIDEO_HERE,
    };
  });
  check("the app states its own size thresholds",
    Number.isFinite(limits.heavy) && Number.isFinite(limits.tooBig)
      && limits.tooBig > limits.heavy,
    `heavy ${limits.heavy} < too big ${limits.tooBig}`);
  check("and the words for both are five-year-old readable",
    /take a while|busy/i.test(limits.heavyWords)
      && /desktop app/i.test(limits.tooBigWords)
      && !/[Bb]itrate|codec|CRF|quantizer|H\.?26|AV1/.test(
        limits.heavyWords + limits.tooBigWords),
    JSON.stringify([limits.heavyWords, limits.tooBigWords]).slice(0, 160));

  /* One helper, three sizes.
     The bytes are not a real clip, and that is sound because the decision
     under test is made on `file.size` and the name before anything is decoded
     - the size gate is the first thing intake consults. A genuinely decodable
     2 GB clip would take an hour to build, occupy 2 GB, and prove nothing more;
     the too-big case never reaches a decoder at all, which is its whole point.

     Built as a Blob of one repeated chunk rather than one big typed array:
     allocating 2 GB contiguously throws "Array buffer allocation failed"
     (observed), while a Blob's size is the sum of its parts and the browser
     never has to hold them contiguously. */
  const drop = async (bytes, label) => page.evaluate(async (n, name) => {
    const CHUNK = 1024 * 1024;
    const one = new Uint8Array(CHUNK);
    const parts = new Array(Math.floor(n / CHUNK)).fill(one);
    const rest = n % CHUNK;
    if (rest) parts.push(new Uint8Array(rest));
    const file = new File(parts, name, { type: "video/mp4" });

    window.__toasts = [];
    const el = document.getElementById("toast");
    const grab = () => {
      const t = el && el.textContent ? el.textContent.trim() : "";
      if (t && !window.__toasts.includes(t)) window.__toasts.push(t);
    };
    const spy = setInterval(grab, 60);

    const mod = await import("/js/intake.js");
    mod.addFiles([file]);
    await new Promise((r) => setTimeout(r, 1400));
    clearInterval(spy);
    grab();

    return {
      toasts: window.__toasts.slice(),
      rows: window.state.items.length,
      names: window.state.items.map((i) => i.name),
    };
  }, bytes, label);

  /* --- 1. ordinary: nothing in the way, nothing said about size ---------- */
  const ordinary = await drop(4 * 1024 * 1024, "ordinary.mp4");
  check("an ordinary video is taken without comment",
    ordinary.rows === 1
      && !ordinary.toasts.some((t) => /take a while|too big|desktop app/i.test(t)),
    `${ordinary.rows} row(s), toasts ${JSON.stringify(ordinary.toasts)}`);

  await page.evaluate(() => { window.state.items.length = 0; window.state.byId.clear(); });

  /* --- 2. heavy: SAID, and then done anyway ------------------------------ */
  const heavy = await drop(limits.heavy + 8 * 1024 * 1024, "heavy.mp4");
  check("a heavy video says it will take a while",
    heavy.toasts.some((t) => /take a while/i.test(t)),
    JSON.stringify(heavy.toasts));
  check("and is still accepted - a warning is not a veto",
    heavy.rows === 1 && heavy.names.includes("heavy.mp4"),
    `${heavy.rows} row(s): ${JSON.stringify(heavy.names)}`);

  await page.evaluate(() => { window.state.items.length = 0; window.state.byId.clear(); });

  /* --- 3. too big: not started, and told where to go --------------------- */
  const huge = await drop(limits.tooBig + 16 * 1024 * 1024, "huge.mp4");
  check("a video too big for a tab is not started",
    huge.rows === 0, `${huge.rows} row(s): ${JSON.stringify(huge.names)}`);
  check("and the desktop app is named as the way to do it",
    huge.toasts.some((t) => /desktop app/i.test(t)),
    JSON.stringify(huge.toasts));

  check("no console errors", consoleErrors.length === 0,
    consoleErrors.slice(0, 2).join(" | "));
} catch (error) {
  check("the probe ran", false, String((error && error.message) || error));
} finally {
  await browser.close();
  server.kill();
}

console.log(failures ? `\n${failures} failed` : "\nall good");
process.exit(failures ? 1 : 0);
