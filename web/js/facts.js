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
import {
  state, current, isReady, ORIGINAL_PICK, effectiveSettings, videoPlan, D,
} from "./state.js";
import {
  human, duration, clock, fmtLabel, scoreText, signedPct,
} from "./format.js";
import { currentPick } from "./views.js";

/** The floor this item was actually run against. A video reads the video
 *  column of the destination table and a picture reads the picture one, and
 *  showing a video's result against a picture's floor would be the panel
 *  reporting a promise nobody made. */
function floorFor(it) {
  return it.isVideo
    ? (it.videoFloor ?? videoPlan(it)?.qualityTarget ?? effectiveSettings(it).qualityTarget)
    : effectiveSettings(it).qualityTarget;
}

/* -------------------------------- versions ------------------------------- */

function chipRows(it, ready) {
  /* Mid-run the chips are the live candidates - each one already a complete,
     real file - marked "kept" only in the sense of "the one on the stage right
     now". The done message replaces them with the authoritative ranking. */
  const source = ready ? it.candidates : (it.liveCandidates || []);
  const rows = source.map((c) => ({
    format: c.format,
    bytes: c.bytes,
    lossless: !!c.lossless,
    score: c.score,
    win: ready
      ? (!it.auto.passthrough && c.format === it.auto.fmt)
      : (it.livePickBytes != null && c.format === it.fmt),
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
    win: ready ? !!it.auto.passthrough : false,
  });
  return rows;
}

function renderChips(it, ready) {
  const box = $("cands");
  const pick = ready ? currentPick(it) : (it.fmt || "");
  const floor = floorFor(it);
  box.textContent = "";

  for (const row of chipRows(it, ready)) {
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
    if (under) {
      b.dataset.under = "1";
      // The first encounter with "under floor" defines it, in place.
      b.title = `Scored ${scoreText(row.score, false)}, below the ${floor} the plan asks for. ` +
        `Still a real file — pick it if size matters more than that promise.`;
    }
    const match = row.lossless
      ? "identical"
      : (row.score == null ? "" : `match ${scoreText(row.score, false)}`);

    /* Mid-run the chips are informational, not yet controls: choosing among
       candidates that are still arriving is a race the person cannot win.
       On a video they are informational for good: a run of encodes of a
       picture all fit in memory and every one of them is kept, so tapping is a
       swap - a run of encodes of a video does not, so only the winner exists
       and a chip that promised a swap would be a control that lies. The
       sentence under the row says exactly that. */
    b.disabled = !ready || !!it.isVideo;
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
function whyLine(it, ready) {
  if (!ready) {
    const tried = it.liveCandidates?.length || 0;
    const total = it.formats || tried;
    return `Still working: ${tried} of ${total} version${total === 1 ? "" : "s"} `
         + `tried so far. Every one shown here is finished and real.`;
  }
  const floor = floorFor(it);
  if (it.isVideo) return videoWhyLine(it, floor);
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
  /* One candidate deserves its reason: an automatic system that narrowed the
     field must say what narrowed it, or the narrowing reads as a fault. */
  if (tried <= 1) {
    const pinned = effectiveSettings(it).formats?.length === 1;
    return `Only ${fmtLabel(it.auto.fmt)} could be written here — ` +
      (pinned
        ? "it is the file type pinned in the plan."
        : "no other format this browser can write could hold this picture.");
  }
  return `${fmtLabel(it.auto.fmt)} was the smallest of ${passed} version` +
         `${passed === 1 ? "" : "s"} that reached your floor of ${floor}, out of ` +
         `${tried} tried. Tap any other one to keep it instead.`;
}

/** Why this video came out the way it did.
 *
 *  Deliberately not the picture sentence with a noun swapped: the two tiers
 *  differ in a way the person can act on. Every version tried is listed with
 *  what it weighed and what it measured, but only the one that shipped still
 *  exists, so there is nothing to tap - and saying so is better than a row of
 *  dead chips with no explanation. */
function videoWhyLine(it, floor) {
  if (it.auto?.passthrough) {
    return it.note || "This video was kept exactly as it arrived.";
  }
  const tried = it.candidates?.length || 0;
  const short = it.score != null && it.score < floor;
  const ranking = tried > 1
    ? `${fmtLabel(it.auto.fmt)} came out smallest of the ${tried} ways this browser tried. `
    : `${fmtLabel(it.auto.fmt)} is the one way this browser could write this video. `;
  const measured = short
    ? `It measured ${scoreText(it.score, false)} against your floor of ${floor}, `
      + `so it did not reach it — the desktop app searches harder and can. `
    : `It measured ${scoreText(it.score, false)} against your floor of ${floor}. `;
  return ranking + measured
    + "Only the version that shipped is kept — a video is too big to hold every "
    + "attempt — so these are a record rather than something to swap between.";
}

/* -------------------------------- measured ------------------------------- */

function renderMeasured(it) {
  setText($("s-format"), fmtLabel(it.fmt));
  /* The bare figure was the one number on the page that did not carry its
     meaning in place: 70.2 of what? The scale rides along here; the words for
     what the number means stay in the why-line and the warning below. */
  setText($("s-score"), it.lossless || it.score == null
    ? scoreText(it.score, it.lossless)
    : `${scoreText(it.score, false)} of 100`);
  setText($("s-dims"), it.outW && it.outH
    ? (it.outW === it.width && it.outH === it.height
        ? `${it.width}×${it.height}`
        : `${it.width}×${it.height} → ${it.outW}×${it.outH}`)
    : "—");
  setText($("s-time"), duration(it.elapsedMs));

  /* How long the clip runs - the fact that explains why this one took minutes
     where a picture took a second. Video only: a still has no length, and a
     stat reading "0:00" on every picture would be four characters of noise on
     every row of the panel. */
  show($("s-length-cell"), !!it.isVideo);
  if (it.isVideo) setText($("s-length"), clock(it.duration));

  const noun = it.isVideo ? "video" : "picture";

  /* Resizing and compressing are different things, and adding their savings
     together hides which one did the work. Said apart - and said FIRST, at
     full strength, above the numbers it affects, because a shrink disclosed in
     fine print under an impressive percentage is the disclosure happening
     backwards. */
  const resized = it.outW && (it.outW !== it.width || it.outH !== it.height);
  const resizeLine = $("s-resize");
  if (resized) {
    const pct = it.originalBytes && Number.isFinite(it.newBytes)
      ? Math.round((1 - it.newBytes / it.originalBytes) * 100) : 0;
    setText(resizeLine,
      (pct > 0
        ? `Part of the −${pct}% comes from shrinking the ${noun} from `
        : `The ${noun} was shrunk from `)
      + `${it.width}×${it.height} to ${it.outW}×${it.outH}`
      + (pct > 0 ? ` — not just from compressing it` : "")
      + `. The visual match below was measured on the compression alone.`);
  }
  show(resizeLine, !!resized);
  /* The undo, exactly where the realisation happens. Offered only while the
     shrink is actually undoable - a positive limit in force that an override
     can zero. When the destination's own ceiling did it (the limit is already
     zero and the ceiling fired anyway), pretending otherwise would be worse
     than the shrink. */
  const limit = it.isVideo
    ? (videoPlan(it)?.maxDimension || 0) : effectiveSettings(it).maxDimension;
  show($("keep-size"), !!resized && limit > 0);
  setText($("keep-size"), `Keep full size for this ${noun}`);

  const notes = [];
  if (it.note) notes.push(it.note);
  if (it.lossless && !it.passthrough) {
    notes.push("This one is lossless — the pixels are identical, not merely close.");
  }
  /* Whether the sound was copied or made again. Shown only when the engine
     says so: the container, the codec and whether a copy was even possible are
     the engine's facts, and a panel that guessed at them would be guessing
     about the half of the file it never measured. */
  if (it.isVideo && it.audioNote) notes.push(it.audioNote);
  const note = $("s-note");
  show(note, notes.length > 0);
  setText(note, notes.join(" "));

  /* Warning-level, not note-level: things the person asked for that could not
     be honoured. A size cap that could not be met without wrecking the image,
     or a "never shrink" the destination's own ceiling overrode. */
  const warns = [...(it.warnings || [])];
  if (it.missedSize && it.sizeTarget) {
    warns.unshift(`Could not get under ${human(it.sizeTarget)} without visible damage. ` +
                  `This is the smallest version still worth keeping.`);
  }
  if (it.isVideo && !it.passthrough) {
    /* Two things a video can owe an explanation for, both of them comparisons
       of numbers the engine reported against numbers the plan asked for -
       never a guess about what the engine did internally.

       The floor first: the browser's encoder is tuned for video calls rather
       than for archives, so a clip can finish honestly short of the mark. It
       says so rather than letting a measured number sit there looking like a
       pass. */
    const floor = floorFor(it);
    if (it.score != null && floor && it.score < floor) {
      warns.unshift(`This reached a visual match of ${scoreText(it.score, false)}, `
        + `under the ${floor} this destination asks for. It is a real file and a `
        + `real measurement — the desktop app searches harder and gets closer.`);
    }
    // And the destination's own byte ceiling, which the browser tier does not
    // search against. A result over it would not do the job the destination
    // exists for, so it is said here instead of being discovered by Discord.
    if (it.sizeTarget && it.newBytes > it.sizeTarget) {
      warns.unshift(`This is still over the ${human(it.sizeTarget)} that this `
        + `destination is for. The desktop app can search for a file that fits.`);
    }
  }
  if (it.hardCapped && !effectiveSettings(it).maxDimension) {
    const cap = D.DOCUMENTS_MAX_DIMENSION;
    warns.unshift(`You asked for no shrinking, but design tools damage anything over ` +
                  `${cap} px when you import it — so this was shrunk to ${cap} px first. ` +
                  `Pick a different “Going to” if you need every pixel.`);
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
  /* The format override lists picture formats, and a video cannot be a PNG.
     Hidden rather than left offering choices that would be ignored - the
     quality override beside it applies to both and stays. */
  show($("ov-format").closest(".field"), !it.isVideo);
  show($("ov-reset"), !!it.override);
  /* Same courtesy the plan's selects give (settings.js): the panel is narrow
     and these options are sentences, so the chosen words stay hoverable when
     the collapsed control cannot show them whole. */
  for (const id of ["ov-format", "ov-quality"]) {
    const sel = $(id);
    const opt = sel.selectedOptions[0];
    sel.title = opt ? opt.textContent : "";
  }
}

/* --------------------------------- render -------------------------------- */

export function renderFacts() {
  const it = current();
  const ready = !!(it && isReady(it) && it.auto);
  /* Live evidence: the bake-off has finished candidates but not the whole run.
     They are real files with real measurements, so they are shown. */
  const live = !!(it && !ready && it.liveCandidates?.length);

  /* The evidence appears when there is evidence. Before any exists this region
     used to sit as dimmed scaffolding - three headings, em-dashes, and
     "Nothing measured yet" - which is clutter explaining its own absence. */
  show($("facts"), ready || live);

  if (!ready && !live) {
    $("cands").textContent = "";
    for (const id of ["s-format", "s-score", "s-dims", "s-time"]) setText($(id), "—");
    show($("s-length-cell"), false);
    show($("s-resize"), false);
    show($("keep-size"), false);
    show($("s-note"), false);
    show($("s-warn"), false);
    $("ov-apply").disabled = true;
    $("remove-btn").disabled = !it;
    return;
  }

  // The override re-runs an image; mid-run that is a race, so it waits - and
  // the button itself says which of the two states it is in.
  $("ov-apply").disabled = !ready;
  setText($("ov-apply"), ready ? "Compress again" : "Working…");
  $("remove-btn").disabled = false;
  renderChips(it, ready);
  setText($("chip-why"), whyLine(it, ready));
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
