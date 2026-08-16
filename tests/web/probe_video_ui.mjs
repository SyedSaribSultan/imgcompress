/* Can a person actually compress a video with this page?
 *
 * probe_video.mjs proves the ENGINE works: it talks to the worker directly and
 * never touches the app. This one proves the PRODUCT works - it drops a file
 * into the real page, served with the real CSP, in real Chrome, and then asks
 * the page what it believes: is there a row, does it say it is a video, did it
 * report progress while it worked, did a measured score land on screen, and is
 * the result something the person can take away.
 *
 * Everything is asserted against the app's own state and its own rendered
 * text, never against a mock. A wiring bug between the worker and the queue is
 * exactly the class of failure that a worker-level test cannot see and a user
 * cannot miss.
 *
 *   node tests/web/probe_video_ui.mjs
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer, { CHROME } from "./resolve_puppeteer.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const fixture = path.join(root, "tests", "video_fixtures", "still.mp4");
const picture = path.join(here, "fixtures", "ui.png");

if (!fs.existsSync(fixture)) {
  console.error("build the corpus first: python tests/make_video_fixtures.py");
  process.exit(1);
}

const PORT = 8198;
const server = spawn("node", [path.join(here, "serve.mjs"), String(PORT)], {
  stdio: "ignore",
});
await new Promise((r) => setTimeout(r, 800));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  protocolTimeout: 3_600_000,
  /* No SharedArrayBuffer flag, deliberately: this architecture avoids
     cross-origin isolation on purpose, and a test browser holding a capability
     the real site never has is a test of a different product. */
  args: ["--no-sandbox"],
});

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failures += 1;
};
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 940 });
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: "networkidle0" });
  await page.waitForFunction(() => typeof window.imgc !== "undefined");

  /* ---- 1. the page asks the browser what it can do, before anything drops -- */

  await page.evaluate(() => window.imgc.probeVideoSupport());
  await page.waitForFunction(() => window.state.videoCaps !== null, { timeout: 60000 });
  const caps = await page.evaluate(() => window.state.videoCaps);
  check("the page asks what this browser can encode", !!caps && caps.webcodecs === true,
    JSON.stringify(caps));
  check("and gets at least one format back on this machine",
    Array.isArray(caps.formats) && caps.formats.length > 0,
    (caps.formats || []).join(", "));

  /* ---- 2. a video goes in through the page's own intake ------------------- */

  const input = await page.$("#file-input");
  await input.uploadFile(fixture);
  await settle(500);

  const landed = await page.evaluate(() => {
    const row = document.querySelector('#queue-list .row');
    return {
      items: window.state.items.length,
      isVideo: window.state.items[0]?.isVideo === true,
      kind: row?.dataset.kind,
      badge: row?.querySelector(".kind")?.textContent || "",
      badgeShown: row ? !row.querySelector(".kind").hidden : false,
      // The untouched original is on the stage from the first frame, as a
      // video, not as a broken <img>.
      beforeShown: !document.getElementById("vid-before").hidden,
      imgHidden: document.getElementById("img-before").hidden,
      transport: !document.getElementById("transport").hidden,
      status: window.state.items[0]?.status,
    };
  });
  check("a video is accepted and becomes one row", landed.items === 1 && landed.isVideo,
    JSON.stringify(landed));
  check("the row says it is a video, and how long it is",
    landed.kind === "video" && landed.badgeShown && /^Video · \d+:\d\d$/.test(landed.badge),
    landed.badge);
  check("the original is on the stage as a video, with a way to play it",
    landed.beforeShown && landed.imgHidden && landed.transport);

  /* Decision D5: a video is purple where a picture is the brand accent. Read
     from the painted element rather than from the stylesheet, because a token
     that never reaches the badge is a decision that did not ship - and read in
     both themes, since one purple cannot clear contrast on both grounds and
     the two values are the whole reason this is a pair. */
  const accent = await page.evaluate(async () => {
    const read = async (theme) => {
      document.documentElement.dataset.theme = theme;
      await new Promise((r) => requestAnimationFrame(r));
      const badge = document.querySelector('.row[data-kind="video"] .kind');
      if (!badge) return null;
      const seen = getComputedStyle(badge);
      return { colour: seen.color, border: seen.borderTopColor };
    };
    const light = await read("light");
    const dark = await read("dark");
    return { light, dark };
  });
  const painted = (v) => v && v.colour && v.colour === v.border
    && v.colour !== "rgb(0, 0, 0)";
  check("the video badge carries the media accent (D5), in both themes",
    painted(accent.light) && painted(accent.dark)
    && accent.light.colour !== accent.dark.colour,
    `light ${accent.light?.colour} / dark ${accent.dark?.colour}`);

  /* ---- 3. it reports what it is doing, for as long as it takes ------------ */

  const sawWork = await page.evaluate(async () => {
    const seen = new Set();
    let fracs = [];
    const started = Date.now();
    while (Date.now() - started < 240000) {
      const it = window.state.items[0];
      if (!it) break;
      if (it.status === "working" && it.progress) {
        seen.add(it.progress.replace(/\d+%/, "N%"));
        fracs.push(it.frac || 0);
      }
      if (it.status === "done" || it.status === "failed" || it.status === "saved") break;
      await new Promise((r) => setTimeout(r, 150));
    }
    return {
      sentences: [...seen],
      /* A bar that goes backwards reads as work being thrown away. The worker
         reports a fraction per FORMAT and there are two of them, so this is
         the assertion that the app turns that into one honest run. */
      monotonic: fracs.every((v, i) => i === 0 || v >= fracs[i - 1]),
      status: window.state.items[0]?.status,
    };
  });
  check("it says what it is doing while it works, in words",
    sawWork.sentences.length >= 2, sawWork.sentences.join(" | "));
  check("no jargon in any of it — no codec names, no CRF, no bitrate",
    !/av1|h264|avc|crf|bitrate|quantizer/i.test(sawWork.sentences.join(" ")));
  check("progress never runs backwards", sawWork.monotonic);
  check("the video finished", sawWork.status === "done", sawWork.status);

  /* ---- 4. the result, and everything it owes the person ------------------- */

  const result = await page.evaluate(() => {
    const it = window.state.items[0];
    const row = document.querySelector('#queue-list .row');
    return {
      status: it.status,
      newBytes: it.newBytes,
      originalBytes: it.originalBytes,
      score: it.score,
      fmt: it.fmt,
      ext: it.ext,
      hasBlob: !!it.afterBlob && it.afterBlob.size > 0,
      blobType: it.afterBlob?.type || "",
      duration: it.duration,
      note: it.note,
      rowSub: row?.querySelector(".sub")?.textContent || "",
      saved: document.getElementById("s-saved").textContent,
      sizeHidden: document.getElementById("s-size").hidden,
      copyHidden: document.getElementById("copy-one").hidden,
      shownScore: document.getElementById("s-score").textContent,
      length: document.getElementById("s-length").textContent,
      lengthShown: !document.getElementById("s-length-cell").hidden,
      why: document.getElementById("chip-why").textContent,
      chips: [...document.querySelectorAll("#cands .chip")].map((c) => ({
        format: c.dataset.format, bytes: Number(c.dataset.bytes), disabled: c.disabled,
      })),
      warn: document.getElementById("s-warn").hidden
        ? "" : document.getElementById("s-warn").textContent,
      afterPlaying: document.getElementById("vid-after").getAttribute("src") || "",
    };
  });

  check("a real file came out, smaller than the one that went in",
    result.hasBlob && result.newBytes > 0 && result.newBytes < result.originalBytes,
    `${result.originalBytes} -> ${result.newBytes} bytes`);
  check("it is a video file, named for what was actually written",
    result.blobType.startsWith("video/") && result.ext === ".mp4",
    `${result.blobType} ${result.ext}`);
  check("it was measured, and the measurement is on screen",
    result.score > 0 && Number(result.shownScore) === Number(result.score.toFixed(1)),
    `score ${result.score} shown as "${result.shownScore}"`);
  check("the length of the clip is shown", result.lengthShown && /^\d+:\d\d$/.test(result.length),
    result.length);

  /* The result line, in the approved words, with both sizes and the
     percentage - and it is the SAME line in the queue and on the stage. */
  const shape = /^[\d.]+ [KMG]?B → [\d.]+ [KMG]?B — \d+% smaller/;
  check("the result line reads as approved: before → after — N% smaller",
    shape.test(result.saved), JSON.stringify(result.saved));
  check("and the row says exactly the same thing",
    result.rowSub.startsWith(result.saved), JSON.stringify(result.rowSub));
  check("the standalone size and the clipboard button are gone on a video",
    result.sizeHidden && result.copyHidden);

  check("the versions tried are listed as evidence, not as controls",
    result.chips.length >= 2 && result.chips.every((c) => c.disabled),
    JSON.stringify(result.chips));
  check("and the panel says why they cannot be swapped",
    /only the version that shipped is kept/i.test(result.why), result.why.slice(0, 90));
  check("the browser tier says so, in the open",
    /desktop app/i.test(result.note), result.note);
  check("falling short of the floor is disclosed, not hidden",
    result.score >= 92 || /under the 92/.test(result.warn), result.warn.slice(0, 120));
  check("the compressed side is loaded and ready to play", !!result.afterPlaying);

  /* ---- 5. the two players share one clock -------------------------------- */

  const sync = await page.evaluate(async () => {
    const before = document.getElementById("vid-before");
    const after = document.getElementById("vid-after");
    document.getElementById("vid-play").click();
    await new Promise((r) => setTimeout(r, 900));
    const drift = Math.abs(after.currentTime - before.currentTime);
    const playing = !before.paused && !after.paused;
    document.getElementById("vid-play").click();
    await new Promise((r) => setTimeout(r, 120));
    return { drift, playing, moved: before.currentTime > 0, paused: before.paused,
             label: document.getElementById("vid-play").textContent,
             time: document.getElementById("vid-time").textContent };
  });
  check("one button plays both sides", sync.playing && sync.moved,
    `at ${sync.time}`);
  check("and the compressed side follows the original's clock",
    sync.drift < 0.25, `drift ${sync.drift.toFixed(3)}s`);
  check("pressing it again stops them, and the button says so",
    sync.paused && sync.label === "Play");

  /* ---- 6. the split still cuts, with two videos on the stage -------------- */

  const split = await page.evaluate(() => {
    const s = document.getElementById("split");
    s.value = "30";
    s.dispatchEvent(new Event("input", { bubbles: true }));
    const frame = document.getElementById("frame");
    return {
      clip: getComputedStyle(document.getElementById("vid-after-wrap")).clipPath,
      onFrame: frame.style.getPropertyValue("--clip"),
      imgClip: getComputedStyle(document.getElementById("img-after-wrap")).clipPath,
    };
  });
  check("the caliper clips the video layer, not just the picture one",
    /inset/.test(split.clip) && split.clip === split.imgClip,
    `${split.onFrame} -> ${split.clip}`);

  /* ---- 7. the disclosure a cap would force, on the line that shows the % --
   * The browser engine does not trade quality for a byte ceiling today, so
   * this flag never fires on its own. It is driven here directly against the
   * real renderer, because a disclosure that has never been seen on screen is
   * a disclosure nobody can promise. */
  const capped = await page.evaluate(() => {
    const it = window.state.items[0];
    it.videoCapped = true;
    it.sizeTarget = 10 * 1024 * 1024;
    window.imgc.renderNow();
    const line = document.getElementById("s-saved").textContent;
    it.videoCapped = false;
    it.sizeTarget = 0;
    window.imgc.renderNow();
    return { line, back: document.getElementById("s-saved").textContent };
  });
  check("a cap that forced quality down is said on the SAME line as the %",
    /% smaller,.*not as sharp as the original to fit 10\.0 MB/.test(capped.line),
    JSON.stringify(capped.line));
  check("and the line goes back to the truth when it is not true",
    !/not as sharp/.test(capped.back));

  /* ---- 8. it can be taken away -------------------------------------------- */

  const client = await page.target().createCDPSession();
  const downloads = path.join(here, "downloads");
  fs.mkdirSync(downloads, { recursive: true });
  await client.send("Page.setDownloadBehavior", {
    behavior: "allow", downloadPath: downloads,
  });
  const named = await page.evaluate(() => {
    document.getElementById("dl-one").click();
    return { name: document.getElementById("out-name").value,
             ext: document.getElementById("out-ext").textContent,
             status: window.state.items[0].status };
  });
  await settle(1200);
  const written = fs.existsSync(path.join(downloads, "still.mp4"))
    ? fs.statSync(path.join(downloads, "still.mp4")).size : 0;
  check("the compressed video downloads, under its own name",
    written > 0 && written === result.newBytes,
    `still.mp4 ${written} bytes, item is "${named.status}"`);
  check("and the name on screen is the one it was saved as",
    named.name === "still" && named.ext === ".mp4");
  try { fs.unlinkSync(path.join(downloads, "still.mp4")); } catch { /* fine */ }

  /* ---- 9. pictures still work, side by side with a video ------------------ */

  if (fs.existsSync(picture)) {
    const input2 = await page.$("#file-input");
    await input2.uploadFile(picture);
    await page.waitForFunction(
      () => window.state.items.length === 2
        && ["done", "failed", "saved"].includes(window.state.items[1].status),
      { timeout: 120000, polling: 300 });
    const mixed = await page.evaluate(() => {
      window.imgc.select(window.state.items[1].id);
      window.imgc.renderNow();
      return {
        kinds: [...document.querySelectorAll("#queue-list .row")].map((r) => r.dataset.kind),
        statuses: window.state.items.map((i) => i.status),
        // Back on a picture, the picture layers are the live ones again.
        imgShown: !document.getElementById("img-before").hidden,
        vidHidden: document.getElementById("vid-before").hidden,
        transportHidden: document.getElementById("transport").hidden,
        diffEnabled: !document.getElementById("mode-diff").disabled,
      };
    });
    check("a picture in the same run still compresses",
      mixed.statuses[1] === "done", mixed.statuses.join(", "));
    check("and the stage swaps cleanly back to the picture layers",
      mixed.imgShown && mixed.vidHidden && mixed.transportHidden && mixed.diffEnabled,
      JSON.stringify(mixed.kinds));
  }

  /* ---- 9b. a worse file is never handed back ----------------------------- *
   * "Email" allows exactly one video format, and on this fixture that format
   * comes out BIGGER than the source. The rule the picture tier has always
   * held - never write a file worse than the one you were given - has to hold
   * here too, and this is the destination that tests it. */

  await page.evaluate(() => {
    window.imgc.select(window.state.items[0].id);
    const t = document.getElementById("target");
    t.value = "email";
    t.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle(600);
  await page.waitForFunction(
    () => window.state.items.every((i) => ["done", "failed", "saved"].includes(i.status)),
    { timeout: 300000, polling: 300 });
  const oneWay = await page.evaluate(() => {
    const it = window.state.items[0];
    window.imgc.renderNow();
    return {
      newBytes: it.newBytes, original: it.originalBytes,
      passthrough: !!it.passthrough, note: it.note,
      tried: [...document.querySelectorAll("#cands .chip")].map((c) => c.dataset.format),
    };
  });
  check("a video is never handed back bigger than it arrived",
    oneWay.newBytes <= oneWay.original,
    oneWay.passthrough
      ? `kept the original — "${oneWay.note}"`
      : `compressed to ${oneWay.newBytes} of ${oneWay.original}`);
  check("and if the original was kept, what was tried is still on show",
    !oneWay.passthrough || oneWay.tried.length > 1, oneWay.tried.join(", "));

  /* ---- 10. a destination that takes no video says so, and touches nothing -- */

  /* The note it is holding RIGHT NOW, captured first. The step before this one
     also ends with the original kept, so waiting on "passthrough is true"
     would be satisfied before the new plan had been applied at all - which is
     exactly what it did on the first run of this probe, and it read the
     previous step's sentence back as though it were this one's. Waiting for
     the sentence to actually change is the honest condition; a timeout falls
     through to the assertions rather than throwing, so a real failure here
     reads as a failure and not as a crashed probe. */
  const previousNote = await page.evaluate(() => window.state.items[0].note);
  await page.evaluate(() => {
    const t = document.getElementById("target");
    t.value = "thumbnail";                       // the table gives it no video row
    t.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.waitForFunction(
    (prev) => window.state.items.every((i) => ["done", "failed", "saved"].includes(i.status))
      && window.state.items[0].note !== prev,
    { timeout: 120000, polling: 200 }, previousNote).catch(() => {});
  const alone = await page.evaluate(() => {
    window.imgc.select(window.state.items[0].id);
    window.imgc.renderNow();
    const it = window.state.items[0];
    return {
      note: it.note,
      bytes: it.newBytes,
      original: it.originalBytes,
      why: document.getElementById("chip-why").textContent,
    };
  });
  check("a picture-only destination leaves a video exactly as it is",
    alone.bytes === alone.original && /is for pictures, not video/i.test(alone.note),
    alone.note);
  check("and the panel says that rather than showing an empty result",
    /is for pictures, not video/i.test(alone.why));

  /* ---- 11. a browser that cannot do this at all -------------------------- */

  const refused = await page.evaluate(async () => {
    /* The honest simulation of Firefox on Android, or Safari before 17.4: the
       page has asked, and the answer was no. What must NOT happen is a queue
       row, a progress bar and a failure a minute later. */
    window.state.videoCaps = { webcodecs: false, formats: [] };
    return window.state.items.length;
  });
  const input3 = await page.$("#file-input");
  await input3.uploadFile(fixture);
  await settle(800);
  const said = await page.evaluate(() => ({
    items: window.state.items.length,
    toast: document.getElementById("toast").textContent,
  }));
  check("a browser with no encoder is told at the door, not after the wait",
    said.items === refused, `${refused} -> ${said.items} rows`);
  check("in the approved words",
    said.toast.includes("This browser can't re-encode video yet")
    && said.toast.includes("the desktop app can"), JSON.stringify(said.toast));

  check("no console errors (a CSP violation lands here)",
    consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));
} finally {
  await browser.close();
  server.kill();
}

console.log(failures ? `\n${failures} failed` : "\nall good");
process.exit(failures ? 1 : 0);
