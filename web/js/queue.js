/* Rendering the queue.
 *
 * Rows are reconciled by id rather than rebuilt. A batch re-renders on almost
 * every worker message, and replacing the list's innerHTML each time would throw
 * away focus, the scroll position and the selection ring several times a second -
 * which is exactly what it used to do.
 *
 * This module renders and nothing else. It attaches no handlers; main.js listens
 * once on the container and reads the row's data-id. That is what keeps a
 * renderer that runs constantly from accumulating listeners.
 */

import { $, setText, show } from "./dom.js";
import { state, isReady, isBusy, totals } from "./state.js";
import { human, fmtLabel } from "./format.js";

const rows = new Map();   // id -> the element showing it

/** The second line of a row: what happened, or what is happening. */
function subLine(it) {
  switch (it.status) {
    case "queued":
      return { text: it.stale ? "updating to your new settings…" : "waiting", tone: "" };
    case "working":
      return {
        text: it.stale ? "updating to your new settings…" : (it.progress || "working…"),
        tone: "",
      };
    case "failed":
      return { text: it.error || "failed", tone: "bad" };
    case "cancelled":
      return { text: "stopped", tone: "" };
    default: {
      const pct = it.originalBytes
        ? Math.round((1 - it.newBytes / it.originalBytes) * 100) : 0;
      const saved = pct > 0 ? `−${pct}%` : "no smaller";
      /* Pixels removed is said on the same line as the %, always. */
      const shrunk = it.outW && (it.outW !== it.width || it.outH !== it.height)
        ? " · shrunk" : "";
      const kept = it.status === "saved" ? " · downloaded" : "";
      return {
        text: `${human(it.originalBytes)} → ${fmtLabel(it.fmt)} · ${saved}${shrunk}${kept}`,
        tone: pct > 0 ? "good" : "",
      };
    }
  }
}

function makeRow(it) {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "row";
  el.dataset.id = it.id;
  el.setAttribute("role", "option");
  el.innerHTML =
    '<img class="thumb" alt="" decoding="async">' +
    '<span class="name"></span>' +
    '<span class="now num"></span>' +
    '<span class="sub"></span>' +
    '<span class="track" hidden><i></i></span>';
  return el;
}

function paintRow(el, it) {
  const thumb = el.querySelector(".thumb");
  if (it.thumbURL && thumb.getAttribute("src") !== it.thumbURL) {
    thumb.src = it.thumbURL;
  }
  setText(el.querySelector(".name"), it.name);
  setText(el.querySelector(".now"), isReady(it) ? human(it.newBytes) : "");

  const sub = el.querySelector(".sub");
  const { text, tone } = subLine(it);
  setText(sub, text);
  sub.className = `sub${tone ? ` ${tone}` : ""}`;

  /* Progress is only drawn while there is progress to draw. A track sitting at
     zero on a finished row reads as a job that never started. */
  const track = el.querySelector(".track");
  const busy = it.status === "working";
  show(track, busy);
  if (busy) track.firstElementChild.style.transform = `scaleX(${it.frac || 0})`;

  /* Status and chosen format as data attributes as well as words. Anything that
     needs to know what state a row is in - a stylesheet, the browser harness -
     reads these rather than parsing the sentence, which is display text and free
     to be reworded. */
  el.dataset.status = it.status;
  el.dataset.format = it.fmt || "";
  el.setAttribute("aria-selected", String(state.selected === it.id));
  // The row's whole accessible name, so a screen reader gets the file and its
  // result in one read rather than four unlabelled fragments.
  el.setAttribute("aria-label", `${it.name}. ${text}`);
}

export function renderQueue() {
  const list = $("queue-list");
  const any = state.items.length > 0;

  show($("queue-empty"), !any);
  show(list, any);
  show($("queue-foot"), any);
  show($("clear-btn"), any);
  setText($("queue-count"), String(state.items.length));

  // Drop the rows whose items are gone, so a cleared queue leaves no orphans.
  for (const [id, el] of rows) {
    if (!state.byId.has(id)) { el.remove(); rows.delete(id); }
  }

  let prev = null;
  for (const it of state.items) {
    let el = rows.get(it.id);
    if (!el) { el = makeRow(it); rows.set(it.id, el); }
    paintRow(el, it);
    // Keep the DOM order equal to the model order without touching rows that are
    // already in the right place.
    const shouldFollow = prev ? prev.nextElementSibling : list.firstElementChild;
    if (shouldFollow !== el) list.insertBefore(el, shouldFollow || null);
    prev = el;
  }

  renderBatch();
  renderFoot();
}

/* Progress across the whole run, as a hairline under the bar. Each image
   contributes its own fraction, so the line advances smoothly through a batch
   rather than jumping once per completed file. */
function renderBatch() {
  const n = state.items.length;
  if (!n) {
    $("batch-bar").style.transform = "scaleX(0)";
    $("batch").setAttribute("aria-valuenow", "0");
    return;
  }
  let done = 0;
  for (const it of state.items) {
    if (isReady(it) || it.status === "failed" || it.status === "cancelled") done += 1;
    else if (it.status === "working") done += it.frac || 0;
  }
  const frac = done / n;
  $("batch-bar").style.transform = `scaleX(${frac})`;
  $("batch").setAttribute("aria-valuenow", String(Math.round(frac * 100)));
  // A finished run has nothing left to report, so the line goes away rather than
  // sitting full across the page as a permanent 100%.
  $("batch").style.opacity = state.items.some(isBusy) ? "1" : "0";
}

function renderFoot() {
  const t = totals();
  /* Totals over the images that actually have a result. A failed image contributes
     nothing to either side - counting its original in "before" and nothing in
     "after" would report a saving that never happened. */
  setText($("t-sizes"), t.ready ? `${human(t.before)} → ${human(t.after)}` : "");
  setText($("t-saved"), t.saved ? `${human(t.saved)} saved` : "");

  const failed = state.items.filter((i) => i.status === "failed").length;
  const working = state.items.filter(isBusy).length;
  const parts = [];
  if (t.ready) parts.push(`${t.ready} ready`);
  if (working) parts.push(`${working} working`);
  if (failed) parts.push(`${failed} failed`);
  setText($("t-count"), parts.join(" · "));

  const ready = state.items.filter(isReady).length;
  const busy = state.items.some(isBusy);
  const btn = $("save-btn");
  // Present only when it would do something. See the note in index.html.
  show(btn, ready > 0);
  btn.disabled = !ready || busy;
  // The button says what it will actually produce. One image is a file; several
  // are a zip, and calling that "Download all" without saying so is how people
  // end up surprised by an archive.
  setText($("save-label"), ready > 1 ? `Download ${ready} as zip` : "Download");
}
