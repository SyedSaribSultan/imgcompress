/* Gate: the DESKTOP app has no visual identity of its own.
 *
 * This used to cover both interfaces. It no longer can, because they no longer
 * share a design language: the browser app was reset to a baseline of system
 * faces and a six-name palette defined in web/css/base.css, and the --oz-* token
 * layer now serves only the desktop app. The browser app's equivalent rule -
 * base.css defines, every other sheet consumes - is enforced in
 * tests/test_design_system.py, which runs without Chrome and without Node.
 *
 * What is left here is the half that still has a token layer to be consistent
 * with. The desktop app is one self-contained HTML file, and before it was
 * brought under this gate it carried its own palette, its own corners and its own
 * two transition shorthands - a second visual identity for the same product, and
 * the half nobody was checking.
 *
 * The weight ceiling is checked here rather than in Python because it needs the
 * token *values*, the face declarations and the files on disk read together, and
 * a ceiling checked in one of three places is a ceiling with two holes in it.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(here, "..", "..", "web");
const REPO = path.resolve(here, "..", "..");

const tokens = readFileSync(path.join(WEB, "heyoz-tokens.css"), "utf8");
const desktopHtml = readFileSync(
  path.join(REPO, "pocketsize", "webui", "app.html"), "utf8");
const desktop = (desktopHtml.match(/<style>([\s\S]*?)<\/style>/) || ["", ""])[1];

let bad = 0;
if (!desktop.trim()) {
  console.log("  DESKTOP could not read the <style> block out of webui/app.html");
  bad++;
}

const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "");
const desktopNoComments = strip(desktop);

/* ---------------------------- every token resolves ------------------------ */

const defined = new Set([...tokens.matchAll(/^\s*(--oz-[a-z0-9-]+)\s*:/gm)].map((m) => m[1]));
console.log(`token layer defines ${defined.size} --oz-* variables`);

{
  const used = new Set([...desktopHtml.matchAll(/var\((--oz-[a-z0-9-]+)/g)].map((m) => m[1]));
  const missing = [...used].filter((v) => !defined.has(v));
  console.log(`webui/app.html: references ${used.size} tokens, ${missing.length} undefined`);
  if (!used.size) { console.log("  the desktop app references no tokens at all"); bad++; }
  for (const m of missing) { console.log(`  MISSING ${m}`); bad++; }
}

/* ------------------------------ no literals ------------------------------- */

{
  const hexes = [...desktopNoComments.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
  const funcs = [...desktopNoComments.matchAll(/\b(rgba?|hsla?)\(/g)].map((m) => m[0]);
  const beziers = [...desktopNoComments.matchAll(/cubic-bezier\(/g)].map((m) => m[0]);
  console.log(`webui/app.html hardcoded: ${hexes.length} hex, ${funcs.length} rgb/hsl, `
              + `${beziers.length} cubic-bezier`);
  for (const h of [...hexes, ...funcs, ...beziers]) {
    console.log(`  LITERAL webui/app.html: ${h}`); bad++;
  }

  // Stale references to the pre-system palette the desktop app used to own.
  const legacy = [...desktopNoComments.matchAll(
    /var\((--(?:ink|surface|panel|raised|line|accent|ok|bad|checker|r-|t-|ui|mono)[a-z0-9-]*)\)/g)]
    .map((m) => m[1]).filter((v) => !v.startsWith("--checker"));
  for (const l of new Set(legacy)) { console.log(`  LEGACY webui/app.html: ${l}`); bad++; }
}

/* --------------------------------- motion --------------------------------- */

/* Two rules. The first is about consistency - the system ships a closed set of
   durations and curves, and the job is to make it the only set. The second costs
   users something real: width, height, top, left, margin and padding all force
   the browser to recompute layout on every frame, where transform and opacity are
   composited and cannot. Three progress bars animated `width` before it existed. */

const LAYOUT_PROPS = ["width", "height", "top", "right", "bottom", "left",
                      "margin", "padding", "inset"];
let motionChecked = 0;

for (const m of desktopNoComments.matchAll(/(transition|animation)\s*:\s*([^;{}]+);/g)) {
  const [, kind, value] = m;
  motionChecked++;
  if (/\bnone\b/.test(value)) continue;

  /* Scan only the parts that are NOT a token reference. Token names contain the
     very words being searched for - `--oz-ease-standard` ends in "ease",
     `--oz-spring-effects-fast-ms` ends in "ms" - so matching the raw value reports
     the correct code as the violation. This was a live false positive, and a gate
     that cries wolf gets switched off. */
  const literalsOnly = value.replace(/var\(\s*--[a-z0-9-]+\s*(,[^)]*)?\)/g, " ");

  for (const lit of literalsOnly.matchAll(/(?<![\w-])(\d+(?:\.\d+)?m?s)(?![\w-])/g)) {
    console.log(`  MOTION literal duration ${lit[1]} in ${kind} — use a token`); bad++;
  }
  for (const lit of literalsOnly.matchAll(
    /(?<![\w-])(ease-in-out|ease-in|ease-out|ease|linear|steps\()/g)) {
    console.log(`  MOTION literal easing "${lit[1]}" in ${kind} — use a token`); bad++;
  }

  if (kind === "transition") {
    if (value.trim().split(/[\s,]+/)[0] === "all") {
      console.log('  MOTION "transition: all" — name the properties'); bad++;
    }
    for (const prop of LAYOUT_PROPS) {
      if (new RegExp(`(^|,)\\s*${prop}(\\s|$|,)`).test(value)) {
        console.log(`  MOTION transitions "${prop}", which forces layout `
                    + `— animate transform or opacity instead`); bad++;
      }
    }
  }
}
console.log(`motion: checked ${motionChecked} transition/animation declarations`);

/* ----------------------------- weight ceiling ----------------------------- */

/* Nothing may render above semibold, in any instance. Three ways that could be
   broken, so all three are checked: a numeric font-weight over 600, a reference
   to a token whose value exceeds 600, and a self-hosted face whose variable range
   reaches past it. */
const CEILING = 600;

const tokenWeights = new Map(
  [...tokens.matchAll(/^\s*(--oz-(?:weight|default-weight)-[a-z]+)\s*:\s*(\d+)/gm)]
    .map((m) => [m[1], Number(m[2])]));

for (const m of desktopNoComments.matchAll(/font-weight\s*:\s*(\d{3})\b/g)) {
  if (Number(m[1]) > CEILING) {
    console.log(`  WEIGHT webui/app.html: literal ${m[1]} > ${CEILING}`); bad++;
  }
}
for (const m of desktopHtml.matchAll(/var\((--oz-(?:weight|default-weight)-[a-z]+)\)/g)) {
  const v = tokenWeights.get(m[1]);
  if (v > CEILING) {
    console.log(`  WEIGHT webui/app.html: ${m[1]} is ${v} > ${CEILING}`); bad++;
  }
}

const fontsCss = readFileSync(path.join(WEB, "fonts.css"), "utf8");
for (const m of fontsCss.matchAll(/font-weight\s*:\s*(\d{3})(?:\s+(\d{3}))?/g)) {
  const top = Number(m[2] || m[1]);
  if (top > CEILING) {
    console.log(`  WEIGHT fonts.css: face range tops at ${top} > ${CEILING}`); bad++;
  }
}
const faces = [...fontsCss.matchAll(/url\('\/fonts\/([^']+)'\)/g)].map((m) => m[1]);
console.log(`weight ceiling ${CEILING}: checked ${tokenWeights.size} tokens, `
            + `${faces.length} self-hosted faces`);

// Every declared face must actually exist on disk, or text silently falls back.
for (const f of new Set(faces)) {
  try { readFileSync(path.join(WEB, "fonts", f)); }
  catch { console.log(`  MISSING FONT ${f}`); bad++; }
}

console.log(bad === 0
  ? "\nOK — desktop app fully tokenised, no weight above 600"
  : `\n${bad} problem(s)`);
process.exit(bad ? 1 : 0);
