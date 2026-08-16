/* Do the numbers follow the reader, or only the author?
 *
 * Most of the world writes 1,4 MB where this app used to hard-code 1.4 MB.
 * On a page whose entire argument is a measured number that is not a cosmetic
 * detail: "90,5" read as "905" is a different claim about the same file.
 *
 * Run in real Chrome, three times, with the browser genuinely launched in a
 * different locale each time - not by stubbing Intl, because the thing under
 * test is precisely whether the code asks the platform at all. A formatter
 * pinned to "en-US" would pass a mocked test and fail every German user.
 *
 * The COPY is English and stays English here; that needs a translator, not a
 * probe. This checks only the half that can be correct without one.
 *
 *   node tests/web/probe_i18n.mjs
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer, { CHROME } from "./resolve_puppeteer.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8211;
const server = spawn("node", [path.join(here, "serve.mjs"), String(PORT)], {
  stdio: "ignore",
});
await new Promise((r) => setTimeout(r, 800));

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failures += 1;
};

/* One locale that uses a comma decimal, one that uses a point, and one more
   comma locale that also groups differently - enough to prove the value is
   read from the platform rather than from a constant that happens to match. */
const CASES = [
  ["de-DE", "1,4 MB", "90,5"],
  ["en-US", "1.4 MB", "90.5"],
  ["fr-FR", "1,4 MB", "90,5"],
];

try {
  for (const [locale, wantSize, wantScore] of CASES) {
    /* `--lang` alone is not enough. On Windows and macOS Chrome honours it,
       but on a Linux runner the ICU default comes from the environment - so
       CI saw "1.4 MB" for de-DE and this probe passed locally while failing
       there. Both are set, which is what makes the answer the same on every
       platform this project builds on. */
    const browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: "new",
      args: ["--no-sandbox", `--lang=${locale}`],
      env: { ...process.env, LANG: `${locale}.UTF-8`, LC_ALL: `${locale}.UTF-8` },
    });
    try {
      const page = await browser.newPage();
      await page.setExtraHTTPHeaders({ "Accept-Language": locale });
      await page.goto(`http://localhost:${PORT}/`, { waitUntil: "networkidle0" });
      const got = await page.evaluate(async () => {
        const m = await import("/js/format.js");
        return {
          size: m.human(1.4 * 1024 * 1024),
          score: m.scoreText(90.5, false),
          /* A clock stays digits in every locale - 2:31 is not localised, and
             pretending otherwise would be worse than leaving it alone. */
          clock: m.clock(151),
          /* What the browser ACTUALLY resolved to. Without this the probe
             cannot tell "the code ignores the locale" from "the runner never
             applied the locale", and the second one would quietly turn every
             assertion below into a comparison of en-US against itself. */
          resolved: Intl.NumberFormat().resolvedOptions().locale,
        };
      });
      const applied = got.resolved.toLowerCase()
        .startsWith(locale.split("-")[0].toLowerCase());
      check(`${locale}: the browser really is in this locale`,
        applied, `resolved to ${got.resolved}`);
      if (!applied) {
        // Everything below would be vacuous. Say so instead of printing
        // three passes that measured nothing.
        console.log("       skipping the formatting checks for this locale");
        continue;
      }
      check(`${locale}: a size reads the way that reader writes one`,
        got.size === wantSize, `${got.size} (want ${wantSize})`);
      check(`${locale}: the visual-match score too`,
        got.score === wantScore, `${got.score} (want ${wantScore})`);
      check(`${locale}: a running time is still clock notation`,
        got.clock === "2:31", got.clock);
    } finally {
      await browser.close();
    }
  }
} finally {
  server.kill();
}

console.log(failures ? `\n${failures} failed` : "\nall good");
process.exit(failures ? 1 : 0);
