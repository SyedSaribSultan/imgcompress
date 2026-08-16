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
 * to disk, and can run for minutes, and none of that belongs in the pool that
 * has to stay responsive enough to compress a screenshot.
 */

import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  Input,
  Mp4OutputFormat,
  Output,
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

function sampleWindows(duration) {
  if (!(duration > 0)) return [[0, SAMPLE_SECONDS]];
  let count = Math.max(1, Math.round(duration / SECONDS_PER_SAMPLE));
  if (duration > 60) count = Math.max(count, 2);
  if (SAMPLE_SECONDS * count >= duration * 0.85) return [[0, duration]];
  const gap = (duration - SAMPLE_SECONDS * count) / (count + 1);
  const out = [];
  for (let i = 0; i < count; i += 1) {
    out.push([gap * (i + 1) + SAMPLE_SECONDS * i, SAMPLE_SECONDS]);
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

/* Frames nearest a set of moments, as RGBA on a canvas of the given size.
 *
 * Paired by timestamp, never by position. Two encodes of one source do not
 * necessarily hold the same number of frames, and comparing the Nth of one to
 * the Nth of the other silently scores frame 40 against frame 39 and reports a
 * catastrophe that is not there. The desktop tier learned this the same way. */
async function framesAt(source, times, width, height) {
  const input = new Input({ source: new BlobSource(source), formats: ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  if (!track) return [];
  const sink = new CanvasSink(track, { width, height, fit: "fill" });
  const out = [];
  for (const time of times) {
    const result = await sink.getCanvas(time);
    if (!result) continue;
    const canvas = result.canvas;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    out.push(context.getImageData(0, 0, canvas.width, canvas.height));
  }
  return out;
}

async function scoreAgainst(original, candidate, windows, width, height, per) {
  const scores = [];
  for (const [start, length] of windows) {
    const times = frameTimes(start, length, per);
    const reference = await framesAt(original, times, width, height);
    const made = await framesAt(candidate, times, width, height);
    const pairs = Math.min(reference.length, made.length);
    for (let i = 0; i < pairs; i += 1) {
      try {
        scores.push(score(reference[i], made[i]));
      } catch (_) {
        /* one unscoreable frame must not end the comparison */
      }
    }
  }
  return pooled(scores);
}

/* One pair of frames, scored the way the image tier scores a picture: the
   validated SSIMULACRA 2 port, on straight RGBA, with no alpha to weigh. */
function score(reference, made) {
  return ss2Score(reference.data, made.data, reference.width, reference.height,
                  null);
}

/* ------------------------------------------------------------------ encoding */

/* One encode, whole file or one window of it, through the browser's codec. */
async function encodeOnce(file, opts) {
  const {
    format, width, height, quantizer, bitrate, start = 0, length = 0,
    withAudio = true, signal,
  } = opts;

  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target: new BufferTarget() });

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
  await conversion.execute();
  return new Blob([output.target.buffer], { type: "video/mp4" });
}

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
    const parts = [];
    for (const [start, length] of windows) {
      parts.push(await encodeOnce(file, {
        format, width, height, quantizer: ladder[index],
        start, length, withAudio: false, signal: ctx.signal,
      }));
    }
    /* Each window was encoded on its own, so its timeline starts at zero -
       the reference is read at the original's offsets and the candidate at
       its own. */
    const scores = [];
    for (let w = 0; w < windows.length; w += 1) {
      const [start, length] = windows[w];
      const times = frameTimes(start, length, PROBE_FRAMES);
      const local = frameTimes(0, length, PROBE_FRAMES);
      const reference = await framesAt(file, times, width, height);
      const made = await framesAt(parts[w], local, width, height);
      const pairs = Math.min(reference.length, made.length);
      for (let i = 0; i < pairs; i += 1) {
        try { scores.push(score(reference[i], made[i])); } catch (_) { /* skip */ }
      }
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

/* --------------------------------------------------------------------- job */

async function runJob(job) {
  const { file, settings } = job;
  const controller = new AbortController();
  const ctx = {
    signal: controller.signal,
    report(stage, fraction, detail) {
      self.postMessage({ type: "progress", id: job.id, stage, fraction, detail });
    },
  };
  ctx.report("reading", 0.02, file.name);

  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error("no video track in this file");

  const duration = await input.computeDuration();
  /* The shape a player shows, rotation included - a phone held upright
     records a landscape frame and flags it, and every number downstream has
     to mean the picture rather than the way it was filed away. */
  const shownWidth = track.displayWidth ?? track.codedWidth;
  const shownHeight = track.displayHeight ?? track.codedHeight;
  const [width, height] = frameFor(shownWidth, shownHeight, settings.maxDimension || 0);
  const windows = sampleWindows(duration);

  const caps = await probeSupport();
  const allowed = (settings.formats || []).filter((f) => caps.formats.includes(f));
  if (!allowed.length) {
    throw new Error("this browser cannot encode video");
  }

  let best = null;
  const candidates = [];
  for (const format of allowed) {
    const ladder = QP_LADDER[format];
    const index = await searchQuality(file, format, width, height,
      settings.qualityTarget, windows, ctx);
    ctx.report("compressing", 0.5, format);
    const blob = await encodeOnce(file, {
      format, width, height, quantizer: ladder[index], signal: ctx.signal,
    });
    ctx.report("checking the result", 0.9, format);
    const { reported, mean } = await scoreAgainst(file, blob, windows, width, height, VERIFY_FRAMES);
    candidates.push({ format, bytes: blob.size, score: reported });
    if (!best || blob.size < best.bytes) {
      best = { format, blob, bytes: blob.size, score: reported, mean, level: ladder[index] };
    }
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
    blob: best.blob,
    /* Said plainly, because it is true and because the person is entitled to
       know which tier they are on: this is the browser's own encoder. */
    note: "compressed in your browser - the desktop app can go smaller",
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
