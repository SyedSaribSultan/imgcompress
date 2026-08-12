/* Getting files in: the picker, a drop, a paste.
 *
 * All three land in addFiles, which is the only place an item is created. That
 * matters because an item's shape is a contract with the engine and with every
 * renderer, and three entry points building it three ways is three shapes.
 */

import { toast } from "./dom.js";
import { state, uid, select } from "./state.js";
import { SUPPORTED } from "./format.js";
import { beginBatch, dispatch, startEngine } from "./engine.js";
import { renderQueue } from "./queue.js";
import { renderStage } from "./compare.js";
import { renderFacts } from "./facts.js";
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

export function addFiles(files) {
  const usable = [...files].filter((f) => SUPPORTED.test(f.name) || /^image\//.test(f.type));
  if (!usable.length) {
    // What happened, then what to do about it. "Unsupported" on its own leaves
    // someone guessing which of their files was the problem and what would work.
    toast("Those file types aren't supported. Try PNG, JPEG, WebP, AVIF, GIF, BMP or TIFF.");
    return;
  }

  startEngine();
  const firstEver = state.items.length === 0;

  for (const file of usable) {
    const item = {
      id: uid(),
      name: file.name || "pasted image.png",
      file,
      originalBytes: file.size,
      status: "queued",
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
    measure(item);
    makeThumb(item);
  }

  beginBatch();
  if (!firstEver) toast(`Added ${usable.length} image${usable.length === 1 ? "" : "s"}`);

  /* The first frame belongs to the file, untouched. These render synchronously
     rather than being scheduled, so the original's src is in the document
     immediately, and the work is held until the frame after that - so the browser
     has actually painted the picture before a single encoder is asked for
     anything. It is a few milliseconds, and it is the difference between "here is
     your image, now watch" and "something happened to my file". */
  renderQueue();
  renderStage();
  renderFacts();
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
