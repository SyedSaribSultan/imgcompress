/* Gate: every --oz-* referenced by the app must be defined by the token layer,
 * and the app must not hand-type a colour. The design system's whole premise is
 * that values are computed upstream; a typo'd var() resolves to nothing and a
 * hardcoded hex silently leaves the engine. */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(here, "..", "..", "web");
const REPO = path.resolve(here, "..", "..");
const tokens = readFileSync(path.join(WEB, "heyoz-tokens.css"), "utf8");
const app = readFileSync(path.join(WEB, "app.css"), "utf8");
const html = readFileSync(path.join(WEB, "index.html"), "utf8");

/* The desktop app is one self-contained HTML file, and until it was brought
   under this gate it carried its own palette, its own corners and its own two
   transition shorthands - a second visual identity for the same product, and
   the half nobody was checking. Its <style> block is an app layer and is held
   to every rule below. */
const desktopHtml = readFileSync(
  path.join(REPO, "imgcompress", "webui", "app.html"), "utf8");
const desktop = (desktopHtml.match(/<style>([\s\S]*?)<\/style>/) || ["", ""])[1];
if (!desktop.trim()) {
  console.log("  DESKTOP could not read the <style> block out of webui/app.html");
}

const defined = new Set([...tokens.matchAll(/^\s*(--oz-[a-z0-9-]+)\s*:/gm)].map((m) => m[1]));
console.log(`token layer defines ${defined.size} --oz-* variables`);

let bad = 0;
for (const [file, src] of [["app.css", app], ["index.html", html],
                           ["webui/app.html", desktop]]) {
  const used = new Set([...src.matchAll(/var\((--oz-[a-z0-9-]+)/g)].map((m) => m[1]));
  const missing = [...used].filter((v) => !defined.has(v));
  console.log(`${file}: references ${used.size} tokens, ${missing.length} undefined`);
  for (const m of missing) { console.log(`  MISSING ${m}`); bad++; }
}

// Hardcoded colours in either app layer. The checkerboard aliases and the
// generated token file itself are exempt; everything else must be a token.
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "");
const appNoComments = strip(app);
const desktopNoComments = strip(desktop);
const APP_LAYERS = [["app.css", appNoComments], ["webui/app.html", desktopNoComments]];

for (const [file, src] of APP_LAYERS) {
  const hexes = [...src.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
  const funcs = [...src.matchAll(/\b(rgba?|hsla?)\(/g)].map((m) => m[0]);
  const beziers = [...src.matchAll(/cubic-bezier\(/g)].map((m) => m[0]);
  console.log(`${file} hardcoded: ${hexes.length} hex, ${funcs.length} rgb/hsl, ${beziers.length} cubic-bezier`);
  for (const h of [...hexes, ...funcs, ...beziers]) { console.log(`  LITERAL ${file}: ${h}`); bad++; }

  // Stale references to a pre-system palette, in either app.
  const legacy = [...src.matchAll(/var\((--(?:ink|surface|panel|raised|line|accent|ok|bad|checker|r-|t-|ui|mono)[a-z0-9-]*)\)/g)]
    .map((m) => m[1]).filter((v) => !v.startsWith("--checker"));
  for (const l of new Set(legacy)) { console.log(`  LEGACY ${file}: ${l}`); bad++; }
}

/* ---------------------------------------------------------------------------
   Motion. The system ships a closed set of durations and curves; the job here
   is to make it the only set. Two rules, and the second is the one that costs
   users something real.

   1. Every duration and easing in a transition or animation must come from a
      token. A hand-typed `250ms` is a value nobody can change centrally, and
      a hand-typed curve is a second opinion about how this product moves.

   2. Nothing may transition a layout property. width, height, top, left,
      margin and padding all force the browser to recompute layout on every
      frame; transform and opacity are composited and cannot. Three progress
      bars in this app animated `width` before this rule existed.

   The brief for this phase proposed adding --oz-motion-* and a second
   --oz-ease-exit. That is not done deliberately: the token layer already has
   --oz-duration-*, --oz-ease-* and the --oz-spring-* pairs, so a parallel set
   would be the duplication this whole exercise removes - and --oz-ease-exit
   already exists with a different curve, so redefining it would silently
   change every exit animation in the product.
   --------------------------------------------------------------------------- */

const LAYOUT_PROPS = ["width", "height", "top", "right", "bottom", "left",
                      "margin", "padding", "inset"];
let motionChecked = 0;

for (const [file, src] of APP_LAYERS) {
  for (const m of src.matchAll(/(transition|animation)\s*:\s*([^;{}]+);/g)) {
    const [, kind, value] = m;
    motionChecked++;
    if (/\bnone\b/.test(value)) continue;

    /* Scan only the parts that are NOT a token reference. Token names contain
       the very words being searched for - `--oz-ease-standard` ends in "ease",
       `--oz-spring-effects-fast-ms` ends in "ms" - so matching against the raw
       value reports the correct code as the violation. This was a live false
       positive, and a gate that cries wolf gets switched off. */
    const literalsOnly = value.replace(/var\(\s*--[a-z0-9-]+\s*(,[^)]*)?\)/g, " ");

    for (const lit of literalsOnly.matchAll(/(?<![\w-])(\d+(?:\.\d+)?m?s)(?![\w-])/g)) {
      console.log(`  MOTION ${file}: literal duration ${lit[1]} in ${kind} — use a token`);
      bad++;
    }
    for (const lit of literalsOnly.matchAll(/(?<![\w-])(ease-in-out|ease-in|ease-out|ease|linear|steps\()/g)) {
      console.log(`  MOTION ${file}: literal easing "${lit[1]}" in ${kind} — use a token`);
      bad++;
    }

    // A transitioned layout property. `transition: all` is the same crime with
    // a wider blast radius, since it sweeps up whatever gets added later.
    if (kind === "transition") {
      const first = value.trim().split(/[\s,]+/)[0];
      if (first === "all") {
        console.log(`  MOTION ${file}: "transition: all" — name the properties`);
        bad++;
      }
      for (const prop of LAYOUT_PROPS) {
        const hit = new RegExp(`(^|,)\\s*${prop}(\\s|$|,)`).test(value);
        if (hit) {
          console.log(`  MOTION ${file}: transitions "${prop}", which forces layout `
                      + `— animate transform or opacity instead`);
          bad++;
        }
      }
    }
  }
}
console.log(`motion: checked ${motionChecked} transition/animation declarations`);

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

/* The desktop layer was missing from this loop, so its `font-weight: 700` on
   the winning version's badge sat there passing. A ceiling checked in one of
   two app layers is a ceiling with a hole in it. */
for (const [file, src] of [["app.css", appNoComments], ["index.html", html],
                           ["webui/app.html", desktopNoComments]]) {
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
