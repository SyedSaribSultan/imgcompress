/* Do the video use-case pages actually set the plan they promise?
 *
 * A page that opens with "the plan already set for Discord" and then does not
 * set it is worse than no page: it is a promise the product breaks in the
 * first second. These presets ride on a data attribute that settings.js reads,
 * and nothing else checks that the two agree.
 *
 *   node tests/web/probe_video_pages.mjs
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer, { CHROME } from "./resolve_puppeteer.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8212;
const server = spawn("node", [path.join(here, "serve.mjs"), String(PORT)], {
  stdio: "ignore",
});
await new Promise((r) => setTimeout(r, 800));

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failures += 1;
};

/* slug -> the destination the page's copy promises. Read off the settings the
   app actually adopted, not off the attribute in the HTML - the attribute
   being present proves nothing about whether anything consumed it. */
const CASES = [
  ["compress-video", "web"],
  ["compress-video-for-discord", "chat"],
  ["compress-video-for-email", "email"],
];

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: "new", args: ["--no-sandbox"],
});

try {
  for (const [slug, wanted] of CASES) {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    // `.html` explicitly: the local dev server serves files, it does not
    // rewrite extensionless paths the way the deploy host does.
    await page.goto(`http://localhost:${PORT}/${slug}.html`, { waitUntil: "networkidle0" });
    await page.waitForFunction(() => typeof window.state !== "undefined");
    const got = await page.evaluate(() => ({
      target: window.state.settings.target,
      title: document.title,
      h1: document.querySelector("#about h1")?.textContent || "",
      canonical: document.querySelector('link[rel="canonical"]')?.href || "",
    }));
    check(`/${slug} opens with the destination its copy promises`,
      got.target === wanted, `${got.target} (want ${wanted})`);
    check(`/${slug} says video in its title`, /video/i.test(got.title), got.title);
    check(`/${slug} has its own canonical`, got.canonical.endsWith(`/${slug}`),
      got.canonical);
    check(`/${slug} loads with no script error`, errors.length === 0,
      errors.slice(0, 1).join(""));
    await page.close();
  }
} finally {
  await browser.close();
  server.kill();
}

console.log(failures ? `\n${failures} failed` : "\nall good");
process.exit(failures ? 1 : 0);
