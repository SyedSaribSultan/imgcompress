/* The size cap, in a real browser.
 *
 * The engine grew a second search: instead of the smallest file that clears a
 * quality floor, the best quality that fits under a byte ceiling. It is the
 * same bisection over the same ladder read in the other direction, and the
 * Python side has unit tests for it - but the browser port carries three extra
 * pieces that only exist here, and each was a plausible wrong answer:
 *
 *   - the chroma gate escalates a candidate up its ladder, which grows the file
 *   - the oxipng pass re-picks the winner by byte count, which under a cap
 *     would take the win from a better-looking candidate they both fit inside
 *   - the post-rejection re-pick had the same assumption
 *
 * None of that is reachable from a unit test, and none of it is reachable from
 * the other probes, which never set a cap. So: set one, and check the two
 * things the mode promises - the file fits, and a looser cap buys quality.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer, { CHROME } from "./resolve_puppeteer.mjs";
import { uploadAndFinish } from "./drive.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(here, "fixtures");
const PORT = 8193;
const server = spawn("node", [path.join(here, "serve.mjs"), String(PORT)], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 900));
const b = await puppeteer.launch({
  executablePath: CHROME, headless: true, protocolTimeout: 3_600_000,
});
let bad = 0;
const ok = (c, n) => { if (c) console.log(`  ok ${n}`); else { console.error(`FAIL ${n}`); bad++; } };

/* Set a cap through the controls rather than by poking state, so the plan
   sentence is on the hook for carrying it too. */
async function setCap(pg, text) {
  await pg.evaluate((t) => {
    const goal = document.getElementById("plan-goal");
    goal.value = t === null ? "small" : "cap";
    goal.dispatchEvent(new Event("change"));
    if (t !== null) {
      const cap = document.getElementById("plan-cap");
      cap.value = t;
      cap.dispatchEvent(new Event("change"));
    }
  }, text);
  await pg.waitForFunction(
    (want) => state.settings.sizeTarget === want,
    { timeout: 20_000, polling: 100 },
    text === null ? 0 : undefined,
  ).catch(() => {});
  await new Promise((r) => setTimeout(r, 500));
}

async function rerunWith(pg, fn) {
  const rev = await pg.evaluate(() => state.settingsRev);
  await fn();
  await pg.waitForFunction((r) => state.settingsRev > r &&
    state.items.every((i) => ["done", "failed", "saved"].includes(i.status)),
    { timeout: 900_000, polling: 300 }, rev);
}

try {
  const pg = await b.newPage();
  await pg.setViewport({ width: 1440, height: 940 });
  const errs = [];
  pg.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
  pg.on("pageerror", (e) => errs.push(String(e)));
  await pg.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "networkidle0" });
  await pg.waitForFunction(() => typeof state !== "undefined");

  // No resizing: a cap is about bytes, and letting the frame move too would
  // make it impossible to say which lever produced the result.
  await pg.evaluate(() => {
    const fit = document.getElementById("plan-fit");
    fit.value = "none";
    fit.dispatchEvent(new Event("change"));
  });

  await uploadAndFinish(pg, [path.join(FIX, "photo.png")], 900_000);
  const free = await pg.evaluate(() => {
    const it = state.items[0];
    return { bytes: it.newBytes, score: it.score, fmt: it.fmt };
  });
  console.log("  uncapped:", JSON.stringify(free));

  // ---- a reachable cap ----------------------------------------------------
  const cap = Math.round(free.bytes * 1.8);
  await rerunWith(pg, () => setCap(pg, `${cap} B`));
  const under = await pg.evaluate(() => {
    const it = state.items[0];
    return { bytes: it.newBytes, score: it.score, fmt: it.fmt,
             missed: !!it.missedSize, target: it.sizeTarget };
  });
  console.log("  under a loose cap:", JSON.stringify(under), "cap was", cap);
  ok(under.bytes <= cap, `the result fits the cap (${under.bytes} <= ${cap})`);
  ok(!under.missed, "and is not reported as a miss");
  ok(under.score > free.score,
     `room under the cap is spent on quality (${under.score} > ${free.score})`);

  // ---- a tighter cap costs quality ---------------------------------------
  const tight = Math.round(free.bytes * 0.5);
  await rerunWith(pg, () => setCap(pg, `${tight} B`));
  const squeezed = await pg.evaluate(() => {
    const it = state.items[0];
    return { bytes: it.newBytes, score: it.score, missed: !!it.missedSize };
  });
  console.log("  under a tight cap:", JSON.stringify(squeezed), "cap was", tight);
  if (squeezed.missed) {
    ok(true, "the tight cap was unreachable and said so (not a failure of the mode)");
  } else {
    ok(squeezed.bytes <= tight, `the tight result fits too (${squeezed.bytes} <= ${tight})`);
    ok(squeezed.score < under.score,
       `and costs quality against the looser cap (${squeezed.score} < ${under.score})`);
  }

  // ---- an impossible cap misses out loud, it does not wreck the image -----
  await rerunWith(pg, () => setCap(pg, "2 KB"));
  const missed = await pg.evaluate(() => {
    const it = state.items[0];
    return { bytes: it.newBytes, score: it.score, missed: !!it.missedSize,
             warnings: it.warnings || [],
             flagged: !document.getElementById("s-warn").hidden
                      && document.getElementById("s-warn").classList.contains("missed") };
  });
  console.log("  under an impossible cap:", JSON.stringify(missed));
  ok(missed.missed, "an unreachable cap is reported as missed");
  ok(missed.bytes > 2048, "and ships the honest file rather than one that fits by being ruined");
  ok(missed.warnings.some((w) => /couldn't fit/i.test(w)),
     `and says so in words (${JSON.stringify(missed.warnings)})`);

  // ---- and it goes back --------------------------------------------------
  await rerunWith(pg, () => setCap(pg, null));
  const back = await pg.evaluate(() => ({
    bytes: state.items[0].newBytes, target: state.settings.sizeTarget,
    missed: !!state.items[0].missedSize,
  }));
  ok(back.target === 0 && !back.missed && back.bytes === free.bytes,
     `clearing the cap restores the ordinary search (${JSON.stringify(back)})`);

  ok(errs.length === 0, `the console stayed clean (${JSON.stringify(errs.slice(0, 3))})`);
} finally {
  await b.close().catch(() => {});
  server.kill();
}

console.log(bad ? `\n${bad} failed` : "\nall good");
process.exit(bad ? 1 : 0);
