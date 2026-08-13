/* The width sweep: the page at every size anyone actually uses, measured for
 * the failures a fixed-viewport probe cannot see.
 *
 *   node tests/web/probe_widths.mjs
 *
 * At each width it asserts four things, empty AND populated:
 *   1. no horizontal document scroll;
 *   2. no two sidebar regions overlap (the queue rendering on top of the plan
 *      is the bug this probe exists for - probe_mobile checked overhang and
 *      touch targets and passed while the sections sat on top of each other);
 *   3. nothing inside the sidebar is clipped by the sidebar's own edge;
 *   4. below 861px every interactive control clears the 44px touch floor.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer, { CHROME } from "./resolve_puppeteer.mjs";
import { uploadAndFinish } from "./drive.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8193;
const FIX = path.join(here, "fixtures");

const server = spawn("node", [path.join(here, "serve.mjs"), String(PORT)], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 900));

const b = await puppeteer.launch({
  executablePath: CHROME, headless: true, protocolTimeout: 3_600_000,
});
let bad = 0;
const ok = (c, n) => { if (c) console.log(`  ok ${n}`); else { console.error(`FAIL ${n}`); bad++; } };

const WIDTHS = [320, 360, 375, 414, 430, 568, 600, 768, 800, 860, 861, 900, 1024, 1280, 1440, 1920];

/* Everything measured inside the page, one evaluate per width. */
async function measure(pg) {
  return pg.evaluate(() => {
    const el = (id) => document.getElementById(id);
    const vis = (e) => {
      if (!e) return false;
      const cs = getComputedStyle(e);
      if (cs.display === "none" || cs.visibility === "hidden") return false;
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const rect = (e) => {
      const r = e.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, r: r.right, b: r.bottom };
    };

    // 1. sideways scroll
    const doc = document.documentElement;
    const sideways = doc.scrollWidth - doc.clientWidth;

    // 2. region overlap - measured on the CONTENT boxes, not just the section
    //    shells. A section squashed to zero height does not intersect anything
    //    itself; its overflowing children do, and they are what a person sees
    //    painted on top of the plan. Zero-height shells are their own failure.
    const contentIds = ["queue-empty", "queue-list", "plan-fields", "cli-note"];
    const shellIds = ["queue-sec", "plan-sec"];
    const boxes = [...contentIds, ...shellIds]
      .map((id) => ({ id, e: el(id) }))
      .filter(({ e }) => vis(e))
      .map(({ id, e }) => ({ id, ...rect(e) }));
    const overlaps = [];
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], c = boxes[j];
        // A shell legitimately contains its own content; only disjoint
        // pairs are judged.
        if ((a.id === "queue-sec" && ["queue-empty", "queue-list"].includes(c.id)) ||
            (c.id === "queue-sec" && ["queue-empty", "queue-list"].includes(a.id)) ||
            (a.id === "plan-sec" && c.id === "plan-fields") ||
            (c.id === "plan-sec" && a.id === "plan-fields")) continue;
        const ox = Math.min(a.r, c.r) - Math.max(a.x, c.x);
        const oy = Math.min(a.b, c.b) - Math.max(a.y, c.y);
        if (ox > 1 && oy > 1) overlaps.push(`${a.id}+${c.id} by ${Math.round(ox)}x${Math.round(oy)}`);
      }
    }
    // A region that is on the page must have real height: a 0px shell is the
    // squash bug even before its content lands on a neighbour.
    for (const id of shellIds) {
      const e = el(id);
      if (e && !e.hidden && e.getBoundingClientRect().height < 24) {
        overlaps.push(`${id} squashed to ${Math.round(e.getBoundingClientRect().height)}px`);
      }
    }

    // 3. clipped by the sidebar's own right edge. A child painting past #side
    //    is covered by the stage, which reads as text sliced mid-word.
    const side = el("side");
    const clipped = [];
    if (vis(side)) {
      const sr = side.getBoundingClientRect();
      for (const child of side.querySelectorAll("p, label, .field, .pair, button, select, input, #cli-note, h2, .muted, summary")) {
        if (!vis(child)) continue;
        const cr = child.getBoundingClientRect();
        if (cr.right > sr.right + 1.5) {
          clipped.push(`${child.id || child.className || child.tagName} +${Math.round(cr.right - sr.right)}px`);
        }
      }
    }

    // 4. touch floor for the controls a finger has to hit. A checkbox wrapped
    //    in its label is measured as the label, because the label is the
    //    target - the whole row toggles it.
    const small = [];
    for (let c of document.querySelectorAll("button, select, input:not([hidden]), summary, a")) {
      if (!vis(c)) continue;
      if (c.matches('input[type="checkbox"]') && c.closest("label")) c = c.closest("label");
      const r = c.getBoundingClientRect();
      if (r.height < 43.5) small.push(`${c.id || c.textContent.trim().slice(0, 18)} ${Math.round(r.height)}px`);
    }

    return { sideways, overlaps, clipped: clipped.slice(0, 6), small: [...new Set(small)].slice(0, 8) };
  });
}

function judge(width, label, m, { touch }) {
  ok(m.sideways <= 0, `${width}px ${label}: no sideways scroll (${m.sideways}px)`);
  ok(m.overlaps.length === 0, `${width}px ${label}: regions tile, never stack (${m.overlaps.join("; ") || "clean"})`);
  ok(m.clipped.length === 0, `${width}px ${label}: nothing clipped at the sidebar edge (${m.clipped.join("; ") || "clean"})`);
  if (touch) {
    ok(m.small.length === 0, `${width}px ${label}: every control clears 44px (${m.small.join("; ") || "clean"})`);
  }
}

try {
  const pg = await b.newPage();
  pg.on("pageerror", (e) => { console.error("[pageerror]", String(e)); bad++; });
  await pg.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "networkidle0" });
  await pg.waitForFunction(() => typeof state !== "undefined");

  // Two heights: the squash bug only fired when the viewport was short enough
  // that the constrained grid had to steal from somewhere.
  const HEIGHTS = [667, 900];

  // ---- empty, every width --------------------------------------------------
  for (const height of HEIGHTS) {
    for (const width of WIDTHS) {
      await pg.setViewport({ width, height });
      await new Promise((r) => setTimeout(r, 120));
      judge(width, `empty @${height}`, await measure(pg), { touch: width < 861 });
    }
  }

  // ---- populated, every width ----------------------------------------------
  await pg.setViewport({ width: 1280, height: 900 });
  await uploadAndFinish(pg, [path.join(FIX, "ui.png"), path.join(FIX, "logo.png")], 900_000);
  for (const height of HEIGHTS) {
    for (const width of WIDTHS) {
      await pg.setViewport({ width, height });
      await new Promise((r) => setTimeout(r, 120));
      judge(width, `with results @${height}`, await measure(pg), { touch: width < 861 });
    }
  }
} finally {
  await b.close();
  server.kill();
}

console.log(bad ? `\n${bad} failed` : "\nOK — every width tiles, nothing clipped");
process.exit(bad ? 1 : 0);
