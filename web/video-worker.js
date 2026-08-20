/* The browser's video engine.
 *
 * Same promise as the desktop tier and the same shape of answer: encode the
 * thing more than one way, measure every result against the original, keep the
 * smallest one that still looks close enough, and say what was measured. What
 * differs is who does the encoding.
 *
 * Nothing here decodes or encodes a single pixel itself. Mediabunny reads and
 * writes the containers; every frame goes through WebCodecs, which is the
 * browser's own codec - the same one the video element plays with, generally
 * running on the machine's video hardware. That choice is the whole
 * architecture:
 *
 *   - it is fast, because it is silicon rather than a WebAssembly interpreter;
 *   - it ships no codec, so the page stays small and no patent licence
 *     travels with it - the browser vendor already holds the ones that matter;
 *   - and it needs no cross-origin isolation, so the site's existing CSP and
 *     service worker are untouched.
 *
 * The honest cost, stated here because it is stated to the person too: a
 * browser's encoder is tuned for video calls, not for archives. It gives up
 * something like a tenth to a third of the file size a patient desktop encoder
 * would find. The measurement is still real - we score what we actually made -
 * but the desktop app is the tier that wins on size, and the page says so.
 *
 * This worker is a module, unlike `worker.js` next to it, because Mediabunny
 * ships as an ES module. That is also why video is a separate worker rather
 * than more branches inside the image one: a video job holds frames, streams
 * its output, and can run for minutes, and none of that belongs in the pool
 * that has to stay responsive enough to compress a screenshot.
 *
 * MEMORY IS A CORRECTNESS PROPERTY HERE, not a nicety. A video job's peak must
 * not scale with the size of the file: once the working set passes what the
 * machine has, the operating system swaps and the whole computer stops
 * responding - which is a worse failure than a slow encode, because it is not
 * confined to this tab. Four rules keep it bounded, each with its own note
 * where it is enforced:
 *
 *   - output is streamed in chunks, never assembled in one buffer
 *     (`chunkedTarget`);
 *   - decoded reference frames are cached under a byte budget, evicted
 *     least-recently-used (`FRAME_CACHE_BYTES`);
 *   - a losing candidate's bytes are released the moment it loses, not at the
 *     end of the bake-off (`runJob`), and a probe holds one window at a time
 *     (`searchQuality`);
 *   - the job yields to the event loop between units of work (`breathe`), so
 *     progress and cancellation still reach the page during the minutes.
 */

import {
  ALL_FORMATS,
  BlobSource,
  Input,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  CanvasSink,
  Conversion,
} from "./vendor/mediabunny.min.js";
import { ss2Score } from "./ss2.module.js";

/* Ladders, mirroring the desktop tier's. The rungs are quantizer values
   rather than CRF because that is the handle WebCodecs exposes, but the shape
   is identical: ascending in quality, bisected by the same search. */
const QP_LADDER = {
  "h264-mp4": [40, 38, 36, 34, 32, 30, 28, 26, 24, 22, 20, 18, 16],
  "av1-mp4": [52, 48, 44, 40, 36, 33, 30, 27, 24, 21, 18],
};

const CODEC_OF = { "h264-mp4": "avc", "av1-mp4": "av1" };

const PROBE_FRAMES = 3;
const VERIFY_FRAMES = 8;
const SAMPLE_SECONDS = 20;
const SECONDS_PER_SAMPLE = 12 * 60;

/* ------------------------------------------------------- sharing the machine */

/* Come up for air.
 *
 * A worker that never returns to its event loop is a worker that cannot post
 * progress, cannot notice a cancellation, and gives the browser no chance to
 * run anything else. The whole job used to be one unbroken chain of awaits on
 * codec promises, and a 129-second encode reported ZERO distinct progress
 * fractions - measured, in probe_video_memory.mjs, before this existed.
 *
 * `setTimeout(0)` rather than a microtask: a microtask queue drain does not
 * yield to the event loop, so a `queueMicrotask` or bare `await null` would
 * post nothing. This is not a delay for throttling's sake - the encode is not
 * being slowed on purpose. It is the point at which queued messages flush.
 *
 * Deliberately NOT a sleep proportional to the work done. Idling would make a
 * slow job slower without helping: the failure this file is fixing was memory
 * pressure, and a process holding a gigabyte and sleeping half the time still
 * swaps. Bounding the bytes is the fix; yielding is what keeps the UI honest
 * while the bytes are bounded. */
const breathe = () => new Promise((resolve) => setTimeout(resolve, 0));

/* How much decoded-frame memory one job may hold.
 *
 * Reference frames are raw RGBA - 4 bytes a pixel, so a single 1080p frame is
 * 8.3 MB. They are cached because re-decoding them per probe rung was measured
 * far worse (the note on makeReader records the 480-full-file-opens version).
 * But the cache had no bound, and windows x frames x 8.3 MB grows with the
 * length of the clip: on a long file the cache alone outgrew the video.
 *
 * A byte budget, not an entry count: entries are frames and frames differ in
 * size by resolution, so counting them bounds nothing on the files that matter.
 * 192 MB holds roughly 23 frames of 1080p - comfortably more than one window's
 * worth at PROBE_FRAMES or VERIFY_FRAMES - and is evicted least-recently-used.
 * A cache with a ceiling is a cache; without one it is a leak with a name. */
const FRAME_CACHE_BYTES = 192 * 1024 * 1024;

/* Probing the WHOLE file is only allowed while the whole file is small. Above
   this, the search samples windows even when they cover most of the duration -
   see sampleWindows(). 64 MB is comfortably more than a phone clip of a few
   seconds and far below the sizes that made a rung cost a full re-encode. */
const PROBE_WHOLE_FILE_BYTES = 64 * 1024 * 1024;

/* Roughly how many source bytes one probe window should cover. The window is
   derived from the file's own bitrate, so a 30 Mbit/s clip gets a short window
   and a 2 Mbit/s clip a long one - the cost of a rung stays about the same
   either way, which is the property that keeps the search affordable. */
const PROBE_WINDOW_BYTES = 24 * 1024 * 1024;

/* The chunk the muxer stages output in. 4 MB rather than the library's 16 MB
   default: that buffer is resident on top of everything else, and four writes
   of 4 MB hand over the same total bytes as one of 16 MB while holding a
   quarter as much at any instant. Below about 1 MB the per-write overhead
   starts to show without buying anything. */
const OUTPUT_CHUNK_BYTES = 4 * 1024 * 1024;

/* The largest single buffer any encode in THIS JOB has been handed.
 *
 * Reported on the result as `largestWrite`, purely so a test can assert the
 * streaming invariant directly: with a chunked stream target this stays at the
 * chunk size, and anything that reassembles the whole output in one allocation
 * makes it the size of the file. Reset per job, because a stale value from a
 * previous job is not a fact about this one.
 *
 * It exists because asserting the same property through the operating system's
 * resident-memory figure did not work. Run-to-run spread on one file measured
 * about 19% - resident memory is sampled on an interval against a
 * garbage-collected runtime - which is wider than the regression's own effect,
 * so that gate could be made to pass or fail by luck. A gate has to assert the
 * mechanism, not an aggregate the mechanism is lost inside. */
let largestWrite = 0;



/* ---------------------------------------------------------------- capability */

/* What this browser can actually do, asked rather than assumed.
 *
 * `isConfigSupported` is the only honest source: support varies by browser,
 * by operating system, by whether a hardware encoder is present, and by codec.
 * Firefox on Android has no WebCodecs at all; Safari encodes H.264 and nothing
 * else; AV1 encoding exists on a minority of machines. The page needs the real
 * answer so it can offer what works and say plainly when nothing does, rather
 * than failing halfway through a job. */
async function probeSupport() {
  const caps = { webcodecs: false, formats: [], hardware: {} };
  if (typeof VideoEncoder === "undefined" || typeof VideoDecoder === "undefined") {
    return caps;
  }
  caps.webcodecs = true;
  const trials = [
    ["av1-mp4", "av01.0.04M.08"],
    ["h264-mp4", "avc1.42001f"],
  ];
  for (const [name, codec] of trials) {
    try {
      const config = {
        codec,
        width: 640,
        height: 360,
        bitrate: 1_000_000,
        framerate: 30,
      };
      const support = await VideoEncoder.isConfigSupported(config);
      if (support && support.supported) caps.formats.push(name);
    } catch (_) {
      /* an encoder that throws on being asked is an encoder we do not have */
    }
  }
  return caps;
}

/* ------------------------------------------------------------------ sampling */

/* Where to look when deciding whether a setting is good enough.
 *
 * `bytes` matters as much as `duration`, and used not to be considered at all.
 * The "just probe the whole thing" shortcut on the last line is right for a
 * short clip off a phone and badly wrong for a short clip at a high bitrate: a
 * ten-second 1080p near-lossless file is 287 MB, and probing the whole thing
 * meant every rung of the search re-encoded all 287 MB. Five rungs across two
 * formats is over 2 GB of encoding to answer a question three seconds of
 * footage answers just as well.
 *
 * So the shortcut is taken only when the file is also SMALL. Above that, a
 * window is used even though it covers most of the duration - the probe is a
 * sample by design, and a sample of a big file has to be a sample of its
 * bytes, not just of its seconds. */
function sampleWindows(duration, bytes = 0) {
  if (!(duration > 0)) return [[0, SAMPLE_SECONDS]];
  let count = Math.max(1, Math.round(duration / SECONDS_PER_SAMPLE));
  if (duration > 60) count = Math.max(count, 2);

  const wholeFileIsCheap = !bytes || bytes <= PROBE_WHOLE_FILE_BYTES;
  if (wholeFileIsCheap && SAMPLE_SECONDS * count >= duration * 0.85) {
    return [[0, duration]];
  }

  /* A heavy file gets a window measured against its own weight: enough seconds
     to judge it, few enough that a rung is not another whole encode. */
  const perSecond = duration > 0 ? bytes / duration : 0;
  const affordable = perSecond > 0
    ? Math.max(2, Math.min(SAMPLE_SECONDS, PROBE_WINDOW_BYTES / perSecond))
    : SAMPLE_SECONDS;
  const span = Math.min(SAMPLE_SECONDS, affordable);
  /* Never sample longer than the clip, and never claim more windows than fit. */
  count = Math.max(1, Math.min(count, Math.floor(duration / span) || 1));
  if (span * count >= duration) return [[0, Math.min(duration, span)]];

  const gap = (duration - span * count) / (count + 1);
  const out = [];
  for (let i = 0; i < count; i += 1) {
    out.push([gap * (i + 1) + span * i, span]);
  }
  return out;
}

function frameTimes(start, length, count) {
  if (count <= 1 || length <= 0) return [start + Math.max(0, length) / 2];
  const inset = length / (count + 1);
  const out = [];
  for (let i = 0; i < count; i += 1) out.push(start + inset * (i + 1));
  return out;
}

/* The reported score is the low percentile, never the mean. A per-frame metric
   cannot see time, so a clip that is perfect for four seconds and falls apart
   for one averages to "fine" while being exactly the thing a person notices. */
function pooled(scores) {
  if (!scores.length) return { reported: 0, mean: 0 };
  const sorted = [...scores].sort((a, b) => a - b);
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  if (sorted.length < 4) return { reported: sorted[0], mean };
  const index = Math.max(0, Math.floor(0.1 * (sorted.length - 1)));
  return { reported: sorted[index], mean };
}

/* -------------------------------------------------------------------- frames */

function evenly(n) {
  const v = Math.round(n);
  return v % 2 === 0 ? v : v - 1;
}

function frameFor(width, height, limit) {
  if (!limit || Math.max(width, height) <= limit) {
    return [evenly(width), evenly(height)];
  }
  const scale = limit / Math.max(width, height);
  return [evenly(width * scale), evenly(height * scale)];
}

/* One file, opened once, read many times.
 *
 * The old shape built a fresh demuxer and decoder for every set of frames it
 * wanted - which meant re-opening the whole file for every probe rung, every
 * window and every verify pass, and never releasing what it built. On a
 * twenty-minute clip that was about 48 full-file opens; on a four-hour one,
 * about 480, and the un-released decoder frames are platform memory the
 * garbage collector cannot see - the tab died partway through exactly the
 * long jobs this tier exists for. One reader per file, disposed when the
 * file is done with, is both the fix and the simpler shape.
 *
 * Frames are still paired by timestamp, never by position. Two encodes of
 * one source do not necessarily hold the same number of frames, and
 * comparing the Nth of one to the Nth of the other silently scores frame 40
 * against frame 39 and reports a catastrophe that is not there. */
function makeReader(source, width, height) {
  const input = new Input({ source: new BlobSource(source), formats: ALL_FORMATS });
  let track = null;
  let sink = null;
  return {
    input,
    /* `region` optionally reads back only part of the frame - see tileFor().
       The frame is still DECODED whole, because a decoder decodes frames; what
       this avoids is keeping a 1920x1080 RGBA copy (8.3 MB) per frame when a
       tile answers the same question. */
    async frames(times, region = null) {
      if (!sink) {
        track = await input.getPrimaryVideoTrack();
        if (!track) return [];
        sink = new CanvasSink(track, { width, height, fit: "fill" });
      }
      const out = [];
      for (const time of times) {
        const result = await sink.getCanvas(time);
        if (!result) continue;
        const canvas = result.canvas;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        const box = region
          ? [region.left, region.top, region.width, region.height]
          : [0, 0, canvas.width, canvas.height];
        out.push(context.getImageData(...box));
      }
      return out;
    },
    dispose() {
      try {
        input.dispose?.();
      } catch (_) {
        /* freeing is best-effort; a reader that cannot be freed is dropped */
      }
    },
  };
}

/* Which part of a frame the SEARCH looks at.
 *
 * The desktop tier settled this question already, and the rule it settled on
 * is in quality.py's own words: "Neither metric is evaluated on a downscaled
 * copy. Compression artefacts live at native resolution; scoring a shrunk
 * version hides exactly what you are looking for. Large images are instead
 * sampled as full-resolution tiles." Its measured drift against the whole
 * frame is under ~0.5 SSIMULACRA 2 points near the useful thresholds.
 *
 * So this does the same thing for video, and for the same two reasons: a tile
 * is honest where a downscale is not, and a 1280x720 centre tile is 3.7 MB of
 * RGBA where the full 1080p frame is 8.3 MB. That is per frame, on both sides
 * of every comparison, across every probe rung - which is where the search's
 * decoded-frame memory actually goes.
 *
 * Centre-weighted rather than a grid: a video frame's subject is overwhelmingly
 * central, and unlike a photograph there are many frames to average over, so
 * the coverage a grid buys on one still is bought here by time instead.
 *
 * The VERIFY pass deliberately does NOT use this - it scores whole frames, and
 * it is the number that gets reported. Cheap where it is guessing, exact where
 * it is answering. */
const PROBE_TILE_PIXELS = 1_200_000;   // the desktop tier's own budget

function tileFor(width, height) {
  if (width * height <= PROBE_TILE_PIXELS) return null;   // small enough whole
  const scale = Math.sqrt(PROBE_TILE_PIXELS / (width * height));
  /* Even dimensions keep the tile aligned to chroma subsampling, so the tile
     is not straddling half a chroma sample and inventing colour error. */
  const w = evenly(Math.min(width, Math.round(width * scale)));
  const h = evenly(Math.min(height, Math.round(height * scale)));
  return {
    left: evenly((width - w) / 2),
    top: evenly((height - h) / 2),
    width: w,
    height: h,
  };
}

/* One pair of frames, scored the way the image tier scores a picture: the
   validated SSIMULACRA 2 port, on straight RGBA, with no alpha to weigh. */
function score(reference, made) {
  return ss2Score(reference.data, made.data, reference.width, reference.height,
                  null);
}

/* ------------------------------------------------------------------ encoding */

/* Where an encode's bytes go.
 *
 * This used to be `BufferTarget` with `fastStart: "in-memory"`, and that pair
 * is what froze a laptop on a 300 MB file. `BufferTarget` grows one contiguous
 * ArrayBuffer holding the entire output; `fastStart: "in-memory"` additionally
 * forces the muxer to retain every packet so the index can be written at the
 * front. Two full copies of the result, both resident, both growing with the
 * file - on top of the source blob and the decoded frames in flight. Measured
 * on a 287 MB input: peak grew 4,536 MB, 15.8x the input, and the operating
 * system started swapping. Swapping is what stops a machine.
 *
 * A `StreamTarget` fed into a chunk list is the fix. Chunks arrive as the
 * muxer produces them and are handed straight to a Blob, which the browser
 * backs with disk rather than keeping wholly resident. Peak stops scaling with
 * the file.
 *
 * The cost, disclosed rather than hidden: the moov index lands at the END of
 * the file instead of the front, because writing it at the front requires
 * either knowing the packet count up front (`fastStart: "reserve"` needs
 * `maximumPacketCount` per track, which a quality SEARCH cannot know - it
 * discovers how many packets there are by encoding) or holding everything in
 * memory, which is the defect. For a file the person downloads to their own
 * disk this costs nothing: a local player reads the whole file anyway. It
 * would matter for progressive playback off a web server, which is not what
 * this tier produces. Recorded here so nobody "fixes" it back. */
function chunkedTarget() {
  /* Chunks arrive with a byte POSITION and are not guaranteed to be in order,
     nor to be written only once: a muxer revisits earlier offsets to patch box
     sizes once it knows them. Appending them in arrival order produced a file
     whose bytes were in the wrong places - it still had a plausible size, and
     scoring it read no frames at all and reported a visual match of 0. That is
     the worst shape of bug this project has a rule against: a number that
     looks like a measurement but is an artefact. So position is honoured, and
     a later write to the same range overwrites rather than appends. */
  /* `seq` records arrival order, because for two writes covering the same byte
     the LATER one is the correct value - a muxer patching a box size means the
     patch, not the placeholder. Sorting by position alone (a stable sort keeps
     the earlier arrival first) would ship the placeholder. */
  const parts = [];
  let seq = 0;
  const stream = new WritableStream({
    write(chunk) {
      /* The writer reuses its buffer, so the bytes are copied out. */
      const bytes = new Uint8Array(
        chunk.data.buffer, chunk.data.byteOffset, chunk.data.byteLength).slice();
      parts.push({ at: chunk.position, bytes, seq: seq += 1 });
      /* The streaming invariant, observable. See `largestWrite`. */
      if (bytes.byteLength > largestWrite) largestWrite = bytes.byteLength;
    },
  });
  return {
    target: new StreamTarget(stream,
      { chunked: true, chunkSize: OUTPUT_CHUNK_BYTES }),
    /* Assembled in position order WITHOUT ever making the file contiguous in
       memory: the pieces are handed to the Blob constructor as a list and the
       browser stitches them itself, backing the result with disk rather than
       holding it all resident. Flattening into one Uint8Array here would have
       undone the whole point of streaming - that array is exactly the
       contiguous full-file copy `BufferTarget` used to grow. */
    blob() {
      /* Later writes patch earlier ones IN PLACE, and the patch is usually
         tiny and lands near the front - Mediabunny writes an mdat header of
         unknown length, streams megabytes of samples, then comes back to
         position 24 with 8 bytes once it knows the size. So this cannot be a
         forward-only walk: the first attempt appended in arrival order (the
         file's bytes ended up in the wrong places, scoring read nothing, and
         the reported visual match was 0), and the second skipped any write
         that ended before the cursor - which threw that 8-byte patch away and
         produced a file no demuxer would open.

         The resolution is a byte-interval map: writes are applied newest-first
         and each one only claims the bytes no newer write has already claimed.
         Cheap in practice because there are a handful of writes, not one per
         packet. */
      const newestFirst = [...parts].sort((a, b) => b.seq - a.seq);
      const claimed = [];                                // [from, to) taken
      const owned = [];                                  // {at, bytes} to emit
      for (const { at, bytes } of newestFirst) {
        let from = at;
        const to = at + bytes.byteLength;
        /* Walk the gaps this write still owns, in ascending order. */
        const overlaps = claimed
          .filter((c) => c[1] > from && c[0] < to)
          .sort((a, b) => a[0] - b[0]);
        for (const [cFrom, cTo] of overlaps) {
          if (cFrom > from) {
            owned.push({ at: from, bytes: bytes.subarray(from - at, cFrom - at) });
          }
          from = Math.max(from, cTo);
        }
        if (from < to) {
          owned.push({ at: from, bytes: bytes.subarray(from - at, to - at) });
        }
        claimed.push([at, to]);
      }
      owned.sort((a, b) => a.at - b.at);
      return new Blob(owned.map((p) => p.bytes), { type: "video/mp4" });
    },
    /* Bytes are droppable the moment a candidate loses, and a loser used to be
       held until the whole bake-off finished. */
    release() { parts.length = 0; seq = 0; },
  };
}

/* One encode, whole file or one window of it, through the browser's codec. */
async function encodeOnce(file, opts) {
  const {
    format, width, height, quantizer, bitrate, start = 0, length = 0,
    withAudio = true, signal,
  } = opts;

  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const sink = chunkedTarget();
  const output = new Output({
    /* false, not "in-memory": see chunkedTarget() above for why the index
       moves to the end and why that is the right trade here. */
    format: new Mp4OutputFormat({ fastStart: false }),
    target: sink.target,
  });

  const conversion = await Conversion.init({
    input,
    output,
    video: {
      width,
      height,
      fit: "fill",
      codec: CODEC_OF[format],
      ...(quantizer != null ? { quantizer } : { bitrate }),
      /* Grain synthesis is deliberately left off: hardware and software
         decoders synthesise it differently, so a file measured here would not
         be the file played elsewhere. */
    },
    audio: withAudio ? { codec: "aac", bitrate: 128_000 } : { discard: true },
    ...(length ? { trim: { start, end: start + length } } : {}),
  });
  if (signal) signal.addEventListener("abort", () => conversion.cancel());
  try {
    await conversion.execute();
    return sink.blob();
  } catch (error) {
    /* Whoever owns a half-written result drops it on the way out - the same
       rule the desktop engine keeps for its half-written files. */
    sink.release();
    throw error;
  } finally {
    /* The demuxer for this one encode. Left open, a probe ladder accumulates
       one per rung per window, each holding decoder state. */
    try { input.dispose?.(); } catch (_) { /* best effort */ }
  }
}

const MIN_BITRATE = 120_000;
/* Below this a 1080p encode is not a compromise, it is a smear. If a size cap
   cannot be met above this floor, the honest answer is that it cannot be met -
   the same constant, and the same reasoning, as the desktop engine. */

/* The search: the lowest rung that still measures at or above the floor.
   Straight bisection, the same shape the image tier uses on a JPEG ladder. */
async function searchQuality(file, format, width, height, target, windows, ctx) {
  const ladder = QP_LADDER[format];
  const memo = new Map();
  let probes = 0;

  const probe = async (index) => {
    if (memo.has(index)) return memo.get(index);
    probes += 1;
    ctx.report("looking for the setting", 0.45 * Math.min(1, probes / 5),
      `${format}, try ${probes}`);
    /* Encoded and scored one window at a time, then dropped.
       The old shape encoded EVERY window first into a `parts` array and only
       then scored them, so a rung held every window's output at once - and on
       a long clip the sampler picks several. Each window's bytes are only
       needed for as long as it takes to read frames back out of them.

       Each window was encoded on its own, so its timeline starts at zero: the
       reference is read at the original's offsets and the candidate at its own. */
    const scores = [];
    for (const [start, length] of windows) {
      const part = await encodeOnce(file, {
        format, width, height, quantizer: ladder[index],
        start, length, withAudio: false, signal: ctx.signal,
      });
      const local = frameTimes(0, length, PROBE_FRAMES);
      /* Both sides read the SAME tile of the same frame - a comparison between
         two different regions is not a comparison. */
      const tile = tileFor(width, height);
      const reference = await ctx.reference(start, length, PROBE_FRAMES, tile);
      const reader = makeReader(part, width, height);
      try {
        const made = await reader.frames(local, tile);
        const pairs = Math.min(reference.length, made.length);
        for (let i = 0; i < pairs; i += 1) {
          try { scores.push(score(reference[i], made[i])); } catch (_) { /* skip */ }
        }
      } finally {
        reader.dispose();
      }
      /* One yield per window: often enough that progress and cancellation are
         responsive on a long clip, rare enough to cost nothing. */
      await breathe();
    }
    const value = pooled(scores).reported;
    memo.set(index, value);
    return value;
  };

  const top = ladder.length - 1;
  if (await probe(top) < target) return top;

  let chosen = top, lo = 0, hi = top;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (await probe(mid) >= target) { chosen = mid; hi = mid - 1; } else { lo = mid + 1; }
  }
  return chosen;
}

/* Which of two finished encodes wins - the desktop engine's rule, ported
   verbatim. The rule inverts under a size cap: with no cap, everything on
   the table already measures close enough, so the smallest file wins; under
   a cap, everything already fits, so the best-looking one wins. And a
   candidate that met the quality floor always beats one that only met the
   byte limit, whatever the numbers say. The old comparison here was
   `smallest bytes wins`, full stop - which shipped the worse-looking file
   whenever the sizes disagreed with the scores. */
function beats(candidate, best, underCap) {
  if (!!candidate.capped !== !!best.capped) return !candidate.capped;
  if (candidate.capped) {
    if (candidate.score !== best.score) return candidate.score > best.score;
    return candidate.bytes < best.bytes;
  }
  if (candidate.bytes !== best.bytes) return candidate.bytes < best.bytes;
  return candidate.score > best.score;
}

/* --------------------------------------------------------------------- job */

/* One format, all the way through: search, encode, and - when a byte ceiling
   exists and the honest quality answer does not fit - the rate-targeted
   encode that does. Quality first even under a cap: a limit is not an
   instruction to spend it. This is the desktop engine's hybrid; the browser
   used to silently drop the cap on the floor, so a person promised "fits
   Discord's free 10 MB limit" could be handed 14 MB with nothing said. */
async function oneFormat(file, format, width, height, floor, windows,
                         sizeCap, duration, hasAudio, ctx) {
  const ladder = QP_LADDER[format];
  const index = await searchQuality(file, format, width, height, floor,
    windows, ctx);
  ctx.report("compressing", 0.5, format);
  let blob = await encodeOnce(file, {
    format, width, height, quantizer: ladder[index], signal: ctx.signal,
  });
  let capped = false;
  let level = ladder[index];

  if (sizeCap && blob.size > sizeCap) {
    /* Aim at 95% of the cap: container overhead is real, rate control is
       approximate, and a file that misses the limit by 40 KB is as useless
       as one that misses it by 4 MB. The sound's share comes off the top -
       this tier always writes AAC at 128k when there is sound at all. */
    const audioBits = hasAudio ? 128_000 : 0;
    let bitrate = (sizeCap * 0.95 * 8) / Math.max(duration, 0.1) - audioBits;
    if (bitrate >= MIN_BITRATE) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        ctx.report("compressing", 0.6 + attempt * 0.1, format);
        const rated = await encodeOnce(file, {
          format, width, height, bitrate: Math.round(bitrate),
          signal: ctx.signal,
        });
        /* The blob this replaces is a whole encode of the whole file. Dropping
           the reference here rather than letting the next assignment do it
           keeps at most one full-size result alive across the retry. */
        blob = null;
        blob = rated;
        capped = true;
        level = null;
        if (rated.size <= sizeCap) break;
        bitrate = bitrate * (sizeCap / rated.size) * 0.95;
        if (bitrate < MIN_BITRATE) break;
        await breathe();
      }
    }
    /* If no usable rate exists, the quality answer stands, over the cap,
       and the missed-size disclosure says so - "every encoder failed" on a
       file that encodes fine is the wrong answer. */
  }

  ctx.report("checking the result", 0.9, format);
  const reader = makeReader(blob, width, height);
  let verdict;
  try {
    const scores = [];
    for (const [start, length] of windows) {
      const times = frameTimes(start, length, VERIFY_FRAMES);
      const reference = await ctx.reference(start, length, VERIFY_FRAMES);
      const made = await reader.frames(times);
      const pairs = Math.min(reference.length, made.length);
      for (let i = 0; i < pairs; i += 1) {
        try { scores.push(score(reference[i], made[i])); } catch (_) { /* skip */ }
      }
      /* VERIFY_FRAMES is eight 1080p frames per window - 66 MB of RGBA decoded
         and scored before this line. The yield is what lets the progress this
         loop's caller reported actually reach the page. */
      await breathe();
    }
    verdict = pooled(scores);
  } finally {
    reader.dispose();
  }
  return { format, blob, bytes: blob.size, score: verdict.reported,
           mean: verdict.mean, level, capped };
}

async function runJob(job) {
  const { file, settings } = job;
  const controller = new AbortController();
  /* This job's own figure, not whatever the last one left behind. */
  largestWrite = 0;

  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error("no video track in this file");
  const duration = await input.computeDuration();
  const hasAudio = !!(await input.getPrimaryAudioTrack());
  /* The shape a player shows, rotation included - a phone held upright
     records a landscape frame and flags it, and every number downstream has
     to mean the picture rather than the way it was filed away. */
  const shownWidth = track.displayWidth ?? track.codedWidth;
  const shownHeight = track.displayHeight ?? track.codedHeight;
  const [width, height] = frameFor(shownWidth, shownHeight, settings.maxDimension || 0);
  /* The file's own size decides how much of it a probe rung may re-encode. */
  const windows = sampleWindows(duration, file.size || 0);
  const sizeCap = Math.max(0, settings.sizeCapBytes || 0);

  /* The original is opened once for the whole job, and its reference frames
     are remembered across probe rungs and formats - the same frames used to
     be decoded from scratch for every single probe.

     Bounded, though: see FRAME_CACHE_BYTES. A Map iterates in insertion order,
     which is what makes least-recently-used cheap here - a hit re-inserts, so
     the oldest live entry is always the first key. */
  const source = makeReader(file, width, height);
  const refCache = new Map();
  let cachedBytes = 0;
  const frameBytes = (frames) =>
    frames.reduce((n, f) => n + (f?.data?.byteLength || 0), 0);
  const ctx = {
    signal: controller.signal,
    report(stage, fraction, detail) {
      self.postMessage({ type: "progress", id: job.id, stage, fraction, detail });
    },
    /* `region` is part of the KEY, not just of the read: the probe asks for a
       centre tile and the verify pass asks for the whole frame, and handing
       one back for the other would score a tile against a full frame. */
    async reference(start, length, count, region = null) {
      const shape = region
        ? `${region.left},${region.top},${region.width},${region.height}`
        : "full";
      const key = `${start.toFixed(3)}:${length.toFixed(3)}:${count}:${shape}`;
      const hit = refCache.get(key);
      if (hit) {
        /* Re-insert so this becomes the newest entry: the eviction below takes
           from the front, and a frequently used window should not be dropped
           just because it was decoded early. */
        refCache.delete(key);
        refCache.set(key, hit);
        return hit;
      }
      const frames = await source.frames(frameTimes(start, length, count), region);
      const size = frameBytes(frames);
      /* A single set of frames larger than the whole budget is not cached at
         all - caching it would evict everything and then not fit. It is still
         returned; the caller gets its frames, they are just not kept. */
      if (size <= FRAME_CACHE_BYTES) {
        refCache.set(key, frames);
        cachedBytes += size;
        while (cachedBytes > FRAME_CACHE_BYTES && refCache.size > 1) {
          const oldest = refCache.keys().next().value;
          cachedBytes -= frameBytes(refCache.get(oldest));
          refCache.delete(oldest);
        }
      }
      return frames;
    },
  };
  ctx.report("reading", 0.02, file.name);

  const caps = await probeSupport();
  const allowed = (settings.formats || []).filter((f) => caps.formats.includes(f));
  if (!allowed.length) {
    source.dispose();
    try { input.dispose?.(); } catch (_) { /* best effort */ }
    throw new Error("this browser cannot encode video");
  }

  let best = null;
  const candidates = [];
  const failures = [];
  try {
    for (const format of allowed) {
      /* One format failing must not end the run - an encoder that passes
         `isConfigSupported` and then falls over at the real resolution used
         to take every other format down with it, and the person was told
         their browser cannot encode video at all. */
      let candidate;
      try {
        candidate = await oneFormat(file, format, width, height,
          settings.qualityTarget, windows, sizeCap, duration, hasAudio, ctx);
      } catch (error) {
        failures.push(`${format} failed (${(error && error.message) || error})`);
        continue;
      }
      candidates.push({ format, bytes: candidate.bytes, score: candidate.score });
      /* The loser's bytes go NOW, not at the end of the bake-off. `web` and
         `original` both allow AV1 and H.264, so this used to mean two whole
         encoded files resident at once - on a large input, that alone is
         hundreds of megabytes held for nothing. The record of what was tried
         (`candidates`, above) is numbers, and numbers are what the panel
         shows: the losing FILE is not kept, only the fact that it existed. */
      if (!best) {
        best = candidate;
      } else if (beats(candidate, best, sizeCap > 0)) {
        best.blob = null;
        best = candidate;
      } else {
        candidate.blob = null;
      }
      await breathe();
    }
  } finally {
    source.dispose();
    try { input.dispose?.(); } catch (_) { /* best effort */ }
    /* The decoded frames are the other half of the peak, and the job is over.
       Nothing downstream reads them - the result carries numbers and one blob. */
    refCache.clear();
    cachedBytes = 0;
  }

  if (!best) {
    throw new Error(failures.length
      ? failures.join("; ")
      : "this browser cannot encode video");
  }

  ctx.report("done", 1, best.format);
  return {
    format: best.format,
    bytes: best.bytes,
    score: best.score,
    mean: best.mean,
    level: best.level,
    width,
    height,
    resized: width !== shownWidth || height !== shownHeight,
    shownWidth,
    shownHeight,
    duration,
    candidates,
    warnings: failures,
    /* Flags, not inferences: the same contract the desktop engine keeps.
       `capped` means the byte ceiling, not the quality floor, decided the
       answer; `missedSize` means even that was not enough. The UI repeats
       these on the result line - it never works them out from the numbers. */
    capped: !!best.capped,
    missedSize: sizeCap > 0 && best.bytes > sizeCap,
    audioNote: hasAudio ? "Sound re-encoded to fit this format." : "",
    blob: best.blob,
    /* Said plainly, because it is true and because the person is entitled to
       know which tier they are on: this is the browser's own encoder. */
    note: "compressed in your browser - the desktop app can go smaller",
    /* Shown to nobody: the streaming invariant, so a test can assert that
       output still leaves the muxer in chunks rather than as one whole-file
       buffer. See `largestWrite`. */
    largestWrite,
  };
}

/* ----------------------------------------------------------------- messages */

self.onmessage = async (event) => {
  const message = event.data || {};
  if (message.type === "probe") {
    self.postMessage({ type: "caps", caps: await probeSupport() });
    return;
  }
  if (message.type === "job") {
    try {
      const result = await runJob(message);
      const { blob, ...rest } = result;
      self.postMessage({ type: "done", id: message.id, result: rest, blob });
    } catch (error) {
      self.postMessage({
        type: "failed", id: message.id,
        error: (error && error.message) || String(error),
      });
    }
  }
};
