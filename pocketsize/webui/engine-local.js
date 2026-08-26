/* COPIED from web/js/engine-local.js by tools/sync_webui_assets.py - DO NOT EDIT.
 * Edit the file in web/ and re-run the tool; CI fails on a stale copy. */
/* engine.js's contract, answered by the local Python engine.
 *
 * The desktop app runs the same interface as the web app - the same modules,
 * the same staged sequence, the same plan panel - and compresses with native
 * encoders in Python instead of WebAssembly workers in the browser. This file
 * is the whole of that difference.
 *
 * It exports exactly what `engine.js` exports, with the same names and the same
 * shapes, so no shared module knows which product it is running inside. Where
 * engine.js posts a message to a worker and hears back, this posts to the local
 * HTTP API and polls `/api/state`.
 *
 * WHY A SECOND FILE RATHER THAN A FLAG INSIDE engine.js
 *
 * engine.js is 700-odd lines of worker-pool bookkeeping - dispatch order, stale
 * revisions, live candidate adoption - and none of it applies here: the Python
 * side owns its own pool and its own bake-off. Threading a `if (LOCAL)` through
 * that would leave two behaviours interleaved in one file and no way to read
 * either. Two files, one contract, and `main.js` imports whichever it was
 * given.
 *
 * WHAT THE PYTHON SIDE ALREADY DOES
 *
 * More than the browser does, which is why the mapping is mostly renaming
 * rather than reimplementing. `/api/state` returns one snapshot per revision
 * holding every item with its status, its measured score, its candidates, its
 * warnings and how far a long encode has got. The queue, the plan panel and the
 * facts blocks all read that same snapshot through `state`. So this file is a
 * translator, not an engine.
 *
 * THE ONE HONEST DIVERGENCE
 *
 * `probeVideoSupport` in the browser asks what the *browser* can encode, and
 * the answer is often "not much". Here the answer comes from `--check`: real
 * ffmpeg, every format the build carries. The owner's instruction (2026-08-25)
 * was that where the shared copy names a browser limit that is not true
 * locally, the desktop app states its own truth rather than repeating the web
 * wording. So the capability report is the local one, and the plan panel offers
 * what this machine can actually write.
 */

import { state, select } from "./state.js";
import { scheduleRender } from "./render.js";
import { reflectFormatAvailability } from "./settings.js";
import { toast } from "./dom.js";

/* The API token is substituted into the page by the server at launch - it
   replaces `__TOKEN__` in app.html before the bytes are sent - and every call
   carries it. A call without it is refused, which is what stops another page in
   the same browser driving this app.

   Read from a data attribute on <body> rather than a global set by an inline
   script, which is what lets the page's CSP refuse inline script outright. The
   header name is the server's: `X-Token`, checked in `_authorised`. */
const TOKEN = document.body.dataset.token || "";

async function call(route, payload) {
  const response = await fetch(route, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Token": TOKEN },
    body: JSON.stringify(payload || {}),
  });
  if (!response.ok) throw new Error(`${route} ${response.status}`);
  return response.json();
}

/* `/api/state` is the one route on do_GET rather than do_POST, because reading
   the snapshot is a read. Sent as a GET so it matches the server rather than
   quietly 404ing. */
async function read(route) {
  const response = await fetch(route, { headers: { "X-Token": TOKEN } });
  if (!response.ok) throw new Error(`${route} ${response.status}`);
  return response.json();
}

/* engine.js exports a live array of worker slots and the browser harness counts
 * it. There are no workers here - the pool lives in Python - so this stays empty
 * and is exported only so the shared modules' imports resolve. Anything that
 * asserts on pool size is asserting about the browser build.
 */
export const pool = [];

let onBatchEnd = null;
export function setBatchEndHandler(fn) { onBatchEnd = fn; }

let batchActive = false;
export function beginBatch() { batchActive = true; }

let held = false;
export function holdWork(on) {
  held = !!on;
  if (!held) dispatch();
}

/* --------------------------------------------------------------------------- *
 * the snapshot, and turning it into what the shared modules read
 * --------------------------------------------------------------------------- */

/* Python's field names are snake_case and carry a couple of different words for
 * the same fact. Renaming happens in exactly one place - here - so that no
 * shared module has to know the server's vocabulary. */
function adoptItem(row) {
  const existing = state.byId.get(row.id) || {};
  const item = Object.assign(existing, {
    id: row.id,
    name: row.name,
    path: row.path,
    status: row.status,
    isVideo: !!row.is_video,
    originalBytes: row.original_bytes,
    newBytes: row.new_bytes,
    fmt: row.fmt,
    level: row.level,
    score: row.score,
    metric: row.metric,
    width: row.width,
    height: row.height,
    outW: row.out_width,
    outH: row.out_height,
    /* `capped` is the server's word for "a size limit, not the quality floor,
       decided this" - the same fact the web build calls hardCapped, and the
       reason the result line has to admit the picture is less sharp. */
    hardCapped: !!row.capped,
    candidates: row.candidates || [],
    note: row.note || "",
    error: row.error || "",
    warnings: row.warnings || [],
    override: row.override || null,
    savedTo: row.saved_to || "",
    duration: row.duration || 0,
    audioNote: row.audio_note || "",
    witness: row.witness || 0,
    stage: row.stage || "",
    frac: row.fraction || 0,
    outputPath: row.output_path || "",
    savedPct: row.saved_pct || 0,
  });
  /* The stage reads both sides through a URL rather than a Blob: the bytes
     already exist on the Python side, and pulling a 2 GB clip into the page to
     make a Blob would defeat the point of compressing it there.

     `before` is its own path because the original may be a RAW or a video that
     the page cannot decode - the server renders a PNG preview for it. The
     `rev` is a cache-buster: same id, new bytes, after a re-run. */
  const q = `?token=${encodeURIComponent(TOKEN)}&rev=${row.rev_stamp || state.snapshotRev || 0}`;
  item.beforeUrl = `/api/image/${encodeURIComponent(row.id)}/before${q}`;
  if (row.status === "done" || row.status === "saved") {
    item.afterUrl = row.is_video
      ? `/api/video/${encodeURIComponent(row.id)}${q}`
      : `/api/image/${encodeURIComponent(row.id)}/after${q}`;
  }
  return item;
}

function adopt(snapshot) {
  state.snapshotRev = snapshot.rev;
  const seen = new Set();
  const items = [];
  for (const row of snapshot.items) {
    seen.add(row.id);
    const item = adoptItem(row);
    if (!state.byId.has(row.id)) state.byId.set(row.id, item);
    items.push(item);
  }
  for (const id of [...state.byId.keys()]) {
    if (!seen.has(id)) state.byId.delete(id);
  }
  state.items = items;

  /* The engine banner and the plan panel's format list both come from what this
     machine can write, which the server reports because only the server knows.
     This is the divergence named at the top of the file: the local truth, not
     the browser's. */
  if (snapshot.engines) state.engines = snapshot.engines;
  if (snapshot.video) {
    state.videoAvailable = !!snapshot.video.available;
    state.videoDestinations = snapshot.video.destinations || [];
  }
  if (snapshot.settings) state.serverSettings = snapshot.settings;
  if (snapshot.totals) state.totals = snapshot.totals;
  if (snapshot.watch_folder !== undefined) state.watchFolder = snapshot.watch_folder;
  if (snapshot.last_folder !== undefined) state.lastFolder = snapshot.last_folder;
  if (snapshot.toast) toast(snapshot.toast);

  if (state.selected && !state.byId.has(state.selected)) select(null);
  scheduleRender();

  /* A run ends when nothing is queued or working. The web build fires this from
     the worker pool going idle; the same condition, read off the snapshot. */
  const busy = !!snapshot.busy;
  if (batchActive && !busy) {
    batchActive = false;
    if (onBatchEnd) onBatchEnd();
  }
  return snapshot;
}

/* --------------------------------------------------------------------------- *
 * polling
 * --------------------------------------------------------------------------- */

/* Two rates, because one rate is either wasteful or feels broken. While work is
 * in flight a long encode needs its progress line to move; while the app sits
 * idle waiting for a drop, four requests a second is noise. */
const RATE_BUSY = 250;
const RATE_IDLE = 1000;

let timer = null;
let inFlight = false;

async function tick() {
  if (inFlight) return;
  inFlight = true;
  try {
    const snapshot = await read("/api/state");
    adopt(snapshot);
    schedule(snapshot.busy ? RATE_BUSY : RATE_IDLE);
  } catch (err) {
    /* The server going away is not a transient - it is the app closing, or the
       token being wrong. Backing off rather than hammering it keeps the console
       readable while that is true. */
    schedule(RATE_IDLE * 3);
  } finally {
    inFlight = false;
  }
}

function schedule(ms) {
  clearTimeout(timer);
  timer = setTimeout(tick, ms);
}

/** Ask the local engine what it can write, and start watching state. The
 *  browser build probes a worker for this; here the answer is already in the
 *  first snapshot. */
export function startEngine() {
  tick();
}

/** Nothing to warm: the encoders are native and already resident. Kept because
 *  main.js calls it, and a missing export is a module-graph error rather than a
 *  no-op. */
export function warmCodecs() {}

/** The Python side dispatches its own work the moment an item is added, so
 *  there is no queue to drain from here. What this does is make sure the poll
 *  is running at the busy rate, so a job that just started is seen promptly
 *  instead of up to a second later. */
export async function dispatch() {
  if (held) return;
  schedule(0);
}

/* Every mutating route answers `{ok: true}` or `{added: [...]}` - none of them
 * returns a snapshot, which was worth checking rather than assuming: chaining
 * `.then(adopt)` onto one would have handed the adopter an object with no
 * `items` and emptied the queue on the next change. So a mutation re-polls, and
 * `/api/state` stays the single source of what is on screen. */
function mutate(route, payload) {
  return call(route, payload).then(() => tick());
}

export function cancelAll() {
  mutate("/api/clear", {}).catch(() => {});
}

/** What this machine can encode, reported by the engine that will do it. */
export function probeVideoSupport() {
  return {
    available: !!state.videoAvailable,
    destinations: state.videoDestinations || [],
  };
}

export function requeue(ids, opts = {}) {
  const list = Array.isArray(ids) ? ids : [ids];
  if (!list.length) return;
  beginBatch();
  mutate("/api/retry", { ids: list, ...opts }).catch(() => {});
}

export function removeItems(ids) {
  const list = Array.isArray(ids) ? ids : [ids];
  if (!list.length) return;
  mutate("/api/remove", { ids: list }).catch(() => {});
}

/* --------------------------------------------------------------------------- *
 * intake and saving, which is where the two products genuinely differ
 * --------------------------------------------------------------------------- */

/** Hand real paths to the engine. The browser build has to read bytes out of a
 *  File; here the file is already on disk and the engine opens it itself, which
 *  is why a folder of 500 photos costs nothing to add. */
export function addPaths(paths) {
  beginBatch();
  return mutate("/api/add", { paths });
}

/** For bytes with no path behind them - a paste, or a drop from an archive.
 *  These go up as an upload and the engine writes them to its own scratch
 *  space. */
export async function addFiles(files) {
  beginBatch();
  for (const file of files) {
    /* The name travels in a header, not the query string: server.py reads
       `X-Filename` and sanitises it, and it is what decides whether the body
       gets the picture limit or the much larger video one. */
    const body = await file.arrayBuffer();
    await fetch("/api/upload", {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Token": TOKEN,
        "X-Filename": encodeURIComponent(file.name),
      },
      body,
    });
  }
  return tick();
}

/** Push the plan to the engine. The shared settings module owns the panel; the
 *  engine owns what the numbers mean, and re-runs whatever the change
 *  invalidated. */
export function pushSettings(settings) {
  /* The server takes the plan nested under `settings`, and re-runs everything
     the change invalidated unless told not to. Passing the bare object would
     update nothing and report success. */
  return mutate("/api/settings", { settings });
}

export function pushOverride(id, override) {
  return mutate("/api/override", { id, override });
}

/** Write the results where the person chose. The browser build has to hand the
 *  bytes back through a download; here the engine already wrote the file and
 *  this moves it, so nothing is copied through the page at all. */
export function saveTo(folder, ids) {
  /* This one does answer with a body worth having - what was written and
     where - so the result is returned as well as re-polled. */
  return call("/api/save", { folder, ids }).then((r) => tick().then(() => r));
}

export function pickFolder(initial) {
  return call("/api/pick-folder", { initial: initial || "" });
}

export function setWatch(folder) {
  return mutate("/api/watch", { folder: folder || "" });
}
