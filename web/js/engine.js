/* The worker pool, and the protocol it speaks.
 *
 * worker.js is the compressor: it decodes, encodes the image several ways, scores
 * each one with SSIMULACRA 2 and reports the smallest that cleared the floor.
 * None of that lives here. This module owns only the pool, the dispatch order and
 * the message contract - which is unchanged from the previous interface, because
 * the engine was never the problem.
 *
 * The contract, in full:
 *
 *   out  { type: "probe" }                          -> asks what this browser can write
 *   out  { type: "warm" }                           -> load codecs now (cache is ready)
 *   out  { type: "job", id, rev, name, buffer, mime, settings }
 *   in   { type: "caps", caps }                     answer to the probe
 *   in   { type: "progress", id, rev, stage, frac, detail, total }
 *   in   { type: "done", id, rev, result, perf, engines }
 *   in   { type: "failed", id, rev, error, warnings }
 *
 * `rev` is the settings revision the job was sent under. A result that comes back
 * stamped with an older rev is stale - the plan moved while it was working - so it
 * is thrown away and re-queued rather than shown.
 */

import { toast } from "./dom.js";
import {
  state, isBusy, effectiveSettings, select, firstInteresting,
  videoPlan, canEncodeVideo, NO_VIDEO_HERE, ORIGINAL_PICK, D,
} from "./state.js";
import { mimeFor, fmtLabel } from "./format.js";
import { adoptCandidateBytes, autoView, applyView } from "./views.js";
import { reflectFormatAvailability } from "./settings.js";
import { scheduleRender } from "./render.js";

/* One worker per core, less two for the main thread and the browser's own work.
   The old cap of 4 left most of a modern machine idle on a batch; the ceiling of 8
   is about memory, since each worker keeps one decoded frame cached. */
const POOL_MAX = Math.min(8, Math.max(2, (navigator.hardwareConcurrency || 4) - 2));

/* Exported for the browser harness, which asserts on how many workers a batch
 * actually spins up - a regression to a pool of one would not fail any other
 * check, it would just make every batch slow. */
export const pool = [];

let batchActive = false;
let onBatchEnd = null;

/** Called when a run finishes with nothing left in flight. */
export function setBatchEndHandler(fn) { onBatchEnd = fn; }

function makeWorker(index) {
  const w = new Worker("/worker.js");
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

/** Ask the browser what it can encode, before anyone has dropped anything. The
 *  answer decides which formats the plan is allowed to offer. */
export function startEngine() {
  ensurePool(1);
  pool[0].w.postMessage({ type: "probe" });
}

/** Load the codecs ahead of the first drop. Called by main.js once the service
 *  worker's offline copy is ready (or on a short timer where there is no
 *  service worker), so the warm reads the cache instead of racing the install
 *  download. Safe to call more than once - the worker caches each load. */
export function warmCodecs() {
  ensurePool(1);
  pool[0].w.postMessage({ type: "warm" });
}

/** Mark the start of a run. Adding files to a run already in flight extends it
 *  rather than restarting the clock. */
export function beginBatch() {
  batchActive = true;
}

/* Test seam. The browser harness asserts that the untouched original is on screen
 * BEFORE any encoder is asked for anything, and that ordering is only observable
 * if the run can be held for a beat. The app holds it for one frame by design;
 * this holds it long enough to look.
 *
 * It is here rather than done by monkey-patching from the test because there is
 * nothing to patch: dispatch is a module binding, not a global, so replacing
 * window.dispatch changes nothing the app calls. Three lines, off by default, and
 * only ever switched on through window.imgc.
 */
let held = false;
export function holdWork(on) {
  held = !!on;
  if (!held) dispatch();
}

export async function dispatch() {
  if (held) return;
  /* Video goes down its own path: a different worker, a different protocol and
     one job at a time. It is driven from here so that every existing caller of
     dispatch() - a drop, a settings change, a finished job - drives both. */
  dispatchVideo();
  const queued = state.items.filter((i) => i.status === "queued" && !i.isVideo);
  if (!queued.length) return;
  ensurePool(queued.length);

  /* Start every read at once. This loop used to await each file's bytes before
     handing the next item to a worker, so with a dozen files the last worker sat
     idle through eleven sequential reads before it got any work. */
  for (const item of queued) {
    if (!item.bytesPromise) {
      item.bytesPromise = item.file.arrayBuffer().catch(() => null);
    }
  }

  for (const item of queued) {
    // Prefer the worker that last handled this item - its decode cache makes a
    // quality-only re-run start instantly.
    let slot = item.slot != null && pool[item.slot] && !pool[item.slot].busy
      ? pool[item.slot] : null;
    if (!slot) slot = pool.find((s) => !s.busy);
    if (!slot) return;

    slot.busy = true;
    slot.itemId = item.id;
    item.slot = slot.index;
    item.status = "working";
    item.stage = "reading";
    item.progress = "reading…";
    item.frac = 0;
    /* The clock starts when this image actually gets a worker, not when it was
       dropped: time spent queued behind other images is the batch's, not this
       image's, and reporting the wait as work would be a lie. */
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
    if (!state.byId.has(item.id) || item.status !== "working") {   // removed mid-read
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

/** Stop everything in flight. Workers are terminated - the only way to interrupt
 *  a wasm encode - and replaced immediately, so the pool stays warm. */
export function cancelAll() {
  const stopping = state.items.filter(isBusy);
  if (!stopping.length) return;
  for (const slot of pool) {
    if (!slot.busy) continue;
    slot.w.terminate();
    pool[slot.index] = makeWorker(slot.index);
  }
  stopVideoWorker();
  for (const item of stopping) {
    // Nothing stale or half-shown survives a stop as though it were a result.
    if (item.stale || item.liveCandidates) clearResult(item);
    item.status = item.candidates?.length ? "failed" : "cancelled";
    item.error = "stopped";
    item.frac = 0;
  }
  batchActive = false;
  const noun = stopping.some((i) => i.isVideo) ? "file" : "image";
  toast(`Stopped — ${stopping.length} ${noun}${stopping.length === 1 ? "" : "s"} left uncompressed`);
  scheduleRender();
}

/* ============================== video ==================================== *
 *
 * A second worker, a second protocol, and one job at a time.
 *
 * It is a MODULE worker, because Mediabunny ships as an ES module, and it is
 * separate from the pool for a reason that is not tidiness: a video job holds
 * decoded frames, runs for minutes and saturates the machine's encoder, and
 * none of that belongs in the pool that has to stay responsive enough to
 * compress a screenshot. One at a time for the same reason - two concurrent
 * video encodes on one machine finish later than two in a row, and neither
 * would report honest progress.
 *
 * The contract, in full (see web/video-worker.js):
 *
 *   out  { type: "probe" }                  -> what can this browser encode?
 *   out  { type: "job", id, file, settings } settings: maxDimension,
 *                                            qualityTarget, formats,
 *                                            sizeCapBytes
 *   in   { type: "caps", caps }             { webcodecs, formats, hardware }
 *   in   { type: "progress", id, stage, fraction, detail }
 *   in   { type: "done", id, result, blob }
 *   in   { type: "failed", id, error }
 *
 * There is no abort message and there does not need to be: terminating the
 * worker is the only way to interrupt a running encode anyway, and the next
 * job builds a fresh one.
 */

let videoWorker = null;
let videoBusy = null;             // the id of the job in flight, or null
const videoRev = new Map();       // job id -> the settings revision it was sent under

function ensureVideoWorker() {
  if (videoWorker) return videoWorker;
  try {
    videoWorker = new Worker("/video-worker.js", { type: "module" });
  } catch {
    /* No module workers at all. That is an answer, and the same one the person
       gets from a browser with no encoder: this cannot happen here. */
    state.videoCaps = { webcodecs: false, formats: [] };
    scheduleRender();
    return null;
  }
  videoWorker.onmessage = (e) => onVideoMessage(e.data || {});
  videoWorker.onerror = () => {
    /* The module failed to load - the vendored reader, or the shared metric.
       Whatever is in flight fails with a reason rather than hanging. */
    const item = videoBusy && state.byId.get(videoBusy);
    if (item) {
      item.status = "failed";
      item.error = "the video engine could not start in this browser";
    }
    videoBusy = null;
    if (state.videoCaps == null) state.videoCaps = { webcodecs: false, formats: [] };
    scheduleRender();
    dispatch();
  };
  return videoWorker;
}

function stopVideoWorker() {
  if (!videoWorker) return;
  /* Terminate rather than ask: a WebCodecs encode mid-flight has no other
     interruption, and a worker holding frames for a job nobody wants is worse
     than the cost of starting a new one. */
  videoWorker.terminate();
  videoWorker = null;
  videoBusy = null;
}

/** Ask what this browser can encode. Idempotent, and cheap after the first
 *  call - the answer is cached on state and the worker stays warm. */
export function probeVideoSupport() {
  if (state.videoCaps) return;
  const w = ensureVideoWorker();
  if (w) w.postMessage({ type: "probe" });
}

/* The stages the worker reports, in words. The worker names the codec it is
 * trying; that name is deliberately not repeated here - the plan asks where a
 * video is going and nothing about codecs, and "Testing av1-mp4" would be the
 * first jargon on the page. What a waiting person needs is what is happening
 * and how far along it is. */
const VIDEO_STAGE_TEXT = {
  "reading": () => "Reading the video…",
  "looking for the setting": (pct) => `Finding the setting that still looks right · ${pct}%`,
  "compressing": (pct) => `Compressing the whole video · ${pct}%`,
  "checking the result": (pct) => `Checking it against the original · ${pct}%`,
  "done": () => "Finishing up…",
};

/** The whole job's progress, not one format's.
 *
 *  The worker searches, encodes and verifies each format in turn and reports a
 *  fraction within that format - so with two formats the raw number runs to
 *  0.9 and then starts again at 0.09. A bar that goes backwards reads as work
 *  being lost, so each format gets its own share of the run. */
function videoFraction(item, msg) {
  const list = item.videoFormats || [];
  if (msg.stage === "done") return 1;
  const detail = String(msg.detail || "");
  const named = detail.split(",")[0].trim();
  const index = list.indexOf(named);
  const within = Math.max(0, Math.min(1, msg.fraction || 0));
  if (index < 0 || list.length < 2) return within;
  return Math.min(1, (index + within) / list.length);
}

/** One video finished without being compressed, on purpose. The file is kept
 *  exactly as it arrived and the reason is said in place - which is what the
 *  desktop tier does with the same three situations. */
function leaveAlone(item, note, keepEvidence = false) {
  item.status = "done";
  /* When a run actually happened and the original still won, what it tried
     stays on screen: "nothing beat the original" is only believable next to
     the things that did not beat it. Nothing was tried in the other two
     cases, so there is nothing to show. */
  if (!keepEvidence) item.candidates = [];
  item.candBlobs = new Map();
  item.warnings = [];
  item.elapsedMs = item.startedAt != null ? performance.now() - item.startedAt : null;
  item.outW = item.width;
  item.outH = item.height;
  item.auto = {
    fmt: ORIGINAL_PICK, ext: null, blob: item.file,
    newBytes: item.originalBytes,
    level: null, score: null, lossless: true,
    note, passthrough: true,
  };
  item.pick = null;
  applyView(item, item.auto);
  item.stale = false;
}

function failVideo(item, error) {
  item.status = "failed";
  item.error = error;
  item.frac = 0;
}

function dispatchVideo() {
  if (held || videoBusy) return;
  const item = state.items.find((i) => i.status === "queued" && i.isVideo);
  if (!item) return;

  /* Nobody has asked the browser yet. Ask, and come back when it answers -
     the caps message calls dispatch() again. The row sits at "waiting", which
     is what is actually true. */
  if (state.videoCaps == null) { probeVideoSupport(); return; }

  if (!canEncodeVideo()) { failVideo(item, NO_VIDEO_HERE); scheduleRender(); dispatch(); return; }

  const plan = videoPlan(item);
  const label = D.DESTINATION_NUMBERS[D.destinationOf(state.settings.target)]?.label
    || "This destination";

  /* Three ways a video is finished before it starts, all of them answers
     rather than errors, and all of them the same answers the desktop tier
     gives:
       - the destination takes no video at all;
       - the plan promises every pixel kept, which no re-encode can honour;
       - and, further down, a result that came out bigger than the original. */
  if (!plan) {
    leaveAlone(item, `“${label}” is for pictures, not video — this was left exactly as it is.`);
    scheduleRender(); dispatch(); maybeFinish();
    return;
  }
  if (state.settings.lossless) {
    leaveAlone(item, "“Identical — every pixel kept” cannot be promised for video, "
      + "so this was left exactly as it is.");
    scheduleRender(); dispatch(); maybeFinish();
    return;
  }

  const formats = plan.formats.filter((f) => state.videoCaps.formats.includes(f));
  if (!formats.length) { failVideo(item, NO_VIDEO_HERE); scheduleRender(); dispatch(); return; }

  const w = ensureVideoWorker();
  if (!w) { failVideo(item, NO_VIDEO_HERE); scheduleRender(); dispatch(); return; }

  videoBusy = item.id;
  videoRev.set(item.id, state.settingsRev);
  item.status = "working";
  item.stage = "reading";
  item.progress = "Reading the video…";
  item.frac = 0;
  item.videoFormats = formats;
  item.videoPlan = plan;
  item.startedAt = performance.now();
  item.elapsedMs = null;
  scheduleRender("queue");

  w.postMessage({
    type: "job", id: item.id, file: item.file,
    settings: {
      maxDimension: plan.maxDimension,
      qualityTarget: plan.qualityTarget,
      formats,
      /* The byte ceiling is part of the plan, not advice. It was computed
         here and then dropped on the floor for a while - the worker never
         saw it, so "Fits Discord's free 10 MB limit" could hand back 14 MB
         with nothing said. */
      sizeCapBytes: plan.sizeCapBytes || 0,
    },
  });
}

function onVideoMessage(msg) {
  if (msg.type === "caps") {
    state.videoCaps = msg.caps || { webcodecs: false, formats: [] };
    scheduleRender();
    dispatch();
    return;
  }

  const item = state.byId.get(msg.id);
  if (!item) {
    if (msg.type !== "progress") { videoBusy = null; dispatch(); }
    return;
  }
  if (item.status === "cancelled") return;

  if (msg.type === "progress") {
    item.stage = msg.stage;
    item.frac = videoFraction(item, msg);
    const say = VIDEO_STAGE_TEXT[msg.stage];
    item.progress = say ? say(Math.round(item.frac * 100)) : "working…";
    scheduleRender("queue");
    if (state.selected === item.id) scheduleRender("stage");
    return;
  }

  videoBusy = null;
  const rev = videoRev.get(msg.id);
  videoRev.delete(msg.id);

  if (rev !== state.settingsRev && !item.override) {
    /* The plan moved while this was encoding. Straight back to the queue to be
       redone under the settings actually in force - a result measured against
       a floor nobody is asking for any more is worse than no result. */
    item.status = "queued";
    item.startedAt = null;
    item.frac = 0;
    scheduleRender(); dispatch();
    return;
  }

  if (item.startedAt != null) item.elapsedMs = performance.now() - item.startedAt;

  if (msg.type === "failed") {
    failVideo(item, msg.error || "failed");
    scheduleRender(); dispatch(); maybeFinish();
    return;
  }

  if (msg.type === "done") {
    const r = msg.result || {};
    const plan = item.videoPlan || videoPlan(item) || {};
    /* Every candidate the bake-off produced, as evidence. Unlike the picture
       tier, only the winner's BYTES survive - a video is too big to keep four
       of - so these are a record and not a set of one-tap swaps, and the panel
       says so rather than offering chips that would do nothing. */
    item.candidates = (r.candidates || []).map((c) => ({
      format: c.format, bytes: c.bytes, score: c.score, lossless: false,
    }));
    item.candBlobs = new Map();
    item.metric = "ss2";
    /* What the worker could not do is part of the result - a format that
       failed at the real resolution is a fact, not noise. */
    item.warnings = r.warnings || [];
    /* The original's shape, as the engine actually read it - rotation applied.
       A phone held upright records a landscape frame and flags it, and every
       number downstream has to mean the picture rather than the way it was
       filed away. */
    if (r.shownWidth) { item.width = r.shownWidth; item.height = r.shownHeight; }
    item.outW = r.width || item.width;
    item.outH = r.height || item.height;
    if (r.duration) item.duration = r.duration;
    item.sizeTarget = plan.sizeCapBytes || 0;
    /* Flags, never inferred from the numbers. The engine says whether a byte
       ceiling took the quality decision away from the floor; the UI's job is
       to repeat it on the same line as the percentage, not to guess it. */
    item.videoCapped = !!r.capped;
    item.missedSize = !!r.missedSize;
    item.audioNote = r.audioNote || "";
    item.videoFloor = plan.qualityTarget;

    const blob = msg.blob;
    /* Never hand back a worse file. The picture tier has always refused to
       write anything bigger than what it was given, and a video is the file
       where that matters most. */
    if (!blob || blob.size >= item.originalBytes) {
      leaveAlone(item,
        "Already smaller than anything this browser could make — left exactly as it is.",
        true);
    } else {
      item.status = "done";
      item.pick = null;
      item.auto = {
        fmt: r.format,
        /* The container, taken from the format key rather than typed, so the
           two can never disagree about what was written. */
        ext: "." + String(r.format || "").split("-").pop(),
        blob,
        newBytes: blob.size,
        level: r.level ?? null,
        score: r.score,
        lossless: false,
        note: r.note || "",
        passthrough: false,
      };
      applyView(item, item.auto);
      item.stale = false;
    }
  }

  if (!state.selected) select(item.id);
  scheduleRender();
  dispatch();
  maybeFinish();
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
    /* Once a live preview has been adopted, its sentence owns the line -
       "Testing AVIF · 40%" would replace "Here's the JPEG…" and hide the one
       fact that matters: there is already something to look at. */
    if (item.livePickBytes == null) {
      const fn = STAGE_TEXT[msg.stage];
      item.progress = fn ? fn(msg.detail, Math.round((item.frac || 0) * 100)) : "working…";
    }
    scheduleRender("queue");
    if (state.selected === item.id) scheduleRender("stage");
    return;
  }

  /* One finished encode, posted the moment it exists. The first one that
     clears the floor goes straight on the stage - the person gets a real
     result in seconds while the rest of the bake-off runs behind it. The done
     message remains the authority and replaces all of this. */
  if (msg.type === "candidate") {
    if (msg.rev !== state.settingsRev && !item.override) return;   // stale preview
    const c = msg.candidate;
    if (msg.first) { item.liveCandidates = []; item.livePickBytes = null; }
    item.formats = msg.total || item.formats;
    item.liveCandidates = item.liveCandidates || [];
    item.liveCandidates.push({
      format: c.format, bytes: c.bytes, score: c.score, lossless: c.lossless,
      level: c.level, ext: c.ext, mime: c.mime,
    });
    if (!(item.candBlobs instanceof Map)) item.candBlobs = new Map();
    const blob = new Blob([msg.data], { type: c.mime || "" });
    item.candBlobs.set(c.format, blob);
    if (msg.dims) {
      item.width = msg.dims.width; item.height = msg.dims.height;
      item.outW = msg.dims.outW; item.outH = msg.dims.outH;
      item.hardCapped = !!msg.dims.hardCapped;
    }
    /* Adopt the smallest passing candidate so far - and never one bigger than
       the original, because "here's your result" must not be a worse file. */
    if (c.passing && c.bytes < item.originalBytes
        && (item.livePickBytes == null || c.bytes < item.livePickBytes)) {
      item.livePickBytes = c.bytes;
      applyView(item, {
        fmt: c.format, ext: c.ext, blob, newBytes: c.bytes,
        level: c.level, score: c.score, lossless: c.lossless,
        note: "", passthrough: false,
      });
      item.stale = false;
      const left = msg.total - msg.done - 1;
      item.progress = left > 0
        ? `Here's the ${fmtLabel(c.format)} — still trying ${left} more way${left === 1 ? "" : "s"} in the background.`
        : `Here's the ${fmtLabel(c.format)} — finishing up.`;
    }
    scheduleRender();
    return;
  }

  slot.busy = false;
  slot.itemId = null;
  if (msg.engines) {
    state.caps = { ...state.caps, ...msg.engines };
    reflectFormatAvailability();
  }

  if (msg.type === "aborted") {
    /* It was told to stop because the plan moved. Straight back to the queue,
       to be redone under the settings that are actually current. Whatever it
       was showing stays up, still marked stale. */
    item.status = "queued";
    item.startedAt = null;
    item.frac = 0;
    scheduleRender(); dispatch();
    return;
  }

  if (msg.rev !== state.settingsRev && !item.override) {
    /* Settings moved under this result: it is about to be redone from the top, so
       the clock restarts too rather than counting the discarded attempt. */
    item.status = "queued";
    item.startedAt = null;
    scheduleRender(); dispatch();
    return;
  }

  if (item.startedAt != null) item.elapsedMs = performance.now() - item.startedAt;

  if (msg.type === "failed") {
    /* A stale result or a half-adopted preview must not sit under a "failed"
       banner looking finished - numbers from settings that no longer exist are
       worse than no numbers. */
    if (item.stale || item.liveCandidates) clearResult(item);
    item.status = "failed";
    item.error = msg.error || "failed";
    item.warnings = msg.warnings || [];
  } else if (msg.type === "done") {
    const r = msg.result;
    item.status = "done";
    item.perf = msg.perf || null;      // phase timings, for the benchmark
    item.result = r;
    item.metric = r.metric;
    item.warnings = r.warnings || [];
    /* A size cap that could not be met without wrecking the image. The engine
       ships the smallest file still worth looking at and says so. */
    item.missedSize = !!r.missedSize;
    item.sizeTarget = r.sizeTarget || 0;
    item.candidates = r.candidates || [];
    adoptCandidateBytes(item);
    // The engine's answer, kept whole, and made the one on screen. A choice among
    // the other encodes is a swap away and never destroys this.
    item.pick = null;
    item.auto = autoView(r, new Blob([r.bytes], { type: r.mime }));
    applyView(item, item.auto);
    /* Measured from the decoded pixels, not guessed from the extension: it is what
       decides whether choosing JPEG has to ask a question first. */
    item.alpha = !!r.alpha;
    item.diffURL = null;
    if (r.width) { item.width = r.width; item.height = r.height; }
    item.outW = r.outW || item.width;
    item.outH = r.outH || item.height;
    /* The destination's ceiling fired, stated by the worker rather than
       inferred from the numbers. The facts panel warns on it. */
    item.hardCapped = !!r.hardCapped;
    // The authority has arrived; the live preview's scaffolding goes.
    item.stale = false;
    item.liveCandidates = null;
    item.livePickBytes = null;
  }

  // The first result of a run gets the stage, so a batch is not silent until it
  // finishes. Later ones do not steal it from whatever is being looked at.
  if (!state.selected) select(item.id);

  scheduleRender();
  dispatch();
  maybeFinish();
}

function maybeFinish() {
  if (state.items.some(isBusy) || !batchActive) return;
  batchActive = false;
  if (!state.selected) select(firstInteresting()?.id);
  onBatchEnd?.();
}

/* ---------------------------- queue maintenance --------------------------- */

/** Drop everything a result ever hung on an item, object URLs included. Used
 *  when a stale result must stop being shown - a failure, a stop - because a
 *  finished-looking picture with numbers from the old settings is a lie. */
function clearResult(item) {
  if (item.afterURL) URL.revokeObjectURL(item.afterURL);
  item.afterURL = null;
  item.afterBlob = null;
  item.fmt = "";
  item.ext = null;
  item.newBytes = null;
  item.score = null;
  item.candidates = [];
  item.candBlobs = null;
  item.auto = null;
  item.pick = null;
  item.liveCandidates = null;
  item.diffURL = null;
  item.stale = false;
  item.videoCapped = false;
  item.audioNote = "";
}

/** Send items back to the start.
 *
 *  Plain requeue clears the slate. With `keepResult` the previous result stays
 *  on screen - marked stale, swapped only when its replacement lands - because
 *  a settings nudge that blanks six finished pictures reads as losing six
 *  finished pictures. Items mid-flight are told to stop; the worker's aborted
 *  reply is what re-queues them, so one item is never two jobs at once. */
export function requeue(ids, opts = {}) {
  const keep = !!opts.keepResult;
  let any = false;
  for (const id of ids) {
    const item = state.byId.get(id);
    if (!item) continue;
    if (item.status === "working") {
      /* A video mid-encode has no abort message to send: the only way to stop
         a WebCodecs run is to end the worker, so it is ended and the item goes
         straight back to the queue rather than waiting for a reply that would
         never come. */
      if (item.isVideo) {
        if (videoBusy === item.id) stopVideoWorker();
        videoRev.delete(item.id);
        item.status = "queued";
        item.frac = 0;
        item.startedAt = null;
        if (keep && item.afterURL) item.stale = true;
        else clearResult(item);
        any = true;
        continue;
      }
      const slot = pool[item.slot];
      if (keep && slot && slot.itemId === item.id) {
        slot.w.postMessage({ type: "abort", id: item.id });
        item.stale = true;
        any = true;
      }
      continue;
    }
    item.status = "queued";
    item.error = "";
    item.warnings = [];
    item.frac = 0;
    item.diffURL = null;
    if (keep && item.afterURL) {
      item.stale = true;      // the old picture stays up until the new one lands
    } else {
      clearResult(item);
      item.note = "";
    }
    any = true;
  }
  if (any) beginBatch();
  scheduleRender();
  dispatch();
}

/** Drop items, and every object URL they were holding open. */
export function removeItems(ids) {
  for (const id of ids) {
    const item = state.byId.get(id);
    if (!item) continue;
    // A video being encoded right now is being encoded for nobody. Stop it.
    if (videoBusy === id) stopVideoWorker();
    videoRev.delete(id);
    if (item.beforeURL) URL.revokeObjectURL(item.beforeURL);
    if (item.afterURL) URL.revokeObjectURL(item.afterURL);
    if (item.thumbURL) URL.revokeObjectURL(item.thumbURL);
    state.byId.delete(id);
    const i = state.items.indexOf(item);
    if (i >= 0) state.items.splice(i, 1);
    if (state.selected === id) state.selected = null;
  }
  if (!state.selected) select(firstInteresting()?.id);
  scheduleRender();
  // Removing the video that was in flight frees the engine for the next one.
  dispatch();
}
