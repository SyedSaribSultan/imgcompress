/* Gate: every --oz-* referenced by the app must be defined by the token layer,
 * and the app must not hand-type a colour. The design system's whole premise is
 * that values are computed upstream; a typo'd var() resolves to nothing and a
 * hardcoded hex silently leaves the engine. */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(here, "..", "..", "web");
const tokens = readFileSync(path.join(WEB, "heyoz-tokens.css"), "utf8");
const app = readFileSync(path.join(WEB, "app.css"), "utf8");
const html = readFileSync(path.join(WEB, "index.html"), "utf8");

const defined = new Set([...tokens.matchAll(/^\s*(--oz-[a-z0-9-]+)\s*:/gm)].map((m) => m[1]));
console.log(`token layer defines ${defined.size} --oz-* variables`);

let bad = 0;
for (const [file, src] of [["app.css", app], ["index.html", html]]) {
  const used = new Set([...src.matchAll(/var\((--oz-[a-z0-9-]+)/g)].map((m) => m[1]));
  const missing = [...used].filter((v) => !defined.has(v));
  console.log(`${file}: references ${used.size} tokens, ${missing.length} undefined`);
  for (const m of missing) { console.log(`  MISSING ${m}`); bad++; }
}

// Hardcoded colours in the app layer. The checkerboard aliases and the
// generated token file itself are exempt; everything else must be a token.
const appNoComments = app.replace(/\/\*[\s\S]*?\*\//g, "");
const hexes = [...appNoComments.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
const funcs = [...appNoComments.matchAll(/\b(rgba?|hsla?)\(/g)].map((m) => m[0]);
const beziers = [...appNoComments.matchAll(/cubic-bezier\(/g)].map((m) => m[0]);
console.log(`app.css hardcoded: ${hexes.length} hex, ${funcs.length} rgb/hsl, ${beziers.length} cubic-bezier`);
for (const h of [...hexes, ...funcs, ...beziers]) { console.log(`  LITERAL ${h}`); bad++; }

// Stale references to the pre-migration palette.
const legacy = [...appNoComments.matchAll(/var\((--(?:ink|surface|panel|raised|line|accent|ok|bad|checker|r-|t-|ui|mono)[a-z0-9-]*)\)/g)]
  .map((m) => m[1]).filter((v) => !v.startsWith("--checker"));
for (const l of new Set(legacy)) { console.log(`  LEGACY ${l}`); bad++; }

/* ---------------------------------------------------------------------------
   Weight ceiling: nothing in this app may render above semibold (600), in any
   instance. Three ways that could be broken, so all three are checked:
   a numeric font-weight over 600, a reference to a token whose value exceeds
   600, and a self-hosted face whose variable range reaches past it.
   --------------------------------------------------------------------------- */
const CEILING = 600;

const tokenWeights = new Map(
  [...tokens.matchAll(/^\s*(--oz-(?:weight|default-weight)-[a-z]+)\s*:\s*(\d+)/gm)]
    .map((m) => [m[1], Number(m[2])]));

for (const [file, src] of [["app.css", appNoComments], ["index.html", html]]) {
  for (const m of src.matchAll(/font-weight\s*:\s*(\d{3})\b/g)) {
    if (Number(m[1]) > CEILING) { console.log(`  WEIGHT ${file}: literal ${m[1]} > ${CEILING}`); bad++; }
  }
  for (const m of src.matchAll(/var\((--oz-(?:weight|default-weight)-[a-z]+)\)/g)) {
    const v = tokenWeights.get(m[1]);
    if (v > CEILING) { console.log(`  WEIGHT ${file}: ${m[1]} is ${v} > ${CEILING}`); bad++; }
  }
}

const fontsCss = readFileSync(path.join(WEB, "fonts.css"), "utf8");
for (const m of fontsCss.matchAll(/font-weight\s*:\s*(\d{3})(?:\s+(\d{3}))?/g)) {
  const top = Number(m[2] || m[1]);
  if (top > CEILING) { console.log(`  WEIGHT fonts.css: face range tops at ${top} > ${CEILING}`); bad++; }
}
const faces = [...fontsCss.matchAll(/url\('\/fonts\/([^']+)'\)/g)].map((m) => m[1]);
console.log(`weight ceiling ${CEILING}: checked ${tokenWeights.size} tokens, ${faces.length} self-hosted faces`);

// Every declared face must actually exist on disk, or text silently falls back.
for (const f of new Set(faces)) {
  try { readFileSync(path.join(WEB, "fonts", f)); }
  catch { console.log(`  MISSING FONT ${f}`); bad++; }
}

console.log(bad === 0 ? "\nOK — fully tokenised, no weight above 600" : `\n${bad} problem(s)`);
process.exit(bad ? 1 : 0);
