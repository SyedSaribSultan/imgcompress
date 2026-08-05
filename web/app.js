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
  items: [],            // ordered
  byId: new Map(),
  settings: { target: "figma", qualityTarget: 0.97, maxDimension: 2560 },
  settingsRev: 0,
  caps: { webp: null, png8: null },
};
let selected = null;
let mode = "split";
let zoom = 0;
let pan = { x: 0, y: 0 };
let batchActive = false;   // true while at least one item is queued/working
const BASE_TITLE = document.title;

function uid() {
  const a = new Uint8Array(8);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* ------------------------- settings persistence -------------------------- */

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem("imgc-settings") || "{}");
    if (saved.target) state.settings.target = saved.target;
    if (saved.qualityTarget >= 0.8 && saved.qualityTarget <= 1) {
      state.settings.qualityTarget = saved.qualityTarget;
    }
    if (Number.isFinite(saved.maxDimension)) state.settings.maxDimension = saved.maxDimension;
  } catch {}
  $("target").value = state.settings.target;
  $("quality").value = Math.round(state.settings.qualityTarget * 100);
  $("quality-out").textContent = $("quality").value;
  $("maxdim").value = state.settings.maxDimension;
  reflectQualityHint();
}

function saveSettings() {
  try { localStorage.setItem("imgc-settings", JSON.stringify(state.settings)); } catch {}
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
  const hint = hintForQuality(q);
  $("quality").title = hint;
  $("quality-out").title = hint;
}

/* ----------------------------- worker pool ------------------------------- */

const POOL_MAX = Math.min(4, Math.max(1, (navigator.hardwareConcurrency || 4) - 1));
const pool = [];

function makeWorker() {
  const w = new Worker("worker.js");
  const slot = { w, busy: false, itemId: null, index: pool.length };
  w.onmessage = (e) => onWorkerMessage(slot, e.data);
  w.onerror = () => {
    if (slot.itemId) {
      const item = state.byId.get(slot.itemId);
      if (item) { item.status = "failed"; item.error = "the compression worker crashed"; }
    }
    slot.busy = false; slot.itemId = null;
    scheduleRender(); dispatch();
  };
  pool.push(slot);
  return slot;
}

/** Spawn workers as demand appears instead of all four at page load. */
function ensurePool(want) {
  while (pool.length < Math.min(POOL_MAX, Math.max(1, want))) makeWorker();
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

  for (const item of queued) {
    // Prefer the worker that last handled this item - its decode cache makes
    // a quality-only re-run start instantly.
    let slot = item.slot != null && !pool[item.slot].busy ? pool[item.slot] : null;
    if (!slot) slot = pool.find((s) => !s.busy);
    if (!slot) return;

    slot.busy = true;
    slot.itemId = item.id;
    item.slot = slot.index;
    item.status = "working";
    item.progress = "reading…";
    item.frac = 0;
    scheduleRender("queue");
    let buffer;
    try {
      buffer = await item.file.arrayBuffer();
    } catch {
      item.status = "failed";
      item.error = "could not read the file";
      slot.busy = false; slot.itemId = null;
      scheduleRender();
      continue;
    }
    slot.w.postMessage({
      type: "job", id: item.id, rev: state.settingsRev,
      name: item.name, buffer, mime: mimeFor(item.file),
      settings: effectiveSettings(item),
    }, [buffer]);
  }
}

function onWorkerMessage(slot, msg) {
  if (msg.type === "caps") {
    state.caps = msg.caps;
    scheduleRender("queue");
    return;
  }
  const item = state.byId.get(msg.id);
  if (!item) { // removed while working
    if (msg.type !== "progress") { slot.busy = false; slot.itemId = null; dispatch(); }
    return;
  }

  if (msg.type === "progress") {
    item.frac = msg.frac ?? item.frac ?? 0;
    item.progress = msg.stage === "decoding"
      ? "decoding…"
      : `${msg.detail || "encoding"} · ${Math.round((item.frac || 0) * 100)}%`;
    scheduleRender("queue");
    return;
  }

  slot.busy = false;
  slot.itemId = null;

  if (msg.rev !== state.settingsRev && !item.override) {
    // Settings changed while this ran; the result is stale. Run it again.
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
    item.justFinished = true;   // one render's worth of celebration
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
    if (r.width) { item.width = r.width; item.height = r.height; }
    item.outW = r.outW || item.width;
    item.outH = r.outH || item.height;
  }
  scheduleRender();
  dispatch();
  maybeCelebrate();
}

function startEngine() {
  ensurePool(1);
  pool[0].w.postMessage({ type: "probe" });
}

/** The app should acknowledge the moment the whole batch lands. */
function maybeCelebrate() {
  const busy = state.items.some((i) => i.status === "queued" || i.status === "working");
  if (busy || !batchActive) return;
  batchActive = false;
  const done = state.items.filter((i) => i.status === "done" || i.status === "saved");
  if (!done.length) return;
  const before = done.reduce((s, i) => s + i.originalBytes, 0);
  const after = done.reduce((s, i) => s + i.newBytes, 0);
  const saved = before - after;
  if (saved > 0) {
    toast(`All done — saved ${human(saved)} (${Math.round(saved / before * 100)}%) across ${done.length} image${done.length === 1 ? "" : "s"}`);
  } else {
    toast("All done — these were already well compressed");
  }
}

/* ------------------------------ add files -------------------------------- */

async function makeThumb(item) {
  try {
    const bmp = await createImageBitmap(item.file);
    const side = 68;
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
  const entries = [...(dt.items || [])]
    .map((i) => i.webkitGetAsEntry?.())
    .filter(Boolean);
  if (!entries.some((e) => e.isDirectory)) return dt.files;

  const out = [];
  async function walk(entry) {
    if (entry.isFile) {
      const f = await new Promise((res, rej) => entry.file(res, rej)).catch(() => null);
      if (f) out.push(f);
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej))
          .catch(() => []);
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
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
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

function statusLine(it) {
  if (it.status === "failed") return `<span class="err">${escapeHtml(it.error || "failed")}</span>`;
  if (it.status === "queued") return "waiting…";
  if (it.status === "working") return escapeHtml(it.progress || "encoding…");
  const pct = it.originalBytes && it.newBytes
    ? 100 * (it.originalBytes - it.newBytes) / it.originalBytes : 0;
  const pctText = pct > 0 ? `−${pct.toFixed(0)}%` : "no gain";
  const tail = it.status === "saved" ? ` <span class="save">saved</span>` : "";
  return `${human(it.originalBytes)} → ${human(it.newBytes)} · ${pctText}${tail}`;
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
    // update in place - no innerHTML churn, no lost hover states
    el.setAttribute("aria-selected", String(it.id === selected));
    el.classList.toggle("working", it.status === "working");
    const meta = statusLine(it);
    if (el.dataset.meta !== meta) {
      el.dataset.meta = meta;
      el.querySelector(".meta").innerHTML = meta;
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

  const done = state.items.filter((i) => i.status === "done" || i.status === "saved").length;
  const busyItems = state.items.filter((i) => i.status === "queued" || i.status === "working").length;
  $("queue-foot").textContent = busyItems
    ? `${busyItems} to go · ${done} ready`
    : `${done} ready · Ctrl+S downloads everything · ? for shortcuts`;
}

function capsLine() {
  if (state.caps.webp === null) return "Drop images anywhere on this page";
  const parts = ["jpeg", "png"];
  if (state.caps.png8) parts.push("png8");
  if (state.caps.webp) parts.push("webp");
  return `Engines ready: ${parts.join(", ")} · runs entirely in your browser`;
}

function renderBatchProgress() {
  const bar = $("batch-bar");
  const items = state.items;
  const busy = items.some((i) => i.status === "queued" || i.status === "working");
  $("batch").classList.toggle("on", busy);
  if (!busy) { bar.style.width = "0%"; return; }
  let sum = 0;
  for (const i of items) {
    sum += (i.status === "done" || i.status === "saved" || i.status === "failed") ? 1
      : i.status === "working" ? Math.min(0.95, i.frac || 0) : 0;
  }
  bar.style.width = `${(sum / items.length) * 100}%`;
}

function renderTitle() {
  const busyItems = state.items.filter((i) => i.status === "queued" || i.status === "working").length;
  const settled = state.items.length - busyItems;
  document.title = busyItems
    ? `▸ ${settled}/${state.items.length} — imgcompress`
    : BASE_TITLE;
}

/* ------------------------------ inspector -------------------------------- */

function showInspector(on) {
  $("inspector-empty").hidden = on;
  $("inspector-body").hidden = !on;
}

function selectItem(id, quiet) {
  selected = id;
  zoom = 0; pan = { x: 0, y: 0 };
  scheduleRender();
  if (!quiet) rowEls.get(id)?.scrollIntoView({ block: "nearest" });
}

function fmtScore(it, score, lossless) {
  if (lossless) return "lossless";
  if (score == null) return "—";
  return score.toFixed(4);
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
  const ready = it.status === "done" || it.status === "saved";
  const wantAfter = ready ? it.afterURL : "";
  if (after.dataset.src !== wantAfter) { after.dataset.src = wantAfter; after.src = wantAfter || ""; }
  $("viewport").classList.toggle("solo", mode === "after" || !ready);
  $("divider").style.display = mode === "split" && ready ? "" : "none";
  $("split").disabled = !ready;
  $("tag-l").style.opacity = mode === "split" && ready ? "1" : "0";
  $("tag-r").style.opacity = ready ? "1" : "0";
  $("tag-l").textContent = ready ? `Original · ${human(it.originalBytes)}` : "Original";
  $("tag-r").textContent = ready ? `Compressed · ${human(it.newBytes)}` : "Compressed";

  const saved = it.originalBytes - it.newBytes;
  const pct = it.originalBytes && it.newBytes ? 100 * saved / it.originalBytes : 0;
  if (ready && it.justFinished) {
    it.justFinished = false;
    rollNumber($("s-size"), it.newBytes, ` <small>from ${human(it.originalBytes)}</small>`);
    if (pct > 0) rollNumber($("s-saved"), saved, ` <small>−${pct.toFixed(0)}%</small>`);
    else $("s-saved").textContent = "none";
    $("s-saved").classList.remove("pop");
    void $("s-saved").offsetWidth;   // restart the animation
    $("s-saved").classList.add("pop");
    maybeShowHint();
  } else {
    $("s-size").innerHTML = ready
      ? `${human(it.newBytes)} <small>from ${human(it.originalBytes)}</small>`
      : (it.status === "failed" ? "—" : "working…");
    $("s-saved").innerHTML = ready
      ? (pct > 0 ? `${human(saved)} <small>−${pct.toFixed(0)}%</small>` : "none")
      : "—";
  }
  $("s-format").textContent = ready ? it.fmt + (it.level != null ? ` q${it.level}` : "") : "—";
  $("s-score").textContent = ready ? fmtScore(it, it.score, it.lossless || it.passthrough) : "—";
  $("s-dims").innerHTML = !it.width ? "—"
    : (it.outW && it.outW !== it.width
        ? `${it.outW}×${it.outH} <small>from ${it.width}×${it.height}</small>`
        : `${it.width}×${it.height}`);
  const floor = it.override?.qualityTarget ?? state.settings.qualityTarget;
  $("s-floor").innerHTML = Number(floor).toFixed(2) + (it.override ? " <small>override</small>" : "");

  const note = $("s-note");
  note.hidden = !it.note; note.textContent = it.note || "";
  const warn = $("s-warn");
  const messages = [...(it.warnings || [])];
  if (it.error) messages.unshift(it.error);
  warn.hidden = !messages.length;
  warn.textContent = messages.join(" · ");

  const cands = $("cands");
  if (!it.candidates?.length) {
    cands.innerHTML = `<div class="note m0">${
      it.status === "failed" ? "This file could not be read." :
      it.passthrough ? "Passed through unchanged." : "Encoding…"}</div>`;
  } else {
    const winner = Math.min(...it.candidates.map((c) => c.bytes));
    cands.innerHTML = [...it.candidates].sort((a, b) => a.bytes - b.bytes).map((c, i) => `
      <div class="cand ${c.bytes === winner ? "win" : ""}" data-cand-index="${i}">
        <span class="f">${escapeHtml(c.format)}</span>
        <span class="b">${human(c.bytes)}</span>
        <span class="${c.bytes === winner ? "badge" : "s"}">${
          c.bytes === winner ? "winner" : (c.lossless ? "lossless" : c.score.toFixed(3))}</span>
      </div>`).join("");
  }
  $("ov-format").value = it.override?.formats?.[0] || "";
  $("ov-quality").value = it.override?.qualityTarget != null
    ? Math.round(it.override.qualityTarget * 100) : "";
  $("ov-reset").hidden = !it.override;
  $("dl-one").disabled = !ready;
  $("retry-btn").hidden = it.status !== "failed";
  applyZoom();
}

/* ------------------------- first-result hint ------------------------------ */

function maybeShowHint() {
  try {
    if (localStorage.getItem("imgc-hint")) return;
  } catch {}
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

function renderSummary() {
  const done = state.items.filter((i) => i.status === "done" || i.status === "saved");
  const before = done.reduce((s, i) => s + i.originalBytes, 0);
  const after = done.reduce((s, i) => s + i.newBytes, 0);
  const saved = before - after;
  $("t-sizes").textContent = done.length ? `${human(before)} → ${human(after)}` : "";
  $("t-saved").textContent = done.length && saved > 0
    ? `saved ${human(saved)} (${((saved / before) * 100).toFixed(0)}%)` : "";
  const btn = $("save-btn");
  if (!btn.dataset.busy) {
    btn.disabled = done.length === 0;
    btn.textContent = done.length <= 1 ? "Download" : `Download all (${done.length})`;
  }
}

/* -------------------------------- zoom ------------------------------------ */

const ZOOMS = [0, 0.5, 1, 2, 4];
function applyZoom() {
  const stage = $("stage"), img = $("img-before"), vp = $("viewport");
  if (!img.naturalWidth) return;
  const pad = 24;
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
  let name;
  if (it.passthrough || !it.result?.ext) name = it.name;
  else name = it.name.replace(/\.[a-z0-9]+$/i, "") + it.result.ext;
  if (used) {
    let candidate = name, n = 1;
    while (used.has(candidate.toLowerCase())) {
      candidate = name.replace(/(\.[a-z0-9]+)$/i, ` (${n})$1`);
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

async function zipStore(entries) { // [{name, blob}]
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
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, 0, true);
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);

    const cdir = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cdir.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
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
  ev.setUint16(8, central.length, true);
  ev.setUint16(10, central.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  return new Blob([...chunks, ...central, eocd], { type: "application/zip" });
}

async function downloadAll() {
  const done = state.items.filter((i) => i.status === "done" || i.status === "saved");
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
  btn.textContent = "Zipping…";
  try {
    const used = new Set();
    const entries = done.map((it) => ({ name: outputName(it, used), blob: it.afterBlob }));
    const zip = await zipStore(entries);
    downloadBlob(zip, "imgcompress.zip");
    const saved = done.reduce((s, i) => s + (i.originalBytes - i.newBytes), 0);
    toast(`Zipped ${done.length} images — ${human(saved)} lighter than they arrived`);
    for (const it of done) it.status = "saved";
    btn.textContent = "Saved ✓";
    setTimeout(() => { delete btn.dataset.busy; scheduleRender(); }, 1600);
  } catch (e) {
    delete btn.dataset.busy;
    toast("Could not build the zip — try downloading images individually");
  }
  scheduleRender();
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

/* ----------------------------- sample images ------------------------------ */

/** No images handy? Generate two on the spot - one photographic, one flat -
 *  so the bake-off's whole point (different winners) shows immediately. */
async function addSamples() {
  const photo = document.createElement("canvas");
  photo.width = 1280; photo.height = 840;
  {
    const ctx = photo.getContext("2d");
    const g = ctx.createLinearGradient(0, 0, 1280, 840);
    g.addColorStop(0, "#e8927c"); g.addColorStop(.5, "#c56a8b"); g.addColorStop(1, "#4a3f6b");
    ctx.fillStyle = g; ctx.fillRect(0, 0, 1280, 840);
    ctx.fillStyle = "#f7d9a0";
    ctx.beginPath(); ctx.arc(950, 260, 130, 0, 7); ctx.fill();
    const id = ctx.getImageData(0, 0, 1280, 840);
    for (let i = 0; i < id.data.length; i += 4) {
      const n = (Math.random() - 0.5) * 22;
      id.data[i] += n; id.data[i + 1] += n; id.data[i + 2] += n;
    }
    ctx.putImageData(id, 0, 0);
  }
  const ui = document.createElement("canvas");
  ui.width = 1280; ui.height = 840;
  {
    const ctx = ui.getContext("2d");
    ctx.fillStyle = "#f4f5f7"; ctx.fillRect(0, 0, 1280, 840);
    ctx.fillStyle = "#191c22"; ctx.fillRect(0, 0, 1280, 64);
    for (let i = 0; i < 9; i++) {
      ctx.fillStyle = "#ffffff"; ctx.fillRect(48, 96 + i * 80, 1184, 64);
      ctx.fillStyle = ["#4471e0", "#3d9e6d", "#c2542e"][i % 3];
      ctx.fillRect(64, 112 + i * 80, 32, 32);
      ctx.fillStyle = "#2a2e36"; ctx.fillRect(116, 118 + i * 80, 300 + (i * 83) % 400, 9);
      ctx.fillStyle = "#9aa1ad"; ctx.fillRect(116, 136 + i * 80, 220 + (i * 131) % 500, 7);
    }
  }
  const blobs = await Promise.all([photo, ui].map(
    (c) => new Promise((r) => c.toBlob(r, "image/png"))));
  addFiles([
    new File([blobs[0]], "sample-photo.png", { type: "image/png" }),
    new File([blobs[1]], "sample-ui.png", { type: "image/png" }),
  ]);
}

/* -------------------------------- events ---------------------------------- */

function setMode(m) {
  mode = m;
  $("mode-split").setAttribute("aria-pressed", String(m === "split"));
  $("mode-after").setAttribute("aria-pressed", String(m === "after"));
  scheduleRender("inspector");
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

  $("theme-btn").addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.classList.add("theming");
    document.documentElement.dataset.theme = next;
    setTimeout(() => document.documentElement.classList.remove("theming"), 260);
    $("theme-btn").textContent = next === "dark" ? "Light" : "Dark";
    try { localStorage.setItem("imgc-theme", next); } catch {}
  });
  $("theme-btn").textContent =
    document.documentElement.dataset.theme === "dark" ? "Light" : "Dark";

  $("queue-list").addEventListener("click", (e) => {
    const row = e.target.closest(".row");
    if (row) selectItem(row.dataset.id);
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
  $("zoom-in").addEventListener("click", () => stepZoom(1));
  $("zoom-out").addEventListener("click", () => stepZoom(-1));
  $("zoom-reset").addEventListener("click", () => { zoom = 0; pan = { x: 0, y: 0 }; applyZoom(); });
  $("img-before").addEventListener("load", applyZoom);
  new ResizeObserver(() => applyZoom()).observe($("stage"));

  // wheel zooms; double-click toggles fit <-> 100%
  $("stage").addEventListener("wheel", (e) => {
    e.preventDefault();
    stepZoom(e.deltaY < 0 ? 1 : -1);
  }, { passive: false });
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
    $("veil-count").textContent = n > 1 ? `${n} items` : "PNG, JPEG, WebP, BMP or GIF";
    $("veil").classList.add("on");
  });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("dragleave", () => { if (--dragDepth <= 0) $("veil").classList.remove("on"); });
  window.addEventListener("drop", async (e) => {
    e.preventDefault(); dragDepth = 0; $("veil").classList.remove("on");
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

  $("clear-btn").addEventListener("click", () => {
    if (!state.items.length) return;
    removeItems(state.items.map((i) => i.id));
    toast("Cleared");
  });
  $("remove-btn").addEventListener("click", () => {
    if (selected) removeItems([selected]);
  });
  $("retry-btn").addEventListener("click", () => {
    if (selected) requeue([selected]);
  });
  $("dl-one").addEventListener("click", () => {
    const it = state.byId.get(selected);
    if (!it || !(it.status === "done" || it.status === "saved")) return;
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
    requeue([it.id]);
  });

  $("save-btn").addEventListener("click", downloadAll);

  // hold Space = flicker-test against the original; tap Space = toggle view
  let spaceHeldAt = 0;
  document.addEventListener("keydown", (e) => {
    if (e.target.matches("input, select, textarea")) return;
    if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); downloadAll(); }
    else if (e.key === "Delete" || e.key === "Backspace") {
      if (selected) { e.preventDefault(); removeItems([selected]); }
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
      setMode(mode === "split" ? "after" : "split");
    } else {
      scheduleRender("inspector"); dirty.inspector = true; scheduleRender();
    }
  });
  $("keys-close").addEventListener("click", () => $("keys").close());

  window.addEventListener("beforeunload", (e) => {
    if (state.items.some((i) => i.status === "done")) e.preventDefault();
  });
}

/* --------------------------------- boot ----------------------------------- */

loadSettings();
bind();
render();
startEngine();
