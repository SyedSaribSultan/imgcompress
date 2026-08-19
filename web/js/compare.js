/* The stage: the original and the result, and the geometry that keeps them
 * registered to each other.
 *
 * One #frame holds both layers at the original's natural pixel size, and the
 * frame is what zooms and pans. That is the reason the two cannot drift apart -
 * a single transform moves both, so any pixel of the result sits over the pixel
 * of the original it replaced at every zoom level.
 *
 * The result may be smaller than the original in pixels, because resizing is part
 * of the plan. It is drawn stretched to the original's box on purpose: what is
 * being compared is how the two look at the size they will be seen at, not their
 * pixel grids.
 *
 * The split is applied as a clip on the top layer in the frame's own
 * coordinates, recomputed from where the divider actually is on screen. That is
 * why the caliper cuts where it appears to cut however far the image has been
 * pushed around.
 */

import { $, setText, show, toast } from "./dom.js";
import { state, current, isReady } from "./state.js";
import {
  human, fmtLabel, splitName, clock, videoResultLine,
} from "./format.js";

let mode = "split";
let zoom = 0;                 // 0 means "fit"; any other number is explicit
let pan = { x: 0, y: 0 };
let diffFor = null;           // which item+pick the heatmap on screen was built for

export const getMode = () => mode;

/* Read-only views of the zoom state, for the browser harness. probe_zoom.mjs
 * asserts that `frame centre - pan == stage centre` at every scale, which needs
 * the actual numbers - it is the check that notices if anyone goes back to
 * centring the frame by CSS alignment instead of by transform. */
export const getZoom = () => zoom;
export const getPan = () => ({ ...pan });

/** Set the zoom state directly. Harness only. probe_flow needs to start its
 *  cursor-anchor test already overflowing on both axes - while an axis still fits,
 *  the clamp correctly pins it to centre and there is nothing to anchor - and it
 *  shoves the pan to infinity to prove the clamp does not lose the image. */
export function setView({ zoom: z, pan: p } = {}) {
  if (z != null) zoom = z;
  if (p) pan = { ...p };
  applyZoom();
}

/* ------------------------------- geometry -------------------------------- */

function frameSize() {
  const it = current();
  return { w: it?.width || 0, h: it?.height || 0 };
}

/** How much of the stage the floating bars actually occlude, measured live so
 *  a wrapped bar counts at its wrapped height. Fit must place the whole image
 *  BETWEEN them: chrome over content is the one thing the stage must not do
 *  to its own default view. */
function barOcclusion() {
  const view = $("view").getBoundingClientRect();
  const top = document.querySelector(".stage-bar.top").getBoundingClientRect();
  const bottom = document.querySelector(".stage-bar.bottom").getBoundingClientRect();
  const GAP = 8;
  return {
    top: top.height ? Math.max(0, top.bottom - view.top + GAP) : 0,
    bottom: bottom.height ? Math.max(0, view.bottom - bottom.top + GAP) : 0,
  };
}

/** The scale that fits the image in the viewport, between the bars. Capped at
 *  1:1 so a 48px icon is shown at its own size rather than blown up to fill a
 *  900px region - "fit" should never invent detail that is not there. */
function fitScale() {
  const view = $("view");
  const { w, h } = frameSize();
  if (!w || !h) return 1;
  const box = view.getBoundingClientRect();
  if (!box.width || !box.height) return 1;
  const occ = barOcclusion();
  const availH = Math.max(80, box.height - occ.top - occ.bottom);
  return Math.min(box.width / w, availH / h, 1);
}

/** At fit, the image centres in the space BETWEEN the bars, not behind them. An
 *  explicit zoom is the person's own framing and gets the whole stage. */
function fitOffsetY() {
  if (zoom) return 0;
  const occ = barOcclusion();
  return (occ.top - occ.bottom) / 2;
}

const scaleNow = () => zoom || fitScale();

/** Keep the image reachable, and keep it covering the stage.
 *
 *  The limit on each axis is exactly the overhang: half the amount by which the
 *  scaled frame exceeds the viewport. Pan to the limit and the frame's edge meets
 *  the viewport's edge; there is no way to open a gap, and no way to flick the
 *  picture off screen with nothing but Fit to get it back.
 *
 *  When an axis already fits, the limit is zero and that axis is pinned to centre -
 *  correct rather than restrictive, because an image smaller than its window has
 *  nothing to pan to. An earlier version added a quarter-viewport of slack on top
 *  of the overhang, which let the image be dragged partly off the stage and left a
 *  band of empty background along one edge. */
function clampPan() {
  const view = $("view").getBoundingClientRect();
  const s = scaleNow();
  const { w, h } = frameSize();
  const limX = Math.max(0, (w * s - view.width) / 2);
  const limY = Math.max(0, (h * s - view.height) / 2);
  pan.x = Math.max(-limX, Math.min(limX, pan.x));
  pan.y = Math.max(-limY, Math.min(limY, pan.y));
}

export function applyZoom() {
  const s = scaleNow();
  clampPan();
  /* The -50% pair is what centres it, against the element's own box rather than
     the layout - see the note in compare.css. It has to come first so the pan and
     the scale are applied inside that centred position. */
  const frame = $("frame");
  frame.style.transform =
    `translate(-50%, -50%) translate(${pan.x}px, ${pan.y + fitOffsetY()}px) scale(${s})`;
  // Past 1:1, pixels stay pixels. Inspecting compression artefacts through a
  // smoothing filter would be inspecting the filter.
  $("view").dataset.sharp = s >= 1.5 ? "1" : "0";
  setText($("zoom-label"), zoom ? `${Math.round(s * 100)}%` : "Fit");
  applySplit();
}

/** Zoom about a point, so the pixel under the cursor stays under the cursor. */
export function zoomAt(dir, clientX, clientY) {
  const view = $("view").getBoundingClientRect();
  const before = scaleNow();
  const next = Math.max(0.05, Math.min(16, before * (dir > 0 ? 1.25 : 1 / 1.25)));
  // The anchor, measured from the viewport's centre because that is where the
  // grid has already placed the frame's own centre.
  const ax = (clientX == null ? view.width / 2 : clientX - view.left) - view.width / 2;
  const ay = (clientY == null ? view.height / 2 : clientY - view.top) - view.height / 2;
  const ratio = next / before;
  pan.x = ax - (ax - pan.x) * ratio;
  pan.y = ay - (ay - pan.y) * ratio;
  zoom = next;
  applyZoom();
}

export const stepZoom = (dir) => zoomAt(dir, null, null);

export function resetZoom() {
  zoom = 0;
  pan = { x: 0, y: 0 };
  applyZoom();
}

export function panBy(dx, dy) {
  pan.x += dx;
  pan.y += dy;
  applyZoom();
}

/* --------------------------------- split --------------------------------- */

/** Convert the divider's position on screen into a clip in the frame's own
 *  coordinates. Reading the live rect is what makes this survive zoom and pan
 *  without either of them having to know the split exists. */
export function applySplit() {
  const pct = Number($("split").value);
  $("divider").style.left = `${pct}%`;

  const view = $("view").getBoundingClientRect();
  const frame = $("frame").getBoundingClientRect();
  if (!frame.width) return;
  const dividerX = view.left + (view.width * pct) / 100;
  const inFrame = ((dividerX - frame.left) / frame.width) * 100;
  /* Written on the FRAME, not on a layer. There are two `.after` layers now -
     one for pictures, one for video - and a custom property set on the first
     one found would clip that one and leave the other showing whole. Setting
     it on their common parent lets it inherit into both, which is what a
     custom property is for. */
  $("frame").style.setProperty("--clip", `${Math.max(0, Math.min(100, inFrame))}%`);

  /* The side labels ride the caliper, but they must never ride it off the
     stage - a label that has left the viewport stops orienting anyone. Pushed
     to an edge, each tag slides along the line just enough to stay readable. */
  const x = (view.width * pct) / 100;
  const tagL = $("tag-l"), tagR = $("tag-r");
  const overL = tagL.offsetWidth + 16 - x;
  const overR = tagR.offsetWidth + 16 - (view.width - x);
  tagL.style.transform = overL > 0 ? `translateX(${overL}px)` : "";
  tagR.style.transform = overR > 0 ? `translateX(${-overR}px)` : "";
}

/* ---------------------------------- mode --------------------------------- */

export function setMode(next) {
  /* The heatmap is built from two decoded stills, and a video has no single
     "the picture" to decode - so Diff is not offered on one, and asking for it
     lands on the split rather than on a blank canvas. The reason is SAID, not
     only parked in a title a touch screen and a screen reader never meet. */
  if (next === "diff" && current()?.isVideo) {
    toast("The difference view is for pictures — a video changes every "
      + "moment, so there is no one picture to compare.");
    next = "split";
  }
  mode = next;
  $("view").dataset.mode = next;
  for (const m of ["split", "after", "diff"]) {
    $(`mode-${m}`).setAttribute("aria-pressed", String(m === next));
  }
  /* With the caliper hidden there is nothing on screen saying WHICH image is
     showing, and an unlabelled heatmap is a chart without a legend. The badge
     is both, and absent in split mode where the caliper already says it. */
  const badge = $("mode-badge");
  show(badge, next !== "split" && !!current());
  setText(badge, next === "after"
    ? (current()?.isVideo ? "Showing the compressed video" : "Showing the compressed picture")
    : "Difference — brighter means more change");
  if (next === "diff") ensureDiff();
  applySplit();
}

/* ---------------------------- the diff heatmap ---------------------------- */

/* Where the two images differ, and by how much. Built from the decoded pixels of
 * both, once per result, and cached against the pick it was built for - swapping
 * to another encode invalidates it, because a heatmap of a file nobody is looking
 * at is worse than none.
 *
 * The scale is deliberately exaggerated: at a floor of 90 the honest difference
 * is nearly invisible, and a black rectangle would be a true image that told
 * nobody anything. What the colour means is stated on the page beside it. */
async function ensureDiff() {
  const it = current();
  const key = it && `${it.id}:${it.fmt}:${it.newBytes}`;
  if (!it || !isReady(it) || diffFor === key) return;

  const canvas = $("img-diff");
  try {
    /* Decode straight to heatmap scale. The heatmap is at most 2048 wide, and
       decoding a 12MP original in full on the main thread just to shrink it
       again was tens of milliseconds of jank per press of D. When the width is
       not yet known the full decode is the honest fallback. */
    const opts = it.width
      ? { resizeWidth: Math.min(it.width, 2048), resizeQuality: "high" }
      : {};
    const [a, b] = await Promise.all([
      createImageBitmap(it.file, opts),
      createImageBitmap(it.afterBlob, opts),
    ]);
    const w = Math.min(a.width, 2048);
    const h = Math.round((a.height / a.width) * w);

    const grab = (bmp) => {
      const c = new OffscreenCanvas(w, h);
      const ctx = c.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0, w, h);
      return ctx.getImageData(0, 0, w, h);
    };
    const pa = grab(a), pb = grab(b);
    a.close?.(); b.close?.();

    const out = new ImageData(w, h);
    for (let i = 0; i < pa.data.length; i += 4) {
      // Perceived brightness, then the gap between the two, amplified.
      const la = 0.299 * pa.data[i] + 0.587 * pa.data[i + 1] + 0.114 * pa.data[i + 2];
      const lb = 0.299 * pb.data[i] + 0.587 * pb.data[i + 1] + 0.114 * pb.data[i + 2];
      const d = Math.min(255, Math.abs(la - lb) * 8);
      out.data[i] = d;                    // heat runs dark -> red -> white
      out.data[i + 1] = Math.max(0, d - 128) * 2;
      out.data[i + 2] = Math.max(0, d - 192) * 4;
      out.data[i + 3] = 255;
    }
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d").putImageData(out, 0, 0);
    diffFor = key;
  } catch {
    // Some files this browser cannot decode twice. Say so rather than showing a
    // blank canvas that looks like "no difference".
    diffFor = null;
    setText($("chip-why"), "This browser could not decode both versions, so the difference cannot be drawn.");
  }
}

/* --------------------------------- video --------------------------------- */

/* Two players, one clock.
 *
 * Comparing video means the same instant on both sides: a split showing second
 * 3 against second 5 is not a comparison, it is two videos. So the compressed
 * side FOLLOWS the original rather than both running free - two independent
 * players drift apart within seconds, and no amount of starting them together
 * fixes it. The same approach the desktop app uses, deliberately, so the two
 * interfaces behave identically.
 *
 * Bound once, at boot, from main.js - like every other listener in this app.
 * These are the media's own mechanics rather than interface handlers, but they
 * still get attached exactly once, in one place, for the same reason: the
 * renderers run several times a second. */
export function bindPlayers() {
  const before = $("vid-before");
  const after = $("vid-after");

  const follow = () => {
    if (!after.getAttribute("src") || after.readyState < 1) return;
    // A tolerance, not an assignment on every tick: writing currentTime on a
    // playing element re-seeks it, which stutters the very thing being judged.
    if (Math.abs(after.currentTime - before.currentTime) > 0.08) {
      after.currentTime = before.currentTime;
    }
  };
  before.addEventListener("timeupdate", () => { follow(); paintTransport(); });
  before.addEventListener("seeked", follow);
  before.addEventListener("play", () => { follow(); after.play().catch(() => {}); });
  before.addEventListener("pause", () => { after.pause(); paintTransport(); });
  before.addEventListener("loadedmetadata", paintTransport);
  before.addEventListener("play", paintTransport);
  before.addEventListener("ended", paintTransport);
}

/** Play, or stop. One button, and it says which of the two it is about to do. */
export function togglePlay() {
  const before = $("vid-before");
  if (!before.getAttribute("src")) return;
  if (before.paused) before.play().catch(() => {});
  else before.pause();
  paintTransport();
}

/** Move both players to a point in the clip. The original is the one moved;
 *  the compressed side follows it, as it does everywhere else. */
export function seekTo(fraction) {
  const before = $("vid-before");
  if (!before.duration || !isFinite(before.duration)) return;
  before.currentTime = Math.max(0, Math.min(1, fraction)) * before.duration;
}

function paintTransport() {
  const before = $("vid-before");
  const playing = !before.paused && !before.ended;
  const btn = $("vid-play");
  setText(btn, playing ? "Pause" : "Play");
  btn.setAttribute("aria-label", playing ? "Pause the video" : "Play the video");
  const total = isFinite(before.duration) ? before.duration : 0;
  setText($("vid-time"), `${clock(before.currentTime || 0)} / ${clock(total)}`);
  const seek = $("vid-seek");
  // Never fight a finger already on the scrubber.
  if (document.activeElement !== seek && total) {
    seek.value = String(Math.round((before.currentTime / total) * 1000));
  }
}

/* Which pair of layers is live, and what they are showing. The picture layers
 * and the video layers are the same two positions in the same frame, so
 * everything downstream - the clip, the zoom, the pan - is unchanged. */
function paintMedia(it, hasResult) {
  const video = !!it.isVideo;
  const vBefore = $("vid-before"), vAfter = $("vid-after");

  show($("img-before"), !video);
  show($("img-after-wrap"), !video);
  show(vBefore, video);
  show($("vid-after-wrap"), video);
  show($("transport"), video);
  /* A heatmap of one frame of a clip would be a true picture of something
     nobody asked about. aria-disabled rather than disabled=: the button stays
     focusable and clickable, and pressing it lands on setMode's guard, which
     says why out loud - a disabled= control keeps its reason to itself. */
  const diffBtn = $("mode-diff");
  diffBtn.setAttribute("aria-disabled", String(video));
  diffBtn.title = video ? "The difference view is for pictures" : "";

  if (!video) {
    // Release the decoders, and the file behind them, when a picture is picked.
    if (vBefore.getAttribute("src")) { vBefore.pause(); vBefore.removeAttribute("src"); vBefore.load(); }
    if (vAfter.getAttribute("src")) { vAfter.pause(); vAfter.removeAttribute("src"); vAfter.load(); }
    if (it.beforeURL && $("img-before").getAttribute("src") !== it.beforeURL) {
      $("img-before").src = it.beforeURL;
    }
    /* Reconcile to what this item actually has, the way the video layers below
       do. Guarding the assignment on `hasResult` used to leave the element
       holding the previous item's blob URL, so selecting a picture that had not
       been compressed yet showed the last one's result as if it were its own. */
    const wantAfter = hasResult ? it.afterURL : "";
    if (($("img-after").getAttribute("src") || "") !== wantAfter) {
      if (wantAfter) $("img-after").src = wantAfter;
      else $("img-after").removeAttribute("src");
      diffFor = null;
    }
    return;
  }

  if (it.beforeURL && vBefore.getAttribute("src") !== it.beforeURL) {
    vBefore.src = it.beforeURL;
    paintTransport();
  }
  const want = hasResult ? it.afterURL : "";
  if ((vAfter.getAttribute("src") || "") !== want) {
    if (want) vAfter.src = want;
    else { vAfter.removeAttribute("src"); vAfter.load(); }
    // A result that arrives mid-playback starts where the original already is.
    if (want) vAfter.currentTime = vBefore.currentTime || 0;
  }
}

/* --------------------------------- render -------------------------------- */

export function renderStage() {
  const it = current();
  const ready = it && isReady(it);
  const working = it && it.status === "working";
  /* There is something real to show: a finished result, a live preview the
     bake-off has already produced, or the previous result held on screen while
     its replacement is computed. All three carry honest numbers. */
  const hasResult = !!(it && it.afterURL && it.fmt);

  /* Arriving at a video with the heatmap on screen: the mode goes back to the
     split rather than leaving a canvas showing the difference between two
     pictures nobody is looking at any more. */
  if (it && it.isVideo && mode === "diff") setMode("split");

  show($("stage-hero"), !it);
  show($("stage-empty"), !it);
  // The empty state carries its own exit: a dead end that only describes
  // itself forces a visual search for what to do next.
  show($("stage-choose"), !state.items.length);
  show($("view"), !!it);
  show($("split"), !!it && mode === "split");
  show($("mode-badge"), !!it && mode !== "split" && it.status !== "failed");
  show($("stage-work"), !!(working || (it && it.stale)));
  // The bottom bar is about a result, so it goes away rather than showing
  // dashes where numbers will later be.
  show(document.querySelector(".stage-bar.bottom"), hasResult);
  show(document.querySelector(".stage-bar.top"), !!it);

  if (!it) {
    setText($("stage-empty"), "Nothing to compare yet.");
    return;
  }

  if (it.status === "failed") {
    show($("view"), false);
    show($("mode-badge"), false);
    show($("stage-hero"), true);
    show($("stage-empty"), true);
    show($("stage-choose"), false);
    setText($("stage-empty"),
      `Could not compress this ${it.isVideo ? "video" : "image"} — ${it.error || "unknown reason"}.`);
    return;
  }

  const { w, h } = frameSize();
  const frame = $("frame");
  if (w && h) {
    frame.style.width = `${w}px`;
    frame.style.height = `${h}px`;
  }

  // The original is on screen from the moment the file is read, including while
  // the work is still running: the untouched picture is what is true right now.
  paintMedia(it, hasResult);

  if (working || it.stale) {
    setText($("work-say"), it.stale
      ? "Updating to your new settings…"
      : (it.progress || "working…"));
  }

  if (hasResult) {
    const { base } = splitName(it.name);
    const nameField = $("out-name");
    // Never write over what is being typed.
    if (document.activeElement !== nameField) nameField.value = base;
    setText($("out-ext"), it.ext || splitName(it.name).ext);
    /* A video's result line carries both sizes itself, in the approved words,
       so the standalone size would be the same number twice on one bar. The
       clipboard takes no video either - the button goes rather than sitting
       there disabled with no explanation. */
    show($("s-size"), !it.isVideo);
    show($("copy-one"), !it.isVideo);
    if (it.isVideo) {
      /* One line, and every disclosure it owes is on it: the resize and the
         byte ceiling ride with the percentage, never after it. */
      setText($("s-saved"), videoResultLine(it));
    } else {
      /* A saving of zero is reported as no saving, not as "−0%". Rounding a
         result that got no smaller into a percentage claims a win of nothing,
         which is worse than saying plainly that nothing was gained.

         And if pixels were removed, the line that says the % says so - at the
         same size, in the same breath. A headline number that quietly includes
         a resize is the least trustworthy number on the page. */
      setText($("s-size"), human(it.newBytes));
      const pct = it.originalBytes
        ? Math.round((1 - it.newBytes / it.originalBytes) * 100) : 0;
      const shrunk = it.outW && (it.outW !== it.width || it.outH !== it.height)
        ? ` · shrunk to ${it.outW}×${it.outH}` : "";
      setText($("s-saved"), (pct > 0
        ? `−${pct}% · ${fmtLabel(it.fmt)}`
        : `no saving · ${fmtLabel(it.fmt)}`) + shrunk);
    }
  }

  if (mode === "diff" && !it.isVideo) ensureDiff();
  applyZoom();
}

/** A new image on the stage starts fitted. Carrying the previous image's zoom
 *  over means arriving at a 400% crop of a picture you have not seen yet. */
export function onSelectionChanged() {
  zoom = 0;
  pan = { x: 0, y: 0 };
  diffFor = null;
  renderStage();
}
