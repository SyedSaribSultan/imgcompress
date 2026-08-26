/* COPIED from web/js/intake.js by tools/sync_webui_assets.py - DO NOT EDIT.
 * Edit the file in web/ and re-run the tool; CI fails on a stale copy. */
/* Getting files in: the picker, a drop, a paste.
 *
 * All three land in addFiles, which is the only place an item is created. That
 * matters because an item's shape is a contract with the engine and with every
 * renderer, and three entry points building it three ways is three shapes.
 */

import { toast } from "./dom.js";
import {
  state, uid, select, canEncodeVideo, NO_VIDEO_HERE,
  HEAVY_VIDEO_BYTES, TOO_BIG_VIDEO_BYTES,
  HEAVY_VIDEO_WARNING, TOO_BIG_VIDEO_HERE,
} from "./state.js";
import { SUPPORTED, SUPPORTED_MIME, isVideoFile } from "./format.js";
import {
  beginBatch, dispatch, startEngine, probeVideoSupport,
} from "./engine-local.js";
import { renderQueue } from "./queue.js";
import { renderStage } from "./compare.js";
import { renderFacts } from "./facts.js";
import { reflectPlan } from "./settings.js";
import { scheduleRender } from "./render.js";

/* A small square, decoded straight to thumbnail scale. Decoding a 12MP original
 * in full on the main thread just to draw it at 36px was the single heaviest
 * thing the interface did per file, and with a couple of dozen files it made the
 * page stutter while the workers were already busy. */
async function makeThumb(item) {
  try {
    const side = 72;                       // 2x the drawn size, for sharp output
    let bmp;
    try {
      // Width only: giving both axes would force them and distort the frame.
      bmp = await createImageBitmap(item.file, { resizeWidth: side, resizeQuality: "low" });
    } catch {
      bmp = await createImageBitmap(item.file);        // older engines
    }
    const scale = Math.max(side / bmp.width, side / bmp.height);
    const c = document.createElement("canvas");
    c.width = side; c.height = side;
    const ctx = c.getContext("2d");
    ctx.imageSmoothingQuality = "medium";
    ctx.drawImage(bmp,
      (side - bmp.width * scale) / 2, (side - bmp.height * scale) / 2,
      bmp.width * scale, bmp.height * scale);
    bmp.close?.();

    /* The natural size, learned here rather than waited for. The engine reports it
       too, but the stage needs a frame the moment the original is painted - which
       is before any encoder has been asked for anything. */
    if (!item.width) { item.width = bmp.width; item.height = bmp.height; }

    const blob = await new Promise((r) => c.toBlob(r, "image/png"));
    if (blob && state.byId.has(item.id)) {
      item.thumbURL = URL.createObjectURL(blob);
      scheduleRender("queue");
    }
  } catch { /* a file this browser cannot decode simply keeps a blank thumb */ }
}

/* A video's own first frame, for the row and for the stage's geometry.
 *
 * Two facts arrive here, both before any encoder has been asked for anything:
 * the shape the picture is (so #frame can be the right size on the first
 * paint) and how long the clip runs (so a row can say "0:34" rather than
 * leaving a person guessing why this one is taking minutes). The poster is a
 * seek to just past the start - frame zero of a lot of real footage is black,
 * and a black square reads as a file that failed to open. */
function measureVideo(item) {
  const probe = document.createElement("video");
  probe.preload = "metadata";
  probe.muted = true;
  probe.playsInline = true;

  probe.addEventListener("loadedmetadata", () => {
    if (!state.byId.has(item.id)) return;
    item.width = probe.videoWidth || 0;
    item.height = probe.videoHeight || 0;
    item.duration = isFinite(probe.duration) ? probe.duration : 0;
    if (!item.outW) { item.outW = item.width; item.outH = item.height; }
    scheduleRender();
    try {
      probe.currentTime = Math.min(0.1, (item.duration || 0) / 2);
    } catch { /* an engine that will not seek simply keeps a blank thumb */ }
  }, { once: true });

  probe.addEventListener("seeked", () => {
    if (!state.byId.has(item.id) || !probe.videoWidth) return;
    try {
      const side = 72;
      const c = document.createElement("canvas");
      c.width = side; c.height = side;
      const ctx = c.getContext("2d");
      const scale = Math.max(side / probe.videoWidth, side / probe.videoHeight);
      ctx.drawImage(probe,
        (side - probe.videoWidth * scale) / 2,
        (side - probe.videoHeight * scale) / 2,
        probe.videoWidth * scale, probe.videoHeight * scale);
      c.toBlob((blob) => {
        if (!blob || !state.byId.has(item.id)) return;
        item.thumbURL = URL.createObjectURL(blob);
        scheduleRender("queue");
      }, "image/png");
    } catch { /* a frame this browser will not hand over keeps a blank thumb */ }
  }, { once: true });

  probe.addEventListener("error", () => {
    /* Said on the row rather than left as a blank thumbnail: a file the
       browser cannot even open is not going to compress, and finding that out
       now is better than finding it out after a minute of work. */
    if (!state.byId.has(item.id) || item.status !== "queued") return;
    item.status = "failed";
    item.error = "this browser could not open this video";
    scheduleRender();
  }, { once: true });

  probe.src = item.beforeURL;
}

/** Learn the original's real pixel size before the engine reports it, so the
 *  stage has a frame to paint into on the first frame. */
function measure(item) {
  const probe = new Image();
  probe.onload = () => {
    if (!state.byId.has(item.id)) return;
    item.width = probe.naturalWidth;
    item.height = probe.naturalHeight;
    if (!item.outW) { item.outW = item.width; item.outH = item.height; }
    if (state.selected === item.id) scheduleRender("stage");
  };
  probe.src = item.beforeURL;
}

/** "3 pictures", "1 video", "2 files" - the noun follows what is actually
 *  there, because a run of clips reported as "pictures" is the interface
 *  telling a person it did not notice what they dropped. */
export function countWords(images, videos) {
  if (videos && images) return `${images + videos} files`;
  if (videos) return `${videos} video${videos === 1 ? "" : "s"}`;
  return `${images} image${images === 1 ? "" : "s"}`;
}

/** The same words, counted off a list of items rather than from two tallies -
 *  what a caller holding the queue itself needs. */
export function countItemWords(items) {
  let images = 0, videos = 0;
  for (const it of items) { if (it.isVideo) videos += 1; else images += 1; }
  return countWords(images, videos);
}

export function addFiles(files) {
  let usable = [...files].filter(
    (f) => SUPPORTED.test(f.name) || SUPPORTED_MIME.has(f.type) || isVideoFile(f));
  if (!usable.length) {
    // What happened, then what to do about it. "Unsupported" on its own leaves
    // someone guessing which of their files was the problem and what would work.
    toast("Those file types aren't supported. Try PNG, JPEG, WebP, AVIF, GIF, "
      + "BMP or TIFF for pictures, or MP4, MOV, WebM or MKV for video.");
    return;
  }

  /* A browser with no video encoder is told so HERE, at the moment the file is
     handed over - not after a queue row, a progress bar and a minute of
     waiting. Firefox on Android has no WebCodecs at all and Safari had none
     before 17.4; accepting a video from either and failing at the end would be
     the interface knowing something and saying it too late.
     `videoCaps` is null until the probe answers. That is not a no: the file is
     accepted and the engine holds it until the answer arrives, and says this
     same sentence on the row if the answer is no. */
  const videos = usable.filter(isVideoFile);
  if (videos.length) {
    probeVideoSupport();
    if (state.videoCaps && !canEncodeVideo()) {
      usable = usable.filter((f) => !isVideoFile(f));
      toast(NO_VIDEO_HERE);
      if (!usable.length) return;
    }
  }

  /* Size, at the door, for the same reason as capability: a person is entitled
     to know before the wait rather than after it.

     Too big is a refusal WITH A ROUTE - the desktop tier reads from disk and
     is not holding the file in a tab, so it is a real answer rather than a
     brush-off. Merely heavy is not a refusal at all: it is said, and then the
     thing the person asked for happens. Deciding for them would be worse than
     a slow encode. */
  const huge = usable.filter((f) => isVideoFile(f) && f.size > TOO_BIG_VIDEO_BYTES);
  if (huge.length) {
    usable = usable.filter((f) => !huge.includes(f));
    toast(TOO_BIG_VIDEO_HERE);
    if (!usable.length) return;
  }
  if (usable.some((f) => isVideoFile(f) && f.size > HEAVY_VIDEO_BYTES)) {
    toast(HEAVY_VIDEO_WARNING);
  }

  startEngine();
  const firstEver = state.items.length === 0;
  let images = 0, clips = 0;

  for (const file of usable) {
    const video = isVideoFile(file);
    const item = {
      id: uid(),
      name: file.name || (video ? "pasted video.mp4" : "pasted image.png"),
      file,
      originalBytes: file.size,
      status: "queued",
      /* The one flag every other module branches on. Set here, from the file
         itself, rather than discovered after an encode that has not started -
         a row must know what it is holding the moment it appears. */
      isVideo: video,
      duration: 0,
      beforeURL: URL.createObjectURL(file),
      thumbURL: null,
      afterURL: null,
      warnings: [], candidates: [],
      width: 0, height: 0, outW: 0, outH: 0,
      override: null,
      frac: 0,
    };
    state.items.push(item);
    state.byId.set(item.id, item);
    if (!state.selected) select(item.id);
    if (video) { clips += 1; measureVideo(item); }
    else { images += 1; measure(item); makeThumb(item); }
  }

  beginBatch();
  if (!firstEver) toast(`Added ${countWords(images, clips)}`);

  /* The first frame belongs to the file, untouched. These render synchronously
     rather than being scheduled, so the original's src is in the document
     immediately, and the work is held until the frame after that - so the browser
     has actually painted the picture before a single encoder is asked for
     anything. It is a few milliseconds, and it is the difference between "here is
     your image, now watch" and "something happened to my file". */
  renderQueue();
  renderStage();
  renderFacts();
  /* The plan says different things depending on whether a video is in the
     queue - the floor video will really run under, and the destination's byte
     ceiling. Dropping a clip changes both, so the panel is refreshed here
     rather than only when a control is touched. It happens here and not in
     render.js on purpose: that module's whole contract is that renderers never
     reach back into state, and the plan panel is a form, not a renderer. */
  reflectPlan();
  requestAnimationFrame(() => dispatch());
}

/** Drops can contain folders - people drop whole export directories. */
export async function filesFromDataTransfer(dt) {
  const entries = [...(dt.items || [])].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.some((e) => e.isDirectory)) return dt.files;

  const out = [];
  async function walk(entry) {
    if (entry.isFile) {
      const f = await new Promise((res, rej) => entry.file(res, rej)).catch(() => null);
      if (f) out.push(f);
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej)).catch(() => []);
        if (!batch.length) break;
        for (const e of batch) await walk(e);
      }
    }
  }
  for (const e of entries) await walk(e);
  return out;
}
