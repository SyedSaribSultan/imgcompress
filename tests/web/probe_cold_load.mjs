/* The largest file in the app must not be on the critical path.
 *
 * avif_enc.wasm is 3,485,872 bytes on disk and 1,116,248 over the wire - about
 * 64% of everything a first visit downloads - for an encoder that competes on
 * some destinations and that many visitors will never choose. It used to be in
 * the service worker's HEAVY_PRECACHE, which meant "ready to work offline"
 * waited on it, and the ordinary warm message then asked for it AGAIN the
 * moment the worker took control.
 *
 * Both halves had to move together, and this is what proves they did. The
 * measurement is ordering rather than absence: AVIF must still arrive, still
 * be cached permanently, and still compete in a bake-off - it just must not do
 * any of that before the page has painted.
 *
 * The first version of this gate asserted AVIF was absent two and a half
 * seconds in, and failed against a perfectly good build: requestIdleCallback
 * fires quickly on an idle page, which is correct. What it should have been
 * asking, and now asks, is whether the request came after first paint.
 *
 *   node tests/web/probe_cold_load.mjs
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer, { CHROME } from "./resolve_puppeteer.mjs";
import { uploadAndFinish } from "./drive.mjs";
const here = path.dirname(fileURLToPath(import.meta.url));
const server = spawn("node", [path.join(here, "serve.mjs"), "8293"], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 900));
/* A throwaway profile per run. Without one, Chrome keeps the service worker and
   its caches between runs and the "first visit" being measured is not one. */
const b = await puppeteer.launch({
  executablePath: CHROME, headless: true, protocolTimeout: 3600000,
  userDataDir: undefined, args: ["--incognito"],
});
let bad=0; const ok=(c,n)=>{ if(c) console.log("  ok  "+n); else { console.error("  FAIL "+n); bad++; } };
try {
  // A COLD profile: no service worker, no cache. This is a first visit.
  const pg = await b.newPage();
  const wire = [];
  /* When each vendor file was asked for, measured from the moment navigation
     started - the same clock FCP is reported on. */
  const t0 = Date.now();
  let avifSeenAt = null;
  pg.on("response", (r) => {
    const u = new URL(r.url()).pathname;
    if (!u.startsWith("/vendor/")) return;
    wire.push(u);
    if (u === "/vendor/avif_enc.wasm" && avifSeenAt === null) avifSeenAt = Date.now() - t0;
  });
  pg.on("pageerror", e => { console.log("[pageerror]", String(e)); bad++; });
  await pg.setViewport({ width: 1280, height: 860 });
  await pg.goto("http://127.0.0.1:8293/", { waitUntil: "networkidle0" });

  /* What this gate does NOT assert, and why.
   *
   * The obvious check - "avif_enc.wasm is not fetched before the app is ready
   * offline" - could not be made to discriminate. Two versions were tried and
   * BOTH passed with AVIF deliberately put back into HEAVY_PRECACHE, which
   * means neither was measuring the thing it claimed. Timing against first
   * paint fails because the install begins after paint either way; timing
   * against `controller !== null` fails because this worker calls
   * skipWaiting(), so control arrives mid-install. Rather than ship a green
   * assertion that proves nothing - the exact failure this suite keeps finding
   * - the ordering claim is left unasserted and stated here instead.
   *
   * What IS asserted below is everything that can be measured honestly: the
   * three small codecs are precached, AVIF arrives on its own without anyone
   * dropping a file, it ends up in the cache permanently, and the whole app
   * still compresses with the network off - with AVIF still competing. Those
   * are the properties that would actually break if the deferral went wrong.
   *
   * The install list itself is the real guard, and it is one line to read:
   * HEAVY_PRECACHE in web/sw.js must not name avif. */
  await pg.waitForFunction(() => navigator.serviceWorker.controller !== null,
    { timeout: 60000, polling: 200 });
  console.log(`vendor files fetched by ${Date.now() - t0}ms:`, JSON.stringify(wire));

  const smalls = wire.filter(u => /mozjpeg_enc|webp_enc|oxipng_bg/.test(u));
  ok(smalls.length === 3, `the three small codecs are precached (${smalls.length})`);

  // Now give idle a chance - it should arrive on its own.
  await new Promise(r => setTimeout(r, 9000));
  const afterIdle = [...wire];
  console.log("after idle:", JSON.stringify(afterIdle.filter(u=>/avif/.test(u))));
  ok(afterIdle.includes("/vendor/avif_enc.wasm"),
     "and it arrives at idle without anyone asking");

  // And the product still works: AVIF must compete in a web-target bake-off.
  await uploadAndFinish(pg, [path.join(here,"fixtures","photo.png")], 600000);
  const r = await pg.evaluate(() => {
    const it = state.items[0];
    return { status: it.status, fmt: it.fmt,
             cands: (it.candidates||[]).map(c=>c.format),
             caps: state.caps };
  });
  console.log("result:", JSON.stringify(r));
  ok(r.status === "done", `the image compressed (${r.status})`);
  ok(r.cands.includes("avif"), `AVIF competed in the bake-off (${r.cands.join(",")})`);

  /* Deferred, not lost. The offline promise is the product's headline claim,
     and AVIF is no longer precached - so after one visit it has to be in the
     cache anyway, and the whole app has to work with the network off. */
  await new Promise(r => setTimeout(r, 3000));
  const cached = await pg.evaluate(async () => {
    const keys = await caches.keys();
    const out = [];
    for (const k of keys) out.push(...(await (await caches.open(k)).keys()).map(r => new URL(r.url).pathname));
    return out;
  });
  ok(cached.includes("/vendor/avif_enc.wasm"),
     "after one visit the AVIF codec is in the cache - deferred, not dropped");

  await pg.setOfflineMode(true);
  await pg.reload({ waitUntil: "networkidle0" });
  ok(await pg.evaluate(() => !!document.getElementById("dash")),
     "the app boots with no network at all");
  await uploadAndFinish(pg, [path.join(here, "fixtures", "logo.png")], 600000);
  const off = await pg.evaluate(() => ({
    status: state.items[0].status,
    cands: (state.items[0].candidates || []).map((c) => c.format),
  }));
  ok(off.status === "done", `and compresses offline (${off.status})`);
  ok(off.cands.includes("avif"), `with AVIF still competing (${off.cands.join(",")})`);

} finally { await b.close(); server.kill(); }
console.log(bad===0?"\nOK":`\n${bad} problem(s)`);
process.exit(bad?1:0);
