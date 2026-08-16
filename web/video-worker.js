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
    async frames(times) {
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
        out.push(context.getImageData(0, 0, canvas.width, canvas.height));
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
      const local = frameTimes(0, length, PROBE_FRAMES);
      const reference = await ctx.reference(start, length, PROBE_FRAMES);
      const reader = makeReader(parts[w], width, height);
      try {
        const made = await reader.frames(local);
        const pairs = Math.min(reference.length, made.length);
        for (let i = 0; i < pairs; i += 1) {
          try { scores.push(score(reference[i], made[i])); } catch (_) { /* skip */ }
        }
      } finally {
        reader.dispose();
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
        blob = rated;
        capped = true;
        level = null;
        if (rated.size <= sizeCap) break;
        bitrate = bitrate * (sizeCap / rated.size) * 0.95;
        if (bitrate < MIN_BITRATE) break;
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
  const windows = sampleWindows(duration);
  const sizeCap = Math.max(0, settings.sizeCapBytes || 0);

  /* The original is opened once for the whole job, and its reference frames
     are remembered across probe rungs and formats - the same frames used to
     be decoded from scratch for every single probe. */
  const source = makeReader(file, width, height);
  const refCache = new Map();
  const ctx = {
    signal: controller.signal,
    report(stage, fraction, detail) {
      self.postMessage({ type: "progress", id: job.id, stage, fraction, detail });
    },
    async reference(start, length, count) {
      const key = `${start.toFixed(3)}:${length.toFixed(3)}:${count}`;
      if (!refCache.has(key)) {
        refCache.set(key,
          await source.frames(frameTimes(start, length, count)));
      }
      return refCache.get(key);
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
      if (!best) {
        best = candidate;
      } else if (beats(candidate, best, sizeCap > 0)) {
        best = candidate;
      }
    }
  } finally {
    source.dispose();
    try { input.dispose?.(); } catch (_) { /* best effort */ }
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
