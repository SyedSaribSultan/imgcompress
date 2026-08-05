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
  settings: { target: "figma", qualityTarget: 0.97, maxDimension: 2560 },
  settingsRev: 0,
  caps: { webp: null, png8: null },
  suffix: false,
};
let selected = null;
let mode = "split";
let zoom = 0;
let pan = { x: 0, y: 0 };
let batchActive = false;
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
    if (saved.target) state.settings.target = saved.target;
    if (saved.qualityTarget >= 0.8 && saved.qualityTarget <= 1) {
      state.settings.qualityTarget = saved.qualityTarget;
    }
    if (Number.isFinite(saved.maxDimension)) state.settings.maxDimension = saved.maxDimension;
    state.suffix = !!saved.suffix;
  } catch {}
  $("target").value = state.settings.target;
  $("quality").value = Math.round(state.settings.qualityTarget * 100);
  $("quality-out").textContent = $("quality").value;
  $("maxdim").value = state.settings.maxDimension;
  $("suffix-toggle").checked = state.suffix;
  reflectQualityHint();
}

function saveSettings() {
  try {
    localStorage.setItem("imgc-settings",
      JSON.stringify({ ...state.settings, suffix: state.suffix }));
  } catch {}
}

function hintForQuality(q) {
  if (q >= 100) return "pixel-perfect — only lossless candidates can win";
  if (q >= 98) return "overkill for most things — masters you'll re-edit";
  if (q >= 97) return "default — imperceptible side by side";
  if (q >= 94) return "safe for A/B toggling";
  if (q >= 90) return "fine for busy photos";
  return "visible if you go looking — thumbnails";
}
function reflectQualityHint() {
  const q = Number($("quality").value);
  $("quality-note").textContent = hintForQuality(q);
}

/* --------------------------- lifetime statistics -------------------------- */
/* Numbers only — never filenames, never image data. This is the honest
 * version of "social proof": your own totals, computed on your machine. */

function bumpLifetime(images, bytes) {
  try {
    const s = JSON.parse(localStorage.getItem("imgc-stats") || "{}");
    const next = { images: (s.images || 0) + images, bytes: (s.bytes || 0) + bytes };
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
  if (msg.engines) state.caps = { ...state.caps, ...msg.engines };

  if (msg.rev !== state.settingsRev && !item.override) {
    item.status = "queued";
    scheduleRender(); dispatch();
    return;
  }

  if (msg.type === "failed") {
    item.status = "failed";
    item.error = msg.error || "failed";
    item.warnings = msg.warnings || [];
  } else if (msg.type === "done") {
    const r = msg.result;
    if (item.afterURL) URL.revokeObjectURL(item.afterURL);
    const blob = new Blob([r.bytes], { type: r.mime });
    item.status = "done";
    item.justFinished = true;
    item.wipePending = true;
    item.perf = msg.perf || null;   // phase timings, for the benchmark
    item.result = r;
    item.afterBlob = blob;
    item.afterURL = URL.createObjectURL(blob);
    item.newBytes = r.newBytes;
    item.fmt = r.fmt;
    item.level = r.level;
    item.score = r.score;
    item.lossless = !!r.lossless;
    item.note = r.note || "";
    item.warnings = r.warnings || [];
    item.candidates = r.candidates || [];
    item.passthrough = !!r.passthrough;
    item.diffURL = null;
    if (r.width) { item.width = r.width; item.height = r.height; }
    item.outW = r.outW || item.width;
    item.outH = r.outH || item.height;
    if (!item.counted) {
      item.counted = true;
      bumpLifetime(1, Math.max(0, item.originalBytes - item.newBytes));
    }
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
  toast(saved > 0
    ? `All done — you just saved ${human(saved)} (${Math.round(saved / before * 100)}%) across ${done.length} image${done.length === 1 ? "" : "s"}`
    : "All done — these were already well compressed");
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
  batchActive = true;
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
  toast(`Added ${usable.length} image${usable.length === 1 ? "" : "s"}`);
  scheduleRender();
  dispatch();
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
    item.candidates = [];
    item.frac = 0;
    if (item.diffURL) { URL.revokeObjectURL(item.diffURL); item.diffURL = null; }
    any = true;
  }
  if (any) batchActive = true;
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
  if (it.passthrough) return "Passed through unchanged";
  return fmtLabel(it.fmt) + (it.level != null ? ` · quality ${it.level}` : "");
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

function capsLine() {
  if (state.caps.webp === null) return "Drop images anywhere on this page";
  const parts = [state.caps.mozjpeg ? "mozjpeg" : "jpeg", "png"];
  if (state.caps.png8) parts.push("png8");
  if (state.caps.oxipng) parts.push("oxipng");
  if (state.caps.webp) parts.push("webp");
  if (state.caps.avif) parts.push("avif");
  return `Engines: ${parts.join(", ")} · all running in your browser`;
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

function fmtScore(score, lossless) {
  if (lossless) return "lossless";
  if (score == null) return "—";
  return score.toFixed(4);
}

/** One plain sentence explaining why this candidate won. */
function verdictFor(it) {
  if (it.passthrough) {
    return `This file was already smaller than anything we could produce, so it was <b>passed through untouched</b>.`;
  }
  if (!it.candidates?.length) return "";
  const pct = it.originalBytes ? 100 * (it.originalBytes - it.newBytes) / it.originalBytes : 0;
  const sorted = [...it.candidates].sort((a, b) => a.bytes - b.bytes);
  const runner = sorted[1];
  const quality = it.lossless
    ? "and it is <b>pixel-identical</b> to the original"
    : `at SSIM <b>${it.score?.toFixed(4)}</b>, above your ${Number(
        it.override?.qualityTarget ?? state.settings.qualityTarget).toFixed(2)} floor`;
  let line = `<b>${escapeHtml(fmtLabel(it.fmt))}</b> won: <b>${pct.toFixed(0)}% smaller</b> than the original, ${quality}.`;
  if (runner && runner.bytes > it.newBytes) {
    const gap = 100 * (runner.bytes - it.newBytes) / runner.bytes;
    line += ` It beat ${escapeHtml(fmtLabel(runner.format))} by ${gap.toFixed(0)}%.`;
  }
  return line;
}

function renderInspector(it) {
  if (!it) { showInspector(false); return; }
  showInspector(true);

  $("insp-name").textContent = it.name;
  const dims = it.width ? `${it.width}×${it.height}` : "";
  const out = it.outW && (it.outW !== it.width || it.outH !== it.height)
    ? ` → ${it.outW}×${it.outH}` : "";
  $("insp-dims").textContent = dims + out;

  const before = $("img-before"), after = $("img-after");
  if (before.dataset.src !== it.beforeURL) { before.dataset.src = it.beforeURL; before.src = it.beforeURL; }
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
  badge.hidden = splitting || !ready;
  if (!badge.hidden) {
    badge.textContent = diffOn
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
  $("s-score").textContent = ready ? fmtScore(it.score, it.lossless || it.passthrough) : "—";
  $("s-dims").innerHTML = !it.width ? "—"
    : (it.outW && it.outW !== it.width
        ? `${it.outW}×${it.outH} <small>from ${it.width}×${it.height}</small>`
        : `${it.width}×${it.height}`);
  const floor = it.override?.qualityTarget ?? state.settings.qualityTarget;
  $("s-floor").innerHTML = Number(floor).toFixed(2) + (it.override ? " <small>override</small>" : "");

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
      ? Math.round(it.override.qualityTarget * 100) : "";
  }
  $("ov-reset").hidden = !it.override;
  $("dl-one").disabled = !ready;
  $("retry-btn").hidden = it.status !== "failed" && it.status !== "cancelled";
  applyZoom();
}

/** Leaderboard: every candidate ranked, with the original as the yardstick.
 *  Each row is a button — clicking it forces that format for this image, which
 *  is the direct route to what the old "override" drawer did in three steps. */
function renderCandidates(it) {
  const cands = $("cands");
  if (!it.candidates?.length) {
    cands.innerHTML = `<div class="note m0">${
      it.status === "failed" ? "This file could not be read." :
      it.status === "cancelled" ? "Stopped before this one finished." :
      it.passthrough ? "Passed through unchanged." : "Testing formats…"}</div>`;
    return;
  }
  const rows = [...it.candidates].sort((a, b) => a.bytes - b.bytes);
  const winner = rows[0].bytes;
  const max = Math.max(it.originalBytes, ...rows.map((c) => c.bytes));
  const forced = it.override?.formats?.[0] || "";

  const pct = (bytes) => it.originalBytes
    ? Math.round(100 * (it.originalBytes - bytes) / it.originalBytes) : 0;

  cands.innerHTML = rows.map((c) => {
    const isWinner = c.bytes === winner;
    const saving = pct(c.bytes);
    return `
    <button class="cand ${isWinner ? "win" : ""} ${forced === c.format ? "forced" : ""}"
            data-bytes="${c.bytes}" data-format="${escapeHtml(c.format)}"
            title="Keep the ${escapeHtml(fmtLabel(c.format))} version for this image">
      <span class="bar"></span>
      <span class="f">${escapeHtml(fmtLabel(c.format))}</span>
      <span class="b">${human(c.bytes)}</span>
      <span class="p">${saving > 0 ? `−${saving}%` : "—"}</span>
      <span class="${isWinner ? "badge" : "s"}">${
        isWinner ? (forced ? "chosen" : "winner") : (c.lossless ? "lossless" : c.score.toFixed(3))}</span>
    </button>`;
  }).join("") + `
    <div class="cand orig" data-bytes="${it.originalBytes}">
      <span class="bar"></span>
      <span class="f">Original</span>
      <span class="b">${human(it.originalBytes)}</span>
      <span class="p"></span>
      <span class="s">—</span>
    </div>`;

  // Widths go through the CSSOM: a style="" attribute in markup would (rightly)
  // be refused by the page's style-src CSP, leaving every bar at zero.
  for (const el of cands.querySelectorAll(".cand")) {
    const w = Math.max(2, (Number(el.dataset.bytes) / max) * 100);
    el.style.setProperty("--w", `${w.toFixed(1)}%`);
  }
}

/** Force a format from a candidate card, or unforce it by clicking it again. */
function chooseCandidate(format) {
  const it = state.byId.get(selected);
  if (!it) return;
  const already = it.override?.formats?.[0] === format;
  const override = { ...(it.override || {}) };
  if (already) delete override.formats; else override.formats = [format];
  it.override = Object.keys(override).length ? override : null;
  $("ov-format").value = it.override?.formats?.[0] || "";
  toast(already ? "Back to the best of all candidates" : `Keeping ${fmtLabel(format)} for this image`);
  requeue([it.id]);
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
function applyZoom() {
  const stage = $("stage"), img = $("img-before"), vp = $("viewport");
  if (!img.naturalWidth) return;
  // Tight margin: the image is the subject, so it should own the pane. Fit is
  // still capped at 1 - upscaling a compressed file would misrepresent it.
  const pad = 14;
  const fit = Math.min(
    (stage.clientWidth - pad * 2) / img.naturalWidth,
    (stage.clientHeight - pad * 2) / img.naturalHeight,
    1
  );
  const scale = zoom || Math.max(fit, 0.02);
  vp.style.width = Math.max(1, Math.round(img.naturalWidth * scale)) + "px";
  vp.style.height = Math.max(1, Math.round(img.naturalHeight * scale)) + "px";
  vp.style.transform = zoom ? `translate(${pan.x}px, ${pan.y}px)` : "";
  stage.style.cursor = zoom ? "grab" : "";
  $("zoom-label").textContent = zoom ? `${Math.round(zoom * 100)}%` : "Fit";
}
function stepZoom(dir) {
  const i = ZOOMS.indexOf(zoom);
  const next = Math.max(0, Math.min(ZOOMS.length - 1, (i < 0 ? 1 : i) + dir));
  zoom = ZOOMS[next]; pan = { x: 0, y: 0 }; applyZoom();
}

/* ------------------------------- downloads -------------------------------- */

function outputName(it, used) {
  let base = it.name.replace(/\.[a-z0-9]+$/i, "");
  const ext = (it.passthrough || !it.result?.ext)
    ? (it.name.match(/\.[a-z0-9]+$/i) || [""])[0] : it.result.ext;
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
    ssim_p5: it.lossless ? "lossless" : (it.score != null ? +it.score.toFixed(4) : ""),
    width: it.outW, height: it.outH,
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
      tool: "imgcompress web", version: "2.2.0",
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
      ...rows.map((r) => `${r.file} → ${r.format}  ${human(r.original_bytes)} → ${human(r.new_bytes)}  −${r.saved_pct}%  ssim ${r.ssim_p5}`),
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
  return {
    target: $("target").value,
    qualityTarget: Number($("quality").value) / 100,
    maxDimension: Number($("maxdim").value) || 0,
  };
}
let pushTimer;
function pushSettings() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    state.settings = currentSettings();
    state.settingsRev++;
    saveSettings();
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
  $("target").addEventListener("change", pushSettings);
  $("maxdim").addEventListener("change", pushSettings);
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

  // A candidate card is the direct way to keep a different format.
  $("cands").addEventListener("click", (e) => {
    const card = e.target.closest(".cand[data-format]");
    if (card) chooseCandidate(card.dataset.format);
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
  new ResizeObserver(() => applyZoom()).observe($("stage"));

  $("stage").addEventListener("wheel", (e) => { e.preventDefault(); stepZoom(e.deltaY < 0 ? 1 : -1); },
    { passive: false });
  $("stage").addEventListener("dblclick", (e) => {
    if (e.target.closest(".stage-bar")) return;
    zoom = zoom ? 0 : 1; pan = { x: 0, y: 0 }; applyZoom();
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

  $("ov-apply").addEventListener("click", () => {
    const it = state.byId.get(selected);
    if (!it) return;
    const format = $("ov-format").value;
    const quality = $("ov-quality").value;
    const override = {};
    if (format) override.formats = [format];
    if (quality !== "") override.qualityTarget = Number(quality) / 100;
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

  window.addEventListener("beforeunload", (e) => {
    if (state.items.some((i) => i.status === "done")) e.preventDefault();
  });
}

/* --------------------------------- boot ----------------------------------- */

loadSettings();
applyTheme(currentThemePref());
renderLifetime();
bind();
render();
animateSizeDemo();
startEngine();
