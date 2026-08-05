/* Build the bench/ fixture set. Two files are the committed bench_corpus
 * sources (byte-identical, just renamed), two are committed here — the
 * snapshot gate compares exact output bytes, so fixture bytes must be exact. */
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const corpus = path.resolve(here, "..", "bench_corpus");
const out = path.join(here, "bench");
mkdirSync(out, { recursive: true });

const plan = [
  [path.join(corpus, "camera_12mp.jpg"), "camera-12mp.jpg"],
  [path.join(corpus, "screenshot_retina.png"), "screenshot-retina.png"],
  [path.join(here, "bench_fixtures", "product.png"), "product.png"],
  [path.join(here, "bench_fixtures", "logo-alpha.png"), "logo-alpha.png"],
];
for (const [src, name] of plan) copyFileSync(src, path.join(out, name));
console.log(`bench/ ready: ${plan.map(([, n]) => n).join(", ")}`);
