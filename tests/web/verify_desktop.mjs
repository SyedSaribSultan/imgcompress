/* Runtime proof that the desktop app renders from the shared design system.
 *
 * The static checks in verify_tokens.mjs prove webui/app.html *references* the
 * token layer. They cannot prove the browser ever receives it. Three ways that
 * could silently fail, all of which end with the app quietly falling back to a
 * system typeface and default colours while every static gate stays green:
 *
 *   - the stylesheets are copied into pocketsize/webui/ by a tool, and a stale
 *     or missing copy is a 404;
 *   - fonts.css points at /fonts/... at the site root and has to be rewritten
 *     to a relative path to work under /webui/;
 *   - `mimetypes` has no woff2 entry on a stock Windows Python, so a face can
 *     arrive as application/octet-stream.
 *
 * So this boots the real Python server and looks at the real page.
 *
 *   node tests/web/verify_desktop.mjs
 *
 * Requires the package importable (pip install -e .) plus Chrome and
 * puppeteer-core, same as the other browser gates.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer, { CHROME } from "./resolve_puppeteer.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, "..", "..");
const PORT = process.env.DESKTOP_PORT || "8177";
const PYTHON = process.env.PYTHON || "python";

let bad = 0;
const ok = (c, n) => { if (c) console.log(`  ok ${n}`); else { console.error(`FAIL ${n}`); bad++; } };

/* The server prints its own URL with a per-run token; there is no other way in,
   which is the point of the token. */
// -u because Python buffers stdout when it is a pipe rather than a terminal,
// so the URL would sit in the buffer until the process exited - which it never
// does. Without it this waits 30s and reports "no output" on a healthy server.
const server = spawn(PYTHON, ["-u", "-m", "pocketsize.gui", "--no-open", "--port", PORT],
                     { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });
let out = "";
const url = await new Promise((resolve, reject) => {
  const deadline = setTimeout(() => reject(new Error(
    `server did not print a URL in 30s. Output was:\n${out}`)), 30_000);
  const scan = (chunk) => {
    out += chunk.toString();
    const m = out.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/);
    if (m) { clearTimeout(deadline); resolve(m[0]); }
  };
  server.stdout.on("data", scan);
  server.stderr.on("data", scan);
  server.on("exit", (code) => reject(new Error(
    `server exited with ${code} before serving. Output was:\n${out}`)));
});

const b = await puppeteer.launch({ executablePath: CHROME, headless: true });
try {
  const pg = await b.newPage();
  const responses = [];
  const origins = new Set();
  const errors = [];
  pg.on("response", (r) => responses.push({ url: r.url(), status: r.status(),
                                            type: r.headers()["content-type"] || "" }));
  pg.on("request", (r) => { try { origins.add(new URL(r.url()).origin); } catch {} });
  pg.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  pg.on("pageerror", (e) => errors.push(String(e)));

  await pg.setViewport({ width: 1280, height: 860 });
  await pg.goto(url, { waitUntil: "networkidle0" });
  await pg.evaluate(() => document.fonts.ready);

  // ---- the shared stylesheets actually arrived ---------------------------
  const got = (needle) => responses.find((r) => r.url.includes(needle));
  for (const sheet of ["heyoz-tokens.css", "fonts.css"]) {
    const r = got(sheet);
    ok(r && r.status === 200, `${sheet} served (${r ? r.status : "no request"})`);
    ok(r && /text\/css/.test(r.type), `${sheet} served as CSS (${r ? r.type : "—"})`);
  }

  // ---- and so did the faces, with a type a browser will accept -----------
  const fonts = responses.filter((r) => r.url.endsWith(".woff2"));
  ok(fonts.length > 0, `at least one face was fetched (${fonts.length})`);
  ok(fonts.every((r) => r.status === 200),
     `every face returned 200 (${fonts.map((r) => r.status).join(",")})`);
  ok(fonts.every((r) => r.type === "font/woff2"),
     `every face served as font/woff2 (${[...new Set(fonts.map((r) => r.type))].join(", ")})`);

  // ---- the tokens are in effect, not merely referenced -------------------
  const resolved = await pg.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const read = (n) => cs.getPropertyValue(n).trim();
    return {
      surface: read("--oz-color-surface-primary"),
      content: read("--oz-color-content-primary"),
      brand: read("--oz-color-fill-brand"),
      /* `--app-radius-sm` was the old inline block's own name for this, and
         it went with that block: the desktop app now consumes the same
         `--radius-sm` the web app does, out of css/base.css. Reading the dead
         name asserted only that the private vocabulary still existed. */
      radius: read("--radius-sm"),
      spring: read("--oz-spring-effects-fast-ms"),
      bodyBg: getComputedStyle(document.body).backgroundColor,
      bodyFamily: getComputedStyle(document.body).fontFamily,
    };
  });
  console.log("  resolved:", JSON.stringify(resolved));
  for (const [name, value] of Object.entries(resolved)) {
    ok(value && value !== "", `${name} resolves to something (${value || "EMPTY"})`);
  }
  ok(/Geist/i.test(resolved.bodyFamily),
     `body paints in the brand face (${resolved.bodyFamily})`);

  // ---- the faces registered and parsed ----------------------------------
  const faces = await pg.evaluate(() =>
    [...document.fonts].map((f) => `${f.family} ${f.weight} ${f.status}`).sort());
  console.log("  faces:", JSON.stringify(faces));
  ok(faces.length === 6, `six faces registered (${faces.length})`);
  ok(!faces.some((f) => f.endsWith("error")), "no face failed to parse");

  // ---- the weight ceiling, as rendered ----------------------------------
  const heavy = await pg.evaluate(() => {
    const over = [];
    for (const el of document.querySelectorAll("*")) {
      const w = Number(getComputedStyle(el).fontWeight);
      if (w > 600) over.push(`${el.tagName.toLowerCase()}.${el.className || "-"}=${w}`);
    }
    return [...new Set(over)];
  });
  ok(heavy.length === 0, `nothing renders above 600 (${heavy.join(", ") || "clean"})`);

  // ---- no private palette left ------------------------------------------
  const legacy = await pg.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    return ["--ink", "--surface", "--panel", "--accent", "--line", "--r-sm", "--t-fast"]
      .filter((n) => cs.getPropertyValue(n).trim() !== "");
  });
  ok(legacy.length === 0,
     `the private palette is gone (${legacy.join(", ") || "none defined"})`);

  // ---- everything stayed local -----------------------------------------
  /* `data:` and `blob:` URLs report an origin of "null", and the shared
     stylesheets draw several icons as inline data: SVGs - which the CSP
     explicitly permits (`img-src 'self' data: blob:`). They are not requests
     that left the machine, and counting them as foreign made this gate fail on
     a page that had contacted nothing. What it means to assert is that no
     request reached a real host other than this one. */
  const foreign = [...origins].filter(
    (o) => o !== "null" && !o.startsWith("data:") && !o.startsWith("blob:")
           && !o.includes("127.0.0.1"));
  ok(foreign.length === 0, `every request stayed on this origin (${foreign.join(", ") || "clean"})`);
  ok(errors.length === 0, `no console errors (${errors.slice(0, 2).join(" | ") || "clean"})`);
} finally {
  await b.close();
  server.kill();
}

console.log(bad === 0 ? "\nOK — the desktop app renders from the shared design system"
                      : `\n${bad} problem(s)`);
process.exit(bad ? 1 : 0);
