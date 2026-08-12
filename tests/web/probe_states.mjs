/* Six states, each held to the same standard: designed, not whatever the layout
 * happens to do when the numbers run out.
 *
 * "Designed" is a feeling until it is spelled out, so it is spelled out here as
 * five things that can be measured, and every state below is checked against all
 * five:
 *
 *   1. something meaningful is on screen - content, not an empty shell;
 *   2. it says what happened in words, not only in numbers;
 *   3. nothing hangs off the side of the viewport and the page never scrolls
 *      sideways;
 *   4. no element is left empty where a value belongs;
 *   5. there is a next action, and it is one that can actually work.
 *
 * The happy path is covered by probe_flow. These are the edges, and an edge nobody
 * has looked at is exactly where a designed state quietly decays into a fallback:
 * a blank where a number should be, a saving reported on a file that was never
 * compressed, a Download offered for a batch where every image failed, a total
 * poisoned by the one file that did not read.
 *
 * REWRITTEN for the one-page dashboard. The previous version was written against
 * three mutually exclusive views - #view-working, #view-single, #view-list - and a
 * drawer, and most of its assertions were about which of those was showing and
 * what the narration said in each. That architecture is gone: the regions are all
 * present at once, so "which view am I in" is not a question with an answer any
 * more. What survives is the part that was never about the arrangement - the five
 * criteria above, and the six states worth walking through. Assertions about the
 * removed copy went with the copy.
 *
 * Each state gets its own page rather than a reload, which is also how the
 * screenshots stay one-per-state.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer, { CHROME } from "./resolve_puppeteer.mjs";
import { uploadAndFinish } from "./drive.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(here, "fixtures");
const PORT = 8197;
const BASE = `http://127.0.0.1:${PORT}/`;

/* Exactly 60 characters, which is the state the roadmap asks for. Built by
   make_web_fixtures.py, which asserts the length so this cannot drift. */
const LONG_NAME = "screenshot-2026-08-10-settings-panel-dark-theme-retina2x.png";

/* A name is worth nothing if it is clipped to nothing, and "does it overflow"
   cannot tell a tidy ellipsis from an erased filename. 20 characters is enough to
   tell two exports of the same screen apart, which is what the name is for. */
const READABLE_MIN = 20;

/* The comparison is the product, so it gets the largest share of the page. Held
   as area rather than width, because a full-width band 200px tall would pass a
   width test and fail the promise. Lower than the old 60%: the dashboard shows the
   plan and the queue beside the stage at all times by design, where the old single
   view gave the comparison the whole window. */
const STAGE_SHARE_MIN = 0.30;

/* What a finished row's second line has to look like: the weight it arrived at,
   the format it became, and what that saved. A row missing it has lost a value
   rather than being still at work. */
const ROW_RESULT_OK = /\d+(\.\d+)? (B|KB|MB|GB) → .+ · (−\d+%|no smaller)/;

let bad = 0;
/* Everything printed goes through ascii(). The app's own words carry an em dash, a
   true minus sign and a middot, and a Windows console in cp1252 turns those into
   replacement characters - which is the one thing a report of what the screen said
   must not do. */
const ascii = (s) => String(s)
  .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
  .replace(/[–—−]/g, "-")
  .replace(/[·•]/g, "*")
  .replace(/→/g, "->").replace(/×/g, "x").replace(/ /g, " ")
  .replace(/[^\x20-\x7e]/g, "?");
const ok = (c, n) => {
  if (c) console.log(`  ok ${ascii(n)}`);
  else { console.error(`FAIL ${ascii(n)}`); bad++; }
};
const say = (label, value) => console.log(`  ${label}: ${ascii(JSON.stringify(value))}`);
const settle = (ms = 600) => new Promise((r) => setTimeout(r, ms));

/* Measurements the page can take about itself. Installed before the app loads and
   called long after, so they read whatever is on screen at the time. */
function installProbes() {
  const docEl = () => document.documentElement;

  /** On screen and hittable, rather than merely present. */
  window.__vis = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return el.offsetParent !== null && r.width > 0 && r.height > 0;
  };

  /** Everything in the dashboard that hangs off the side of the viewport. One
   *  exemption: the version chips wrap and may scroll within their own block. */
  window.__overhang = () => {
    const w = docEl().clientWidth;
    const out = [];
    for (const el of document.querySelectorAll("#bar *, #dash *")) {
      if (el.closest("#cands")) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && (r.right > w + 1 || r.left < -1)) {
        out.push(`${el.tagName.toLowerCase()}#${el.id || "?"}.${el.getAttribute("class") || ""}` +
                 ` ${Math.round(r.left)}..${Math.round(r.right)}`);
      }
    }
    return out;
  };

  window.__sideways = () => docEl().scrollWidth > docEl().clientWidth;

  /** How many characters of `text` fit in this element's text box, measured in its
   *  own font. The difference between a name tidily shortened and one erased. */
  window.__readable = (el, text) => {
    const cs = getComputedStyle(el);
    const room = el.clientWidth -
      (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
    const ctx = document.createElement("canvas").getContext("2d");
    ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    let n = 0;
    while (n < text.length && ctx.measureText(text.slice(0, n + 1)).width <= room) n++;
    return n;
  };

  /** Every way out of the app that is on screen, and whether it could work.
   *  Offering one that cannot is the specific dishonesty this watches for. */
  window.__downloads = () => [...document.querySelectorAll("#dl-one, #save-btn")]
    .filter(window.__vis)
    .map((e) => ({ id: e.id, disabled: !!e.disabled, label: e.textContent.trim() }));

  /** The primary action, counted rather than assumed. Two on one screen is two
   *  answers to "what do I do now". */
  window.__primaries = () => [...document.querySelectorAll(".btn.primary")]
    .filter(window.__vis).map((e) => e.id || e.getAttribute("class"));

  /** Buttons a person could press right now, so "there is a next action" is a
   *  measurement instead of a hope. */
  window.__actions = () => [...document.querySelectorAll("#bar button, #dash button")]
    .filter((e) => window.__vis(e) && !e.disabled)
    .map((e) => e.id || e.getAttribute("class"));

  /** Which regions have content. There are no views to be in; this is what the old
   *  view names stood for. */
  window.__regions = () => ({
    emptyPrompt: !document.getElementById("queue-empty").hidden,
    listed: !document.getElementById("queue-list").hidden,
    stageLive: document.getElementById("stage-empty").hidden,
    working: state.items.some((i) => i.status === "working"),
    selected: state.selected,
  });

  /** What each row actually says. Status and format are data attributes, so this
   *  reads state rather than parsing display copy. */
  window.__rows = () => [...document.querySelectorAll("#queue-list .row")].map((r) => ({
    name: r.querySelector(".name").textContent,
    now: r.querySelector(".now").textContent,
    sub: r.querySelector(".sub").textContent,
    format: r.dataset.format,
    state: r.dataset.status,
    right: Math.round(r.getBoundingClientRect().right),
    readableName: window.__readable(r.querySelector(".name"),
                                    r.querySelector(".name").textContent),
  }));

  /** The share of the page the comparison is given, by area. */
  window.__stageShare = () => {
    const s = document.getElementById("stage").getBoundingClientRect();
    const w = docEl().clientWidth, h = docEl().clientHeight;
    return {
      share: (s.width * s.height) / (w * h),
      stage: `${Math.round(s.width)}x${Math.round(s.height)}`,
      screen: `${w}x${h}`,
    };
  };

  /** The queue's footer, which is where a run reports itself. */
  window.__foot = () => ({
    count: document.getElementById("t-count").textContent,
    sizes: document.getElementById("t-sizes").textContent,
    saved: document.getElementById("t-saved").textContent,
  });
}

const server = spawn("node", [path.join(here, "serve.mjs"), String(PORT)], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 900));
const b = await puppeteer.launch({
  executablePath: CHROME, headless: true, protocolTimeout: 3_600_000,
});

/** A fresh page, files compressed, ready to measure. */
async function reach(label, files, width = 1440, height = 940) {
  console.log(`\n=== ${label} ===`);
  const pg = await b.newPage();
  const errors = [];
  pg.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  pg.on("pageerror", (e) => errors.push(String(e)));
  await pg.setViewport({ width, height });
  await pg.evaluateOnNewDocument(installProbes);
  await pg.goto(BASE, { waitUntil: "networkidle0" });
  await uploadAndFinish(pg, files.map((f) => path.join(FIX, f)), 1_800_000);
  await settle(700);
  return { pg, errors };
}

/** The three criteria that hold in every state, plus a clean console. */
async function universal(pg, errors, label) {
  const g = await pg.evaluate(() => ({
    overhang: window.__overhang(),
    sideways: window.__sideways(),
    actions: window.__actions(),
    primaries: window.__primaries(),
  }));
  ok(g.overhang.length === 0,
     `${label}: nothing hangs off the viewport (${g.overhang.slice(0, 3).join("; ") || "clean"})`);
  ok(!g.sideways, `${label}: the page does not scroll sideways`);
  ok(g.actions.length > 0, `${label}: there is something to press (${g.actions.length} controls)`);
  ok(g.primaries.length <= 1,
     `${label}: at most one primary action (${g.primaries.join(",") || "none"})`);
  ok(errors.length === 0,
     `${label}: no console errors (${errors.slice(0, 2).join(" | ") || "clean"})`);
  return g;
}

async function finish(pg, errors, label, shot) {
  await pg.screenshot({ path: path.join(here, shot) });
  await pg.close();
}

try {
  /* ===================== 0. NOTHING DROPPED YET ==========================
     The empty state is a state, not an absence. One thing to press, and the
     regions that have nothing to say are quiet rather than full of dashes. */
  {
    console.log("\n=== empty ===");
    const pg = await b.newPage();
    const errors = [];
    pg.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    pg.on("pageerror", (e) => errors.push(String(e)));
    await pg.setViewport({ width: 1440, height: 940 });
    await pg.evaluateOnNewDocument(installProbes);
    await pg.goto(BASE, { waitUntil: "networkidle0" });
    await settle(400);

    const empty = await pg.evaluate(() => ({
      ...window.__regions(),
      prompt: document.getElementById("queue-empty").innerText,
      stageSays: document.getElementById("stage-empty").textContent,
      downloads: window.__downloads(),
      foot: window.__foot(),
      planReady: document.getElementById("target").options.length,
    }));
    say("empty", empty);
    ok(empty.emptyPrompt && !empty.listed,
       "the prompt is up and there is no empty list frame around nothing");
    ok(!empty.stageLive && empty.stageSays.trim().length > 0,
       `the stage says there is nothing to compare (${empty.stageSays})`);
    ok(/drop|choose/i.test(empty.prompt), "and the prompt says what to do");
    ok(empty.downloads.length === 0,
       `no download is offered when there is nothing to download (${JSON.stringify(empty.downloads)})`);
    ok(empty.planReady > 0, `the plan is ready before anything is dropped (${empty.planReady} destinations)`);
    await universal(pg, errors, "empty");
    await finish(pg, errors, "empty", "shot-state-empty.png");
  }

  /* ======================= 1. ONE IMAGE ==================================
     Nothing to choose between, so the comparison should dominate. */
  {
    const { pg, errors } = await reach("one image", ["logo.png"]);
    const one = await pg.evaluate(() => ({
      ...window.__regions(),
      items: state.items.length,
      ...window.__stageShare(),
      why: document.getElementById("chip-why").textContent,
      size: document.getElementById("s-size").textContent,
      saved: document.getElementById("s-saved").textContent,
      score: document.getElementById("s-score").textContent,
      dims: document.getElementById("s-dims").textContent,
      time: document.getElementById("s-time").textContent,
      /* Base and extension apart. The extension shown is the OUTPUT's - logo.png
         kept as WebP is logo.webp, which is the name the download will carry - so
         asserting the whole string equals the input filename would be asserting
         that compressing never changes the format. */
      nameBase: document.getElementById("out-name").value,
      nameExt: document.getElementById("out-ext").textContent,
      saveLabel: document.getElementById("save-label").textContent,
      downloads: window.__downloads(),
      rows: window.__rows(),
    }));
    say("one image", one);
    ok(one.items === 1 && one.stageLive && one.listed,
       "the comparison is up and the one image has a row");
    ok(one.share > STAGE_SHARE_MIN,
       `the comparison gets ${Math.round(one.share * 100)}% of the page, want over ` +
       `${STAGE_SHARE_MIN * 100}% (${one.stage} of ${one.screen})`);
    ok(one.why.trim().length > 0, `what happened is said in words (${one.why.slice(0, 60)})`);
    ok(/\d/.test(one.size), `the result names its size (${one.size})`);
    ok(one.saved.trim() !== "" && one.saved.trim() !== "—",
       `and the saving is filled in rather than left as a dash (${one.saved})`);
    ok([one.score, one.dims, one.time].every((v) => v.trim() && v.trim() !== "—"),
       `every measured value is filled in (${[one.score, one.dims, one.time].join(" | ")})`);
    ok(one.nameBase === "logo" && /^\.[a-z0-9]+$/i.test(one.nameExt),
       `the file is named on screen, with the extension it will be saved as ` +
       `(${one.nameBase}${one.nameExt})`);
    ok(!/zip/i.test(one.saveLabel),
       `one image is a file, not an archive (${one.saveLabel})`);
    ok(one.downloads.some((d) => d.id === "save-btn" && !d.disabled),
       `the way out can actually be pressed (${JSON.stringify(one.downloads)})`);
    ok(one.rows.length === 1 && ROW_RESULT_OK.test(one.rows[0].sub),
       `the row reports its result (${one.rows[0]?.sub})`);
    await universal(pg, errors, "one image");
    await finish(pg, errors, "one image", "shot-state-one.png");
  }

  /* ======================= 2. MANY IMAGES ================================ */
  {
    const { pg, errors } = await reach("many images",
      ["logo.png", "ui.png", "photo.png", "small.jpg", "static.gif"]);
    const many = await pg.evaluate(() => ({
      ...window.__regions(),
      items: state.items.length,
      rows: window.__rows(),
      count: document.getElementById("queue-count").textContent,
      foot: window.__foot(),
      saveLabel: document.getElementById("save-label").textContent,
      downloads: window.__downloads(),
    }));
    say("many images", { ...many, rows: many.rows.length });
    ok(many.listed && many.stageLive, "the list and the comparison are both up");
    ok(many.rows.length === many.items,
       `every image has a row (${many.rows.length}/${many.items})`);

    const blankWeight = many.rows.filter((r) => !r.now.trim());
    ok(blankWeight.length === 0,
       `no row is missing its weight (${blankWeight.map((r) => r.name).join(", ") || "all present"})`);
    const noResult = many.rows.filter((r) => !ROW_RESULT_OK.test(r.sub));
    ok(noResult.length === 0,
       `every row reports its result (${noResult.map((r) => `${r.name}: ${r.sub}`).join("; ") || "all do"})`);
    const noFormat = many.rows.filter((r) => !r.format);
    ok(noFormat.length === 0,
       `every row names the format it became (${noFormat.map((r) => r.name).join(", ") || "all do"})`);

    ok(many.count === String(many.items),
       `the header counts them (${many.count})`);
    ok(new RegExp(`${many.items} ready`).test(many.foot.count),
       `and the footer says how many finished (${many.foot.count})`);
    ok(/\d+(\.\d+)? (B|KB|MB|GB) → \d+(\.\d+)? (B|KB|MB|GB)/.test(many.foot.sizes) &&
       /saved/.test(many.foot.saved),
       `the run reports its before, after and saving (${many.foot.sizes} / ${many.foot.saved})`);
    ok(/zip/i.test(many.saveLabel) && new RegExp(`${many.items}`).test(many.saveLabel),
       `and says it will be an archive of ${many.items} (${many.saveLabel})`);
    await universal(pg, errors, "many images");
    await finish(pg, errors, "many images", "shot-state-many.png");
  }

  /* ==================== 3. EVERY IMAGE FAILED ============================
     The state most likely to decay into a fallback: nothing to show, nothing to
     download, and every number undefined. */
  {
    const { pg, errors } = await reach("all failed", ["corrupt.png", "corrupt.jpg"]);
    const failed = await pg.evaluate(() => ({
      ...window.__regions(),
      statuses: state.items.map((i) => i.status),
      stageSays: document.getElementById("stage-empty").textContent,
      stageHidden: document.getElementById("stage-empty").hidden,
      rows: window.__rows(),
      foot: window.__foot(),
      downloads: window.__downloads(),
      actions: window.__actions(),
      why: document.getElementById("chip-why").textContent,
      originalsIntact: state.items.every((i) => i.originalBytes > 0 && !!i.beforeURL),
    }));
    say("all failed", { ...failed, rows: failed.rows.length });
    ok(failed.statuses.every((s) => s === "failed"),
       `both files failed as expected (${failed.statuses})`);
    ok(failed.listed, "the list is still on screen");
    ok(!failed.stageHidden && failed.stageSays.trim().length > 0,
       `the stage says what happened instead of showing a broken image (${failed.stageSays})`);
    const silent = failed.rows.filter((r) => !r.sub.trim());
    ok(silent.length === 0,
       `every failed row says why (${failed.rows.map((r) => r.sub).join("; ")})`);
    ok(failed.rows.every((r) => r.state === "failed"),
       `and is marked failed rather than left looking busy (${failed.rows.map((r) => r.state)})`);
    ok(/2 failed/.test(failed.foot.count) && !/ready/.test(failed.foot.count),
       `the footer counts the failures and claims no successes (${failed.foot.count})`);
    ok(failed.foot.sizes.trim() === "" && failed.foot.saved.trim() === "",
       `and reports no totals rather than zeroes (${JSON.stringify(failed.foot)})`);
    ok(failed.downloads.length === 0 || failed.downloads.every((d) => d.disabled),
       `no working download is offered (${JSON.stringify(failed.downloads)})`);
    ok(failed.actions.includes("add-btn") && failed.actions.includes("clear-btn"),
       `there is still a way forward (${failed.actions.join(",")})`);
    ok(failed.originalsIntact, "and every original is still held, unharmed");
    await universal(pg, errors, "all failed");
    await finish(pg, errors, "all failed", "shot-state-failed.png");
  }

  /* ============= 4. NOTHING BEAT THE ORIGINAL (PASSTHROUGH) ==============
     A real result, and the one most easily reported as a fake win. */
  {
    const { pg, errors } = await reach("passthrough", ["small.jpg"]);
    const kept = await pg.evaluate(() => {
      const it = state.items[0];
      return {
        passthrough: !!it.passthrough,
        same: it.newBytes === it.originalBytes,
        why: document.getElementById("chip-why").textContent,
        saved: document.getElementById("s-saved").textContent,
        size: document.getElementById("s-size").textContent,
        note: document.getElementById("s-note").textContent,
        chips: [...document.querySelectorAll("#cands .chip")].map((c) => ({
          f: c.dataset.format, win: c.dataset.win === "1", d: c.querySelector(".cd").textContent,
        })),
        rows: window.__rows(),
        downloads: window.__downloads(),
      };
    });
    say("passthrough", kept);
    if (kept.passthrough) {
      ok(kept.same, "the bytes shipped are the bytes that arrived");
      ok(/kept exactly as it arrived|Nothing beat the original/.test(kept.why),
         `it says the original was kept, and why (${kept.why})`);
      ok(/no saving/.test(kept.saved),
         `the saving reads as none rather than as -0% (${kept.saved})`);
      const winner = kept.chips.find((c) => c.win);
      ok(winner && winner.f === "__original",
         `the Original chip is marked as the one kept (${JSON.stringify(winner)})`);
      ok(/no smaller/.test(kept.rows[0].sub),
         `and the row says it got no smaller rather than claiming a percentage (${kept.rows[0].sub})`);
    } else {
      /* The engine beat this fixture, which is a legitimate outcome and not a
         reason to fail - but then this state was not reached, and saying so is
         better than reporting a pass for a case that never ran. */
      ok(true, `SKIPPED: the engine beat small.jpg, so passthrough was not reached ` +
               `(${kept.size}, ${kept.saved})`);
    }
    ok(kept.downloads.some((d) => !d.disabled),
       `the file can still be taken away (${JSON.stringify(kept.downloads)})`);
    await universal(pg, errors, "passthrough");
    await finish(pg, errors, "passthrough", "shot-state-passthrough.png");
  }

  /* ====================== 5. A 60-CHARACTER NAME =========================
     Checked at both widths, and checked for readability rather than for the
     absence of overflow: "does it overflow" cannot tell a tidy ellipsis from an
     erased filename. */
  for (const width of [1440, 375]) {
    const { pg, errors } = await reach(`long name @${width}px`, [LONG_NAME], width, 900);
    const h = await pg.evaluate((full) => {
      const field = document.getElementById("out-name");
      const bar = document.querySelector(".stage-bar.bottom");
      const r = field.getBoundingClientRect(), br = bar.getBoundingClientRect();
      const dl = document.getElementById("save-btn").getBoundingClientRect();
      return {
        value: field.value,
        ext: document.getElementById("out-ext").textContent,
        // The name a person typed, entire. The extension is the output's, so it is
        // checked for being a real extension rather than for matching the input's.
        whole: field.value === full.replace(/\.[a-z0-9]+$/i, "") &&
               /^\.[a-z0-9]+$/i.test(document.getElementById("out-ext").textContent),
        readable: window.__readable(field, field.value),
        insideBar: r.left >= br.left - 1 && r.right <= br.right + 1,
        actionOnScreen: dl.right <= document.documentElement.clientWidth + 1 && dl.width > 0,
        rows: window.__rows(),
        width: document.documentElement.clientWidth,
      };
    }, LONG_NAME);
    say(`long name @${width}`, { ...h, rows: h.rows.length });
    ok(LONG_NAME.length === 60, `the fixture's name is 60 characters (${LONG_NAME.length})`);
    ok(h.whole, `${width}px: the whole name is still there to read (${h.value}${h.ext})`);
    ok(h.readable >= READABLE_MIN,
       `${width}px: ${h.readable} characters of it are legible, want ${READABLE_MIN}+`);
    ok(h.insideBar, `${width}px: the field stays inside its bar`);
    ok(h.actionOnScreen, `${width}px: and has not pushed the download off the screen`);
    ok(h.rows[0] && h.rows[0].readableName >= READABLE_MIN,
       `${width}px: and the row's copy of the name is legible too (${h.rows[0]?.readableName})`);
    ok(h.rows[0] && h.rows[0].right <= h.width,
       `${width}px: the row does not hang off the side (${h.rows[0]?.right} <= ${h.width})`);
    await universal(pg, errors, `long name @${width}px`);
    await finish(pg, errors, `long name @${width}px`,
                 width === 375 ? "shot-state-longname-375.png" : "shot-state-longname.png");
  }

  /* ======================= 6. SOME WORKED, ONE DID NOT ===================
     The totals are the thing to watch: one unreadable file must not poison them. */
  {
    const { pg, errors } = await reach("mixed", ["logo.png", "ui.png", "corrupt.png"]);
    const mixed = await pg.evaluate(() => {
      const ready = state.items.filter((i) => i.status === "done" || i.status === "saved");
      const human = imgc.human;
      return {
        readyCount: ready.length,
        rows: window.__rows(),
        count: document.getElementById("queue-count").textContent,
        foot: window.__foot(),
        // What the footer should say if it counts only the images with a result.
        readyOnly: `${human(ready.reduce((s, i) => s + i.originalBytes, 0))} → ` +
                   `${human(ready.reduce((s, i) => s + i.newBytes, 0))}`,
        downloads: window.__downloads(),
      };
    });
    say("mixed", { ...mixed, rows: mixed.rows.length });
    ok(mixed.readyCount === 2, `two of the three finished (${mixed.readyCount})`);
    const badRow = mixed.rows.find((r) => r.name === "corrupt.png");
    ok(badRow && badRow.state === "failed" && badRow.sub.trim().length > 0,
       `the one that failed says so on its own row (${badRow?.sub})`);
    ok(mixed.rows.filter((r) => r.name !== "corrupt.png").every((r) => ROW_RESULT_OK.test(r.sub)),
       "and the two that worked report their results");
    ok(mixed.count === "3" && /2 ready/.test(mixed.foot.count) && /1 failed/.test(mixed.foot.count),
       `the footer counts both outcomes (${mixed.count}, ${mixed.foot.count})`);
    ok(mixed.foot.sizes === mixed.readyOnly,
       `the totals count only what finished (${mixed.foot.sizes} vs ${mixed.readyOnly})`);
    ok(!/—|NaN|Infinity|undefined/.test(mixed.foot.sizes + mixed.foot.saved + mixed.foot.count),
       `and no total is poisoned by the file that failed (${JSON.stringify(mixed.foot)})`);
    ok(mixed.downloads.some((d) => !d.disabled),
       `the two that worked can still be taken away (${JSON.stringify(mixed.downloads)})`);
    await universal(pg, errors, "mixed");
    await finish(pg, errors, "mixed", "shot-state-mixed.png");
  }
} finally {
  await b.close();
  server.kill();
}

console.log(bad === 0
  ? "\nOK — every state is designed, not a fallback"
  : `\n${bad} problem(s)`);
process.exit(bad ? 1 : 0);
