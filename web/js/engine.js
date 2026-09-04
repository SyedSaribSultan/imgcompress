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
 *   out  { type: "warm-avif" }                      -> and the big one, at idle
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
  state, isBusy, effectiveSettings, select, firstInteresting, D,
} from "./state.js";
import { mimeFor, fmtLabel } from "./format.js";
import { adoptCandidateBytes, autoView, applyView } from "./views.js";
import { reflectFormatAvailability } from "./settings.js";
import { scheduleRender } from "./render.js";

/* One worker per core, less two for the main thread and the browser's own work.
 *
 * The ceiling is about memory, not cores: each worker holds a decoded frame,
 * and a 12-megapixel photograph is about 48MB of RGBA before any candidate
 * encode exists. Twelve of those is most of a modest laptop.
 *
 * So the ceiling moves with what the machine says about itself, and the two
 * directions are deliberately not symmetric:
 *
 *   deviceMemory <= 4   a genuinely small machine. Four workers, and the read
 *                       window in dispatch narrows with it, because on these
 *                       the failure is not slowness, it is the tab dying.
 *   otherwise           twelve. Chrome CLAMPS deviceMemory at 8 for
 *                       fingerprinting reasons, so "8" means "8 or anything
 *                       above it" and cannot be read as a workstation signal -
 *                       there is no branch above this one to write honestly.
 *                       Twelve is chosen against cores instead: it is what a
 *                       14-core machine reaches under cores-2, and wasm SIMD
 *                       encode scales sub-linearly past that anyway.
 *
 * Firefox and Safari do not implement deviceMemory at all, so both land in the
 * second case, which is why it has to be the safe one rather than the greedy
 * one. */
const DEVICE_MEMORY = navigator.deviceMemory || 0;
const POOL_CEILING = DEVICE_MEMORY > 0 && DEVICE_MEMORY <= 4 ? 4 : 12;
const POOL_MAX = Math.min(
  POOL_CEILING, Math.max(2, (navigator.hardwareConcurrency || 4) - 2));

/* Exported for the browser harness, which asserts on how many workers a batch
 * actually spins up - a regression to a pool of one would not fail any other
 * check, it would just make every batch slow. */
export const pool = [];

/* What the sizing decided, and what it decided from. A gate that only sees the
 * pool length cannot tell a correct 6 on an 8-core machine from a ceiling that
 * silently stopped moving. */
export const poolPlan = () => ({
  max: POOL_MAX,
  ceiling: POOL_CEILING,
  cores: navigator.hardwareConcurrency || null,
  deviceMemory: navigator.deviceMemory || null,
});

let batchActive = false;
let onBatchEnd = null;
/* How many file reads are in flight, and whether a dispatch is already walking
 * the queue. Both module-level on purpose - see dispatch. */
let reading = 0;
let dispatching = false;
let dispatchAgain = false;

/** Called when a run finishes with nothing left in flight. */
export function setBatchEndHandler(fn) { onBatchEnd = fn; }

/* Test seam. The browser harness asserts that the read window actually bounds
 * how much of a batch is resident at once - a regression to reading every file
 * up front would not fail any other check, it would just quietly make a
 * 200-file drop a gigabyte of ArrayBuffer. Counting items with a bytesPromise
 * from outside does NOT measure this: the promise stays set after it resolves,
 * until the post loop transfers the buffer and clears it. */
export const readingCount = () => reading;
/* The high-water mark, because sampling from outside cannot catch a read that
 * starts and finishes between two polls - and a peak of zero from a poller
 * that simply kept missing is a gate that measured nothing. */
let readingPeak = 0;
export const readingPeakSeen = () => readingPeak;

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

/** The AVIF encoder, which is bigger than everything else put together and is
 *  therefore neither precached nor part of the ordinary warm. Called from
 *  main.js at idle, after the offline install has finished, so the largest
 *  file in the app is fetched when nothing is competing for the network. The
 *  worker ignores it on a weak device. */
export function warmAvif() {
  ensurePool(1);
  pool[0].w.postMessage({ type: "warm-avif" });
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

/* One walk of the queue at a time.
 *
 * dispatch awaits mid-loop and is called from ten places - a worker finishing,
 * a settings change, a removal, and now every completed file read. Two walks
 * overlapping is not a theoretical race: both see the same queued items, both
 * await the same bytesPromise, and both post it - and the second postMessage
 * throws DataCloneError, because the first transferred the buffer and detached
 * it. Observed, on a 24-file batch, the first time the read window was bounded.
 *
 * A call that arrives mid-walk sets a flag instead of running, and the walk in
 * progress goes round again when it finishes. That way nothing is dropped and
 * nothing is done twice. */
export async function dispatch() {
  if (held) return;
  if (dispatching) { dispatchAgain = true; return; }
  dispatching = true;
  try {
    await walkQueue();
  } finally {
    dispatching = false;
  }
  if (dispatchAgain) { dispatchAgain = false; dispatch(); }
}

async function walkQueue() {
  const queued = state.items.filter((i) => i.status === "queued");
  if (!queued.length) return;
  ensurePool(queued.length);

  /* Read ahead, but only far enough to keep the pool fed.
   *
   * This started every read at once, which fixed a real bug - it used to await
   * each file's bytes before handing the next item to a worker, so the last
   * worker sat idle through eleven sequential reads. But "all of them" made
   * peak memory a function of how many files were dropped rather than of what
   * the machine can chew on: two hundred five-megabyte photographs is a
   * gigabyte of ArrayBuffer resident before a single one has been encoded, and
   * on a phone that is the tab.
   *
   * The window is the pool plus two: every worker has its bytes, and two more
   * are in flight so a slot never waits on a disk read. Beyond that the reads
   * are simply not started yet - each completion tops the window up, so this
   * throttles memory without throttling throughput.
   *
   * `reading` is a module-level count rather than a local one because dispatch
   * is re-entrant: it awaits mid-loop and is called from nine places, so two
   * overlapping runs each keeping their own tally would each open a full
   * window. Decrementing in the settle handler rather than after the await is
   * the same reasoning - the count has to fall when the read finishes, not
   * when some particular caller gets around to noticing. */
  /* Plus two on an ordinary machine so a worker never waits on a disk read;
     plus one where memory is the binding constraint, since there the point of
     the window is the resident bytes rather than the idle slot. */
  const window = pool.length + (POOL_CEILING === 4 ? 1 : 2);
  for (const item of queued) {
    if (reading >= window) break;
    if (item.bytesPromise) continue;
    reading += 1;
    if (reading > readingPeak) readingPeak = reading;
    item.bytesPromise = item.file.arrayBuffer()
      .catch(() => null)
      .finally(() => {
        reading -= 1;
        /* A slot freed by a finished read is a slot the next file can use.
           Without this the window would drain to zero and stop, because the
           only other thing that calls dispatch is a worker finishing. The
           guard in dispatch is what keeps this from re-entering the walk that
           is very likely still in progress above. */
        dispatch();
      });
  }

  for (const item of queued) {
    // Prefer the worker that last handled this item - its decode cache makes a
    // quality-only re-run start instantly.
    let slot = item.slot != null && pool[item.slot] && !pool[item.slot].busy
      ? pool[item.slot] : null;
    if (!slot) slot = pool.find((s) => !s.busy);
    if (!slot) return;   // every worker is busy; a finishing one calls back

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
    scheduleRender("queue", item.id);

    /* Its read may not have started yet - the window above is bounded, so a
       queued item can reach this loop with nothing pending. Leave it queued;
       the read that frees a window slot calls dispatch again. */
    if (!item.bytesPromise) {
      item.status = "queued";
      item.startedAt = null;
      slot.busy = false; slot.itemId = null;
      continue;
    }
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
  for (const item of stopping) {
    // Nothing stale or half-shown survives a stop as though it were a result.
    if (item.stale || item.liveCandidates) clearResult(item);
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
    const wasFrac = item.frac || 0;
    const wasSay = item.progress;
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
    /* A frame is only worth asking for if something would look different.
       A worker posts progress far faster than the screen refreshes, and a bar
       three hundred pixels wide cannot render a movement of half a percent -
       so a frame that would only nudge `frac` by less than that is skipped.
       The sentence is not subject to the gate: the words change independently
       of the number, and the terminal frames (0 and 1) always paint, because
       "started" and "finished" are the two positions that must never be the
       ones dropped. */
    const moved = Math.abs((item.frac || 0) - wasFrac) >= 0.005;
    const terminal = item.frac === 0 || item.frac >= 1;
    if (moved || terminal || item.progress !== wasSay) {
      scheduleRender("queue", item.id);
      if (state.selected === item.id) scheduleRender("stage");
    }
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
       inferred from the numbers. */
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
  // Removing whatever was in flight frees a worker for the next one.
  dispatch();
}
