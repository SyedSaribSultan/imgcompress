/* Validate the JS SSIMULACRA 2 port against the Python reference's scores. */

import { readFileSync } from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const VEC = path.join(here, "ss2_vectors");

vm.runInThisContext(
  readFileSync(path.resolve(here, "..", "..", "web", "ss2.js"), "utf8"),
  { filename: "ss2.js" });

const vectors = JSON.parse(readFileSync(path.join(VEC, "vectors.json"), "utf8"));

const toRGBA = (rgb) => {
  const n = rgb.length / 3;
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    out[i * 4] = rgb[i * 3];
    out[i * 4 + 1] = rgb[i * 3 + 1];
    out[i * 4 + 2] = rgb[i * 3 + 2];
    out[i * 4 + 3] = 255;
  }
  return out;
};

let worst = 0, worstName = "", sumAbs = 0, failures = 0;
const TOL = 0.25;   // quarter of a point on a 100-point scale

for (const v of vectors) {
  const ref = toRGBA(new Uint8Array(readFileSync(path.join(VEC, v.ref + ".rgb"))));
  const dist = toRGBA(new Uint8Array(readFileSync(path.join(VEC, v.dist + ".rgb"))));
  const t0 = performance.now();
  const got = ss2Score(ref, dist, v.w, v.h, null);
  const ms = performance.now() - t0;
  const diff = Math.abs(got - v.score);
  sumAbs += diff;
  if (diff > worst) { worst = diff; worstName = v.dist; }
  const bad = diff > TOL;
  if (bad) failures++;
  console.log(`${bad ? "FAIL" : "  ok"} ${v.dist.padEnd(24)} py ${v.score.toFixed(3).padStart(8)}  ` +
              `js ${got.toFixed(3).padStart(8)}  Δ ${diff.toFixed(4)}  ${ms.toFixed(0)}ms`);
}

console.log(`\nmean |Δ| ${(sumAbs / vectors.length).toFixed(4)} · worst |Δ| ${worst.toFixed(4)} (${worstName}) · tolerance ${TOL}`);
console.log(failures === 0 ? "VALIDATED — the JS port matches the reference" : `${failures} pair(s) out of tolerance`);
process.exit(failures ? 1 : 0);
