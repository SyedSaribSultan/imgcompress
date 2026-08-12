/* Rendering #facts - the evidence behind the file that was kept.
 *
 * The chips are the interesting part. Every one of them is a complete file that
 * already exists, which is why they are buttons and not a legend: tapping one
 * swaps the stage in the same frame, and nothing is re-encoded. The engine's own
 * pick is marked in words as well as with a border.
 *
 * Like queue.js this renders and nothing else - main.js listens once on the chip
 * container. A renderer that runs on every worker message must not be a place
 * where handlers accumulate.
 */

import { $, setText, show } from "./dom.js";
import { state, current, isReady, ORIGINAL_PICK, effectiveSettings } from "./state.js";
import { human, duration, fmtLabel, scoreText, signedPct } from "./format.js";
import { currentPick } from "./views.js";

/* -------------------------------- versions ------------------------------- */

function chipRows(it) {
  const rows = it.candidates.map((c) => ({
    format: c.format,
    bytes: c.bytes,
    lossless: !!c.lossless,
    score: c.score,
    win: !it.auto.passthrough && c.format === it.auto.fmt,
  }));
  /* The encodes are ranked smallest first, so the row reads as a ranking. */
  rows.sort((a, b) => a.bytes - b.bytes);

  /* Keeping the file as it arrived is a real candidate and belongs in the same row
     as the encodes, not hidden behind a separate control - but it goes last
     regardless of what it weighs, because it is the yardstick rather than a
     competitor. Sorting it in by size put "Original" in the middle of the ranking
     on any image the encoders could not beat, which reads as though not
     compressing were one of the compression results. It is marked as the winner
     when nothing beat it, which is a result and not a failure. */
  rows.push({
    format: ORIGINAL_PICK,
    bytes: it.originalBytes,
    lossless: true,
    score: null,
    win: !!it.auto.passthrough,
  });
  return rows;
}

function renderChips(it) {
  const box = $("cands");
  const pick = currentPick(it);
  const floor = effectiveSettings(it).qualityTarget;
  box.textContent = "";

  for (const row of chipRows(it)) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip";
    b.dataset.format = row.format;
    /* The size in machine form as well as in words. The chips are ranked smallest
       first, and that ordering is a promise the browser harness checks - reading it
       back off the rendered "337.9 KB" would be parsing a display string. */
    b.dataset.bytes = String(row.bytes);
    if (row.win) b.dataset.win = "1";
    b.setAttribute("aria-pressed", String(pick === row.format));

    // Always against the original, including for the original's own chip, where
    // it reads "same size" and confirms that is what keeping it means.
    const delta = signedPct(it.originalBytes, row.bytes);

    /* The encoder tries formats that then miss the floor, and they stay in this
       row because choosing one is a legitimate thing to want. But a chip showing
       only "252 KB, -71%" makes the cheapest option look like the best one, and
       the reason it lost is invisible. So every lossy chip carries its score, and
       one that came in under the floor says so. */
    const under = !row.lossless && row.score != null && row.score < floor;
    if (under) b.dataset.under = "1";
    const match = row.lossless
      ? "identical"
      : (row.score == null ? "" : `match ${scoreText(row.score, false)}`);

    b.innerHTML =
      `<span class="cf">${fmtLabel(row.format)}</span>` +
      `<span class="cb num">${human(row.bytes)}</span>` +
      `<span class="cd num">${delta || ""}${match ? ` · ${match}` : ""}</span>`;
    // The whole story in the accessible name, since the spans are meaningless
    // read one at a time.
    b.setAttribute("aria-label",
      `${fmtLabel(row.format)}, ${human(row.bytes)}` +
      `${delta ? `, ${delta} of the original` : ""}` +
      `${match ? `, ${match}` : ""}` +
      `${under ? `, below your floor of ${floor}` : ""}` +
      `${row.win ? ", the version kept" : ""}`);
    box.appendChild(b);
  }
}

/** Why the winner won, in one sentence.
 *
 *  It deliberately does not say "all of these cleared your floor". They did not:
 *  the encoder reports everything it tried, including formats that came in under,
 *  and claiming otherwise on the panel whose whole job is "we measured this" was
 *  the least trustworthy thing in view. */
function whyLine(it) {
  const floor = effectiveSettings(it).qualityTarget;
  if (it.pick) {
    const chosen = it.candidates.find((c) => c.format === it.pick);
    const under = chosen && !chosen.lossless && chosen.score != null && chosen.score < floor;
    return `Showing ${fmtLabel(it.pick)} because you chose it` +
           `${under ? `, and it scored under your floor of ${floor}` : ""}. ` +
           `The engine kept ${fmtLabel(it.auto.passthrough ? ORIGINAL_PICK : it.auto.fmt)}.`;
  }
  if (it.auto.passthrough) {
    return "Nothing beat the original, so it was kept exactly as it arrived.";
  }
  const tried = it.candidates.length;
  const passed = it.candidates.filter(
    (c) => c.lossless || c.score == null || c.score >= floor).length;
  if (tried <= 1) return `Only ${fmtLabel(it.auto.fmt)} could be written here.`;
  return `${fmtLabel(it.auto.fmt)} was the smallest of ${passed} version` +
         `${passed === 1 ? "" : "s"} that reached your floor of ${floor}, out of ` +
         `${tried} tried. Tap any other one to keep it instead.`;
}

/* -------------------------------- measured ------------------------------- */

function renderMeasured(it) {
  setText($("s-format"), fmtLabel(it.fmt));
  setText($("s-score"), scoreText(it.score, it.lossless));
  setText($("s-dims"), it.outW && it.outH
    ? (it.outW === it.width && it.outH === it.height
        ? `${it.width}×${it.height}`
        : `${it.width}×${it.height} → ${it.outW}×${it.outH}`)
    : "—");
  setText($("s-time"), duration(it.elapsedMs));

  /* Resizing and compressing are different things, and adding their savings
     together hides which one did the work. Said apart. */
  const resized = it.outW && it.outW !== it.width;
  const notes = [];
  if (it.note) notes.push(it.note);
  if (resized) {
    notes.push(`Part of this saving is the resize to ${it.outW}×${it.outH}. ` +
               `The visual match above was measured on the compression alone.`);
  }
  if (it.lossless && !it.passthrough) {
    notes.push("This one is lossless — the pixels are identical, not merely close.");
  }
  const note = $("s-note");
  show(note, notes.length > 0);
  setText(note, notes.join(" "));

  /* A size cap that could not be met without wrecking the image. The engine ships
     the smallest file still worth looking at and says so. */
  const warns = [...(it.warnings || [])];
  if (it.missedSize && it.sizeTarget) {
    warns.unshift(`Could not get under ${human(it.sizeTarget)} without visible damage. ` +
                  `This is the smallest version still worth keeping.`);
  }
  const warn = $("s-warn");
  show(warn, warns.length > 0);
  setText(warn, warns.join(" "));
}

/* ---------------------------------- redo --------------------------------- */

let syncedFor = null;

function renderRedo(it) {
  // Only write the override controls when the selection moves. Rewriting them on
  // every render would fight anyone typing in them mid-batch.
  if (syncedFor !== it.id) {
    syncedFor = it.id;
    $("ov-format").value = it.override?.formats?.[0] || "";
    $("ov-quality").value = it.override?.qualityTarget ?? "";
  }
  show($("ov-reset"), !!it.override);
}

/* --------------------------------- render -------------------------------- */

export function renderFacts() {
  const it = current();
  const ready = it && isReady(it) && it.auto;

  // Every block keeps its heading and goes quiet, rather than the region
  // collapsing and moving everything below it.
  for (const id of ["versions", "measured", "redo"]) {
    $(id).style.opacity = ready ? "1" : "0.45";
  }

  if (!ready) {
    $("cands").textContent = "";
    setText($("chip-why"), it
      ? "Nothing measured yet for this image."
      : "Add an image to see every version that was tried.");
    for (const id of ["s-format", "s-score", "s-dims", "s-time"]) setText($(id), "—");
    show($("s-note"), false);
    show($("s-warn"), false);
    $("ov-apply").disabled = true;
    $("remove-btn").disabled = !it;
    return;
  }

  $("ov-apply").disabled = false;
  $("remove-btn").disabled = false;
  renderChips(it);
  setText($("chip-why"), whyLine(it));
  renderMeasured(it);
  renderRedo(it);
}

/** Force the override controls to re-read on the next render, for when they have
 *  been changed from outside - a reset, or a fresh run of the same image. */
export function invalidateRedo() {
  syncedFor = null;
}

/** What the override controls currently say, or null for "follow the plan". */
export function readOverride() {
  const fmt = $("ov-format").value;
  const q = $("ov-quality").value.trim();
  const quality = q === "" ? null : Math.max(60, Math.min(99, Number(q)));
  if (!fmt && quality == null) return null;
  const o = {};
  if (fmt) o.formats = [fmt];
  if (quality != null && isFinite(quality)) o.qualityTarget = quality;
  return o;
}

/** Which items the override applies to. Only ever the one on the stage - the
 *  plan is the whole-queue control, and this is deliberately not. */
export function overrideTarget() {
  const it = current();
  return it && state.byId.has(it.id) ? it : null;
}
