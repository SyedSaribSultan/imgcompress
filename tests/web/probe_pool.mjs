/* How many workers a machine gets, and why.
 *
 * The pool is where this app spends the machine, and it is sized from two
 * signals the browser reports about itself. Neither is trustworthy in the
 * obvious way, which is the whole reason this gate exists rather than a
 * comment:
 *
 *   hardwareConcurrency is honest but is a CORE count, and the constraint here
 *   is memory - every worker holds a decoded frame, and a 12MP photograph is
 *   ~48MB of RGBA before a single candidate encode exists.
 *
 *   deviceMemory is CLAMPED at 8 by Chrome for fingerprinting reasons, so "8"
 *   means "8 or anything above", and Firefox and Safari do not implement it at
 *   all. Any branch that reads a high value as "this is a big machine" is
 *   reading a number that cannot mean that.
 *
 * So the sizing only ever moves DOWNWARD on a memory signal, and the ceiling
 * for everyone else is chosen against cores. This asserts that shape holds on
 * a low-memory device as well as an ordinary one - a case no developer machine
 * reaches on its own, and therefore one that had never been exercised.
 *
 *   node tests/web/probe_pool.mjs
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer, { CHROME } from "./resolve_puppeteer.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const server = spawn("node", [path.join(here, "serve.mjs"), "8307"], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 900));
const b = await puppeteer.launch({
  executablePath: CHROME, headless: true, protocolTimeout: 3_600_000,
});
let bad = 0;
const ok = (c, n) => { if (c) console.log(`  ok ${n}`); else { console.error(`FAIL ${n}`); bad++; } };

/** Boot the app with the machine pretending to be something else. */
async function planFor({ cores, memory }) {
  const pg = await b.newPage();
  /* Both signals are read at module scope, so they have to be in place before
     a single line of the app runs - hence evaluateOnNewDocument rather than a
     patch after load. */
  await pg.evaluateOnNewDocument((c, m) => {
    Object.defineProperty(navigator, "hardwareConcurrency", { get: () => c, configurable: true });
    if (m === null) {
      delete Object.getPrototypeOf(navigator).deviceMemory;
      Object.defineProperty(navigator, "deviceMemory", { get: () => undefined, configurable: true });
    } else {
      Object.defineProperty(navigator, "deviceMemory", { get: () => m, configurable: true });
    }
  }, cores, memory);
  await pg.goto("http://127.0.0.1:8307/", { waitUntil: "networkidle0" });
  const plan = await pg.evaluate(() => imgc.poolPlan());
  await pg.close();
  return plan;
}

try {
  console.log("=== an ordinary laptop: 8 cores, 8GB ===");
  const laptop = await planFor({ cores: 8, memory: 8 });
  console.log(" ", JSON.stringify(laptop));
  ok(laptop.max === 6, `cores minus two (${laptop.max})`);
  ok(laptop.ceiling === 12, `under the ordinary ceiling (${laptop.ceiling})`);

  console.log("\n=== a many-core machine: 16 cores, 8GB reported ===");
  const big = await planFor({ cores: 16, memory: 8 });
  console.log(" ", JSON.stringify(big));
  ok(big.max === 12,
     `the ceiling moved past the old hard 8, but not to 14 (${big.max})`);
  /* The point of the previous assertion: deviceMemory says 8 on this machine
     and would say 8 on a 64GB workstation too, so 12 is chosen against cores
     rather than believed from memory. */

  console.log("\n=== a small phone: 4 cores, 2GB ===");
  const phone = await planFor({ cores: 4, memory: 2 });
  console.log(" ", JSON.stringify(phone));
  ok(phone.ceiling === 4, `the low-memory ceiling applied (${phone.ceiling})`);
  ok(phone.max === 2, `and a starved machine still gets the floor of two (${phone.max})`);

  console.log("\n=== a big machine that reports no memory at all (Safari, Firefox) ===");
  const noMem = await planFor({ cores: 16, memory: null });
  console.log(" ", JSON.stringify(noMem));
  ok(noMem.ceiling === 12,
     `an absent signal takes the ordinary ceiling, not the small one (${noMem.ceiling})`);
  ok(noMem.max === 12, `so it is not punished for not answering (${noMem.max})`);

  console.log("\n=== a low-memory machine with many cores ===");
  const weird = await planFor({ cores: 16, memory: 4 });
  console.log(" ", JSON.stringify(weird));
  ok(weird.max === 4,
     `memory wins over cores, which is the direction that protects the tab (${weird.max})`);

  /* ---- warming the pool costs nothing only when the cache can serve it ----
   * Every worker compiles its own codecs, so warming just pool[0] leaves the
   * rest compiling on their first job. But warming them all on a FIRST visit
   * is a worse trade than the compile it avoids: workers created before the
   * service worker takes control are uncontrolled clients whose importScripts
   * fetches bypass the fetch handler, so six warmed workers meant twelve real
   * downloads of the same four files. Measured, not assumed - half the
   * responses reported fromServiceWorker false. */
  console.log("\n=== warming: first visit against a return visit ===");
  {
    /* A fresh browser context, because the five subtests above already
       installed the service worker in this one - a "first visit" measured
       after them is not one, and the check silently passed on 24 cached
       responses the first time it was written. */
    const ctx = await b.createBrowserContext();
    const pg = await ctx.newPage();
    let wire = 0, cached = 0;
    pg.on("response", (r) => {
      if (!/\/vendor\/.*\.wasm/.test(r.url())) return;
      wire++;
      if (r.fromServiceWorker()) cached++;
    });
    await pg.goto("http://127.0.0.1:8307/", { waitUntil: "networkidle0" });
    await new Promise((r) => setTimeout(r, 6000));
    const cold = { wire, cached, pool: await pg.evaluate(() => imgc.pool.length) };
    console.log("  first visit:", JSON.stringify(cold));
    ok(cold.pool === 1,
       `a first visit warms one worker, not the whole pool (${cold.pool})`);
    ok(cold.wire <= 4,
       `so each codec is downloaded once, not once per worker (${cold.wire})`);

    wire = 0; cached = 0;
    await pg.reload({ waitUntil: "networkidle0" });
    await new Promise((r) => setTimeout(r, 6000));
    const warm = { wire, cached, pool: await pg.evaluate(() => imgc.pool.length) };
    console.log("  return visit:", JSON.stringify(warm));
    ok(warm.pool > 1, `a return visit warms the whole pool (${warm.pool})`);
    ok(warm.wire > 0 && warm.cached === warm.wire,
       `and every byte of it comes from the cache (${warm.cached}/${warm.wire})`);
    await pg.close();
    await ctx.close();
  }

} finally { await b.close(); server.kill(); }

console.log(bad === 0 ? "\nOK — the pool is sized from what the machine says, cautiously"
                      : `\n${bad} problem(s)`);
process.exit(bad ? 1 : 0);
