/* Visual verification of the design pass: both themes, and proof that the
 * app-level scale actually resolves. A custom property that references itself
 * is invalid at computed-value time and silently falls back - which is exactly
 * what a careless find-and-replace across a token file produces. */
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

try {
  const pg = await b.newPage();
  await pg.setViewport({ width: 1440, height: 940 });
  const errs = [];
  pg.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
  pg.on("pageerror", (e) => errs.push(String(e)));
  await pg.goto("http://127.0.0.1:8196/", { waitUntil: "networkidle0" });

  // ---- the scale resolves to real lengths -------------------------------
  const scale = await pg.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const names = ["--app-radius-sm", "--app-radius-md", "--app-radius-lg",
                   "--app-radius-pill", "--app-control-h", "--app-control-h-sm",
                   "--app-gap-tight"];
    return Object.fromEntries(names.map((n) => [n, cs.getPropertyValue(n).trim()]));
  });
  console.log("  scale:", JSON.stringify(scale));
  for (const [n, v] of Object.entries(scale)) {
    ok(/^\d+(\.\d+)?px$/.test(v), `${n} resolves to a length (${v || "EMPTY"})`);
  }

  await uploadAndFinish(pg, [path.join(FIX, "photo.png"), path.join(FIX, "ui.png")], 900_000);
  await pg.evaluate(() => selectItem(state.items[0].id));
  await new Promise((r) => setTimeout(r, 600));

  // ---- corners actually painted ------------------------------------------
  const corners = await pg.evaluate(() => {
    const seen = {};
    for (const el of document.querySelectorAll("*")) {
      const cs = getComputedStyle(el);
      if (cs.display === "none") continue;
      const r = cs.borderTopLeftRadius;
      if (r && r !== "0px" && el.getBoundingClientRect().width > 0) {
        seen[r] = (seen[r] || 0) + 1;
      }
    }
    return seen;
  });
  console.log("  painted corner radii:", JSON.stringify(corners));
  const distinct = Object.keys(corners).filter((k) => !k.includes("%"));
  ok(distinct.length <= 5,
     `corners collapse to a small set (${distinct.length}: ${distinct.join(", ")})`);

  /* ---- controls share a height ------------------------------------------
     The panel has to be open before this means anything. Most controls live
     in it now, and the measurement skips anything with `offsetParent === null`
     - so with the drawer shut this found exactly one control and reported that
     it shared a height with itself. A check that quietly shrinks to nothing is
     the failure mode this suite keeps turning up, so the count is asserted
     too: it cannot pass over an almost-empty set again. */
  await pg.evaluate(() => {
    if (state.items.length) selectItem(state.items[0].id);
  });
  await new Promise((r) => setTimeout(r, 400));
  await pg.evaluate(() => document.getElementById("insp-toggle").click());
  await new Promise((r) => setTimeout(r, 600));

  /* Boxed controls in a row. The plan's own picks are deliberately not in this
     list any more: they are words inside a sentence, sized to the words, and
     forcing them all to one height would put them back in boxes and undo the
     thing the sentence exists to be. They get their own check below, against
     each other, which is where consistency actually matters for them. */
  const WANT = ["#ov-format", "#ov-quality", "#dl-one",
                "#copy-one", "#save-btn", "#insp-toggle", "#ov-apply"];
  const heights = await pg.evaluate((sels) => {
    const out = {};
    for (const sel of sels) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null) out[sel] = Math.round(el.getBoundingClientRect().height);
    }
    return out;
  }, WANT);
  console.log("  control heights:", JSON.stringify(heights));
  const found = Object.keys(heights).length;
  ok(found >= 5,
     `enough controls were visible to compare (${found} of ${WANT.length}: ${
       Object.keys(heights).join(", ") || "none"})`);
  const hs = [...new Set(Object.values(heights))];
  ok(hs.length <= 2, `controls share a height (${hs.join(", ")})`);

  /* The plan's picks answer to a different rule: they sit on one line of prose,
     so what has to match is each other and the text around them. A pick taller
     than its neighbours pushes the line apart and the sentence stops reading as
     a sentence - which is exactly what happened when every slot was sized to
     its own longest option. */
  const planned = await pg.evaluate(() => {
    const out = { heights: [], tops: [] };
    /* The selects and the number boxes - the things actually on screen.
       .plan-shadow is a hidden ruler now, not a label, so measuring it here
       compared a control against a measuring stick. */
    for (const el of document.querySelectorAll("#plan .plan-pick > select, #plan .plan-num")) {
      if (el.offsetParent === null) continue;
      const r = el.getBoundingClientRect();
      out.heights.push(Math.round(r.height));
      out.tops.push(Math.round(r.top));
    }
    return out;
  });
  console.log("  plan pick heights:", JSON.stringify(planned));
  ok(planned.heights.length >= 4,
     `the plan's picks were visible to compare (${planned.heights.length})`);
  /* Exactly one height, not "at most two". Two was what this allowed when it
     was first written, and two was what it found: the pixel box carried a
     smaller font size and came out 4px shorter, sitting 2px off the pick beside
     it on the same line. The assertion went green and the sentence still
     wobbled. Words on one line either share a height or they do not. */
  ok(new Set(planned.heights).size === 1,
     `the plan's picks share a height (${[...new Set(planned.heights)].join(", ")})`);

  /* Each pick has to be wide enough for the words it is showing. Sizing a
     select to its selected option needs a measurement, and a measurement taken
     while the element sits inside a hidden ancestor comes back zero - which got
     written straight into the widths and collapsed every pick to nothing but
     its caret. Too narrow and too wide are both failures here: too narrow
     clips, too wide is the column-of-boxes this component exists to avoid. */
  const widths = await pg.evaluate(() => {
    const out = [];
    for (const sel of document.querySelectorAll(".plan-pick > select")) {
      const sh = sel.parentNode.querySelector(".plan-shadow");
      const measure = (t) => { sh.textContent = t; return sh.getBoundingClientRect().width; };
      const chosen = (sel.options[sel.selectedIndex] || {}).textContent || "";
      const selected = measure(chosen);
      let longest = 0, longestText = "";
      for (const o of sel.options) {
        const w = measure(o.textContent);
        if (w > longest) { longest = w; longestText = o.textContent; }
      }
      measure(chosen);                       // leave the ruler as it was found
      out.push({
        id: sel.id, text: chosen, longestText,
        selected: Math.round(selected), longest: Math.round(longest),
        box: Math.round(sel.getBoundingClientRect().width),
      });
    }
    return out;
  });
  console.log("  pick widths:", JSON.stringify(widths));
  for (const w of widths) {
    ok(w.selected > 0 && w.box >= w.selected,
       `#${w.id} fits "${w.text}" (${w.box}px box, ${w.selected}px of text)`);
    /* 60px is the control's own chrome - its padding plus the caret - measured
       rather than guessed. The first version of this check used an invented 44
       and failed three picks that were sized perfectly well. */
    ok(w.box - w.selected <= 60,
       `#${w.id} adds only its own chrome (${w.box} - ${w.selected} = ${w.box - w.selected})`);
    /* The real regression guard: a <select> left to itself is as wide as its
       longest option, which is what turned this sentence into a column of
       boxes. Skipped where every option is about the same length, because then
       the two are indistinguishable and the check would prove nothing. */
    if (w.longest > w.selected + 40) {
      ok(w.box < w.longest,
         `#${w.id} is sized to its selection, not to "${w.longestText}" `
         + `(${w.box} < ${w.longest})`);
    }
  }

  /* ---- the OPEN list, which is where this component actually broke --------
   * A `color: transparent` on the select shipped to main. <option> inherits it,
   * so every entry in every dropdown rendered invisible, and a `background:
   * transparent` alongside it got Chrome to draw the popup as an unstyled white
   * sheet over a dark page. Nothing caught it: every test drove these controls
   * with page.select(), which sets a value and never opens the popup, and the
   * screenshots were all of the closed state.
   *
   * The popup is a native widget and cannot be screenshotted. Its colours can
   * be read, and unreadable text is exactly "the glyphs are the same colour as
   * the sheet behind them" - so that is what this asserts, for every option of
   * every pick, in both themes. */
  const invisible = (c) => !c || c === "transparent" || /rgba\(\s*\d+,\s*\d+,\s*\d+,\s*0\s*\)/.test(c);
  for (const theme of ["dark", "light"]) {
    await pg.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
    await new Promise((r) => setTimeout(r, 250));
    const lists = await pg.evaluate(() => {
      const out = [];
      for (const sel of document.querySelectorAll(".plan-pick > select")) {
        const cs = getComputedStyle(sel);
        out.push({
          id: sel.id,
          selColor: cs.color,
          count: sel.options.length,
          rows: [...sel.options].map((o) => {
            const os = getComputedStyle(o);
            return { text: o.textContent.slice(0, 24), color: os.color, bg: os.backgroundColor };
          }),
        });
      }
      return out;
    });
    ok(lists.length >= 4, `${theme}: the picks were found (${lists.length})`);
    for (const list of lists) {
      ok(!invisible(list.selColor),
         `${theme}: #${list.id} paints its own text (${list.selColor})`);
      const dead = list.rows.filter((r) => invisible(r.color) || r.color === r.bg);
      ok(dead.length === 0,
         `${theme}: every option in #${list.id} is legible (${list.count} options`
         + `${dead.length ? `, unreadable: ${JSON.stringify(dead)}` : ""})`);
    }
  }
  await pg.evaluate(() => { document.documentElement.dataset.theme = "dark"; });

  /* ---- the toast must never cover something clickable ------------------- */
  await pg.evaluate(() => toast("A message long enough to be worth reading"));
  await new Promise((r) => setTimeout(r, 500));
  const hidden = await pg.evaluate(() => {
    const t = document.getElementById("toast").getBoundingClientRect();
    const hit = [];
    // Real controls only. Scroll containers carry a tabindex for keyboard
    // scrolling and are not something a toast can "cover".
    for (const el of document.querySelectorAll("button, select, input, a[href]")) {
      if (el.offsetParent === null) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0) continue;
      if (r.left < t.right && r.right > t.left && r.top < t.bottom && r.bottom > t.top) {
        hit.push(`${el.tagName.toLowerCase()}#${el.id || el.className}`);
      }
    }
    return hit;
  });
  ok(hidden.length === 0, `the toast covers no control (${hidden.join(", ") || "clear"})`);

  // ---- both themes -------------------------------------------------------
  for (const theme of ["dark", "light"]) {
    await pg.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
    await new Promise((r) => setTimeout(r, 500));
    await pg.screenshot({ path: path.join(here, `shot-theme-${theme}.png`) });
    const bg = await pg.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const fg = await pg.evaluate(() => getComputedStyle(document.body).color);
    console.log(`  ${theme}: bg ${bg} fg ${fg}`);
    ok(bg !== fg, `${theme} mode has contrast between page and text`);
  }

  ok(errs.length === 0, `no console errors${errs.length ? ": " + errs.join(" | ") : ""}`);
} finally { await b.close(); server.kill(); }
console.log(bad ? `\n${bad} failed` : "\nall good");
process.exit(bad ? 1 : 0);
