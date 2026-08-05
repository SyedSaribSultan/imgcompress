/* A realistic batch: the four fixtures repeated, so the corpus mixes one heavy
 * photograph with light UI art the way a real export folder does. */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, "bench");
const dst = path.join(here, "batch");
rmSync(dst, { recursive: true, force: true });
mkdirSync(dst, { recursive: true });

const files = readdirSync(src);
const COPIES = Number(process.argv[2] || 6);
let n = 0;
for (let c = 0; c < COPIES; c++) {
  for (const f of files) {
    const ext = path.extname(f);
    const base = path.basename(f, ext);
    writeFileSync(path.join(dst, `${base}-${c + 1}${ext}`), readFileSync(path.join(src, f)));
    n++;
  }
}
console.log(`${n} files in batch/`);
