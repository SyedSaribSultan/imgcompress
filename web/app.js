/* imgcompress web UI — the desktop app's interface, driving an in-browser
 * compression engine (worker.js) instead of a local Python server.
 * No network requests are made anywhere in this file. */

"use strict";

const $ = (id) => document.getElementById(id);
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ------------------------------- helpers --------------------------------- */

function human(n) {
  if (!n && n !== 0) return "—";
  const u = ["B", "KB", "MB", "GB"];
  let v = n, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${i === 0 ? v.toFixed(0) : v.toFixed(1)} ${u[i]}`;
}

/* Read from the footer rather than duplicated here: a second copy of a version
   string is a second thing to forget, and the exported report was still
   claiming 2.2.0 long after the app had moved on. */
const APP_VERSION =
  (document.getElementById("app-version")?.textContent || "").trim().replace(/^v/, "") || "unknown";

/** Elapsed time, at a precision a person can actually use. Sub-second work is
 *  reported in milliseconds because "0.1 s" reads as a rounding artefact,
 *  and anything past a minute gets minutes because "83.4 s" does not. */
function duration(ms) {
  if (ms == null || !isFinite(ms)) return "—";
  if (ms < 950) return `${Math.max(1, Math.round(ms))} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(ms < 9950 ? 1 : 0)} s`;
  const m = Math.floor(ms / 60000);
  return `${m}m ${Math.round((ms - m * 60000) / 1000)}s`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const SUPPORTED = /\.(png|jpe?g|webp|bmp|tiff?|gif)$/i;

/* Format names as a person writes them. The engine's keys are lowercase
   identifiers; showing those raw made the interface read like debug output. */
const FORMAT_LABEL = {
  jpeg: "JPEG", png8: "PNG-8", png: "PNG", webp: "WebP",
  "webp-lossless": "WebP lossless", avif: "AVIF", gif: "GIF",
  // Not an encoder: the choice to keep the file exactly as it arrived, which
  // is a real candidate and the one the original chip stands for.
  original: "Original",
};
const fmtLabel = (f) => FORMAT_LABEL[f] || (f ? f.toUpperCase() : "");

const MIME_OF = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
  bmp: "image/bmp", gif: "image/gif", tif: "image/tiff", tiff: "image/tiff",
};
function mimeFor(file) {
  if (file.type) return file.type;
  const ext = (file.name.match(/\.([a-z0-9]+)$/i) || [, ""])[1].toLowerCase();
  return MIME_OF[ext] || "application/octet-stream";
}

/** Count-up for byte values: the number rolls to its destination. */
function rollNumber(el, toBytes, suffixHtml) {
  if (REDUCED || toBytes < 1024) {
    el.innerHTML = human(toBytes) + (suffixHtml || "");
    return;
  }
  const t0 = performance.now(), dur = 300;
  const tick = (t) => {
    const p = Math.min(1, (t - t0) / dur);
    const eased = 1 - (1 - p) * (1 - p) * (1 - p);
    el.innerHTML = human(toBytes * eased) + (suffixHtml || "");
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/* -------------------------------- state ---------------------------------- */

const state = {
  items: [],
  byId: new Map(),
  /* Taken from the default destination rather than typed out. Repeating its
     frame and quality here made this a fourth copy of two numbers - and one
     that only shows up before anything is stored, so a stale value would be
     wrong for exactly the people arriving for the first time.
     qualityTarget is on the SSIMULACRA 2 scale (0-100); 90 is its published
     "visually lossless" line.
     `formats` null means the comparison decides; a one-element array means the
     person did. `alphaPolicy` only matters when that choice cannot hold the
     image's transparency, and is only ever set by answering the dialog. */
  settings: {
    target: DEFAULT_DESTINATION,
    metric: "ss2",
    qualityTarget: DESTINATION_NUMBERS[DEFAULT_DESTINATION].qualityTarget,
    maxDimension: DESTINATION_NUMBERS[DEFAULT_DESTINATION].maxDimension,
    formats: null,
    alphaPolicy: "png",
  },
  settingsRev: 0,
  caps: { webp: null, png8: null },
  suffix: false,
};

/* DESTINATION_NUMBERS, DESTINATION_ORDER, OLD_TARGET_NAMES and destinationOf()
   come from destinations.js, which index.html loads before this file. It is
   generated from imgcompress/destinations.py and committed; nothing here
   restates a destination's name, frame size or minimum visual match. */

/* The control's own options are built from that table too, rather than typed
   into index.html - a hand-written list would be one more copy to keep in step,
   and this one is the copy a person actually reads. */
function renderDestinationOptions() {
  const group = $("target-destinations");
  if (!group || group.children.length) return;
  for (const name of DESTINATION_ORDER) {
    const d = DESTINATION_NUMBERS[name];
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = d.label;
    opt.title = d.help;
    group.appendChild(opt);
  }
}

/* The Format control is one list spanning "you choose" to "I choose", so its
   value carries both facts. Single-format picks leave the destination's format
   list behind but keep its size cap - a person who picked "Email or chat" and
   then said "JPEG only" still wants it to fit in an email. */
const ONE = "one-";
function parseFormatChoice(value, current) {
  if (!value.startsWith(ONE)) return { target: destinationOf(value), formats: null };
  return { target: destinationOf(current), formats: [value.slice(ONE.length)] };
}
function formatChoiceValue(s) {
  return s.formats && s.formats.length ? ONE + s.formats[0] : destinationOf(s.target);
}

/* Words first, number behind Advanced. The floor is still the single source of
   truth - these are named landmarks on it, not a separate setting. */
const QUALITY_PRESETS = [95, 90, 85, 80, 70];
let selected = null;
let mode = "split";
let zoom = 0;
let pan = { x: 0, y: 0 };
let batchActive = false;
let batchStartedAt = 0;   // wall clock for the run, not the sum of its images
/** Mark the start of a run. Adding files to a run already in flight extends
 *  it rather than restarting the clock. */
function beginBatch() {
  if (!batchActive) batchStartedAt = performance.now();
  batchActive = true;
}
let ovSyncedFor = null;   // which item the override controls currently reflect
const BASE_TITLE = document.title;

function uid() {
  const a = new Uint8Array(8);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const isReady = (i) => i.status === "done" || i.status === "saved";
const isBusy = (i) => i.status === "queued" || i.status === "working";

/* ------------------------- settings persistence -------------------------- */

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem("imgc-settings") || "{}");
    // A target saved before 2.7 is a pre-destination name; map it rather than
    // letting `figma` reach the engine as somewhere that no longer exists.
    if (saved.target) state.settings.target = destinationOf(saved.target);
    // Stored floors from before the metric change were SSIM fractions (<= 1);
    // they mean nothing on the SSIMULACRA 2 scale, so they reset to default.
    // v2: an init-scaling bug once pinned the slider to 99 and pushSettings
    // persisted it. A floor stored without the version stamp is that bug's
    // residue, not a choice, so it resets too. Target/dimension/suffix were
    // never distorted and are honoured regardless.
    if (saved.v >= 2 && saved.qualityTarget >= 60 && saved.qualityTarget <= 99) {
      state.settings.qualityTarget = saved.qualityTarget;
    }
    if (Number.isFinite(saved.maxDimension)) state.settings.maxDimension = saved.maxDimension;
    if (Array.isArray(saved.formats) && saved.formats.length === 1) {
      state.settings.formats = saved.formats;
    }
    if (saved.alphaPolicy === "flatten") state.settings.alphaPolicy = "flatten";
    state.suffix = !!saved.suffix;
  } catch {}
  const choice = formatChoiceValue(state.settings);
  $("target").value = choice;
  // A stored single-format pick whose codec this browser lacks would leave the
  // control blank and the engine on a format it cannot run. Fall back to the
  // recommended automatic set instead of pretending.
  if (!$("target").value) {
    state.settings.formats = null;
    state.settings.target = "web";
    $("target").value = "web";
  }
  // qualityTarget is ALREADY on the slider's 0-100 scale. The old SSIM floor
  // was a fraction and was scaled here; doing that to 90 pinned the slider to
  // its max and silently ran every search at floor 99. See the e2e default
  // assert - this line is why it exists.
  $("quality").value = Math.round(state.settings.qualityTarget);
  $("quality-out").textContent = $("quality").value;
  $("maxdim").value = state.settings.maxDimension;
  $("suffix-toggle").checked = state.suffix;
  reflectQualityHint();
}

function saveSettings() {
  try {
    localStorage.setItem("imgc-settings",
      JSON.stringify({ v: 3, ...state.settings, suffix: state.suffix }));
  } catch {}
}

/* SSIMULACRA 2's published scale, the same one the desktop README prints. */
function hintForQuality(q) {
  if (q >= 95) return "overkill for most things — masters you'll re-edit";
  if (q >= 90) return "default — not noticeable even in a flicker test";
  if (q >= 85) return "imperceptible when A/B toggling";
  if (q >= 80) return "imperceptible side by side";
  if (q >= 70) return "perceptible but not annoying — fine for thumbnails";
  return "visibly compressed";
}
function reflectQualityHint() {
  const q = Number($("quality").value);
  $("quality-note").textContent = hintForQuality(q);
  // The words and the number are one setting seen two ways, so the preset
  // follows the slider. A floor between the landmarks is a real choice, not an
  // error - it gets the hidden "Custom" entry rather than being snapped away.
  const sel = $("quality-preset");
  sel.value = QUALITY_PRESETS.includes(q) ? String(q) : "custom";
  const custom = sel.querySelector('option[value="custom"]');
  custom.hidden = sel.value !== "custom";
  custom.textContent = `Custom — floor ${q}`;
}

/* --------------------------- lifetime statistics -------------------------- */
/* Numbers only — never filenames, never image data. This is the honest
 * version of "social proof": your own totals, computed on your machine. */

function bumpLifetime(images, bytes) {
  try {
    const s = JSON.parse(localStorage.getItem("imgc-stats") || "{}");
    // Clamped: choosing a larger encode after the fact sends a negative delta
    // through here, and a lifetime total is not allowed to go backwards past
    // zero on the way to being corrected.
    const next = {
      images: (s.images || 0) + images,
      bytes: Math.max(0, (s.bytes || 0) + bytes),
    };
    localStorage.setItem("imgc-stats", JSON.stringify(next));
    renderLifetime();
  } catch {}
}
function renderLifetime() {
  try {
    const s = JSON.parse(localStorage.getItem("imgc-stats") || "{}");
    if (!s.images) return;
    const el = $("lifetime");
    el.hidden = false;
    el.textContent = `All time on this device: ${s.images} image${s.images === 1 ? "" : "s"}, ${human(s.bytes)} saved`;
    el.title = "Counted locally. Nothing leaves your browser.";
  } catch {}
}

/* ----------------------------- worker pool ------------------------------- */

/* Leave two threads for the UI and the browser's own decoding, take the rest.
   The old cap of 4 left most of a modern machine idle on a batch; the ceiling
   of 8 is about memory, since each worker keeps one decoded frame cached. */
const POOL_MAX = Math.min(8, Math.max(2, (navigator.hardwareConcurrency || 4) - 2));
const pool = [];

function makeWorker(index) {
  const w = new Worker("worker.js");
  const slot = { w, busy: false, itemId: null, index };
  w.onmessage = (e) => onWorkerMessage(slot, e.data);
  w.onerror = () => {
    if (slot.itemId) {
      const item = state.byId.get(slot.itemId);
      if (item) { item.status = "failed"; item.error = "the compression worker crashed"; }
    }
    slot.busy = false; slot.itemId = null;
    scheduleRender(); dispatch();
  };
  return slot;
}

function ensurePool(want) {
  while (pool.length < Math.min(POOL_MAX, Math.max(1, want))) {
    pool.push(makeWorker(pool.length));
  }
}

function effectiveSettings(item) {
  const s = { ...state.settings };
  if (item.override) {
    if (item.override.formats) { s.formats = item.override.formats; s.target = "web"; }
    if (item.override.qualityTarget != null) s.qualityTarget = item.override.qualityTarget;
  }
  return s;
}

async function dispatch() {
  const queued = state.items.filter((i) => i.status === "queued");
  if (!queued.length) return;
  ensurePool(queued.length);

  /* Start every read at once. This loop used to `await` each file's bytes
     before handing the next item to a worker, so with a dozen files the last
     worker sat idle through eleven sequential reads before it got any work. */
  for (const item of queued) {
    if (!item.bytesPromise) {
      item.bytesPromise = item.file.arrayBuffer().catch(() => null);
    }
  }

  for (const item of queued) {
    // Prefer the worker that last handled this item - its decode cache makes
    // a quality-only re-run start instantly.
    let slot = item.slot != null && pool[item.slot] && !pool[item.slot].busy ? pool[item.slot] : null;
    if (!slot) slot = pool.find((s) => !s.busy);
    if (!slot) return;

    slot.busy = true;
    slot.itemId = item.id;
    item.slot = slot.index;
    item.status = "working";
    item.stage = "reading";
    item.progress = "reading…";
    item.frac = 0;
    // The clock starts when this image actually gets a worker, not when it was
    // dropped: time spent queued behind other images is the batch's, not this
    // image's, and reporting the wait as if it were work would be a lie.
    item.startedAt = performance.now();
    item.elapsedMs = null;
    scheduleRender("queue");
    const buffer = await item.bytesPromise;
    item.bytesPromise = null;   // transferred below; a second read must re-open
    if (!buffer) {
      item.status = "failed";
      item.error = "could not read the file";
      slot.busy = false; slot.itemId = null;
      scheduleRender();
      continue;
    }
    if (!state.byId.has(item.id) || item.status !== "working") { // removed mid-read
      slot.busy = false; slot.itemId = null;
      continue;
    }
    slot.w.postMessage({
      type: "job", id: item.id, rev: state.settingsRev,
      name: item.name, buffer, mime: mimeFor(item.file),
      settings: effectiveSettings(item),
    }, [buffer]);
  }
}

/** Stop everything in flight. Workers are terminated (the only way to
 *  interrupt a wasm encode) and replaced, so the pool stays warm. */
function cancelAll() {
  const stopping = state.items.filter(isBusy);
  if (!stopping.length) return;
  for (const slot of pool) {
    if (!slot.busy) continue;
    slot.w.terminate();
    const fresh = makeWorker(slot.index);
    pool[slot.index] = fresh;
  }
  for (const item of stopping) {
    item.status = item.candidates?.length ? "failed" : "cancelled";
    item.error = "stopped";
    item.frac = 0;
  }
  batchActive = false;
  toast(`Stopped — ${stopping.length} image${stopping.length === 1 ? "" : "s"} left uncompressed`);
  scheduleRender();
}

const STAGE_TEXT = {
  codec: (d) => `Loading the ${fmtLabel(d)} engine…`,
  decoding: () => "Reading the image…",
  encoding: (d, pct) => `Testing ${fmtLabel(d)} · ${pct}%`,
};

function onWorkerMessage(slot, msg) {
  if (msg.type === "caps") {
    state.caps = { ...state.caps, ...msg.caps };
    reflectFormatAvailability();
    scheduleRender("queue");
    return;
  }
  const item = state.byId.get(msg.id);
  if (!item) {
    if (msg.type !== "progress") { slot.busy = false; slot.itemId = null; dispatch(); }
    return;
  }
  if (item.status === "cancelled") return;

  if (msg.type === "progress") {
    item.frac = msg.frac ?? item.frac ?? 0;
    item.stage = msg.stage;
    item.formats = msg.total || item.formats;
    const fn = STAGE_TEXT[msg.stage];
    item.progress = fn ? fn(msg.detail, Math.round((item.frac || 0) * 100)) : "working…";
    scheduleRender("queue");
    return;
  }

  slot.busy = false;
  slot.itemId = null;
  if (msg.engines) { state.caps = { ...state.caps, ...msg.engines }; reflectFormatAvailability(); }

  if (msg.rev !== state.settingsRev && !item.override) {
    // Settings moved under this result: it is about to be redone from the top,
    // so the clock restarts too rather than counting the discarded attempt.
    item.status = "queued";
    item.startedAt = null;
    scheduleRender(); dispatch();
    return;
  }

  if (item.startedAt != null) item.elapsedMs = performance.now() - item.startedAt;

  if (msg.type === "failed") {
    item.status = "failed";
    item.error = msg.error || "failed";
    item.warnings = msg.warnings || [];
  } else if (msg.type === "done") {
    const r = msg.result;
    item.status = "done";
    item.justFinished = true;
    item.wipePending = true;
    item.perf = msg.perf || null;   // phase timings, for the benchmark
    item.result = r;
    item.metric = r.metric;
    item.warnings = r.warnings || [];
    item.candidates = r.candidates || [];
    adoptCandidateBytes(item);
    // The engine's answer, kept whole, and made the one on screen. A choice
    // among the other encodes is a swap away and never destroys this.
    item.pick = null;
    item.auto = autoView(r, new Blob([r.bytes], { type: r.mime }));
    applyView(item, item.auto);
    // Measured from the decoded pixels, not guessed from the extension: it is
    // what decides whether choosing JPEG has to ask a question first.
    item.alpha = !!r.alpha;
    item.diffURL = null;
    if (r.width) { item.width = r.width; item.height = r.height; }
    item.outW = r.outW || item.width;
    item.outH = r.outH || item.height;
    countLifetime(item);
  }
  scheduleRender();
  dispatch();
  maybeCelebrate();
}

function startEngine() {
  ensurePool(1);
  pool[0].w.postMessage({ type: "probe" });
}

function maybeCelebrate() {
  if (state.items.some(isBusy) || !batchActive) return;
  batchActive = false;
  const done = state.items.filter(isReady);
  if (!done.length) return;
  const before = done.reduce((s, i) => s + i.originalBytes, 0);
  const after = done.reduce((s, i) => s + i.newBytes, 0);
  const saved = before - after;
  // Wall clock for the run. Images are compressed several at a time, so this
  // is measured, never summed from the per-image times - adding them up would
  // report a number several times larger than the wait the person just had.
  const took = batchStartedAt ? ` in ${duration(performance.now() - batchStartedAt)}` : "";
  toast(saved > 0
    ? `All done${took} — you just saved ${human(saved)} (${Math.round(saved / before * 100)}%) across ${done.length} image${done.length === 1 ? "" : "s"}`
    : `All done${took} — these were already well compressed`);
}

/* ------------------------ which encode is on screen ----------------------- *
 * The bake-off produces several finished files and used to throw all but one
 * away. It now brings them all home, so "show me the AVIF instead" is a
 * relabel and a new object URL rather than a fresh run of the whole search.
 *
 * Three fields carry the state. `auto` is the answer the engine gave, kept
 * whole so it can always be returned to. `candBlobs` holds every encode's
 * bytes. `pick` is what the person chose to look at instead - null while the
 * engine's answer stands. The live fields (fmt, newBytes, score, afterBlob…)
 * always describe whichever of those is currently on screen, so every number,
 * the split view, the diff and the download follow from one swap. */

const ORIGINAL_PICK = "__original";

const splitName = (name) => {
  const m = /^(.*?)(\.[a-z0-9]+)?$/i.exec(name) || [];
  return { base: m[1] || name, ext: m[2] || "" };
};

/** Move the transferred candidate buffers onto the item as blobs. Blobs are
 *  backed by the browser's own store rather than the JS heap, which is what
 *  makes holding every encode of every image in a large batch affordable. */
function adoptCandidateBytes(item) {
  item.candBlobs = new Map();
  for (const row of item.candidates) {
    if (!row.data) continue;
    item.candBlobs.set(row.format, new Blob([row.data], { type: row.mime || "" }));
    delete row.data;    // the rows are plain data from here on
  }
}

/** The engine's own answer, in the shape a view takes. */
function autoView(r, blob) {
  return {
    fmt: r.fmt,
    /* Passthrough ships the original bytes, so its name keeps the original's
       extension - left null and resolved at download time, because the file
       may be renamed between now and then. */
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

/** Keeping the file exactly as it arrived. The File object is already a Blob,
 *  so this costs nothing and needs no encoder. */
function originalView(it) {
  return {
    fmt: "original", ext: null, blob: it.file,
    newBytes: it.originalBytes,
    level: null, score: null, lossless: true,
    note: "Kept exactly as it arrived — not compressed.", passthrough: true,
  };
}

/** Point the item's live fields at one of those views. */
function applyView(it, view) {
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
function currentPick(it) {
  if (it.pick) return it.pick;
  if (it.auto?.passthrough) return ORIGINAL_PICK;
  return it.auto?.fmt || "";
}

/* Lifetime totals follow the file actually kept. Choosing a different encode
   changes what was saved, so the difference is applied rather than the image
   being counted a second time. */
function countLifetime(it) {
  const saved = Math.max(0, it.originalBytes - it.newBytes);
  if (it.countedBytes == null) { it.countedBytes = saved; bumpLifetime(1, saved); }
  else if (saved !== it.countedBytes) {
    bumpLifetime(0, saved - it.countedBytes);
    it.countedBytes = saved;
  }
}

/** Tapping a chip. The whole point of this path is that it finishes now: the
 *  picture changes under the finger that touched it, which is how someone
 *  finds out they had a choice without ever being told they did. */
function chooseCandidate(format) {
  const it = state.byId.get(selected);
  if (!it || !isReady(it) || !it.auto) return;
  if (currentPick(it) === format) return;    // already the one on screen

  let view, said;
  if (format === ORIGINAL_PICK) {
    view = originalView(it);
    said = "Keeping your original — nothing compressed";
  } else if (format === it.auto.fmt && !it.auto.passthrough) {
    view = it.auto;                          // the winner chip IS the way back
    said = "Back to the smallest one that passed";
  } else {
    const row = it.candidates.find((c) => c.format === format);
    view = row && candidateView(it, row);
    said = view && `Keeping ${fmtLabel(format)} for this image`;
  }
  if (!applyView(it, view)) return;

  it.pick = (view === it.auto) ? null : format;
  /* A swap gets the same reveal a first result gets - the wipe over the
     original, and the weights rolling to their new values. That response is
     the entire reason the chips are the control: you learn what the choice
     does by watching it happen, not by reading a label. */
  it.wipePending = true;
  it.justFinished = true;
  countLifetime(it);
  /* The Advanced dropdown is deliberately not touched. It means "run this
     image again forcing that format", which is a different act from showing an
     encode the run already produced, and making it echo a chip would claim a
     re-run that never happened. */
  toast(said);
  dirty.inspector = dirty.queue = dirty.summary = true;
  scheduleRender();
}

/* ------------------------------ add files -------------------------------- */

async function makeThumb(item) {
  try {
    // Decode straight to thumbnail scale. Decoding a 12MP original in full on
    // the main thread just to draw it at 92px was the single heaviest thing the
    // UI did per file, and with a couple of dozen files it made the page stutter
    // while the workers were already busy.
    const side = 92;
    let bmp;
    try {
      // Width only: giving both axes would force them and distort the frame.
      bmp = await createImageBitmap(item.file, {
        resizeWidth: side * 2, resizeQuality: "low",
      });
    } catch {
      bmp = await createImageBitmap(item.file);      // older engines
    }
    const scale = Math.max(side / bmp.width, side / bmp.height);
    const c = document.createElement("canvas");
    c.width = side; c.height = side;
    const ctx = c.getContext("2d");
    ctx.imageSmoothingQuality = "medium";
    ctx.drawImage(bmp,
      (side - bmp.width * scale) / 2, (side - bmp.height * scale) / 2,
      bmp.width * scale, bmp.height * scale);
    bmp.close();
    const blob = await new Promise((r) => c.toBlob(r, "image/png"));
    if (blob && state.byId.has(item.id)) {
      item.thumbURL = URL.createObjectURL(blob);
      const row = rowEls.get(item.id);
      if (row) row.querySelector(".thumb").style.backgroundImage = `url("${item.thumbURL}")`;
    }
  } catch { /* corrupt files simply keep a blank thumb */ }
}

function addFiles(files) {
  const usable = [...files].filter((f) => SUPPORTED.test(f.name) || /^image\//.test(f.type));
  if (!usable.length) { toast("No supported images in that drop"); return; }
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
      warnings: [], candidates: [],
      width: 0, height: 0, outW: 0, outH: 0,
    };
    state.items.push(item);
    state.byId.set(item.id, item);
    if (!selected) selected = item.id;
    makeThumb(item);
  }
  beginBatch();
  if (!firstEver) toast(`Added ${usable.length} image${usable.length === 1 ? "" : "s"}`);

  /* The first frame belongs to the file, untouched. render() runs here rather
     than being scheduled so the studio and the original's src are in the
     document immediately, and the work is held until the frame after that, so
     the browser has actually painted the picture before a single encoder is
     asked for anything. It is a few milliseconds, and it is the difference
     between "here is your image, now watch" and "something happened to my
     file". */
  renderNow();
  requestAnimationFrame(() => dispatch());
}

/** Drops can contain folders - designers drop whole export directories. */
async function filesFromDataTransfer(dt) {
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

function removeItems(ids) {
  for (const id of ids) {
    const item = state.byId.get(id);
    if (!item) continue;
    URL.revokeObjectURL(item.beforeURL);
    if (item.afterURL) URL.revokeObjectURL(item.afterURL);
    if (item.thumbURL) URL.revokeObjectURL(item.thumbURL);
    state.byId.delete(id);
    const i = state.items.indexOf(item);
    if (i >= 0) state.items.splice(i, 1);
    const row = rowEls.get(id);
    if (row) { row.remove(); rowEls.delete(id); }
    if (selected === id) selected = null;
  }
  if (!selected && state.items.length) selected = state.items[0].id;
  scheduleRender();
}

function requeue(ids) {
  let any = false;
  for (const id of ids) {
    const item = state.byId.get(id);
    if (!item || item.status === "working") continue;
    item.status = "queued";
    item.error = "";
    item.warnings = [];
    item.note = "";
    // A re-run replaces the whole bake-off, so the encodes it produced and any
    // choice made among them go with it.
    item.candidates = [];
    item.candBlobs = null;
    item.auto = null;
    item.pick = null;
    item.frac = 0;
    if (item.diffURL) { URL.revokeObjectURL(item.diffURL); item.diffURL = null; }
    any = true;
  }
  if (any) beginBatch();
  scheduleRender();
  dispatch();
}

/* --------------------------- render scheduling ---------------------------- */

const dirty = { queue: false, inspector: false, summary: false };
let renderQueued = false;
function scheduleRender(part) {
  if (part) dirty[part] = true;
  else dirty.queue = dirty.inspector = dirty.summary = true;
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}
/** Everything, in this frame. Only for the moment a file arrives, where the
 *  point is that the original is on screen before anything else happens. */
function renderNow() {
  dirty.queue = dirty.inspector = dirty.summary = true;
  render();
}

function render() {
  const wantAll = dirty.inspector || dirty.summary;
  if (dirty.queue || wantAll) { renderQueue(); dirty.queue = false; }
  if (wantAll) {
    renderSummary(); dirty.summary = false;
    const still = state.byId.get(selected);
    if (!still && state.items.length) selected = state.items[0].id;
    renderInspector(state.byId.get(selected));
    dirty.inspector = false;
  }
  $("app-empty").hidden = state.items.length > 0;
  $("app-full").hidden = state.items.length === 0;
  renderBatchProgress();
  renderTitle();
}

/* -------------------------------- queue ---------------------------------- */

const rowEls = new Map();

/** Weights line — the same shape at every stage, so rows never reflow. */
function statusLine(it) {
  if (it.status === "failed") return `<span class="err">${escapeHtml(it.error || "Failed")}</span>`;
  const from = human(it.originalBytes);
  if (!isReady(it)) {
    return `${from} → <span class="skel w-sm"></span>`;
  }
  const pct = it.originalBytes && it.newBytes
    ? 100 * (it.originalBytes - it.newBytes) / it.originalBytes : 0;
  const pctText = pct > 0 ? `−${pct.toFixed(0)}%` : "no gain";
  const tail = it.status === "saved" ? ` <span class="save">saved</span>` : "";
  return `${from} → ${human(it.newBytes)} · ${pctText}${tail}`;
}

/** Phase line — what is happening to this file right now. */
function phaseLine(it) {
  if (it.status === "cancelled") return "Stopped";
  if (it.status === "failed") return "";
  if (it.status === "queued") return "Waiting";
  if (it.status === "working") return it.progress || "Working";
  const took = it.elapsedMs != null ? ` · ${duration(it.elapsedMs)}` : "";
  if (it.passthrough) return "Passed through unchanged" + took;
  return fmtLabel(it.fmt) + (it.level != null ? ` · quality ${it.level}` : "") + took;
}

function buildRow(it) {
  const el = document.createElement("button");
  el.className = "row enter";
  el.dataset.id = it.id;
  el.setAttribute("role", "option");
  el.innerHTML = `
    <span class="thumb"></span>
    <span class="cell">
      <span class="name"></span>
      <span class="meta"></span>
      <span class="phase"></span>
      <span class="track"><i></i></span>
    </span>
    <span class="tail">
      <span class="micro ov" title="This image has its own settings" hidden>OV</span>
      <span class="dot"></span>
    </span>`;
  el.querySelector(".name").textContent = it.name;
  if (it.thumbURL) el.querySelector(".thumb").style.backgroundImage = `url("${it.thumbURL}")`;
  el.addEventListener("animationend", () => el.classList.remove("enter"), { once: true });
  return el;
}

function renderQueue() {
  const list = $("queue-list");
  $("queue-count").textContent = state.items.length;
  if (!state.items.length) {
    for (const el of rowEls.values()) el.remove();
    rowEls.clear();
    if (!list.querySelector(".queue-empty")) {
      list.innerHTML = `<div class="queue-empty">Nothing queued yet.<br>Drop images anywhere on this page.</div>`;
    }
    $("queue-foot").textContent = capsLine();
    $("live-stat").textContent = "";
    return;
  }
  list.querySelector(".queue-empty")?.remove();

  let prev = null;
  for (const it of state.items) {
    let el = rowEls.get(it.id);
    if (!el) {
      el = buildRow(it);
      rowEls.set(it.id, el);
      if (prev) prev.after(el); else list.prepend(el);
    }
    el.setAttribute("aria-selected", String(it.id === selected));
    el.classList.toggle("working", it.status === "working");
    const meta = statusLine(it);
    if (el.dataset.meta !== meta) {
      el.dataset.meta = meta;
      el.querySelector(".meta").innerHTML = meta;
    }
    const phase = phaseLine(it);
    if (el.dataset.phase !== phase) {
      el.dataset.phase = phase;
      el.querySelector(".phase").textContent = phase;
    }
    const dot = el.querySelector(".dot");
    const dotClass = `dot ${it.status}`;
    if (dot.className !== dotClass) dot.className = dotClass;
    el.querySelector(".ov").hidden = !it.override;
    if (it.status === "working") {
      el.querySelector(".track i").style.width = `${Math.max(4, (it.frac || 0) * 100)}%`;
    }
    prev = el;
  }

  // One short status line. Shortcuts are taught on the buttons themselves and
  // in the ? sheet, so they no longer need repeating here.
  const done = state.items.filter(isReady);
  const busyItems = state.items.filter(isBusy).length;
  const failed = state.items.filter((i) => i.status === "failed").length;
  $("queue-foot").textContent = busyItems
    ? `${busyItems} working · ${done.length} ready${failed ? ` · ${failed} failed` : ""}`
    : `${done.length} ready${failed ? ` · ${failed} failed` : ""}`;

  // live savings while the batch is still running
  const saved = done.reduce((s, i) => s + (i.originalBytes - i.newBytes), 0);
  $("live-stat").textContent = busyItems && saved > 0 ? `−${human(saved)} so far` : "";
}

/* Offering "AVIF only" in a browser with no AVIF encoder would be offering a
   dead end. The automatic sets need no such gate - they route around whatever
   is missing by design; a single chosen format has nowhere to route to. */
function reflectFormatAvailability() {
  const have = { jpeg: true, png: true, webp: state.caps.webp, avif: state.caps.avif };
  for (const [fmt, ok] of Object.entries(have)) {
    const opt = $("target").querySelector(`option[value="${ONE}${fmt}"]`);
    if (!opt || ok === null) continue;          // not probed yet: leave it be
    opt.disabled = !ok;
    opt.textContent = ok ? `${fmt.toUpperCase()} only`
                         : `${fmt.toUpperCase()} only — not available in this browser`;
  }
}

function capsLine() {
  if (state.caps.webp === null) return "Drop images anywhere on this page";
  const parts = [state.caps.mozjpeg ? "mozjpeg" : "jpeg", "png"];
  if (state.caps.png8) parts.push("png8");
  if (state.caps.oxipng) parts.push("oxipng");
  if (state.caps.webp) parts.push("webp");
  if (state.caps.webpLossless) parts.push("webp-lossless");
  if (state.caps.avif) parts.push("avif");
  return `Engines: ${parts.join(", ")} · scored with SSIMULACRA 2 · all in your browser`;
}

function renderBatchProgress() {
  const bar = $("batch-bar");
  const items = state.items;
  const busy = items.some(isBusy);
  $("batch").classList.toggle("on", busy);
  $("stop-btn").hidden = !busy;
  if (!busy) { bar.style.width = "0%"; return; }
  let sum = 0;
  for (const i of items) {
    sum += (isReady(i) || i.status === "failed" || i.status === "cancelled") ? 1
      : i.status === "working" ? Math.min(0.95, i.frac || 0) : 0;
  }
  bar.style.width = `${(sum / items.length) * 100}%`;
}

function renderTitle() {
  const busyItems = state.items.filter(isBusy).length;
  const settled = state.items.length - busyItems;
  document.title = busyItems ? `▸ ${settled}/${state.items.length} — imgcompress` : BASE_TITLE;
}

/* ------------------------------ inspector -------------------------------- */

function showInspector(on) {
  $("inspector-empty").hidden = on;
  $("inspector-body").hidden = !on;
}

function selectItem(id, quiet) {
  selected = id;
  zoom = 0; pan = { x: 0, y: 0 };
  if (mode === "diff") mode = "split";
  scheduleRender();
  if (!quiet) rowEls.get(id)?.scrollIntoView({ block: "nearest" });
}

function fmtScore(score, lossless, metric) {
  if (lossless) return "lossless";
  if (score == null) return "—";
  return metric === "ssim" ? score.toFixed(4) : score.toFixed(1);
}

/* ------------------------------ narration -------------------------------- *
 * The one line in this app that has to land without being read carefully. It
 * says the same thing the landing page promised, in the same words, while the
 * promise is actually being kept - and when it has been kept, it ends in a
 * real action rather than a full stop, because the thing worth discovering
 * next is the row of encodes underneath it. */

/** Frame 2. This sentence is the landing page's claim, in the present tense,
 *  said while it is happening. It is not a status message and must not be
 *  reduced to one. */
const WORKING_LINE =
  "Trying a few ways to shrink this, keeping only the one that still looks right.";

/** Returns HTML: the invitation at the end is a button, not decoration. */
function narrationFor(it) {
  if (!it) return "";
  if (it.status === "failed") {
    return `That file couldn't be read${it.error ? ` — ${escapeHtml(it.error)}` : ""}. ` +
           `Your original is untouched.`;
  }
  if (it.status === "cancelled") return "Stopped. Your original is untouched.";
  if (!isReady(it)) return escapeHtml(WORKING_LINE);

  const ask = (action, words) =>
    ` <button class="narr-link" type="button" data-narr="${action}">${words}</button>`;

  if (it.pick === ORIGINAL_PICK) {
    return `Keeping your original, exactly as it arrived.` +
           ask("auto", "Go back to the smallest one that passed?");
  }
  if (it.pick) {
    return `Showing <b>${escapeHtml(fmtLabel(it.fmt))}</b> because you picked it — ` +
           `${human(it.newBytes)}.` + ask("auto", "Back to the automatic choice?");
  }
  if (it.auto?.passthrough) {
    return `This was already smaller than anything we could make, so it was left ` +
           `exactly as it is.` + ask("chips", "See what we tried?");
  }
  return `Went with <b>${escapeHtml(fmtLabel(it.fmt))}</b> — smallest option that ` +
         `still passes.` + ask("chips", "Prefer something else?");
}

/** The invitation's other half: put the chips under the eye that just asked
 *  for them. Not a tour and not a tooltip - it is the answer to a click. */
function surfaceChips() {
  const cands = $("cands");
  const first = cands.querySelector(".cand");
  if (!first) return;
  cands.classList.remove("calling");
  void cands.offsetWidth;
  cands.classList.add("calling");
  first.focus({ preventScroll: true });
  cands.scrollIntoView({ block: "nearest", behavior: REDUCED ? "auto" : "smooth" });
}

/** The numbers behind the sentence: how the winner compares to the runner-up
 *  and where it landed against the floor. The narration says which one won, so
 *  this no longer repeats it. */
function verdictFor(it) {
  if (it.pick === ORIGINAL_PICK) return "";
  if (it.passthrough) {
    return `Every encode came out <b>larger than the file you gave us</b>, which is ` +
           `what already-well-compressed looks like.`;
  }
  if (!it.candidates?.length) return "";
  const pct = it.originalBytes ? 100 * (it.originalBytes - it.newBytes) / it.originalBytes : 0;
  const sorted = [...it.candidates].sort((a, b) => a.bytes - b.bytes);
  const runner = sorted.find((c) => c.format !== it.fmt);
  const quality = it.lossless
    ? "and it is <b>pixel-identical</b> to the original"
    : `at SSIMULACRA 2 <b>${it.score?.toFixed(1)}</b>, above your ${Number(
        it.override?.qualityTarget ?? state.settings.qualityTarget).toFixed(0)} floor`;
  let line = `<b>${pct.toFixed(0)}% smaller</b> than the original, ${quality}.`;
  if (runner && runner.bytes > it.newBytes) {
    const gap = 100 * (runner.bytes - it.newBytes) / runner.bytes;
    line += ` It beat ${escapeHtml(fmtLabel(runner.format))} by ${gap.toFixed(0)}%.`;
  }
  return line;
}

function renderInspector(it) {
  if (!it) { showInspector(false); return; }
  showInspector(true);

  /* Only reseed the name field when the selection changes: this render runs
     several times a second while a batch is in flight, and overwriting the
     field every frame would eat what someone is halfway through typing. */
  const nameField = $("insp-name");
  if (nameField.dataset.for !== it.id) {
    nameField.dataset.for = it.id;
    const { base, ext } = splitName(it.name);
    nameField.value = base;
    // The field is sized to its content so the extension stays beside the name
    // it belongs to rather than at the far end of the heading.
    nameField.size = Math.max(4, base.length);
    $("insp-ext").textContent = ext;
  }
  const dims = it.width ? `${it.width}×${it.height}` : "";
  const out = it.outW && (it.outW !== it.width || it.outH !== it.height)
    ? ` → ${it.outW}×${it.outH}` : "";
  $("insp-dims").textContent = dims + out;

  const before = $("img-before"), after = $("img-after");
  if (before.dataset.src !== it.beforeURL) {
    before.dataset.src = it.beforeURL;
    // A previous item's failure must not mark this one dead before it tries.
    before.classList.toggle("dead", !!it.previewDead);
    before.src = it.beforeURL;
  }
  /* Some files decode nowhere in this browser - a damaged export, or a format
     it has no decoder for (the same reason the compression itself failed).
     The element is then hidden and the stage says so, because the alternative
     is the browser's broken-image glyph sitting on the artwork. */
  const dead = !!it.previewDead;
  const none = $("stage-none");
  none.hidden = !dead;
  $("viewport").hidden = dead;
  if (dead) {
    none.textContent = it.status === "failed"
      ? "No preview — this browser can’t read this file."
      : "No preview — this browser can’t display this format, but the file was still compressed.";
  }
  const ready = isReady(it);
  const wantAfter = ready ? it.afterURL : "";
  if (after.dataset.src !== wantAfter) {
    after.dataset.src = wantAfter;
    // An empty src is not "no image" - it resolves against the document URL,
    // fails, and paints the broken-image icon and alt text over the photograph.
    if (wantAfter) after.src = wantAfter; else after.removeAttribute("src");
    // The result arriving is the one moment worth animating.
    if (wantAfter && it.wipePending) {
      it.wipePending = false;
      const panel = document.querySelector(".viewport .after");
      panel.classList.remove("wipe");
      void panel.offsetWidth;
      panel.classList.add("wipe");
    }
  }

  const diffOn = mode === "diff" && ready;
  $("img-diff").hidden = !diffOn;
  if (diffOn) ensureDiff(it);
  const splitting = mode === "split" && ready;
  $("viewport").classList.toggle("solo", mode !== "split" || !ready);
  $("divider").style.display = splitting ? "" : "none";
  $("split").disabled = !ready || mode !== "split";
  // In Split the two weights ride the caliper; otherwise one corner badge says
  // what you are looking at.
  $("tag-l").textContent = `Original · ${human(it.originalBytes)}`;
  $("tag-r").textContent = `Compressed · ${human(it.newBytes)}`;
  const badge = $("stage-badge");
  /* Frame 1's label. While the work runs there is exactly one image on the
     stage and it is the person's own file, so the badge says so out loud -
     an unlabelled picture during an action nobody asked for is the whole
     anxiety this sequence exists to answer. */
  badge.hidden = splitting || (!ready && (it.status === "failed" || it.status === "cancelled"));
  if (!badge.hidden) {
    badge.textContent = !ready
      ? `Your original · ${human(it.originalBytes)} · untouched`
      : diffOn
        ? (it.diffInfo
            ? `Difference ×${it.diffInfo.gain} · peak ${it.diffInfo.peak}/255 · avg ${it.diffInfo.mean}`
            : "Difference")
        : `Compressed · ${human(it.newBytes)}`;
  }
  $("mode-diff").setAttribute("aria-pressed", String(diffOn));
  $("mode-diff").disabled = !ready;

  const saved = it.originalBytes - it.newBytes;
  const pct = it.originalBytes && it.newBytes ? 100 * saved / it.originalBytes : 0;
  if (ready && it.justFinished) {
    it.justFinished = false;
    rollNumber($("s-size"), it.newBytes, ` <small>from ${human(it.originalBytes)}</small>`);
    if (pct > 0) rollNumber($("s-saved"), saved, ` <small>−${pct.toFixed(0)}%</small>`);
    else $("s-saved").textContent = "none";
    $("s-saved").classList.remove("pop");
    void $("s-saved").offsetWidth;
    $("s-saved").classList.add("pop");
    maybeShowHint();
  } else {
    // A pending value is a shape, not a dash: "not yet" rather than "nothing".
    const stalled = it.status === "failed" || it.status === "cancelled";
    const pending = stalled ? "—" : `<span class="skel"></span>`;
    $("s-size").innerHTML = ready
      ? `${human(it.newBytes)} <small>from ${human(it.originalBytes)}</small>`
      : `${pending}${stalled ? "" : `<small>from ${human(it.originalBytes)}</small>`}`;
    $("s-saved").innerHTML = ready
      ? (pct > 0 ? `${human(saved)} <small>−${pct.toFixed(0)}%</small>` : "none")
      : pending;
  }
  $("s-format").innerHTML = ready
    ? `${fmtLabel(it.fmt)}${it.level != null ? ` <small>quality ${it.level}</small>` : ""}`
    : (it.status === "failed" || it.status === "cancelled" ? "—" : `<span class="skel w-sm"></span>`);
  $("s-score").textContent = ready ? fmtScore(it.score, it.lossless || it.passthrough, it.metric) : "—";
  $("s-dims").innerHTML = !it.width ? "—"
    : (it.outW && it.outW !== it.width
        ? `${it.outW}×${it.outH} <small>from ${it.width}×${it.height}</small>`
        : `${it.width}×${it.height}`);
  const floor = it.override?.qualityTarget ?? state.settings.qualityTarget;
  $("s-floor").innerHTML = Number(floor).toFixed(0) + (it.override ? " <small>override</small>" : "");
  // Encodes-and-scores for this one image. Images run several at a time, so
  // this is deliberately not summed into a batch total anywhere.
  $("s-time").innerHTML = it.elapsedMs != null
    ? `${duration(it.elapsedMs)}${it.candidates?.length
        ? ` <small>${it.candidates.length} candidate${it.candidates.length === 1 ? "" : "s"}</small>` : ""}`
    : (it.status === "working" ? `<span class="skel w-sm"></span>` : "—");

  // The narration is rewritten only when it actually changes: it carries a
  // focusable button, and replacing the node every frame would throw the
  // keyboard off it mid-batch.
  const narr = $("narration");
  const ntext = narrationFor(it);
  if (narr.dataset.said !== ntext) {
    narr.dataset.said = ntext;
    narr.innerHTML = ntext;
  }
  narr.classList.toggle("working", !ready && it.status !== "failed" && it.status !== "cancelled");

  const verdict = $("s-verdict");
  const vtext = ready ? verdictFor(it) : "";
  verdict.hidden = !vtext;
  verdict.innerHTML = vtext;

  const note = $("s-note");
  note.hidden = !it.note; note.textContent = it.note || "";
  const warn = $("s-warn");
  const messages = [...(it.warnings || [])];
  if (it.error && it.status !== "cancelled") messages.unshift(it.error);
  warn.hidden = !messages.length;
  warn.textContent = messages.join(" · ");

  renderCandidates(it);

  // Only seed the override controls when the selection actually changes.
  // Re-syncing them on every frame would wipe a choice the user is halfway
  // through making - progress messages re-render several times a second.
  if (ovSyncedFor !== it.id) {
    ovSyncedFor = it.id;
    $("ov-format").value = it.override?.formats?.[0] || "";
    $("ov-quality").value = it.override?.qualityTarget != null
      ? Math.round(it.override.qualityTarget) : "";
  }
  $("ov-reset").hidden = !it.override;
  $("dl-one").disabled = !ready;
  $("copy-one").disabled = !ready;
  $("retry-btn").hidden = it.status !== "failed" && it.status !== "cancelled";
  applyZoom();
}

/** Every encode that was tried, ranked smallest first, as things you can touch.
 *  This is the app's primary format control: not because it is labelled as one,
 *  but because tapping one changes the picture immediately, which is the only
 *  way a control teaches itself. The Original sits at the end as the yardstick
 *  and is selectable too — keeping the file exactly as it arrived is a real
 *  answer, and it is the one that makes "your original is one action away"
 *  literally true. */
function renderCandidates(it) {
  const cands = $("cands");
  if (!it.candidates?.length) {
    const waiting = !isReady(it) && it.status !== "failed" && it.status !== "cancelled";
    // Never a bare spinner: this sits directly under the sentence that explains
    // what the app is doing, and it names the format being measured right now.
    cands.innerHTML = waiting
      ? `<span class="cand-wait">${escapeHtml(it.progress || "Testing formats…")}</span>`
      : "";
    return;
  }
  const rows = [...it.candidates].sort((a, b) => a.bytes - b.bytes);
  const smallest = rows[0].bytes;
  const max = Math.max(it.originalBytes, ...rows.map((c) => c.bytes));
  const now = currentPick(it);
  const autoFmt = it.auto && !it.auto.passthrough ? it.auto.fmt : "";

  const pct = (bytes) => it.originalBytes
    ? Math.round(100 * (it.originalBytes - bytes) / it.originalBytes) : 0;

  const chip = (key, label, bytes, mark, title) => {
    const saving = pct(bytes);
    const current = now === key;
    return `
    <button class="cand${key === autoFmt ? " win" : ""}${current ? " current" : ""}"
            type="button" data-bytes="${bytes}" data-format="${escapeHtml(key)}"
            aria-pressed="${current}" title="${escapeHtml(title)}">
      <span class="meter"></span>
      <span class="f">${escapeHtml(label)}</span>
      <span class="mark">${mark}</span>
      <span class="b num">${human(bytes)}</span>
      <span class="p num">${saving > 0 ? `−${saving}%` : "—"}</span>
    </button>`;
  };

  cands.innerHTML = rows.map((c) => {
    const quality = c.lossless ? "pixel-identical to the original"
      : `SSIMULACRA 2 ${c.score?.toFixed(1)}`;
    const mark = c.format === autoFmt ? "winner"
      : now === c.format ? "showing"
      : c.bytes === smallest ? "smallest" : "";
    return chip(c.format, fmtLabel(c.format), c.bytes, mark,
      `${fmtLabel(c.format)} · ${human(c.bytes)} · ${quality}${
        c.rejected ? " · failed the colour check" : ""} — tap to show this one`);
  }).join("") + chip(
    ORIGINAL_PICK, "Original", it.originalBytes,
    now === ORIGINAL_PICK ? "showing" : "",
    `Your file exactly as it arrived · ${human(it.originalBytes)} — tap to keep this instead`);

  // Widths go through the CSSOM: a style="" attribute in markup would (rightly)
  // be refused by the page's style-src CSP, leaving every meter at zero.
  for (const el of cands.querySelectorAll(".cand")) {
    const w = Math.max(2, (Number(el.dataset.bytes) / max) * 100);
    el.style.setProperty("--w", `${w.toFixed(1)}%`);
  }
}

/* --------------------------- difference heatmap --------------------------- */
/* The strongest possible answer to "did this ruin my image?": show exactly
 * where the pixels moved, amplified so you can actually see it. */

/** The brand fill as per-channel multipliers, normalised so the strongest
 *  channel is 1. Read from the token layer rather than restated here. */
let heatTint = null;
function brandHeatTint() {
  if (heatTint) return heatTint;
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue("--oz-color-fill-brand").trim();
  const m = raw.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i);
  if (!m) return (heatTint = [1, 1, 1]);          // unknown format: plain greyscale
  const rgb = [1, 2, 3].map((i) => parseInt(m[i], 16));
  const peak = Math.max(...rgb) || 255;
  // Lift the floor a little so the darkest channel still carries some signal.
  heatTint = rgb.map((v) => 0.25 + 0.75 * (v / peak));
  return heatTint;
}

function ensureDiff(it) {
  const canvas = $("img-diff");
  if (it.diffFor === it.afterURL) return;   // already computed for this result
  const a = $("img-before"), b = $("img-after");
  if (!a.naturalWidth || !b.naturalWidth) return;

  const W = a.naturalWidth, H = a.naturalHeight;
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  const scratch = document.createElement("canvas");
  scratch.width = W; scratch.height = H;
  const sctx = scratch.getContext("2d", { willReadFrequently: true });

  sctx.drawImage(a, 0, 0, W, H);
  const origData = sctx.getImageData(0, 0, W, H);
  sctx.clearRect(0, 0, W, H);
  sctx.drawImage(b, 0, 0, W, H);
  const compData = sctx.getImageData(0, 0, W, H);

  const o = origData.data, c = compData.data;
  const out = ctx.createImageData(W, H);
  const d = out.data;

  // Two passes: measure the real error first, then amplify to fill the range.
  // A fixed gain either clips a damaged image or shows nothing at all on a
  // good one - and the whole point is to be legible in both cases. The factor
  // is reported on screen so the amplification is never mistaken for damage.
  let peak = 0, total = 0;
  const mag = new Uint8Array(W * H);
  for (let i = 0, p = 0; i < o.length; i += 4, p++) {
    const v = (Math.abs(o[i] - c[i]) + Math.abs(o[i + 1] - c[i + 1]) +
               Math.abs(o[i + 2] - c[i + 2])) / 3;
    mag[p] = v > 255 ? 255 : v;
    if (v > peak) peak = v;
    total += v;
  }
  const gain = peak > 0 ? Math.min(64, Math.max(1, 235 / peak)) : 1;
  // Heat is tinted with the live brand fill, read from the token layer, so the
  // map cannot drift from the interface if the palette is ever regenerated.
  const [hr, hg, hb] = brandHeatTint();
  for (let p = 0, i = 0; p < mag.length; p++, i += 4) {
    const v = Math.min(255, mag[p] * gain);
    d[i] = Math.min(255, v * hr);
    d[i + 1] = Math.min(255, v * hg);
    d[i + 2] = Math.min(255, v * hb);
    d[i + 3] = 255;
  }
  ctx.putImageData(out, 0, 0);
  it.diffFor = it.afterURL;
  it.diffInfo = {
    gain: Math.round(gain),
    peak: Math.round(peak),
    mean: (total / mag.length).toFixed(2),
  };
}

/* ------------------------- first-result hint ------------------------------ */

function maybeShowHint() {
  try { if (localStorage.getItem("imgc-hint")) return; } catch {}
  const hint = $("hint");
  hint.hidden = false;
  hint.classList.add("on");
  const dismiss = () => {
    hint.classList.remove("on");
    setTimeout(() => { hint.hidden = true; }, 300);
    try { localStorage.setItem("imgc-hint", "1"); } catch {}
    $("stage").removeEventListener("pointerdown", dismiss);
  };
  $("stage").addEventListener("pointerdown", dismiss);
  setTimeout(dismiss, 9000);
}

/* ------------------------------- summary --------------------------------- */

function totals() {
  const done = state.items.filter(isReady);
  const before = done.reduce((s, i) => s + i.originalBytes, 0);
  const after = done.reduce((s, i) => s + i.newBytes, 0);
  return { done, before, after, saved: before - after };
}

function renderSummary() {
  const { done, before, after, saved } = totals();
  $("t-sizes").textContent = done.length ? `${human(before)} → ${human(after)}` : "";
  $("t-saved").textContent = done.length && saved > 0
    ? `saved ${human(saved)} (${((saved / before) * 100).toFixed(0)}%)` : "";
  // Plain arithmetic, no hand-waving: what this weight means at scale.
  const bw = $("t-bandwidth");
  bw.hidden = saved <= 0;
  if (saved > 0) {
    bw.textContent = `${human(saved * 10000)} saved per 10k views`;
    bw.title = `Serving these ${done.length} image${done.length === 1 ? "" : "s"} to 10,000 visitors `
      + `moves ${human(saved * 10000)} less data than the originals would have.`;
  }

  const btn = $("save-btn");
  if (!btn.dataset.busy) {
    btn.disabled = done.length === 0;
    $("save-label").textContent = done.length > 1
      ? `Download all ${done.length} · ${human(after)} zip`
      : "Download";
  }
  $("export-btn").disabled = done.length === 0;
}

/* -------------------------------- zoom ------------------------------------ */

const ZOOMS = [0, 0.5, 1, 2, 4, 8];

/** Scale that fits the frame in the stage. Capped at 1 - upscaling a
 *  compressed file would misrepresent it. */
function fitScale() {
  const stage = $("stage"), img = $("img-before");
  if (!img.naturalWidth) return 1;
  const pad = 14;   // tight: the image is the subject, it should own the pane
  return Math.min(
    (stage.clientWidth - pad * 2) / img.naturalWidth,
    (stage.clientHeight - pad * 2) / img.naturalHeight,
    1);
}
const scaleNow = () => zoom || Math.max(fitScale(), 0.02);

/* Panning was unbounded, so a drag could throw the image clean off the stage
   and leave you hunting for it - which is what "I have to drag back a long
   way" actually was. The frame may now be moved only as far as its own
   overhang: at or below fit scale there is no overhang, so it stays centred. */
function clampPan() {
  const stage = $("stage"), img = $("img-before");
  const s = scaleNow();
  const overX = Math.max(0, (img.naturalWidth * s - stage.clientWidth) / 2);
  const overY = Math.max(0, (img.naturalHeight * s - stage.clientHeight) / 2);
  pan.x = Math.min(overX, Math.max(-overX, pan.x));
  pan.y = Math.min(overY, Math.max(-overY, pan.y));
}

function applyZoom() {
  const stage = $("stage"), img = $("img-before"), vp = $("viewport");
  if (!img.naturalWidth) return;
  const scale = scaleNow();
  clampPan();
  vp.style.width = Math.max(1, Math.round(img.naturalWidth * scale)) + "px";
  vp.style.height = Math.max(1, Math.round(img.naturalHeight * scale)) + "px";
  // The -50% pair is what centres it; see the note on .viewport in app.css.
  vp.style.transform = `translate(-50%, -50%) translate(${pan.x}px, ${pan.y}px)`;
  stage.style.cursor = zoom ? "grab" : "";
  $("zoom-label").textContent = zoom ? `${Math.round(zoom * 100)}%` : "Fit";
}

/* Zoom about a point instead of about the middle. Scrolling used to re-centre
   the frame and drop the pan, so zooming in on a detail threw you somewhere
   else entirely and you had to drag back to find it. Whatever sits under the
   cursor now stays under the cursor, which is what every map and image viewer
   has trained people to expect. */
function zoomAt(dir, clientX, clientY) {
  const i = ZOOMS.indexOf(zoom);
  const next = Math.max(0, Math.min(ZOOMS.length - 1, (i < 0 ? 1 : i) + dir));
  const before = scaleNow();
  zoom = ZOOMS[next];
  const after = scaleNow();
  if (after !== before) {
    const box = $("stage").getBoundingClientRect();
    const cx = box.left + box.width / 2, cy = box.top + box.height / 2;
    const dx = (clientX == null ? cx : clientX) - cx;
    const dy = (clientY == null ? cy : clientY) - cy;
    const k = after / before;
    pan = { x: dx - (dx - pan.x) * k, y: dy - (dy - pan.y) * k };
  }
  applyZoom();
}
const stepZoom = (dir) => zoomAt(dir, null, null);

/* ------------------------------- downloads -------------------------------- */

function outputName(it, used) {
  let base = it.name.replace(/\.[a-z0-9]+$/i, "");
  // it.ext follows whichever encode is currently on screen, and is null when
  // the bytes are the original's - then the source name's own extension is the
  // honest one, read now rather than at result time so a rename is respected.
  const ext = it.ext || (it.name.match(/\.[a-z0-9]+$/i) || [""])[0];
  if (state.suffix) base += "-min";
  let name = base + ext;
  if (used) {
    let candidate = name, n = 1;
    while (used.has(candidate.toLowerCase())) {
      candidate = `${base} (${n})${ext}`;
      n++;
    }
    used.add(candidate.toLowerCase());
    return candidate;
  }
  return name;
}

/* Copy the result to the clipboard, for pasting straight into Figma, Slack or
 * a document. Clipboards accept image/png and nothing else — writing a JPEG or
 * WebP blob is rejected outright — so the compressed result is decoded and
 * re-encoded as PNG. The pixels are exactly what was measured; the bytes are
 * not the file, and the toast says so rather than letting someone believe they
 * pasted a 400 KB JPEG. */
async function copyImage(it) {
  if (!it || !isReady(it)) return;
  const btn = $("copy-one");
  btn.disabled = true;
  try {
    if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
      throw new Error("this browser has no clipboard image support");
    }
    const asPng = async () => {
      if (it.afterBlob.type === "image/png") return it.afterBlob;
      const bmp = await createImageBitmap(it.afterBlob);
      const c = document.createElement("canvas");
      c.width = bmp.width; c.height = bmp.height;
      c.getContext("2d").drawImage(bmp, 0, 0);
      bmp.close?.();
      return new Promise((res) => c.toBlob(res, "image/png"));
    };
    /* The blob is handed over as a promise rather than awaited first. Awaiting
       the re-encode before calling write() spends the click's user activation,
       which Safari rejects outright and Chrome can too; the promise form is
       what the API is designed around. */
    await navigator.clipboard.write([new ClipboardItem({ "image/png": asPng() })]);
    toast(it.afterBlob.type === "image/png"
      ? "Copied — paste it anywhere"
      : "Copied as PNG — the only image format clipboards take");
  } catch (e) {
    toast(`Could not copy: ${e && e.message ? e.message : e}`);
  } finally {
    btn.disabled = false;
  }
}

function downloadBlob(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
}

/* Minimal ZIP writer, STORE method — the entries are already compressed. */
const ZCRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function zcrc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = ZCRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function zipStore(entries) {
  const encoder = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;

  const datas = await Promise.all(entries.map((e) => e.blob.arrayBuffer()));
  entries.forEach((entry, i) => {
    const data = new Uint8Array(datas[i]);
    const nameBytes = encoder.encode(entry.name);
    const crc = zcrc32(data);

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true); lv.setUint16(8, 0, true);
    lv.setUint16(10, dosTime, true); lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true); lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);

    const cdir = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cdir.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true); cv.setUint16(12, dosTime, true); cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cdir.set(nameBytes, 46);

    chunks.push(local, data);
    central.push(cdir);
    offset += local.length + data.length;
  });

  let centralSize = 0;
  for (const c of central) centralSize += c.length;
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, central.length, true); ev.setUint16(10, central.length, true);
  ev.setUint32(12, centralSize, true); ev.setUint32(16, offset, true);

  return new Blob([...chunks, ...central, eocd], { type: "application/zip" });
}

async function downloadAll() {
  const done = state.items.filter(isReady);
  if (!done.length) return;
  const btn = $("save-btn");
  if (done.length === 1) {
    const it = done[0];
    downloadBlob(it.afterBlob, outputName(it));
    toast(`Downloaded ${outputName(it)}`);
    it.status = "saved";
    scheduleRender();
    return;
  }
  btn.dataset.busy = "1";
  $("save-label").textContent = "Zipping…";
  try {
    const used = new Set();
    const entries = done.map((it) => ({ name: outputName(it, used), blob: it.afterBlob }));
    const zip = await zipStore(entries);
    downloadBlob(zip, "imgcompress.zip");
    const saved = done.reduce((s, i) => s + (i.originalBytes - i.newBytes), 0);
    toast(`Zipped ${done.length} images — ${human(saved)} lighter than they arrived`);
    for (const it of done) it.status = "saved";
    $("save-label").textContent = "Saved ✓";
    setTimeout(() => { delete btn.dataset.busy; scheduleRender(); }, 1600);
  } catch {
    delete btn.dataset.busy;
    toast("Could not build the zip — try downloading images individually");
  }
  scheduleRender();
}

/* ------------------------------ export report ----------------------------- */

function reportRows() {
  return state.items.filter(isReady).map((it) => ({
    file: it.name,
    output: outputName(it),
    format: it.fmt,
    quality: it.level ?? "",
    original_bytes: it.originalBytes,
    new_bytes: it.newBytes,
    saved_bytes: it.originalBytes - it.newBytes,
    saved_pct: it.originalBytes
      ? +(100 * (it.originalBytes - it.newBytes) / it.originalBytes).toFixed(1) : 0,
    metric: it.metric || "ssimulacra2",
    quality_score: it.lossless ? "lossless" : (it.score != null ? +it.score.toFixed(2) : ""),
    width: it.outW, height: it.outH,
    // Per-image, and only meaningful as such: images are compressed in
    // parallel, so this column does not add up to the run's wall clock.
    time_ms: it.elapsedMs != null ? Math.round(it.elapsedMs) : "",
  }));
}

function exportReport(kind) {
  const rows = reportRows();
  if (!rows.length) return;
  const { before, after, saved } = totals();

  if (kind === "csv") {
    const cols = Object.keys(rows[0]);
    const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
    const csv = [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
    downloadBlob(new Blob([csv], { type: "text/csv" }), "imgcompress-report.csv");
    toast("CSV downloaded");
  } else if (kind === "json") {
    const payload = {
      tool: "imgcompress web", version: APP_VERSION,
      settings: { ...state.settings },
      totals: { before_bytes: before, after_bytes: after, saved_bytes: saved },
      images: rows,
    };
    downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }),
                 "imgcompress-report.json");
    toast("JSON downloaded");
  } else {
    const pct = before ? (100 * saved / before).toFixed(0) : 0;
    const lines = [
      `imgcompress — ${rows.length} image${rows.length === 1 ? "" : "s"}`,
      `${human(before)} → ${human(after)}  (saved ${human(saved)}, ${pct}%)`,
      "",
      ...rows.map((r) => `${r.file} → ${r.format}  ${human(r.original_bytes)} → ${human(r.new_bytes)}  −${r.saved_pct}%  ${r.metric} ${r.quality_score}`),
    ];
    navigator.clipboard?.writeText(lines.join("\n"))
      .then(() => toast("Summary copied to your clipboard"))
      .catch(() => toast("Could not access the clipboard"));
  }
}

/* -------------------------------- toast ----------------------------------- */

let toastTimer;
function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("on"), 3600);
}

/* ------------------------------- settings --------------------------------- */

function currentSettings() {
  const { target, formats } = parseFormatChoice($("target").value, state.settings.target);
  return {
    target, formats,
    metric: "ss2",
    qualityTarget: Number($("quality").value),
    maxDimension: Number($("maxdim").value) || 0,
    alphaPolicy: state.settings.alphaPolicy,
  };
}
/* ---- choosing a format that cannot hold what is already in the queue ----- *
 * JPEG has no alpha channel. Asking for "JPEG only" with transparent artwork
 * queued is a question with two defensible answers, so it is asked once, up
 * front, instead of being resolved silently in either direction. Only images
 * the engine has actually looked at count: `alpha` is measured from the
 * decoded pixels, never guessed from the file extension. */
const CARRIES_ALPHA = { jpeg: false, webp: true, png: true, avif: true };

function alphaItemCount() {
  return state.items.filter((i) => i.alpha === true).length;
}

let alphaAnswered = false;   // distinguishes a decision from a dismissal

function onFormatChoice() {
  const value = $("target").value;
  const { formats } = parseFormatChoice(value, state.settings.target);
  // Choosing a destination is choosing all three of its numbers. Leaving size
  // and quality behind would make "Thumbnail or avatar" mean nothing but a
  // shorter format list, and the person would have to know to open Advanced
  // and change two more things for it to do what it says. Still editable
  // afterwards - this moves the starting point, it does not lock it.
  const d = DESTINATION_NUMBERS[value];
  if (d) {
    $("maxdim").value = d.maxDimension;
    $("quality").value = d.qualityTarget;
    $("quality-out").textContent = d.qualityTarget;
    reflectQualityHint();
  }
  const one = formats && formats[0];
  const n = alphaItemCount();
  if (!one || CARRIES_ALPHA[one] !== false || !n) { pushSettings(); return; }

  const dlg = $("alpha-ask");
  $("alpha-ask-body").textContent =
    `${n} ${n === 1 ? "image has" : "images have"} transparent areas, and ` +
    `${one.toUpperCase()} has nowhere to put them. Keep those images as PNG, ` +
    `or flatten the transparency onto white and take the ${one.toUpperCase()}?`;
  alphaAnswered = false;
  dlg.showModal();
}

function settleAlphaChoice(policy) {
  if (policy) {
    state.settings.alphaPolicy = policy;
    alphaAnswered = true;
    $("alpha-ask").close();
    pushSettings();
  } else {
    $("alpha-ask").close();   // the close handler puts the control back
  }
}

let pushTimer;
function pushSettings() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    state.settings = currentSettings();
    state.settingsRev++;
    saveSettings();
    // The toolbar is the whole-queue control: changing it means everything is
    // redone to match, which is what makes it the power-user surface rather
    // than the discoverable one.
    requeue(state.items.filter((i) => i.status !== "working").map((i) => i.id));
  }, 350);
}

/* ------------------------------ theme ------------------------------------- */

const THEMES = ["dark", "light", "system"];
function currentThemePref() {
  try { return localStorage.getItem("imgc-theme") || "system"; } catch { return "system"; }
}
function applyTheme(pref) {
  const resolved = pref === "system"
    ? (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark")
    : pref;
  document.documentElement.classList.add("theming");
  document.documentElement.dataset.theme = resolved;
  setTimeout(() => document.documentElement.classList.remove("theming"), 260);
  const next = THEMES[(THEMES.indexOf(pref) + 1) % THEMES.length];
  const btn = $("theme-btn");
  btn.textContent = next === "system" ? "Auto" : next === "dark" ? "Dark" : "Light";
  btn.title = `Theme: ${pref}. Click for ${next}.`;
  try { localStorage.setItem("imgc-theme", pref); } catch {}
}
matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
  if (currentThemePref() === "system") applyTheme("system");
});

/* ----------------------------- sample images ------------------------------ */

/* A stand-in photograph. It needs real photographic *structure* — soft
 * overlapping shapes at many scales — not just a gradient, or JPEG compresses
 * it to nothing and the demo's numbers look too good to be true. Grain has to
 * stay light: pure noise cannot clear a 0.97 SSIM p5 floor under any lossy
 * codec, so a grainy sample would hand the win to lossless PNG and hide the
 * very thing the demo exists to show. */
function paintPhoto(ctx, W, H) {
  const g = ctx.createLinearGradient(0, 0, W * .3, H);
  g.addColorStop(0, "#f0a184"); g.addColorStop(.45, "#c56a8b"); g.addColorStop(1, "#3c3560");
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

  // low sun with haze
  const sx = W * 0.72, sy = H * 0.28, sr = Math.min(W, H) * 0.22;
  const sun = ctx.createRadialGradient(sx, sy, sr * 0.05, sx, sy, sr);
  sun.addColorStop(0, "#fff3d4"); sun.addColorStop(.35, "rgba(251,222,170,.55)");
  sun.addColorStop(1, "rgba(251,231,189,0)");
  ctx.fillStyle = sun; ctx.beginPath(); ctx.arc(sx, sy, sr, 0, 7); ctx.fill();

  // bokeh: many soft discs, deterministic-ish but varied, at several scales
  let seed = 20260805;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  ctx.save();
  for (let i = 0; i < 90; i++) {
    const r = (8 + rnd() * 74) * (i % 7 === 0 ? 1.8 : 1);
    const x = rnd() * W, y = H * 0.28 + rnd() * H * 0.8;
    const tint = ["255,214,168", "232,150,140", "150,132,196", "255,236,205", "96,86,140"][i % 5];
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, `rgba(${tint},${0.1 + rnd() * 0.22})`);
    grad.addColorStop(1, `rgba(${tint},0)`);
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
  }
  ctx.restore();

  // a dark foreground ridge, so there is real contrast and edge detail
  ctx.save();
  ctx.fillStyle = "rgba(28,24,44,.88)";
  ctx.beginPath();
  ctx.moveTo(0, H);
  ctx.lineTo(0, H * 0.78);
  for (let x = 0; x <= W; x += W / 18) {
    ctx.lineTo(x, H * (0.72 + 0.1 * Math.sin(x / W * 7) + 0.03 * Math.sin(x / W * 23)));
  }
  ctx.lineTo(W, H);
  ctx.closePath(); ctx.fill();
  ctx.restore();

  // light film grain, stamped from one small tile: a per-pixel JS loop over a
  // megapixel froze the page for seconds.
  const TILE = 128;
  const tile = document.createElement("canvas");
  tile.width = TILE; tile.height = TILE;
  const tctx = tile.getContext("2d");
  const id = tctx.createImageData(TILE, TILE);
  for (let i = 0; i < id.data.length; i += 4) {
    id.data[i] = id.data[i + 1] = id.data[i + 2] = 128;
    id.data[i + 3] = Math.random() * 34;
  }
  tctx.putImageData(id, 0, 0);
  ctx.save();
  ctx.globalCompositeOperation = "overlay";
  ctx.globalAlpha = 0.32;
  ctx.fillStyle = ctx.createPattern(tile, "repeat");
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
}

function paintUi(ctx, W, H) {
  ctx.fillStyle = "#f4f5f7"; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#191c22"; ctx.fillRect(0, 0, W, 64);
  const rows = Math.floor((H - 96) / 80);
  for (let i = 0; i < rows; i++) {
    ctx.fillStyle = "#ffffff"; ctx.fillRect(48, 96 + i * 80, W - 96, 64);
    ctx.fillStyle = ["#4471e0", "#3d9e6d", "#c2542e"][i % 3];
    ctx.fillRect(64, 112 + i * 80, 32, 32);
    ctx.fillStyle = "#2a2e36";
    ctx.fillRect(116, 118 + i * 80, Math.min(W - 200, 300 + (i * 83) % 400), 9);
    ctx.fillStyle = "#9aa1ad";
    ctx.fillRect(116, 136 + i * 80, Math.min(W - 240, 220 + (i * 131) % 500), 7);
  }
}

let samplesBusy = false;
async function addSamples() {
  if (samplesBusy) return;
  samplesBusy = true;
  const btn = $("sample-btn");
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Building demo…";
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  try {
    const make = (paint, W, H) => {
      const c = document.createElement("canvas");
      c.width = W; c.height = H;
      paint(c.getContext("2d"), W, H);
      return new Promise((r) => c.toBlob(r, "image/png"));
    };
    const photo = await make(paintPhoto, 900, 600);
    const ui = await make(paintUi, 1000, 700);
    addFiles([
      new File([photo], "sample-photo.png", { type: "image/png" }),
      new File([ui], "sample-ui.png", { type: "image/png" }),
    ]);
  } catch {
    toast("Could not build the demo — try dropping your own image");
  } finally {
    btn.disabled = false;
    btn.textContent = label;
    samplesBusy = false;
  }
}

/* --------------------------- hero size animation --------------------------- */

function animateSizeDemo() {
  if (REDUCED) return;
  const pairs = [
    [5.0 * 1024 * 1024, 812 * 1024, "PNG screenshot"],
    [2.4 * 1024 * 1024, 214 * 1024, "hero photo"],
    [860 * 1024, 61 * 1024, "product shot"],
    [1.6 * 1024 * 1024, 96 * 1024, "Figma export"],
  ];
  let i = 0;
  const from = $("sd-from"), to = $("sd-to"), pct = $("sd-pct");
  const show = () => {
    if (!from || $("app-empty").hidden) return;      // stop once work begins
    const [a, b] = pairs[i % pairs.length];
    from.textContent = human(a);
    pct.textContent = `−${Math.round(100 * (a - b) / a)}%`;
    const t0 = performance.now(), dur = 900;
    const tick = (t) => {
      const p = Math.min(1, (t - t0) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      to.textContent = human(a + (b - a) * eased);
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    i++;
  };
  show();
  setInterval(show, 3400);
}

/* -------------------------------- events ---------------------------------- */

function setMode(m) {
  mode = m;
  $("mode-split").setAttribute("aria-pressed", String(m === "split"));
  $("mode-after").setAttribute("aria-pressed", String(m === "after"));
  $("mode-diff").setAttribute("aria-pressed", String(m === "diff"));
  dirty.inspector = true;
  scheduleRender();
}

function bind() {
  $("target").addEventListener("change", onFormatChoice);
  $("maxdim").addEventListener("change", pushSettings);
  // The words drive the number, and the number drives the engine. One setting.
  $("quality-preset").addEventListener("change", (e) => {
    if (e.target.value === "custom") return;    // only the slider sets that
    $("quality").value = e.target.value;
    $("quality-out").textContent = e.target.value;
    reflectQualityHint();
    pushSettings();
  });
  $("quality").addEventListener("input", () => {
    $("quality-out").textContent = $("quality").value;
    reflectQualityHint();
  });
  $("quality").addEventListener("change", pushSettings);
  $("suffix-toggle").addEventListener("change", (e) => {
    state.suffix = e.target.checked;
    saveSettings();
    scheduleRender("summary");
  });

  $("adv-btn").addEventListener("click", () => {
    const open = $("advanced").hidden;
    $("advanced").hidden = !open;
    $("adv-btn").setAttribute("aria-expanded", String(open));
  });

  $("theme-btn").addEventListener("click", () => {
    const pref = currentThemePref();
    applyTheme(THEMES[(THEMES.indexOf(pref) + 1) % THEMES.length]);
  });

  $("queue-list").addEventListener("click", (e) => {
    const row = e.target.closest(".row");
    if (row) selectItem(row.dataset.id);
  });

  // A candidate chip is the direct way to see and keep a different encode.
  $("cands").addEventListener("click", (e) => {
    const card = e.target.closest(".cand[data-format]");
    if (card) chooseCandidate(card.dataset.format);
  });
  // The end of the narration is a real action, so it is handled like one.
  $("narration").addEventListener("click", (e) => {
    const act = e.target.closest("[data-narr]")?.dataset.narr;
    if (act === "chips") surfaceChips();
    else if (act === "auto") {
      const it = state.byId.get(selected);
      if (it?.auto) chooseCandidate(it.auto.passthrough ? ORIGINAL_PICK : it.auto.fmt);
    }
  });

  /* Renaming, which used to live in the set-up step. The extension is not
     editable: the encode that is on screen decides it. */
  const commitName = () => {
    const it = state.byId.get(selected);
    if (!it) return;
    const field = $("insp-name"), { base, ext } = splitName(it.name);
    const v = field.value.trim();
    if (v && v !== base) {
      it.name = v + ext;
      field.size = Math.max(4, v.length);
      rowEls.get(it.id)?.querySelector(".name")?.replaceChildren(it.name);
      scheduleRender("summary");
    } else if (!v) {
      field.value = base;
    }
  };
  $("insp-name").addEventListener("change", commitName);
  $("insp-name").addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    commitName();
    $("insp-name").blur();
  });

  // Collapse the detail panel to give the comparison the whole pane.
  $("insp-toggle").addEventListener("click", () => {
    const open = $("details").hidden;
    $("details").hidden = !open;
    $("insp-toggle").setAttribute("aria-expanded", String(open));
    $("insp-toggle").textContent = open ? "Details ▾" : "Details ▸";
    requestAnimationFrame(applyZoom);
  });

  // Header overflow menu.
  const moreMenu = $("more-menu");
  $("more-btn").addEventListener("click", () => {
    const open = moreMenu.hidden;
    moreMenu.hidden = !open;
    $("more-btn").setAttribute("aria-expanded", String(open));
  });
  moreMenu.addEventListener("click", (e) => {
    if (e.target.hasAttribute?.("data-keys")) $("keys").showModal();
    moreMenu.hidden = true;
    $("more-btn").setAttribute("aria-expanded", "false");
  });
  document.addEventListener("click", (e) => {
    if (!moreMenu.hidden && !e.target.closest(".overflow")) {
      moreMenu.hidden = true;
      $("more-btn").setAttribute("aria-expanded", "false");
    }
  });

  $("split").addEventListener("input", (e) => {
    $("viewport").style.setProperty("--split", `${100 - e.target.value}%`);
    $("divider").style.left = `${e.target.value}%`;
  });
  $("viewport").style.setProperty("--split", "50%");
  $("divider").addEventListener("dblclick", () => {
    $("split").value = 50;
    $("viewport").style.setProperty("--split", "50%");
    $("divider").style.left = "50%";
  });

  $("mode-split").addEventListener("click", () => setMode("split"));
  $("mode-after").addEventListener("click", () => setMode("after"));
  $("mode-diff").addEventListener("click", () => setMode(mode === "diff" ? "split" : "diff"));
  $("zoom-in").addEventListener("click", () => stepZoom(1));
  $("zoom-out").addEventListener("click", () => stepZoom(-1));
  $("zoom-reset").addEventListener("click", () => { zoom = 0; pan = { x: 0, y: 0 }; applyZoom(); });
  $("img-before").addEventListener("load", applyZoom);
  // The heatmap needs both frames decoded; recompute once the late one lands.
  for (const id of ["img-before", "img-after"]) {
    $(id).addEventListener("load", () => {
      if (mode === "diff") { dirty.inspector = true; scheduleRender(); }
    });
  }
  /* The original would not decode. Recorded on the item, not just the element,
     so it survives selecting away and back - and matched against the URL that
     actually failed, so a stale flag cannot condemn a later image. */
  $("img-before").addEventListener("error", (e) => {
    const url = e.target.getAttribute("src");
    if (!url) return;                       // src removed, not a load failure
    const it = state.byId.get(selected);
    if (!it || it.beforeURL !== url) return;
    it.previewDead = true;
    dirty.inspector = true;
    scheduleRender();
  });
  new ResizeObserver(() => applyZoom()).observe($("stage"));

  $("stage").addEventListener("wheel", (e) => {
    e.preventDefault();
    zoomAt(e.deltaY < 0 ? 1 : -1, e.clientX, e.clientY);
  }, { passive: false });
  $("stage").addEventListener("dblclick", (e) => {
    if (e.target.closest(".stage-bar")) return;
    // Double-click toggles fit and 100%, and lands on what was clicked.
    if (zoom) { zoom = 0; pan = { x: 0, y: 0 }; applyZoom(); return; }
    const box = $("stage").getBoundingClientRect();
    const cx = box.left + box.width / 2, cy = box.top + box.height / 2;
    const k = 1 / scaleNow();
    zoom = 1;
    pan = { x: (e.clientX - cx) - (e.clientX - cx - pan.x) * k,
            y: (e.clientY - cy) - (e.clientY - cy - pan.y) * k };
    applyZoom();
  });

  let dragging = null;
  $("stage").addEventListener("pointerdown", (e) => {
    if (zoom === 0 || e.target.id === "split") return;
    dragging = { x: e.clientX - pan.x, y: e.clientY - pan.y };
    $("stage").setPointerCapture(e.pointerId);
    $("stage").style.cursor = "grabbing";
  });
  $("stage").addEventListener("pointermove", (e) => {
    if (!dragging) return;
    pan = { x: e.clientX - dragging.x, y: e.clientY - dragging.y };
    applyZoom();
  });
  $("stage").addEventListener("pointerup", () => {
    dragging = null;
    $("stage").style.cursor = zoom ? "grab" : "";
  });

  let dragDepth = 0;
  window.addEventListener("dragenter", (e) => {
    e.preventDefault(); dragDepth++;
    const n = e.dataTransfer?.items?.length || 0;
    $("veil-count").textContent = n > 1
      ? `${n} items — we'll race every format on each one`
      : "We'll race every format and keep the smallest that passes";
    $("veil").classList.add("on");
    $("drop-target")?.classList.add("armed");
  });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("dragleave", () => {
    if (--dragDepth <= 0) {
      $("veil").classList.remove("on");
      $("drop-target")?.classList.remove("armed");
    }
  });
  window.addEventListener("drop", async (e) => {
    e.preventDefault(); dragDepth = 0;
    $("veil").classList.remove("on");
    $("drop-target")?.classList.remove("armed");
    if (!e.dataTransfer) return;
    const files = await filesFromDataTransfer(e.dataTransfer);
    if (files.length) addFiles(files);
  });
  window.addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) addFiles(files);
  });

  $("file-input").addEventListener("change", (e) => {
    if (e.target.files.length) addFiles(e.target.files);
    e.target.value = "";
  });
  $("add-btn").addEventListener("click", () => $("file-input").click());
  $("empty-add").addEventListener("click", () => $("file-input").click());
  $("sample-btn").addEventListener("click", addSamples);
  $("stop-btn").addEventListener("click", cancelAll);

  $("clear-btn").addEventListener("click", () => {
    if (!state.items.length) return;
    cancelAll();
    removeItems(state.items.map((i) => i.id));
    toast("Cleared");
  });
  $("remove-btn").addEventListener("click", () => { if (selected) removeItems([selected]); });
  $("retry-btn").addEventListener("click", () => { if (selected) requeue([selected]); });
  $("dl-one").addEventListener("click", () => {
    const it = state.byId.get(selected);
    if (!it || !isReady(it)) return;
    downloadBlob(it.afterBlob, outputName(it));
    toast(`Downloaded ${outputName(it)}`);
    it.status = "saved";
    scheduleRender();
  });
  $("copy-one").addEventListener("click", () => copyImage(state.byId.get(selected)));

  $("ov-apply").addEventListener("click", () => {
    const it = state.byId.get(selected);
    if (!it) return;
    const format = $("ov-format").value;
    const quality = $("ov-quality").value;
    const override = {};
    if (format) override.formats = [format];
    if (quality !== "") override.qualityTarget = Number(quality);
    it.override = Object.keys(override).length ? override : null;
    requeue([it.id]);
  });
  $("ov-reset").addEventListener("click", () => {
    const it = state.byId.get(selected);
    if (!it) return;
    it.override = null;
    $("ov-format").value = "";
    $("ov-quality").value = "";
    requeue([it.id]);
  });

  $("save-btn").addEventListener("click", downloadAll);

  const menu = $("export-menu");
  $("export-btn").addEventListener("click", () => {
    const open = menu.hidden;
    menu.hidden = !open;
    $("export-btn").setAttribute("aria-expanded", String(open));
  });
  menu.addEventListener("click", (e) => {
    const kind = e.target.dataset?.export;
    if (!kind) return;
    exportReport(kind);
    menu.hidden = true;
    $("export-btn").setAttribute("aria-expanded", "false");
  });
  document.addEventListener("click", (e) => {
    if (!menu.hidden && !e.target.closest(".export")) {
      menu.hidden = true;
      $("export-btn").setAttribute("aria-expanded", "false");
    }
  });

  let spaceHeldAt = 0;
  document.addEventListener("keydown", (e) => {
    if (e.target.matches("input, select, textarea")) return;
    if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); downloadAll(); }
    else if (e.key === "Escape") { cancelAll(); }
    else if (e.key === "Delete" || e.key === "Backspace") {
      if (selected) { e.preventDefault(); removeItems([selected]); }
    } else if (e.key === "d" || e.key === "D") {
      if (state.items.length) setMode(mode === "diff" ? "split" : "diff");
    } else if (e.key === " ") {
      e.preventDefault();
      if (e.repeat) return;
      spaceHeldAt = performance.now();
      $("viewport").classList.add("peek");
      $("tag-r").textContent = "Showing original — release to compare";
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!state.items.length) return;
      e.preventDefault();
      const i = state.items.findIndex((x) => x.id === selected);
      const next = state.items[Math.max(0, Math.min(state.items.length - 1,
        i + (e.key === "ArrowDown" ? 1 : -1)))];
      if (next) selectItem(next.id);
    } else if (e.key === "?") {
      $("keys").showModal();
    }
  });
  document.addEventListener("keyup", (e) => {
    if (e.key !== " " || e.target.matches("input, select, textarea")) return;
    $("viewport").classList.remove("peek");
    if (performance.now() - spaceHeldAt < 250 && state.items.length) {
      setMode(mode === "after" ? "split" : "after");
    } else {
      dirty.inspector = true; scheduleRender();
    }
  });
  $("keys-close").addEventListener("click", () => $("keys").close());

  $("alpha-keep").addEventListener("click", () => settleAlphaChoice("png"));
  $("alpha-flatten").addEventListener("click", () => settleAlphaChoice("flatten"));
  $("alpha-cancel").addEventListener("click", () => settleAlphaChoice(null));
  /* Esc and the backdrop close a <dialog> without touching a button, and that
     must mean the same thing as Cancel: the control goes back to what is
     actually in force, rather than displaying a setting the engine was never
     given. An answered dialog is exempt - its choice is already on its way
     through pushSettings, which reads this control. */
  $("alpha-ask").addEventListener("close", () => {
    if (alphaAnswered) { alphaAnswered = false; return; }
    $("target").value = formatChoiceValue(state.settings);
  });

  window.addEventListener("beforeunload", (e) => {
    if (state.items.some((i) => i.status === "done")) e.preventDefault();
  });
}

/* --------------------------------- boot ----------------------------------- */

// Options before values: loadSettings assigns to #target, and assigning a
// value an empty <select> does not have is silently a no-op - the control
// would sit blank and the stored destination would be lost on the next push.
renderDestinationOptions();
loadSettings();
applyTheme(currentThemePref());
renderLifetime();
bind();
render();
animateSizeDemo();
startEngine();
