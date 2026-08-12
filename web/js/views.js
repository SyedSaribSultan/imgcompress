/* Which encode is on the stage.
 *
 * A run produces several complete files, not one. The engine names a winner, and
 * every other encode it tried is kept as bytes alongside it - so choosing a
 * different one is a swap, not a re-run, and it finishes in the same frame as the
 * tap that asked for it.
 *
 * A "view" is one of those files in the shape the stage reads. Swapping views
 * never destroys the engine's own answer: `item.auto` holds it for the whole
 * life of the item, and the winner chip is the way back to it.
 */

import { state, ORIGINAL_PICK } from "./state.js";
import { fmtLabel } from "./format.js";

/** Move the transferred candidate buffers onto the item as blobs. Blobs are
 *  backed by the browser's own store rather than the JS heap, which is what makes
 *  holding every encode of every image in a large batch affordable. */
export function adoptCandidateBytes(item) {
  item.candBlobs = new Map();
  for (const row of item.candidates) {
    if (!row.data) continue;
    item.candBlobs.set(row.format, new Blob([row.data], { type: row.mime || "" }));
    delete row.data;   // the rows are plain data from here on
  }
}

/** The engine's own answer, in the shape a view takes. */
export function autoView(r, blob) {
  return {
    fmt: r.fmt,
    /* Passthrough ships the original bytes, so its name keeps the original's
       extension - left null and resolved at download time, because the file may
       be renamed between now and then. */
    ext: r.passthrough ? null : (r.ext || null),
    blob,
    newBytes: r.newBytes,
    level: r.level, score: r.score, lossless: !!r.lossless,
    note: r.note || "", passthrough: !!r.passthrough,
  };
}

function candidateView(it, row) {
  return {
    fmt: row.format, ext: row.ext || null,
    blob: it.candBlobs.get(row.format),
    newBytes: row.bytes,
    level: row.lossless ? null : (row.level ?? null),
    score: row.lossless ? null : row.score,
    lossless: !!row.lossless,
    note: "", passthrough: false,
  };
}

/** Keeping the file exactly as it arrived. The File object is already a Blob, so
 *  this costs nothing and needs no encoder. */
function originalView(it) {
  return {
    fmt: ORIGINAL_PICK, ext: null, blob: it.file,
    newBytes: it.originalBytes,
    level: null, score: null, lossless: true,
    note: "Kept exactly as it arrived — not compressed.", passthrough: true,
  };
}

/** Point the item's live fields at one of those views. The old object URL is
 *  revoked first: a batch of large images swapped a few times each will hold
 *  every one of them alive otherwise. */
export function applyView(it, view) {
  if (!view || !view.blob) return false;
  if (it.afterURL) URL.revokeObjectURL(it.afterURL);
  it.fmt = view.fmt;
  it.ext = view.ext;
  it.afterBlob = view.blob;
  it.afterURL = URL.createObjectURL(view.blob);
  it.newBytes = view.newBytes;
  it.level = view.level;
  it.score = view.score;
  it.lossless = view.lossless;
  it.note = view.note;
  it.passthrough = view.passthrough;
  return true;
}

/** Which chip is the one currently on screen. */
export function currentPick(it) {
  if (it.pick) return it.pick;
  if (it.auto?.passthrough) return ORIGINAL_PICK;
  return it.auto?.fmt || "";
}

/** Tapping a chip. The whole point of this path is that it finishes now: the
 *  picture changes under the finger that touched it, which is how someone finds
 *  out they had a choice without ever being told they did.
 *
 *  Returns the sentence to acknowledge with, or "" if nothing changed. It does
 *  not render and does not toast - the caller owns both, so this stays callable
 *  from a test without a document. */
export function chooseCandidate(format) {
  const it = state.selected ? state.byId.get(state.selected) : null;
  if (!it || !it.auto) return "";
  if (currentPick(it) === format) return "";     // already the one on screen

  let view, said;
  if (format === ORIGINAL_PICK) {
    view = originalView(it);
    said = "Keeping your original — nothing compressed";
  } else if (format === it.auto.fmt && !it.auto.passthrough) {
    view = it.auto;                              // the winner chip IS the way back
    said = "Back to the smallest one that passed";
  } else {
    const row = it.candidates.find((c) => c.format === format);
    view = row && candidateView(it, row);
    said = view && `Keeping ${fmtLabel(format)} for this image`;
  }
  if (!applyView(it, view)) return "";

  it.pick = (view === it.auto) ? null : format;
  /* The diff was computed against the previous result, so it is now wrong. Drop
     it and let the stage rebuild it on demand rather than showing a heatmap of
     an encode nobody is looking at any more. */
  it.diffURL = null;
  return said;
}
