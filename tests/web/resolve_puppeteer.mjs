/* puppeteer-core is a test-only dependency and is not vendored. Resolve it
 * from wherever it lives: the repo, or a path given in PUPPETEER_CORE. */
import { pathToFileURL } from "node:url";

export default await (async () => {
  const explicit = process.env.PUPPETEER_CORE;
  for (const spec of [explicit && pathToFileURL(explicit).href, "puppeteer-core"].filter(Boolean)) {
    try { return (await import(spec)).default; } catch { /* try the next */ }
  }
  console.error(
    "puppeteer-core not found. Install it (npm i -D puppeteer-core) or set\n" +
    "PUPPETEER_CORE to the path of its puppeteer-core.js.");
  process.exit(2);
})();

export const CHROME = process.env.CHROME_PATH ||
  "C:/Program Files/Google/Chrome/Application/chrome.exe";
