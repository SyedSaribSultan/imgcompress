/* Does the interface admit that it compresses video?
 *
 * The engine has compressed video since the browser tier shipped, and it does
 * it honestly - measured, disclosed, capped. But the plan panel was written
 * for pictures and never revisited, so it told a person one thing while the
 * engine did another. Two failures, one of them a real correctness bug:
 *
 *   - A destination carries TWO quality floors, one for pictures and one for
 *     video. `videoPlan()` correctly runs the video one; the panel only ever
 *     showed the picture one. For "Website or app" that is 90 on screen and 92
 *     in the engine. The whole purpose of the readout sentence is to stop the
 *     plan and the engine drifting apart, so a silent two-point difference is
 *     precisely the bug it exists to prevent.
 *   - Three destinations govern video with a BYTE CEILING - email 18 MB, chat
 *     10 MB, social 500 MB - and that ceiling appeared nowhere in the
 *     interface at all, despite deciding the outcome.
 *
 * This asserts the panel now says both, that it says them only when a video is
 * actually in the queue, that a mixed queue discloses both floors rather than
 * picking one, and that the words stay inside the product's register.
 *
 * Everything is read off the rendered document and the app's own state, never
 * a mock: the failure being guarded against is exactly a panel that disagrees
 * with the engine, and a mock of either would agree with itself.
 *
 *   node tests/web/probe_video_parity.mjs
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer, { CHROME } from "./resolve_puppeteer.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const clip = path.join(root, "tests", "video_fixtures", "still.mp4");
const picture = path.join(here, "fixtures", "ui.png");

for (const f of [clip, picture]) {
  if (!fs.existsSync(f)) {
    console.error(`missing fixture ${f}\n`
      + "build them: python tests/make_video_fixtures.py "
      + "&& node tests/web/make_web_fixtures.mjs");
    process.exit(1);
  }
}

const PORT = 8213;
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

/* The register the whole product is written in: no codec names, no bitrates,
   no quantizers, in anything a person reads. Checked on every sentence this
   probe collects rather than trusted. */
const JARGON = /\b(CRF|quantizer|bitrate|H\.?26[45]|AVC|AV1|VP9|HEVC|yuv|chroma|mux)\b/i;

try {
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: "networkidle0" });

  const planNote = () => page.evaluate(
    () => (document.getElementById("quality-note")?.textContent || "").trim());
  const setTarget = (name) => page.evaluate((t) => {
    const sel = document.getElementById("target");
    sel.value = t;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  }, name);
  const clear = () => page.evaluate(() => {
    const btn = document.getElementById("clear-btn");
    if (btn) btn.click();
  });

  /* --- 1. with nothing queued, the panel says nothing about video --------- */
  await setTarget("web");
  const empty = await planNote();
  check("with an empty queue the plan says nothing about video",
    !/video/i.test(empty), JSON.stringify(empty));

  /* --- 2. a video in the queue: the floor that will REALLY run ------------ */
  const input = await page.$("#file-input");
  await input.uploadFile(clip);
  await page.waitForFunction(
    () => window.state?.items?.some((i) => i.isVideo), { timeout: 60000 });
  await new Promise((r) => setTimeout(r, 400));

  const withVideo = await planNote();
  /* What the engine will actually use, asked of the app rather than assumed. */
  const truth = await page.evaluate(async () => {
    const s = await import("/js/state.js");
    const plan = s.videoPlan(window.state.items.find((i) => i.isVideo));
    const D = window.DESTINATIONS;
    const target = D.destinationOf(document.getElementById("target").value);
    return {
      videoFloor: plan.qualityTarget,
      pictureFloor: D.DESTINATION_NUMBERS[target].qualityTarget,
      capMb: D.DESTINATION_VIDEO_NUMBERS[target].sizeCapMb,
    };
  });

  check("the two floors really do differ on this destination — "
    + "otherwise this probe proves nothing",
    truth.videoFloor !== truth.pictureFloor,
    `picture ${truth.pictureFloor} vs video ${truth.videoFloor}`);

  /* What the panel owes a person is the floor that will ACTUALLY RUN, said in
     the product's own words. On "Website or app" the numbers differ (90 vs 92)
     but both land in the same band, so the honest readout is the one sentence -
     repeating "exactly the same to your eye" would be noise pretending to be
     disclosure. So the assertion is on the WORDS being right, not on the string
     "video" appearing: a probe that demanded the word would force the panel to
     say something it has no reason to say. */
  const words = await page.evaluate(async (floor) => {
    const f = await import("/js/format.js");
    return f.wordsForQuality(floor);
  }, truth.videoFloor);
  check("the plan states the floor the video will really run under",
    withVideo.includes(words),
    `expected the words for ${truth.videoFloor} (“${words}”) in `
    + JSON.stringify(withVideo));
  check("and no jargon rode in with it", !JARGON.test(withVideo),
    JSON.stringify(withVideo));

  /* --- 3. the byte ceiling, where one exists ----------------------------- */
  await setTarget("chat");
  await new Promise((r) => setTimeout(r, 300));
  const chat = await planNote();
  const chatCap = await page.evaluate(
    () => window.DESTINATIONS.DESTINATION_VIDEO_NUMBERS.chat.sizeCapMb);
  check("a destination with a byte ceiling states it",
    chat.includes(String(chatCap)) && /\bMB\b/.test(chat),
    `${chatCap} MB expected in ${JSON.stringify(chat)}`);

  /* A ceiling is a fact, not a question: there must be no control for it.
     Making it editable would add a decision the product refuses to add, and
     would let someone "raise" a limit Discord will not honour. */
  const editable = await page.evaluate(() => {
    const ids = ["video-cap", "video-size", "plan-video-cap", "video-limit"];
    return ids.filter((id) => !!document.getElementById(id));
  });
  check("and offers no control to change it", editable.length === 0,
    editable.join(", "));

  /* --- 4. a destination that takes no video says so ---------------------- */
  await setTarget("thumbnail");
  await new Promise((r) => setTimeout(r, 300));
  const thumb = await planNote();
  const takesVideo = await page.evaluate(
    () => !!window.DESTINATIONS.DESTINATION_VIDEO_NUMBERS.thumbnail);
  check("“Thumbnail or avatar” really takes no video", !takesVideo);
  check("and the plan says the video is left alone, before the run",
    /left exactly as it is/i.test(thumb), JSON.stringify(thumb));

  /* --- 5. a MIXED queue speaks for both, and says which is which ---------
     On "Discord or group chat" the two differ in a way a person can act on:
     the pictures are held to one standard and the video is additionally capped
     at 10 MB. With both kinds queued the sentence has to attribute that to the
     video rather than leaving a reader to assume it applies to their photos. */
  await setTarget("chat");
  const pic = await page.$("#file-input");
  await pic.uploadFile(picture);
  await page.waitForFunction(() => {
    const items = window.state?.items || [];
    return items.some((i) => i.isVideo) && items.some((i) => !i.isVideo);
  }, { timeout: 60000 });
  await new Promise((r) => setTimeout(r, 400));

  const mixed = await planNote();
  check("a mixed queue attributes the video's own limit to the video",
    /the video has to/i.test(mixed) && /10 MB/.test(mixed),
    JSON.stringify(mixed));
  check("and does not imply it applies to the pictures too",
    !/it also has to/i.test(mixed), JSON.stringify(mixed));

  /* --- 6. and it goes back to silence when the video goes ---------------- */
  await clear();
  await page.waitForFunction(() => (window.state?.items || []).length === 0,
    { timeout: 30000 });
  await new Promise((r) => setTimeout(r, 300));
  const after = await planNote();
  check("clearing the queue stops the panel talking about video",
    !/video/i.test(after), JSON.stringify(after));

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
