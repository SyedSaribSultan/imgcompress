/* imgcompress web UI — the desktop app's interface, driving an in-browser
 * compression engine (worker.js) instead of a local Python server.
 * No network requests are made anywhere in this file. */

"use strict";

const $ = (id) => document.getElementById(id);

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

function uid() {
  const a = new Uint8Array(8);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* ----------------------------- worker pool ------------------------------- */

const POOL_SIZE = Math.min(4, Math.max(1, (navigator.hardwareConcurrency || 4) - 1));
const pool = [];

function makeWorker() {
  const w = new Worker("worker.js");
  const slot = { w, busy: false, itemId: null };
  w.onmessage = (e) => onWorkerMessage(slot, e.data);
  w.onerror = () => {
    if (slot.itemId) {
      const item = state.byId.get(slot.itemId);
      if (item) { item.status = "failed"; item.error = "the compression worker crashed"; }
    }
    slot.busy = false; slot.itemId = null;
    render(); dispatch();
  };
  pool.push(slot);
  return slot;
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
  for (const slot of pool) {
    if (slot.busy) continue;
    const item = state.items.find((i) => i.status === "queued");
    if (!item) return;
    slot.busy = true;
    slot.itemId = item.id;
    item.status = "working";
    item.progress = "reading…";
    render();
    let buffer;
    try {
      buffer = await item.file.arrayBuffer();
    } catch {
      item.status = "failed";
      item.error = "could not read the file";
      slot.busy = false; slot.itemId = null;
      render();
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
    render();
    return;
  }
  const item = state.byId.get(msg.id);
  if (!item) { // removed while working
    if (msg.type !== "progress") { slot.busy = false; slot.itemId = null; dispatch(); }
    return;
  }

  if (msg.type === "progress") {
    item.progress = msg.stage === "decoding" ? "decoding…" : `encoding ${msg.detail || ""}…`;
    renderQueue();
    return;
  }

  slot.busy = false;
  slot.itemId = null;

  if (msg.rev !== state.settingsRev && !item.override) {
    // Settings changed while this ran; the result is stale. Run it again.
    item.status = "queued";
    render(); dispatch();
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
  render();
  dispatch();
}

function startEngine() {
  if (!pool.length) {
    for (let i = 0; i < POOL_SIZE; i++) makeWorker();
    pool[0].w.postMessage({ type: "probe" });
  }
}

/* ------------------------------ add files -------------------------------- */

function addFiles(files) {
  const usable = [...files].filter((f) => SUPPORTED.test(f.name) || /^image\//.test(f.type));
  if (!usable.length) { toast("No supported images in that drop"); return; }
  startEngine();
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
  }
  toast(`Added ${usable.length} image${usable.length === 1 ? "" : "s"}`);
  render();
  dispatch();
}

function removeItems(ids) {
  for (const id of ids) {
    const item = state.byId.get(id);
    if (!item) continue;
    URL.revokeObjectURL(item.beforeURL);
    if (item.afterURL) URL.revokeObjectURL(item.afterURL);
    state.byId.delete(id);
    const i = state.items.indexOf(item);
    if (i >= 0) state.items.splice(i, 1);
    if (selected === id) selected = null;
  }
  if (!selected && state.items.length) selected = state.items[0].id;
  render();
}

function requeue(ids) {
  for (const id of ids) {
    const item = state.byId.get(id);
    if (!item || item.status === "working") continue;
    item.status = "queued";
    item.error = "";
    item.warnings = [];
    item.note = "";
    item.candidates = [];
  }
  render();
  dispatch();
}

/* ------------------------------- rendering ------------------------------- */

function render() {
  renderQueue();
  renderSummary();
  const still = state.byId.get(selected);
  if (!still && state.items.length) { selected = state.items[0].id; }
  renderInspector(state.byId.get(selected));
  $("app-empty").hidden = state.items.length > 0;
  $("app-full").hidden = state.items.length === 0;
}

function statusLine(it) {
  if (it.status === "failed") return `<span class="err">${escapeHtml(it.error || "failed")}</span>`;
  if (it.status === "queued") return "waiting";
  if (it.status === "working") return escapeHtml(it.progress || "encoding…");
  const pct = it.originalBytes && it.newBytes
    ? 100 * (it.originalBytes - it.newBytes) / it.originalBytes : 0;
  const pctText = pct > 0 ? `−${pct.toFixed(0)}%` : "no gain";
  const tail = it.status === "saved" ? ` <span class="save">saved</span>` : "";
  return `${human(it.originalBytes)} → ${human(it.newBytes)} · ${pctText}${tail}`;
}

function renderQueue() {
  const list = $("queue-list");
  $("queue-count").textContent = state.items.length;
  if (!state.items.length) {
    list.innerHTML = `<div class="queue-empty">Nothing queued yet.<br>Drop images anywhere on this page.</div>`;
    $("queue-foot").textContent = capsLine();
    return;
  }
  list.innerHTML = state.items.map((it) => `
    <button class="row" role="option" data-id="${it.id}" aria-selected="${it.id === selected}">
      <span class="thumb"></span>
      <span class="cell">
        <span class="name">${escapeHtml(it.name)}</span>
        <span class="meta">${statusLine(it)}</span>
        ${it.status === "working" ? '<span class="track"><i></i></span>' : ""}
      </span>
      <span class="tail">
        ${it.override ? '<span class="micro" title="This image has its own settings">OV</span>' : ""}
        <span class="dot ${it.status}"></span>
      </span>
    </button>`).join("");
  // Thumbnails go through the CSSOM: a style="" attribute in the markup would
  // (rightly) be refused by the page's style-src CSP.
  for (const row of list.querySelectorAll(".row")) {
    const it = state.byId.get(row.dataset.id);
    if (it && it.status !== "failed") {
      row.querySelector(".thumb").style.backgroundImage = `url("${it.beforeURL}")`;
    }
  }
  const done = state.items.filter((i) => i.status === "done" || i.status === "saved").length;
  const busy = state.items.filter((i) => i.status === "queued" || i.status === "working").length;
  $("queue-foot").textContent = busy ? `${busy} to go · ${done} ready` : `${done} ready to download`;
}

function capsLine() {
  if (state.caps.webp === null) return "Drop images anywhere on this page";
  const parts = ["jpeg", "png"];
  if (state.caps.png8) parts.push("png8");
  if (state.caps.webp) parts.push("webp");
  return `Engines ready: ${parts.join(", ")} · runs entirely in your browser`;
}

function showInspector(on) {
  $("inspector-empty").hidden = on;
  $("inspector-body").hidden = !on;
}

function selectItem(id, quiet) {
  selected = id;
  zoom = 0; pan = { x: 0, y: 0 };
  renderQueue();
  renderInspector(state.byId.get(id));
  if (!quiet) $("queue-list").querySelector(`[data-id="${id}"]`)?.scrollIntoView({ block: "nearest" });
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

  $("s-size").innerHTML = ready
    ? `${human(it.newBytes)} <small>from ${human(it.originalBytes)}</small>`
    : (it.status === "failed" ? "—" : "working…");
  const saved = it.originalBytes - it.newBytes;
  const pct = it.originalBytes && it.newBytes ? 100 * saved / it.originalBytes : 0;
  $("s-saved").innerHTML = ready
    ? (pct > 0 ? `−${pct.toFixed(0)}% <small>${human(saved)}</small>` : "none")
    : "—";
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
    cands.innerHTML = [...it.candidates].sort((a, b) => a.bytes - b.bytes).map((c) => `
      <div class="cand ${c.bytes === winner ? "win" : ""}">
        <span class="f">${escapeHtml(c.format)}</span>
        <span class="b">${human(c.bytes)}</span>
        <span class="${c.bytes === winner ? "badge" : "s"}">${
          c.bytes === winner ? "winner" : (c.lossless ? "lossless" : c.score.toFixed(3))}</span>
      </div>`).join("");
  }
  $("ov-format").value = it.override?.formats?.[0] || "";
  $("ov-quality").value = it.override?.qualityTarget != null
    ? Math.round(it.override.qualityTarget * 100) : "";
  $("dl-one").disabled = !ready;
  applyZoom();
}

function renderSummary() {
  const done = state.items.filter((i) => i.status === "done" || i.status === "saved");
  const before = done.reduce((s, i) => s + i.originalBytes, 0);
  const after = done.reduce((s, i) => s + i.newBytes, 0);
  const saved = before - after;
  $("t-sizes").textContent = done.length ? `${human(before)} → ${human(after)}` : "";
  $("t-saved").textContent = done.length && saved > 0
    ? `saved ${human(saved)} (${((saved / before) * 100).toFixed(0)}%)` : "";
  const n = state.items.filter((i) => i.status === "done").length;
  const btn = $("save-btn");
  btn.disabled = done.length === 0;
  btn.textContent = done.length <= 1 ? "Download" : `Download all (${done.length})`;
  if (n === 0 && done.length === 0) btn.textContent = "Download";
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

  for (const { name, blob } of entries) {
    const data = new Uint8Array(await blob.arrayBuffer());
    const nameBytes = encoder.encode(name);
    const crc = zcrc32(data);

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);          // version needed
    lv.setUint16(6, 0x0800, true);      // UTF-8 names
    lv.setUint16(8, 0, true);           // method: store
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
  }

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
  if (done.length === 1) {
    const it = done[0];
    downloadBlob(it.afterBlob, outputName(it));
    it.status = "saved";
    render();
    return;
  }
  const used = new Set();
  const entries = done.map((it) => ({ name: outputName(it, used), blob: it.afterBlob }));
  toast("Building zip…");
  const zip = await zipStore(entries);
  downloadBlob(zip, "imgcompress.zip");
  for (const it of done) it.status = "saved";
  render();
}

/* -------------------------------- toast ----------------------------------- */

let toastTimer;
function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("on"), 3200);
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
    requeue(state.items.filter((i) => i.status !== "working").map((i) => i.id));
  }, 350);
}

/* -------------------------------- events ---------------------------------- */

function bind() {
  $("target").addEventListener("change", pushSettings);
  $("maxdim").addEventListener("change", pushSettings);
  $("quality").addEventListener("input", () => { $("quality-out").textContent = $("quality").value; });
  $("quality").addEventListener("change", pushSettings);

  $("theme-btn").addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    $("theme-btn").textContent = next === "dark" ? "Light" : "Dark";
    try { localStorage.setItem("imgc-theme", next); } catch {}
  });
  $("theme-btn").textContent =
    document.documentElement.dataset.theme === "dark" ? "Light" : "Dark";

  $("queue-list").addEventListener("click", (e) => {
    const row = e.target.closest(".row");
    if (row) selectItem(row.dataset.id);
  });
  $("queue-list").addEventListener("keydown", (e) => {
    if (!["ArrowDown", "ArrowUp"].includes(e.key)) return;
    e.preventDefault();
    const i = state.items.findIndex((x) => x.id === selected);
    const next = state.items[Math.max(0, Math.min(state.items.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
    if (next) selectItem(next.id);
  });

  $("split").addEventListener("input", (e) => {
    $("viewport").style.setProperty("--split", `${100 - e.target.value}%`);
    $("divider").style.left = `${e.target.value}%`;
  });
  $("viewport").style.setProperty("--split", "50%");

  $("mode-split").addEventListener("click", () => setMode("split"));
  $("mode-after").addEventListener("click", () => setMode("after"));
  $("zoom-in").addEventListener("click", () => stepZoom(1));
  $("zoom-out").addEventListener("click", () => stepZoom(-1));
  $("zoom-reset").addEventListener("click", () => { zoom = 0; pan = { x: 0, y: 0 }; applyZoom(); });
  $("img-before").addEventListener("load", applyZoom);
  new ResizeObserver(() => applyZoom()).observe($("stage"));

  let dragging = null;
  $("stage").addEventListener("pointerdown", (e) => {
    if (zoom === 0 || e.target.id === "split") return;
    dragging = { x: e.clientX - pan.x, y: e.clientY - pan.y };
    $("stage").setPointerCapture(e.pointerId);
  });
  $("stage").addEventListener("pointermove", (e) => {
    if (!dragging) return;
    pan = { x: e.clientX - dragging.x, y: e.clientY - dragging.y };
    applyZoom();
  });
  $("stage").addEventListener("pointerup", () => { dragging = null; });

  let dragDepth = 0;
  window.addEventListener("dragenter", (e) => {
    e.preventDefault(); dragDepth++; $("veil").classList.add("on");
  });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("dragleave", () => { if (--dragDepth <= 0) $("veil").classList.remove("on"); });
  window.addEventListener("drop", (e) => {
    e.preventDefault(); dragDepth = 0; $("veil").classList.remove("on");
    if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
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

  $("clear-btn").addEventListener("click", () => {
    if (!state.items.length) return;
    removeItems(state.items.map((i) => i.id));
    toast("Cleared");
  });
  $("remove-btn").addEventListener("click", () => {
    if (selected) removeItems([selected]);
  });
  $("dl-one").addEventListener("click", () => {
    const it = state.byId.get(selected);
    if (!it || !(it.status === "done" || it.status === "saved")) return;
    downloadBlob(it.afterBlob, outputName(it));
    it.status = "saved";
    render();
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

  $("save-btn").addEventListener("click", downloadAll);

  document.addEventListener("keydown", (e) => {
    if (e.target.matches("input, select, textarea")) return;
    if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); downloadAll(); }
    else if (e.key === "Delete" || e.key === "Backspace") {
      if (selected) { e.preventDefault(); removeItems([selected]); }
    } else if (e.key === " " && state.items.length) {
      e.preventDefault(); setMode(mode === "split" ? "after" : "split");
    }
  });

  window.addEventListener("beforeunload", (e) => {
    if (state.items.some((i) => i.status === "done")) e.preventDefault();
  });
}

function setMode(m) {
  mode = m;
  $("mode-split").setAttribute("aria-pressed", String(m === "split"));
  $("mode-after").setAttribute("aria-pressed", String(m === "after"));
  renderInspector(state.byId.get(selected));
}

/* --------------------------------- boot ----------------------------------- */

bind();
render();
startEngine();
