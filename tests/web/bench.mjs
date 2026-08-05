/* Benchmark + correctness snapshot for the web engine.
 *
 * Reports wall-clock and the worker's own phase breakdown, and writes the
 * chosen format / bytes / score for every fixture to a JSON snapshot. The
 * snapshot is the no-compromise gate: an optimisation may move the timings, it
 * may not move the results.
 *
 *   node tests/web/setup_bench.mjs            # once, to build bench/
 *   node tests/web/bench.mjs <label>          # gate against snap-figma.json
 *   BENCH_TARGET=web node tests/web/bench.mjs <label>
 *   BENCH_DIR=batch SNAP=batch node tests/web/bench.mjs <label>
 *   BENCH_WRITE=1 ...                         # rewrite a snapshot on purpose
 */

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer, { CHROME } from "./resolve_puppeteer.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const BENCH = path.join(here, process.env.BENCH_DIR || "bench");
const label = process.argv[2] || "run";
const target = process.env.BENCH_TARGET || "figma";

if (!existsSync(BENCH)) {
  console.error(`${BENCH} missing — run: node tests/web/setup_bench.mjs`);
  process.exit(2);
}

const server = spawn("node", [path.join(here, "serve.mjs"), "8171"], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 900));
const b = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--no-first-run"],
  protocolTimeout: 3_600_000,
});
try {
  const pg = await b.newPage();
  await pg.setViewport({ width: 1600, height: 1000 });
  pg.on("pageerror", (e) => console.log("[pageerror]", String(e)));
  await pg.goto("http://127.0.0.1:8171/", { waitUntil: "networkidle0" });
  if (target !== "figma") {
    await pg.select("#target", target);
    await pg.evaluate(() => document.getElementById("target").dispatchEvent(new Event("change")));
    await new Promise((r) => setTimeout(r, 500));
  }
  // Warm the codecs first so the measurement is steady-state, not first-load.
  await pg.evaluate(() => addSamples());
  await pg.waitForFunction(() => state.items.length === 2 &&
    state.items.every((i) => ["done", "saved", "failed"].includes(i.status)), { timeout: 300000 });
  await pg.evaluate(() => { document.getElementById("clear-btn").click(); });
  await new Promise((r) => setTimeout(r, 300));

  const files = readdirSync(BENCH).map((f) => path.join(BENCH, f));
  await pg.evaluate(() => { window.__perf = {}; });
  await pg.exposeFunction("__note", () => {});

  const t0 = Date.now();
  const input = await pg.$("#file-input");
  await input.uploadFile(...files);
  await pg.waitForFunction(
    (n) => state.items.length === n &&
      state.items.every((i) => ["done", "saved", "failed"].includes(i.status)),
    { timeout: 900000, polling: 250 }, files.length);
  const wall = Date.now() - t0;

  const rows = await pg.evaluate(() => state.items.map((i) => ({
    name: i.name, status: i.status, fmt: i.fmt, level: i.level,
    score: i.score == null ? null : +i.score.toFixed(4),
    lossless: !!i.lossless, passthrough: !!i.passthrough,
    originalBytes: i.originalBytes, newBytes: i.newBytes,
    candidates: (i.candidates || []).map((c) => `${c.format}:${c.bytes}`).sort(),
    perf: i.perf || null,
  })));

  const pool = await pg.evaluate(() => ({
    poolSize: typeof pool !== "undefined" ? pool.length : null,
    cores: navigator.hardwareConcurrency,
  }));

  const sum = (k) => rows.reduce((s, r) => s + ((r.perf && r.perf[k]) || 0), 0);
  const phases = ["decode", "encode", "back", "ssimTiled", "ssimFull", "ssimChroma",
                  "quantize", "pngWrite", "oxipng",
                  "enc:jpeg", "enc:png8", "enc:png", "enc:webp", "enc:avif"];
  const cpu = {};
  for (const p of phases) cpu[p] = Math.round(sum(p));
  cpu.probes = sum("probes"); cpu.encodes = sum("encodes");

  console.log(`\n=== ${label} · target=${target} · wall ${(wall / 1000).toFixed(2)}s · ` +
              `pool ${pool.poolSize}/${pool.cores} cores ===`);
  for (const r of rows) {
    console.log(`  ${r.name.padEnd(24)} ${String(r.fmt).padEnd(6)} ` +
      `${String(r.originalBytes).padStart(9)} -> ${String(r.newBytes).padStart(8)}  ` +
      `${r.lossless ? "lossless" : r.score}`);
  }
  console.log("  worker CPU by phase (ms, summed across workers):");
  // enc:* are a breakdown *inside* encode, so they must not be double-counted.
  const total = phases.filter((p) => !p.startsWith("enc:")).reduce((s, p) => s + cpu[p], 0);
  for (const p of phases) {
    if (!cpu[p]) continue;
    console.log(`    ${p.padEnd(11)} ${String(cpu[p]).padStart(7)}  ${(100 * cpu[p] / total).toFixed(1)}%`);
  }
  console.log(`    ${"TOTAL".padEnd(11)} ${String(total).padStart(7)}   (${cpu.probes} probes, ${cpu.encodes} final encodes)`);

  // Deterministic work counts. Unlike times these do not move with the CPU's
  // thermal mood, so they are what actually proves an algorithmic change.
  const counts = {};
  for (const r of rows) {
    for (const [k, v] of Object.entries(r.perf || {})) {
      if (k.startsWith("n:")) counts[k.slice(2)] = (counts[k.slice(2)] || 0) + v;
    }
  }
  console.log("  operation counts (deterministic):");
  for (const k of Object.keys(counts).sort()) console.log(`    ${k.padEnd(11)} ${counts[k]}`);
  writeFileSync(path.join(here, `counts-${label}-${target}.json`), JSON.stringify(counts, null, 1));

  // correctness snapshot
  const snapName = `snap-${process.env.SNAP || target}.json`;
  const snapPath = path.join(here, snapName);
  const snap = rows.map(({ name, fmt, level, score, lossless, passthrough, originalBytes, newBytes, candidates }) =>
    ({ name, fmt, level, score, lossless, passthrough, originalBytes, newBytes, candidates }));
  let regressed = false;
  if (existsSync(snapPath) && process.env.BENCH_WRITE !== "1") {
    const prev = JSON.parse(readFileSync(snapPath, "utf8"));
    let diffs = 0;
    for (const now of snap) {
      const was = prev.find((p) => p.name === now.name);
      if (!was) { console.log(`  NEW ${now.name}`); diffs++; continue; }
      for (const k of ["fmt", "level", "lossless", "passthrough", "newBytes"]) {
        if (JSON.stringify(was[k]) !== JSON.stringify(now[k])) {
          console.log(`  CHANGED ${now.name}.${k}: ${was[k]} -> ${now[k]}`); diffs++;
        }
      }
      if (was.score !== now.score && Math.abs((was.score ?? 0) - (now.score ?? 0)) > 0.0005) {
        console.log(`  CHANGED ${now.name}.score: ${was.score} -> ${now.score}`); diffs++;
      }
      if (JSON.stringify(was.candidates) !== JSON.stringify(now.candidates)) {
        console.log(`  CANDIDATES ${now.name}:\n    was ${was.candidates}\n    now ${now.candidates}`);
      }
    }
    regressed = diffs > 0;
    console.log(diffs === 0
      ? "  ✓ results identical to the snapshot — speed changed, output did not"
      : `  ✗ ${diffs} result difference(s) — this is a quality/size regression`);
  } else {
    writeFileSync(snapPath, JSON.stringify(snap, null, 1));
    console.log(`  snapshot written to ${snapName}`);
  }
  writeFileSync(path.join(here, `bench-${label}-${target}.json`),
    JSON.stringify({ label, target, wall, pool, cpu, rows }, null, 1));
  if (regressed) process.exitCode = 1;
} finally { await b.close(); server.kill(); }
