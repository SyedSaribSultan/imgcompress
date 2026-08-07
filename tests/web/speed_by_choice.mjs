/* What each Format choice actually costs, measured in the app, on the real
 * corpus. Answers the only question that matters to someone waiting: "how
 * much faster is it if I just pick one format?"
 *
 * Uses the app's own per-image clock. Run it on an idle machine - timings
 * taken under load are fiction.
 *
 *   node tests/web/speed_by_choice.mjs
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer, { CHROME } from "./resolve_puppeteer.mjs";
import { uploadAndFinish } from "./drive.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const REF = path.resolve(here, "..", "bench_ref");
const IMAGES = [
  ["photo, 1.0 MP", path.join(REF, "photo.png")],
  ["camera, 4.9 MP", path.join(REF, "camera_12mp.png")],
];
const CHOICES = [
  ["Automatic — design tools", "figma"],
  ["Automatic — web", "web"],
  ["JPEG only", "one-jpeg"],
  ["WebP only", "one-webp"],
  ["AVIF only", "one-avif"],
];

for (const [, f] of IMAGES) {
  if (!existsSync(f)) { console.error(`missing ${f} — run tests/bench_vs_alternatives.py first`); process.exit(2); }
}

const server = spawn("node", [path.join(here, "serve.mjs"), "8189"], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 900));
const b = await puppeteer.launch({
  executablePath: CHROME, headless: true, protocolTimeout: 3_600_000,
});
const rows = [];
try {
  for (const [imgLabel, file] of IMAGES) {
    const pg = await b.newPage();
    pg.on("pageerror", (e) => console.error("[pageerror]", String(e)));
    await pg.goto("http://127.0.0.1:8189/", { waitUntil: "networkidle0" });
    // No second resize: the corpus is already normalised, and a resize would
    // mean each choice was compressing different pixels.
    await pg.evaluate(() => {
      const md = document.getElementById("maxdim");
      md.value = "0"; md.dispatchEvent(new Event("change"));
    });
    await new Promise((r) => setTimeout(r, 500));

    // First run also pays for codec load; the measured rows come after it.
    await uploadAndFinish(pg, [file], 900_000);

    for (const [label, value] of CHOICES) {
      const before = await pg.evaluate(() => state.settingsRev);
      await pg.select("#target", value);
      await pg.waitForFunction((rev) => state.settingsRev > rev &&
        ["done", "failed", "saved"].includes(state.items[0].status),
        { timeout: 900000, polling: 250 }, before);
      const r = await pg.evaluate(() => {
        const it = state.items[0];
        return { ms: it.elapsedMs, fmt: it.fmt, bytes: it.newBytes,
                 score: it.score, lossless: it.lossless,
                 cands: (it.candidates || []).length };
      });
      rows.push({ img: imgLabel, choice: label, ...r });
      console.log(`  ${imgLabel.padEnd(15)} ${label.padEnd(26)} ` +
        `${(r.ms / 1000).toFixed(1).padStart(6)}s  ${String(r.fmt).padEnd(14)} ` +
        `${String(r.bytes).padStart(8)} B  ${r.cands} candidate${r.cands === 1 ? "" : "s"}  ` +
        `${r.lossless ? "lossless" : "ss2 " + (r.score ?? 0).toFixed(1)}`);
    }
    await pg.close();
  }
} finally { await b.close(); server.kill(); }

console.log("\n=== how much the choice buys ===");
for (const [imgLabel] of IMAGES) {
  const mine = rows.filter((r) => r.img === imgLabel);
  const auto = mine.find((r) => r.choice === "Automatic — design tools");
  console.log(`\n${imgLabel} — automatic (design tools) takes ${(auto.ms / 1000).toFixed(1)}s`);
  for (const r of mine) {
    if (r === auto) continue;
    const x = auto.ms / r.ms;
    const bigger = auto.bytes ? (100 * (r.bytes - auto.bytes) / auto.bytes) : 0;
    console.log(`  ${r.choice.padEnd(26)} ${(r.ms / 1000).toFixed(1).padStart(6)}s  ` +
      `${x >= 1 ? `${x.toFixed(1)}x faster` : `${(1 / x).toFixed(1)}x slower`}` +
      `   file ${bigger >= 0 ? "+" : ""}${bigger.toFixed(0)}% vs automatic`);
  }
}
