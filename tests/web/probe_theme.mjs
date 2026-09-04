/* Both colour schemes, and proof that every surface actually changes with them.
 *
 * REWRITTEN for the reset UI. This used to verify the `--app-*` scale resolved to
 * real lengths, that controls shared a height across the design system, that the
 * inline plan sentence's selects were sized to their own words, and that the theme
 * button cycled dark/light/auto. All four of those subjects are gone: the browser
 * app no longer reads the --oz- and --app- token layer (that now serves only the
 * desktop app, and tests/web/verify_tokens.mjs checks it there), the plan is
 * labelled fields rather than a measured sentence, and there is no theme button -
 * the page follows the reader's own setting.
 *
 * What survives is the part that was never about the token layer: in each scheme,
 * is anything unreadable, and does the page actually respond to the setting at all.
 * The second question is the one worth asking mechanically. A palette defined only
 * inside a `prefers-color-scheme: dark` block leaves light mode falling back to
 * whatever the browser does, and a page that ignores the media query entirely looks
 * fine in whichever scheme the developer happens to use.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer, { CHROME } from "./resolve_puppeteer.mjs";
import { uploadAndFinish } from "./drive.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(here, "fixtures");
const server = spawn("node", [path.join(here, "serve.mjs"), "8196"], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 900));
const b = await puppeteer.launch({
  executablePath: CHROME, headless: true, protocolTimeout: 3_600_000,
});
let bad = 0;
const ok = (c, n) => { if (c) console.log(`  ok ${n}`); else { console.error(`FAIL ${n}`); bad++; } };

/** sRGB relative luminance, for a contrast ratio that means something. */
function luminance(rgb) {
  const [r, g, b_] = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b_;
}
function contrast(a, b_) {
  const la = luminance(a), lb = luminance(b_);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
const parse = (css) => {
  const m = String(css).match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const parts = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
  return parts.slice(0, 3);
};

/* Text that has to be legible, and the surface each sits on. Body text is held to
   4.5:1 and the quiet metadata to 3:1 - it is small-but-secondary, and holding it
   to the body ratio would mean it could not be quiet at all. */
const TEXT_TARGETS = [
  { sel: "#plan-h", min: 3, what: "a region heading" },
  { sel: '#plan-fields label[for="target"]', min: 4.5, what: "a field label" },
  { sel: "#quality-note", min: 3, what: "the plan's summary" },
  { sel: "#queue-list .row .name", min: 4.5, what: "a filename in the list" },
  { sel: "#queue-list .row .sub", min: 3, what: "a row's result line" },
  { sel: "#out-name", min: 4.5, what: "the export name" },
  { sel: "#s-size", min: 4.5, what: "the result's size" },
  { sel: "#s-saved", min: 3, what: "what the picture became" },
  { sel: "#queue-foot #t-sizes", min: 4.5, what: "the run's before and after" },
  { sel: "#queue-foot #t-saved", min: 3, what: "what the run saved" },
];

try {
  const seen = {};
  for (const scheme of ["light", "dark"]) {
    console.log(`\n=== ${scheme} ===`);
    const pg = await b.newPage();
    await pg.setViewport({ width: 1440, height: 940 });
    const errs = [];
    pg.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
    pg.on("pageerror", (e) => errs.push(String(e)));
    // The setting comes from the reader, so it is emulated rather than clicked.
    await pg.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
    await pg.goto("http://127.0.0.1:8196/", { waitUntil: "networkidle0" });

    await uploadAndFinish(pg, [path.join(FIX, "photo.png"), path.join(FIX, "ui.png")], 900_000);
    await pg.evaluate(() => imgc.select(state.items[0].id));
    await new Promise((r) => setTimeout(r, 700));

    const read = await pg.evaluate((targets) => {
      const surfaceOf = (el) => {
        // Walk up to the first ancestor that actually paints a background.
        for (let n = el; n; n = n.parentElement) {
          const bg = getComputedStyle(n).backgroundColor;
          const m = bg.match(/rgba?\(([^)]+)\)/);
          if (!m) continue;
          const parts = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
          if (parts.length < 4 || parts[3] > 0.9) return bg;
        }
        return getComputedStyle(document.body).backgroundColor;
      };
      const out = { body: {}, items: [] };
      const bodyCs = getComputedStyle(document.body);
      out.body = { bg: bodyCs.backgroundColor, fg: bodyCs.color };
      for (const t of targets) {
        const el = document.querySelector(t.sel);
        if (!el) { out.items.push({ ...t, missing: true }); continue; }
        out.items.push({
          ...t, missing: false,
          fg: getComputedStyle(el).color,
          bg: surfaceOf(el),
        });
      }
      /* Every distinct background actually painted in the dashboard, so "the page
         responds to the setting" is measured across surfaces rather than on body
         alone - a palette half-defined in a media block moves one and not the
         others. */
      out.surfaces = [...new Set(
        [...document.querySelectorAll("#bar, #side, #stage, #queue-list, .row, .btn")]
          .map((e) => getComputedStyle(e).backgroundColor)
          // A transparent background has no colour to move, so comparing it across
          // schemes proves nothing. `.btn.quiet` is deliberately transparent.
          .filter((c) => !/rgba\([^)]*,\s*0\s*\)$/.test(c)))];
      return out;
    }, TEXT_TARGETS);

    seen[scheme] = read;
    console.log(`  body ${read.body.bg} on ${read.body.fg}`);
    console.log(`  surfaces: ${read.surfaces.join(" | ")}`);

    const missing = read.items.filter((i) => i.missing);
    ok(missing.length === 0,
       `${scheme}: every measured surface was found (${missing.map((m) => m.sel).join(", ") || "all"})`);

    for (const i of read.items.filter((x) => !x.missing)) {
      const fg = parse(i.fg), bg = parse(i.bg);
      if (!fg || !bg) { ok(false, `${scheme}: could not read colours for ${i.what}`); continue; }
      const ratio = contrast(fg, bg);
      ok(ratio >= i.min,
         `${scheme}: ${i.what} is legible (${ratio.toFixed(2)}:1, want ${i.min}:1)`);
    }

    ok(errs.length === 0,
       `${scheme}: no console errors${errs.length ? ": " + errs.join(" | ") : ""}`);
    await pg.screenshot({ path: path.join(here, `shot-theme-${scheme}.png`) });
    await pg.close();
  }

  /* The page actually responds to the setting. Compared across every painted
     surface, not just body: a palette defined only inside the dark media block
     moves the body and leaves the panels behind, which is the specific bug this
     catches. */
  console.log("\n=== the two schemes differ ===");
  ok(seen.light.body.bg !== seen.dark.body.bg,
     `the page ground changes (${seen.light.body.bg} -> ${seen.dark.body.bg})`);
  ok(seen.light.body.fg !== seen.dark.body.fg,
     `and so does the ink (${seen.light.body.fg} -> ${seen.dark.body.fg})`);
  /* The HeyOz brand fill is the same value in both modes on purpose - its
     contrast is gated (APCA) in the token layer, and the system's own README
     says not to "fix" it. Everything that is not the brand must move. */
  const BRAND_FILL = "rgb(255, 61, 1)";
  const same = seen.light.surfaces.filter(
    (c) => seen.dark.surfaces.includes(c) && c !== BRAND_FILL);
  ok(same.length === 0,
     `every non-brand surface moved with the scheme (${same.join(", ") || "all moved"})`);
} finally {
  await b.close();
  server.kill();
}

console.log(bad === 0
  ? "\nOK — legible in both schemes, and both are really different"
  : `\n${bad} problem(s)`);
process.exit(bad ? 1 : 0);
