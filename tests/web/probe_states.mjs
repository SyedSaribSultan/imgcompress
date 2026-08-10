/* The six states phase 4.4 names, each held to the same standard: designed,
 * not whatever the layout happens to do when the numbers run out.
 *
 * "Designed" is a feeling until it is spelled out, so it is spelled out here as
 * five things that can be measured, and every state below is checked against
 * all five:
 *
 *   1. something meaningful is on screen - a view, not an empty shell;
 *   2. it says what happened in words, not only in numbers;
 *   3. nothing hangs off the side of the viewport and the page never scrolls
 *      sideways;
 *   4. no element is left empty where a value belongs;
 *   5. there is a next action, and it is one that can actually work.
 *
 * The happy path is covered by probe_flow. These are the edges, and an edge
 * nobody has looked at is exactly where a designed state quietly decays into a
 * fallback: a blank where a number should be, a saving reported on a file that
 * was never compressed, a Download button offered for a batch where every
 * image failed, a total poisoned by the one file that did not read.
 *
 * Each state gets its own page rather than a reload. The app asks the browser
 * to confirm before unloading finished work (see the beforeunload handler), and
 * under automation that confirmation has nobody to answer it - a reload just
 * hangs. Closing a page skips it, which is why every state opens a fresh one.
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
   cannot tell a tidy ellipsis from an erased filename. 20 characters is enough
   to tell two exports of the same screen apart, which is what the name is for.
   Measured: 60 of 60 in the list at 1440px, 35 at 375px, and 25 in the heading
   over the comparison at 375px. Narrowing the name's column to a fixed 96px
   took the list to 13 and clamping the heading to 9ch took it to 7, so this
   number sits between a working layout and a broken one rather than a hair away
   from either. */
const READABLE_MIN = 20;

/* The brief's number: the comparison is the product, so on a screen with one
   image on it the comparison gets most of the screen. Measured as area, not
   width, because a full-width band 200px tall would pass a width test and fail
   the promise. */
const STAGE_SHARE_MIN = 0.60;

/* What a row's weights line has to look like: two weights and the arrow between
   them. This is the shape that survives every stage of a run, so a row missing
   it is a row that has lost a value rather than one that is still working. */
const SIZES_OK = /^\s*\d+(\.\d+)? (B|KB|MB|GB) → \d+(\.\d+)? (B|KB|MB|GB)/;

let bad = 0;
/* Everything printed goes through ascii(). The app's own words carry an em
   dash, a true minus sign and a middot, and a Windows console in cp1252 turns
   those into replacement characters - which is the one thing a report of what
   the screen said must not do. */
const ascii = (s) => String(s)
  .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
  .replace(/[–—−]/g, "-")
  .replace(/[·•]/g, "*")
  .replace(/→/g, "->").replace(/×/g, "x").replace(/\u00a0/g, " ")
  .replace(/[^\x20-\x7e]/g, "?");
const ok = (c, n) => {
  if (c) console.log(`  ok ${ascii(n)}`);
  else { console.error(`FAIL ${ascii(n)}`); bad++; }
};
const say = (label, value) => console.log(`  ${label}: ${ascii(JSON.stringify(value))}`);
const settle = (ms = 600) => new Promise((r) => setTimeout(r, ms));

/* Measurements the page can take about itself. Installed before the app loads
   and called long after, so they read whatever is on screen at the time. */
function installProbes() {
  const docEl = () => document.documentElement;

  /** On screen and hittable, rather than merely present. A control inside a
   *  hidden view reports offsetParent === null, and a probe that counts those
   *  passes over an empty set - the failure mode this suite keeps finding. */
  window.__vis = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return el.offsetParent !== null && r.width > 0 && r.height > 0;
  };

  /** Everything inside the working shell that hangs off the side of the
   *  viewport. Two deliberate exemptions: the version chips scroll sideways
   *  within their own strip on purpose, and a shut panel is parked past the
   *  right edge by a transform, which is how it stays out of the way without
   *  any view reserving room for it. */
  window.__overhang = () => {
    const w = docEl().clientWidth;
    const out = [];
    for (const el of document.querySelectorAll("#app-full *")) {
      if (el.closest("#cands")) continue;
      const panel = el.closest("#panel");
      if (panel && !panel.classList.contains("on")) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && (r.right > w + 1 || r.left < -1)) {
        out.push(`${el.tagName.toLowerCase()}#${el.id || "?"}.${el.getAttribute("class") || ""}` +
                 ` ${Math.round(r.left)}..${Math.round(r.right)}`);
      }
    }
    return out;
  };

  window.__sideways = () => docEl().scrollWidth > docEl().clientWidth;

  /** How many characters of `text` fit in this element's text box, measured in
   *  its own font. This is the difference between a name that was tidily
   *  shortened and a name that was erased. */
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
  window.__downloads = () => [...document.querySelectorAll("#dl-one, #save-btn, #export-btn")]
    .filter(window.__vis)
    .map((e) => ({ id: e.id, disabled: !!e.disabled, label: e.textContent.trim() }));

  /** The primary action, counted rather than assumed. Two of them on one screen
   *  is two answers to "what do I do now". */
  window.__primaries = () => [...document.querySelectorAll(".btn.primary")]
    .filter(window.__vis).map((e) => e.id || e.getAttribute("class"));

  /** Buttons a person could press right now, so "there is a next action" is a
   *  measurement instead of a hope. */
  window.__actions = () => [...document.querySelectorAll("#app-full button")]
    .filter((e) => window.__vis(e) && !e.disabled)
    .map((e) => e.id || e.getAttribute("class"));

  window.__views = () => ({
    view: currentView(),
    working: !document.getElementById("view-working").hidden,
    single: !document.getElementById("view-single").hidden,
    list: !document.getElementById("view-list").hidden,
  });

  /** What each row in the list actually says. */
  window.__rows = () => [...document.querySelectorAll("#queue-list .row")].map((r) => ({
    name: r.querySelector(".name").textContent,
    sizes: r.querySelector(".meta").textContent,
    phase: r.querySelector(".phase").textContent,
    format: r.querySelector(".won").textContent,
    state: r.querySelector(".dot").getAttribute("class"),
    right: Math.round(r.getBoundingClientRect().right),
    readableName: window.__readable(r.querySelector(".name"),
                                    r.querySelector(".name").textContent),
  }));

  /** The share of the screen the comparison is given, by area. */
  window.__stageShare = () => {
    const r = document.getElementById("stage").getBoundingClientRect();
    return {
      share: +((r.width * r.height) / (innerWidth * innerHeight)).toFixed(3),
      stage: `${Math.round(r.width)}x${Math.round(r.height)}`,
      screen: `${innerWidth}x${innerHeight}`,
    };
  };
}

const server = spawn("node", [path.join(here, "serve.mjs"), String(PORT)], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 900));
const b = await puppeteer.launch({
  executablePath: CHROME, headless: true, protocolTimeout: 3_600_000,
});

/** Reach one state: a fresh page, the files dropped on it, and the run finished.
 *  Console errors are collected per state so the one that produced them is
 *  named rather than the run as a whole. */
async function reach(title, files, viewport = { width: 1440, height: 940 }) {
  console.log(`\n=== ${title} ===`);
  const pg = await b.newPage();
  const errors = [];
  pg.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  pg.on("pageerror", (e) => errors.push(String(e)));
  await pg.evaluateOnNewDocument(installProbes);
  await pg.setViewport(viewport);
  await pg.goto(BASE, { waitUntil: "networkidle0" });
  await uploadAndFinish(pg, files.map((f) => path.join(FIX, f)));
  await settle(800);
  return { pg, errors };
}

/** Common to all six: nothing hangs off the side, and the console stayed quiet.
 *  A layout fault and a thrown exception both turn a designed state into a
 *  fallback, and neither shows up in any single assertion above. */
async function finish(pg, errors, title, shot) {
  const fit = await pg.evaluate(() => ({
    overhang: window.__overhang(), sideways: window.__sideways(),
    width: document.documentElement.clientWidth,
  }));
  ok(fit.overhang.length === 0,
     `${title}: nothing hangs off the ${fit.width}px viewport (${
       fit.overhang.join("; ") || "clean"})`);
  ok(!fit.sideways, `${title}: the page does not scroll sideways`);
  ok(errors.length === 0,
     `${title}: no console errors (${errors.slice(0, 2).join(" | ") || "clean"})`);
  if (shot) await pg.screenshot({ path: path.join(here, shot) });
  await pg.close();
}

/* A drop selects its first file, so a batch opens on image one and the list is
   one press behind it. That press is what a person does to see the whole batch,
   and it is the only way to reach the list view at all, so every state below
   that is about the list goes through it. */
async function openTheList(pg) {
  const shown = await pg.evaluate(() => {
    const back = document.getElementById("back-btn");
    const was = window.__vis(back);
    back.click();
    return was;
  });
  await settle(500);
  return shown;
}

try {
  /* ======================= 1. ONE IMAGE ==================================
     Nothing to choose between, so there is nothing to choose from: the
     comparison is the screen, and the list - which would be a single row and a
     header - is not drawn at all. */
  {
    const { pg, errors } = await reach("one image", ["logo.png"]);
    const one = await pg.evaluate(() => {
      const field = document.getElementById("insp-name");
      return {
        ...window.__views(),
        items: state.items.length,
        ...window.__stageShare(),
        back: window.__vis(document.getElementById("back-btn")),
        narration: document.getElementById("narration").textContent,
        size: document.getElementById("s-size").textContent,
        saved: document.getElementById("s-saved").textContent,
        name: field.value + document.getElementById("insp-ext").textContent,
        primaries: window.__primaries(),
        downloads: window.__downloads(),
      };
    });
    say("one image", one);
    ok(one.items === 1 && one.single && !one.list && !one.working,
       `the comparison is the whole screen and the list is not drawn (${one.view})`);
    ok(one.share > STAGE_SHARE_MIN,
       `the comparison gets ${Math.round(one.share * 100)}% of the screen, want over ` +
       `${STAGE_SHARE_MIN * 100}% (${one.stage} of ${one.screen})`);
    ok(!one.back,
       "and no way back to a list that would hold one row, because there is none");
    ok(/Went with|left exactly as it is/.test(one.narration),
       `what happened is said in words (${one.narration})`);
    ok(/\d+(\.\d+)? (B|KB|MB|GB) .*from \d/.test(one.size),
       `the new size names the old one beside it (${one.size})`);
    ok(one.saved.trim() !== "" && one.saved.trim() !== "—",
       `and the saving is filled in rather than left as a dash (${one.saved})`);
    ok(one.name === "logo.png", `the file is named on screen (${one.name})`);
    ok(one.primaries.length === 1 && one.primaries[0] === "dl-one",
       `exactly one primary action, and it is the way out (${one.primaries})`);
    ok(one.downloads.some((d) => d.id === "dl-one" && !d.disabled),
       `the next action can actually be pressed (${JSON.stringify(one.downloads)})`);
    await finish(pg, errors, "one image", "shot-state-one.png");
  }

  /* ======================= 2. MANY IMAGES ================================
     The list is the task: one row per image, each row saying both weights and
     which format won, and one place to take the whole batch away. */
  {
    const { pg, errors } = await reach("many images", ["ui.png", "logo.png", "photo.png"]);
    const back = await openTheList(pg);
    ok(back, "the list is one press from the image a batch opens on");
    const many = await pg.evaluate(() => ({
      ...window.__views(),
      items: state.items.map((i) => i.name),
      rows: window.__rows(),
      count: document.getElementById("queue-count").textContent,
      foot: document.getElementById("queue-foot").textContent,
      totals: document.getElementById("t-sizes").textContent,
      savedTotal: document.getElementById("t-saved").textContent,
      saveLabel: document.getElementById("save-label").textContent,
      primaries: window.__primaries(),
      downloads: window.__downloads(),
    }));
    say("many images", many);
    ok(many.list && !many.single && !many.working,
       `the list is what is on screen (${many.view})`);
    ok(many.rows.length === many.items.length &&
       many.rows.every((r, i) => r.name === many.items[i]),
       `one row per image, in the order they arrived (${many.rows.length} rows, ` +
       `${many.items.length} images)`);
    const noSizes = many.rows.filter((r) => !SIZES_OK.test(r.sizes));
    ok(noSizes.length === 0,
       `every row carries both weights (${noSizes.map((r) => r.sizes).join("; ") || "all do"})`);
    const noFormat = many.rows.filter((r) => !r.format.trim());
    ok(noFormat.length === 0,
       `and the format it ended up as (${
         many.rows.map((r) => r.format).join(", ") || "none"})`);
    const noPhase = many.rows.filter((r) => !r.phase.trim());
    ok(noPhase.length === 0,
       `and says what was done to it (${noPhase.map((r) => r.name).join("; ") || "all do"})`);
    ok(many.count === String(many.items.length),
       `the header counts them (${many.count})`);
    ok(/\d+ ready/.test(many.foot), `and says so in words (${many.foot})`);
    ok(/\d+(\.\d+)? (B|KB|MB|GB) → \d+(\.\d+)? (B|KB|MB|GB)/.test(many.totals) &&
       /saved .*\(\d+%\)/.test(many.savedTotal),
       `the batch total is stated (${many.totals} / ${many.savedTotal})`);
    ok(many.primaries.length === 1 && many.primaries[0] === "save-btn",
       `exactly one primary download control on screen (${many.primaries})`);
    ok(new RegExp(`all ${many.items.length}`).test(many.saveLabel),
       `and it says how many it will take (${many.saveLabel})`);
    await finish(pg, errors, "many images", "shot-state-many.png");
  }

  /* ======================= 3. EVERY IMAGE FAILED =========================
     Two damaged files, so the batch has nothing in it that worked. The screen
     has to say what happened to each one, offer something to do about it, and
     not offer a download that cannot produce a file. */
  {
    const { pg, errors } = await reach("every image failed", ["corrupt.png", "corrupt.jpg"]);
    const opened = await pg.evaluate(() => ({
      ...window.__views(),
      statuses: state.items.map((i) => i.status),
      narration: document.getElementById("narration").textContent,
      stageNone: document.getElementById("stage-none").textContent,
      stageNoneShown: !document.getElementById("stage-none").hidden,
      downloads: window.__downloads(),
    }));
    say("the failed image it opened on", opened);
    ok(opened.statuses.every((s) => s === "failed"),
       `both files failed, which is the state under test (${opened.statuses})`);
    ok(/couldn't be read/i.test(opened.narration) && /your original/i.test(opened.narration),
       `it says what happened and that the original is safe (${opened.narration})`);
    ok(opened.stageNoneShown &&
       /No preview/.test(opened.stageNone) && /read this file/.test(opened.stageNone),
       `and the empty stage says why there is no picture (${opened.stageNone})`);
    ok(opened.downloads.every((d) => d.disabled),
       `no download is offered for a file that does not exist (${
         JSON.stringify(opened.downloads)})`);

    /* The next action for one damaged file lives in the panel, so getting to it
       is two presses - Details, then Try again. Measured with the panel open,
       because a control measured while its drawer is shut measures nothing. */
    await pg.click("#insp-toggle");
    await settle(600);
    const retry = await pg.evaluate(() => {
      const btn = document.getElementById("retry-btn");
      return {
        shown: window.__vis(btn), label: btn.textContent.trim(),
        warn: document.getElementById("s-warn").textContent,
        warnShown: !document.getElementById("s-warn").hidden,
      };
    });
    say("the way out of a failure", retry);
    ok(retry.shown && /again/i.test(retry.label),
       `a damaged file offers a next action (${retry.label})`);
    ok(retry.warnShown && retry.warn.trim().length > 0,
       `and the reason is written out, not implied (${retry.warn})`);

    const back = await openTheList(pg);
    ok(back, "the whole batch is one press away");
    const failed = await pg.evaluate(() => ({
      ...window.__views(),
      rows: window.__rows(),
      foot: document.getElementById("queue-foot").textContent,
      totals: document.getElementById("t-sizes").textContent,
      savedTotal: document.getElementById("t-saved").textContent,
      downloads: window.__downloads(),
      actions: window.__actions(),
    }));
    say("every image failed", failed);
    ok(failed.list, `the list is on screen (${failed.view})`);
    const silent = failed.rows.filter((r) => !/damaged|couldn't be read/i.test(r.sizes));
    ok(silent.length === 0,
       `every row says in words what happened to it (${
         silent.map((r) => r.name).join("; ") || failed.rows[0].sizes})`);
    ok(failed.rows.every((r) => /failed/.test(r.state)),
       `and is marked as failed rather than pending (${
         failed.rows.map((r) => r.state).join(", ")})`);
    ok(/0 ready/.test(failed.foot) && /2 failed/.test(failed.foot),
       `the footer counts the failures instead of leaving the count blank (${failed.foot})`);
    ok(failed.totals.trim() === "" && failed.savedTotal.trim() === "",
       `no batch total is invented for a batch that produced nothing (${
         JSON.stringify([failed.totals, failed.savedTotal])})`);
    ok(failed.downloads.length > 0 && failed.downloads.every((d) => d.disabled),
       `every download control on screen is dead, because none of them could work (${
         JSON.stringify(failed.downloads)})`);
    ok(failed.actions.includes("add-btn") && failed.actions.includes("clear-btn"),
       `and there is still something to do (${failed.actions.join(", ")})`);
    await finish(pg, errors, "every image failed", "shot-state-failed.png");
  }

  /* ======================= 4. NOTHING BEAT THE ORIGINAL ==================
     A small JPEG that every encoder came back larger than. The result is the
     file the person already had, and the screen has to say so and say why -
     without reporting a saving that did not happen. */
  {
    const { pg, errors } = await reach("nothing beat the original", ["small.jpg"]);
    const kept = await pg.evaluate(() => {
      const it = state.items[0];
      return {
        ...window.__views(),
        passthrough: !!it.passthrough,
        same: it.newBytes === it.originalBytes,
        bytes: [it.originalBytes, it.newBytes],
        narration: document.getElementById("narration").textContent,
        size: document.getElementById("s-size").textContent,
        saved: document.getElementById("s-saved").textContent,
        /* Every word on the comparison screen, so a percentage claimed
           anywhere on it can be looked for rather than guessed at. */
        words: document.getElementById("view-single").innerText,
        downloads: window.__downloads(),
      };
    });
    say("nothing beat the original", {
      ...kept, words: kept.words.replace(/\s+/g, " ").slice(0, 200),
    });
    ok(kept.passthrough && kept.same,
       `the file that came out is the file that went in (${kept.bytes})`);
    ok(/already smaller than anything we could make/.test(kept.narration),
       `it says the original was kept, and why (${kept.narration})`);
    ok(kept.saved.trim() === "none",
       `the saving reads "none" rather than a blank or a zero (${
         JSON.stringify(kept.saved)})`);
    ok(/\d+(\.\d+)? (B|KB|MB|GB) .*from \d/.test(kept.size),
       `both weights are still shown, and they match (${kept.size})`);
    const percents = kept.words.match(/[-−]?\s?\d+(\.\d+)?\s?%/g) || [];
    ok(percents.length === 0,
       `no percentage is claimed for work that was not done (${
         percents.join(", ") || "none claimed"})`);
    ok(kept.downloads.some((d) => d.id === "dl-one" && !d.disabled),
       `and the original can still be taken away (${JSON.stringify(kept.downloads)})`);

    /* The evidence for "nothing beat it" is the row of versions and the
       sentence over them, both in the panel. A claim like this one is the one
       that most needs its receipts. */
    await pg.click("#insp-toggle");
    await settle(600);
    const why = await pg.evaluate(() => ({
      verdict: document.getElementById("s-verdict").textContent,
      verdictShown: !document.getElementById("s-verdict").hidden,
      chips: document.querySelectorAll("#cands .cand").length,
      tried: [...document.querySelectorAll("#cands .cand")].map((c) => c.dataset.format),
      savings: [...document.querySelectorAll("#cands .cand .p")].map((c) => c.textContent),
    }));
    say("the evidence", why);
    ok(why.verdictShown && /larger than the file you gave us/.test(why.verdict),
       `the reason is written out (${why.verdict})`);
    ok(why.chips > 1, `the versions it tried are all there to look at (${why.tried})`);
    ok(why.savings.every((s) => !/\d/.test(s)),
       `and not one of them claims a saving (${why.savings.join(",")})`);
    await finish(pg, errors, "nothing beat the original", "shot-state-passthrough.png");
  }

  /* ======================= 5. A 60-CHARACTER FILENAME ====================
     A real export name out of a screen grabber. It appears in two places - the
     row in the list and the heading over the comparison - and both are checked
     at a desktop width and again at 375px, because a long name in a narrow box
     is the whole of this state.

     Neither width stands in for the other. Both places are governed by one set
     of rules on a desktop and a different set below the phone breakpoint, and
     when this was proved by breaking it, the desktop rules failed at 1440px
     while 375px stayed green because the narrow rules had replaced them.

     The second width is set with width and height only. Turning on phone
     emulation makes puppeteer reload the page to apply it, and the app's
     confirm-before-leaving guard has nobody to answer it under automation, so
     that reload never returns. */
  {
    const { pg, errors } = await reach("a 60-character filename", [LONG_NAME, "ui.png"]);
    const heading = () => pg.evaluate((full) => {
      const field = document.getElementById("insp-name");
      const title = document.querySelector(".float-bar.bottom .insp-title");
      const bar = document.getElementById("bar-bottom");
      const dl = document.getElementById("dl-one");
      return {
        width: document.documentElement.clientWidth,
        value: field.value, ext: document.getElementById("insp-ext").textContent,
        whole: field.value + document.getElementById("insp-ext").textContent === full,
        readable: window.__readable(field, field.value),
        insideTitle: Math.round(field.getBoundingClientRect().right) <=
                     Math.round(title.getBoundingClientRect().right) + 1,
        insideBar: Math.round(title.getBoundingClientRect().right) <=
                   Math.round(bar.getBoundingClientRect().right) + 1,
        actionOnScreen: window.__vis(dl) &&
          Math.round(dl.getBoundingClientRect().right) <= document.documentElement.clientWidth,
      };
    }, LONG_NAME);
    const row = () => pg.evaluate((full) => {
      const rows = window.__rows();
      const it = rows.find((r) => r.name === full);
      return { width: document.documentElement.clientWidth, rows: rows.length, row: it };
    }, LONG_NAME);

    ok(LONG_NAME.length === 60, `the fixture's name is 60 characters (${LONG_NAME.length})`);

    for (const width of [1440, 375]) {
      if (width !== 1440) {
        await pg.setViewport({ width, height: 844 });
        await settle(800);
      }
      /* The heading first - a batch opens on its first image, which is this one
         - then the list behind it. Both hold the same name. */
      await pg.evaluate(() =>
        selectItem(state.items.find((i) => i.name.length === 60).id));
      await settle(500);
      const h = await heading();
      say(`heading at ${width}px`, h);
      ok(h.whole, `${width}px: the whole name is still there to read (${h.value}${h.ext})`);
      ok(h.readable >= READABLE_MIN,
         `${width}px: ${h.readable} characters of it are legible, want ${READABLE_MIN}+`);
      ok(h.insideTitle && h.insideBar,
         `${width}px: the field stays inside its heading and its bar (${
           JSON.stringify([h.insideTitle, h.insideBar])})`);
      ok(h.actionOnScreen, `${width}px: and has not pushed the download off the screen`);
      const fitsHeading = await pg.evaluate(() => ({
        overhang: window.__overhang(), sideways: window.__sideways(),
      }));
      ok(fitsHeading.overhang.length === 0 && !fitsHeading.sideways,
         `${width}px: the long name moves nothing off the screen (${
           fitsHeading.overhang.join("; ") || "clean"})`);

      await openTheList(pg);
      const r = await row();
      say(`row at ${width}px`, r);
      ok(!!r.row, `${width}px: the long name has a row of its own`);
      ok(r.row.readableName >= READABLE_MIN,
         `${width}px: ${r.row.readableName} characters are legible in the list, want ` +
         `${READABLE_MIN}+`);
      ok(r.row.right <= r.width,
         `${width}px: the row ends inside the viewport (${r.row.right} of ${r.width})`);
      ok(SIZES_OK.test(r.row.sizes),
         `${width}px: and the name has not squeezed the weights out (${r.row.sizes})`);
    }
    await finish(pg, errors, "a 60-character filename", "shot-state-longname.png");
  }

  /* ======================= 6. A DAMAGED FILE AMONG GOOD ONES =============
     The one that matters most: a failure must cost exactly one image. The
     others finish, the bad one is named, and the batch's arithmetic counts what
     was actually produced - a failed image has no new weight, and summing it in
     would turn the total into nothing at all. */
  {
    const { pg, errors } = await reach("a damaged file among good ones",
                                       ["corrupt.png", "ui.png", "logo.png"]);
    const toast = await pg.evaluate(() => document.getElementById("toast").textContent);
    await openTheList(pg);
    const mixed = await pg.evaluate(() => {
      const ready = state.items.filter((i) => ["done", "saved"].includes(i.status));
      return {
        ...window.__views(),
        statuses: state.items.map((i) => `${i.name}:${i.status}`),
        readyCount: ready.length,
        rows: window.__rows(),
        count: document.getElementById("queue-count").textContent,
        foot: document.getElementById("queue-foot").textContent,
        totals: document.getElementById("t-sizes").textContent,
        savedTotal: document.getElementById("t-saved").textContent,
        saveLabel: document.getElementById("save-label").textContent,
        /* What the total would have to say if it were computed from the ready
           images alone, using the app's own formatting so the comparison is
           about the arithmetic and not about rounding. */
        readyOnly: `${human(ready.reduce((s, i) => s + i.originalBytes, 0))} → ` +
                   `${human(ready.reduce((s, i) => s + i.newBytes, 0))}`,
        downloads: window.__downloads(),
      };
    });
    say("a damaged file among good ones", { ...mixed, toast });
    ok(mixed.readyCount === 2,
       `the good images still finished (${mixed.statuses.join(", ")})`);
    const badRow = mixed.rows.find((r) => r.name === "corrupt.png");
    ok(!!badRow && /damaged|couldn't be read/i.test(badRow.sizes),
       `the damaged one is named and explained in its own row (${badRow && badRow.sizes})`);
    ok(mixed.rows.filter((r) => r.name !== "corrupt.png").every((r) => SIZES_OK.test(r.sizes)),
       `and the rows either side of it still carry their weights (${
         mixed.rows.map((r) => r.sizes.slice(0, 24)).join(" | ")})`);
    ok(mixed.count === "3" && /2 ready/.test(mixed.foot) && /1 failed/.test(mixed.foot),
       `three arrived, two are ready, one failed, and the footer says all three (${
         mixed.count} / ${mixed.foot})`);
    ok(mixed.totals === mixed.readyOnly,
       `the batch total is the two that worked (${mixed.totals} against ${mixed.readyOnly})`);
    ok(!/—|NaN|Infinity/.test(mixed.totals + mixed.savedTotal),
       `so it is a pair of weights rather than a dash (${mixed.totals} / ${mixed.savedTotal})`);
    const pct = Number((mixed.savedTotal.match(/\((\d+)%\)/) || [])[1]);
    ok(pct > 0 && pct < 100,
       `and the percentage is a real one (${mixed.savedTotal})`);
    ok(/all 2\b/.test(mixed.saveLabel),
       `the download offers the two files it has (${mixed.saveLabel})`);
    ok(/across 2 images?/.test(toast),
       `and the run's own summary counts two, not three (${toast})`);
    await finish(pg, errors, "a damaged file among good ones", "shot-state-mixed.png");
  }
} finally { await b.close(); server.kill(); }

console.log(bad === 0
  ? "\nOK - all six states are designed, not fallbacks"
  : `\n${bad} problem(s)`);
process.exit(bad ? 1 : 0);
