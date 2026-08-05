/* imgcompress web worker — the compression engine, ported from the Python
 * package (core.py / quality.py / encoders.py) to run entirely in the browser.
 *
 * Same premise as the desktop version: quality is measured, never assumed.
 * Every candidate encode is decoded back and scored against the original with
 * SSIM aggregated at the 5th percentile (the desktop app's fallback metric —
 * SSIMULACRA 2 has no browser build, which is one honest reason the desktop
 * version stays the reference). Transparent images are scored over a dark and
 * a light backdrop and the worse score wins.
 *
 * Encoders available in a browser:
 *   jpeg  — canvas encoder
 *   png8  — our own palette quantizer + PNG writer (CompressionStream deflate)
 *   png   — canvas encoder, lossless
 *   webp  — canvas encoder, where supported (feature-detected)
 *
 * No network I/O of any kind happens in this file. Images never leave the
 * machine.
 */

"use strict";

/* The metric itself. ss2.js is the validated JavaScript port of SSIMULACRA 2 -
 * the same metric the desktop app scores with, matching its Python reference
 * to four decimal places across the validation corpus. */
if (typeof importScripts === "function") importScripts("ss2.js");

/* ------------------------------------------------------------------------- *
 * constants — ladders mirror encoders.py
 * ------------------------------------------------------------------------- */

const PNG8_COLORS = [16, 24, 32, 48, 64, 96, 128, 192, 256];
// Tops out at 98: mozjpeg's quality scale runs tighter than the canvas
// encoder's, and high floors legitimately need the extra headroom.
/* Every lossy ladder reaches into the high 90s. The head-to-head found the old
 * ceilings costing real bytes: on a hard photograph no lossy rung could clear
 * a strict floor, so a multi-megabyte lossless PNG won by forfeit while a
 * higher AVIF rung would have passed at an eighth of the size. Bisection means
 * the extra rungs cost at most one additional probe. */
const JPEG_QUALITY = [40, 50, 58, 65, 70, 74, 78, 82, 85, 88, 90, 92, 94, 96, 97, 98, 99];
const WEBP_QUALITY = [40, 50, 58, 65, 70, 75, 80, 84, 87, 90, 92, 94, 96, 98];
const AVIF_QUALITY = [30, 38, 45, 52, 58, 64, 70, 76, 82, 88, 93, 96];

const FIGMA_MAX_DIMENSION = 4096;

// SSIM constants for 8-bit data (Wang et al. 2004)
const C1 = (0.01 * 255) ** 2;
const C2 = (0.03 * 255) ** 2;
const WINDOW = 8;

// Tiling for the search phase (quality.py)
const TILE = 512;
const TILE_BUDGET = 1_200_000;

// Transparent artwork is judged against a dark and a light backdrop, and the
// worse of the two wins — a halo you cannot see on white is still a defect.
const BACKDROPS = [[26, 26, 26], [230, 230, 230]];

const TARGETS = {
  figma: ["jpeg", "png8", "png"],
  web: ["jpeg", "png8", "png", "webp", "webp-lossless", "avif"],
  lossless: ["png", "png8x", "webp-lossless"], // png8x = palette PNG only when pixel-exact
};

/* ------------------------------------------------------------------------- *
 * capability probes
 * ------------------------------------------------------------------------- */

let CAN_WEBP = null;
let CAN_DEFLATE = typeof CompressionStream !== "undefined";

async function probeWebp() {
  if (CAN_WEBP !== null) return CAN_WEBP;
  try {
    const c = new OffscreenCanvas(1, 1);
    c.getContext("2d").fillRect(0, 0, 1, 1);
    const blob = await c.convertToBlob({ type: "image/webp", quality: 0.8 });
    CAN_WEBP = blob && blob.type === "image/webp";
  } catch {
    CAN_WEBP = false;
  }
  return CAN_WEBP;
}

/* ------------------------------------------------------------------------- *
 * WASM codecs — mozjpeg, oxipng, libaom (AVIF), self-hosted under /vendor/,
 * loaded lazily the first time an encode needs them. Every one of them has a
 * graceful fallback: mozjpeg/oxipng fall back to the canvas encoder or plain
 * output, AVIF simply doesn't enter the bake-off.
 * ------------------------------------------------------------------------- */

const CODECS = { mozjpeg: null, oxipng: null, avif: null, webp: null };

/* ------------------------------------------------------------------------- *
 * timing. Cheap accumulators so the cost of every phase is a measurement
 * rather than a guess; the totals ride along on the done message.
 * ------------------------------------------------------------------------- */

let PERF = null;
const perfReset = () => {
  PERF = {
    decode: 0, encode: 0, back: 0, ssimTiled: 0, ssimFull: 0, ssimChroma: 0,
    quantize: 0, oxipng: 0, pngWrite: 0, probes: 0, encodes: 0,
    "enc:jpeg": 0, "enc:png8": 0, "enc:png": 0, "enc:webp": 0, "enc:avif": 0,
  };
};
/* Both the elapsed time and the call count. Time is what a user feels but it is
   hostage to thermal state; the counts are deterministic, so they are what
   actually proves an algorithmic change. */
function timed(bucket, fn) {
  if (!PERF) return fn();
  PERF[`n:${bucket}`] = (PERF[`n:${bucket}`] || 0) + 1;
  const t = performance.now();
  const out = fn();
  PERF[bucket] += performance.now() - t;
  return out;
}
async function timedAsync(bucket, fn) {
  if (!PERF) return fn();
  PERF[`n:${bucket}`] = (PERF[`n:${bucket}`] || 0) + 1;
  const t = performance.now();
  const out = await fn();
  PERF[bucket] += performance.now() - t;
  return out;
}

let onCodecStatus = null;   // set per job so the UI can narrate the first load

async function loadCodec(name, script, globalName, wasmFile) {
  if (CODECS[name] !== null) return CODECS[name];
  try {
    if (onCodecStatus) onCodecStatus(name);
    importScripts(`vendor/${script}`);
    const bytes = await (await fetch(`vendor/${wasmFile}`)).arrayBuffer();
    const module = await WebAssembly.compile(bytes);
    await self[globalName].init(module);
    CODECS[name] = self[globalName];
  } catch (e) {
    console.warn(`codec ${name} unavailable:`, e && e.message ? e.message : e);
    CODECS[name] = false;
  }
  return CODECS[name];
}
const loadMozjpeg = () => loadCodec("mozjpeg", "mozjpeg.js", "__mozjpeg", "mozjpeg_enc.wasm");
const loadOxipng = () => loadCodec("oxipng", "oxipng.js", "__oxipng", "squoosh_oxipng_bg.wasm");
const loadAvif = () => loadCodec("avif", "avif.js", "__avif", "avif_enc.wasm");
// The SIMD build: the glue selects it wherever wasm SIMD exists, which is every
// current browser. Engines without SIMD skip the candidate gracefully.
const loadWebp = () => loadCodec("webp", "webp.js", "__webp", "webp_enc_simd.wasm");

/** Lossless oxipng pass over a finished PNG - the browser-tier zopfli.
 *
 * Deliberately NOT called from inside an encoder. It is by far the most
 * expensive step in the whole pipeline (37% of all worker CPU when it ran
 * eagerly), and on a photograph it was being spent compressing a 25 MB
 * lossless PNG that loses to JPEG by 34x. It now runs only where it could
 * change which candidate wins - see `oxiCompetitive`. */
async function oxiPass(pngBytes, level = 2) {
  if (!CODECS.oxipng) return pngBytes;
  try {
    const out = new Uint8Array(await CODECS.oxipng.optimise(pngBytes.buffer, { level }));
    if (out.length >= pngBytes.length) return pngBytes;
    // Carry the reconstruction helpers across: oxipng is lossless, so the
    // decoded pixels - and therefore every score already measured - are
    // unchanged. Only the byte count moves.
    if (pngBytes._rgba) out._rgba = pngBytes._rgba;
    if (pngBytes._exact) out._exact = pngBytes._exact;
    return out;
  } catch {
    return pngBytes;
  }
}

/* The most oxipng has ever plausibly taken off a canvas-written PNG is well
   under 30%. If a candidate is still larger than the best after granting it a
   30% discount it cannot win, so compressing it would only cost time. */
const OXI_BEST_CASE = 0.7;

/* ------------------------------------------------------------------------- *
 * GIF frame counter — a real block walker, not a heuristic. Needed because
 * animated GIFs pass through untouched (core.py does the same via Pillow).
 * ------------------------------------------------------------------------- */

function gifFrameCount(bytes) {
  const b = new Uint8Array(bytes);
  if (b.length < 13 || b[0] !== 0x47 || b[1] !== 0x49 || b[2] !== 0x46) return 0;
  let p = 6;
  const flags = b[p + 4];
  p += 7; // logical screen descriptor
  if (flags & 0x80) p += 3 * (1 << ((flags & 0x07) + 1)); // global colour table
  let frames = 0;
  while (p < b.length) {
    const block = b[p++];
    if (block === 0x3b) break; // trailer
    if (block === 0x21) { // extension: label + sub-blocks
      p++;
      while (p < b.length && b[p] !== 0) p += b[p] + 1;
      p++;
    } else if (block === 0x2c) { // image descriptor
      frames++;
      if (frames > 1) return frames; // all we need to know
      const localFlags = b[p + 8];
      p += 9;
      if (localFlags & 0x80) p += 3 * (1 << ((localFlags & 0x07) + 1));
      p++; // LZW minimum code size
      while (p < b.length && b[p] !== 0) p += b[p] + 1;
      p++;
    } else {
      break; // corrupt; let the decoder report it
    }
  }
  return frames;
}

/* ------------------------------------------------------------------------- *
 * CRC32 + PNG writer (colour type 3) + zlib via CompressionStream
 * ------------------------------------------------------------------------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes, start = 0, end = bytes.length, seed = 0xffffffff) {
  let c = seed;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return c;
}

function crc32Final(bytes) {
  return (crc32(bytes) ^ 0xffffffff) >>> 0;
}

async function zlibDeflate(raw) {
  // CompressionStream("deflate") emits the zlib wrapper PNG's IDAT wants.
  const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function pngChunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32Final(out.subarray(4, 8 + data.length)));
  return out;
}

/** Indexed pixels + RGBA palette -> a complete palette PNG. */
async function writeIndexedPng(indices, width, height, palette) {
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 3;  // colour type: palette
  // compression, filter, interlace all 0

  const plte = new Uint8Array(palette.length * 3);
  let hasAlpha = false;
  for (let i = 0; i < palette.length; i++) {
    plte[i * 3] = palette[i][0];
    plte[i * 3 + 1] = palette[i][1];
    plte[i * 3 + 2] = palette[i][2];
    if (palette[i][3] < 255) hasAlpha = true;
  }

  let trns = null;
  if (hasAlpha) {
    // Truncate trailing fully-opaque entries — the spec allows it and it
    // saves a few bytes.
    let last = palette.length - 1;
    while (last >= 0 && palette[last][3] === 255) last--;
    trns = new Uint8Array(last + 1);
    for (let i = 0; i <= last; i++) trns[i] = palette[i][3];
  }

  // Scanlines with filter byte 0 — the standard choice for palette images.
  const raw = new Uint8Array(height * (width + 1));
  for (let y = 0; y < height; y++) {
    raw.set(indices.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  }
  const idat = await zlibDeflate(raw);

  const parts = [sig, pngChunk("IHDR", ihdr), pngChunk("PLTE", plte)];
  if (trns && trns.length) parts.push(pngChunk("tRNS", trns));
  parts.push(pngChunk("IDAT", idat), pngChunk("IEND", new Uint8Array(0)));

  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/* ------------------------------------------------------------------------- *
 * palette quantizer — median cut in RGBA with Floyd–Steinberg dithering.
 * The browser stand-in for libimagequant. Exact palettes are detected and
 * bypass quantization entirely, which makes png8 lossless on flat artwork.
 * ------------------------------------------------------------------------- */

function exactPalette(rgba, maxColors) {
  const seen = new Map();
  const palette = [];
  const n = rgba.length >> 2;
  const indices = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    // Normalise fully transparent pixels: their RGB is arbitrary junk.
    const a = rgba[o + 3];
    const key = a === 0 ? -1 : ((rgba[o] << 24) | (rgba[o + 1] << 16) | (rgba[o + 2] << 8) | a);
    let idx = seen.get(key);
    if (idx === undefined) {
      if (palette.length >= maxColors) return null;
      idx = palette.length;
      seen.set(key, idx);
      palette.push(a === 0 ? [0, 0, 0, 0] : [rgba[o], rgba[o + 1], rgba[o + 2], a]);
    }
    indices[i] = idx;
  }
  return { indices, palette, exact: true };
}

/** Median cut over a sampled pixel set.
 *
 *  Boxes carry their own precomputed range and are kept in a flat sample
 *  array, so each split touches only the box being split rather than
 *  re-scanning every pixel in every box. The naive version was
 *  O(boxes x pixels) and took tens of seconds on a noisy megapixel photo. */
function medianCutPalette(rgba, maxColors) {
  const n = rgba.length >> 2;
  // Sample at most ~60k pixels for box statistics; mapping still sees all.
  const stride = Math.max(1, Math.floor(n / 60_000));
  const count = Math.ceil(n / stride);
  const samples = new Uint8Array(count * 4);
  for (let i = 0, s = 0; s < count; i += stride, s++) {
    samples.set(rgba.subarray(i * 4, i * 4 + 4), s * 4);
  }

  const rangeOf = (lo, hi) => {           // [widestChannel, width]
    const min = [255, 255, 255, 255], max = [0, 0, 0, 0];
    for (let i = lo; i < hi; i++) {
      for (let c = 0; c < 4; c++) {
        const v = samples[i * 4 + c];
        if (v < min[c]) min[c] = v;
        if (v > max[c]) max[c] = v;
      }
    }
    let ch = 0, width = -1;
    for (let c = 0; c < 4; c++) {
      // Alpha errors are the most visible, luma next; weight the search.
      const w = (max[c] - min[c]) * (c === 3 ? 2 : 1);
      if (w > width) { width = w; ch = c; }
    }
    return [ch, width];
  };

  const boxes = [];
  const [ch0, w0] = rangeOf(0, count);
  boxes.push({ lo: 0, hi: count, ch: ch0, width: w0 });

  while (boxes.length < maxColors) {
    let bi = -1, best = 0;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (b.hi - b.lo < 2 || b.width <= 0) continue;
      if (b.width > best) { best = b.width; bi = i; }
    }
    if (bi < 0) break;

    const box = boxes[bi];
    // Sort just this box's slice on its widest channel.
    const slice = [];
    for (let i = box.lo; i < box.hi; i++) {
      const o = i * 4;
      slice.push([samples[o], samples[o + 1], samples[o + 2], samples[o + 3]]);
    }
    slice.sort((a, b) => a[box.ch] - b[box.ch]);
    for (let i = 0; i < slice.length; i++) samples.set(slice[i], (box.lo + i) * 4);

    const mid = box.lo + (slice.length >> 1);
    const [chA, wA] = rangeOf(box.lo, mid);
    const [chB, wB] = rangeOf(mid, box.hi);
    boxes.splice(bi, 1,
      { lo: box.lo, hi: mid, ch: chA, width: wA },
      { lo: mid, hi: box.hi, ch: chB, width: wB });
  }

  const palette = boxes.filter((b) => b.hi > b.lo).map((b) => {
    let r = 0, g = 0, bl = 0, a = 0;
    for (let i = b.lo; i < b.hi; i++) {
      const o = i * 4;
      r += samples[o]; g += samples[o + 1]; bl += samples[o + 2]; a += samples[o + 3];
    }
    const k = b.hi - b.lo;
    return [Math.round(r / k), Math.round(g / k), Math.round(bl / k), Math.round(a / k)];
  });

  /* Lloyd refinement: reassign the samples to their nearest palette entry and
     move each entry to its cluster's mean, twice. Median cut alone picks the
     boxes; this settles the colours inside them, which is a large part of
     what puts libimagequant ahead of naive median cut. Two iterations recover
     most of that gap at a fraction of the search cost. */
  for (let iter = 0; iter < 2; iter++) {
    const K = palette.length;
    const sums = new Float64Array(K * 4);
    const counts = new Uint32Array(K);
    const flat = new Int16Array(K * 4);
    for (let i = 0; i < K; i++) {
      flat[i * 4] = palette[i][0]; flat[i * 4 + 1] = palette[i][1];
      flat[i * 4 + 2] = palette[i][2]; flat[i * 4 + 3] = palette[i][3];
    }
    for (let s = 0; s < count; s++) {
      const o = s * 4;
      const r = samples[o], g = samples[o + 1], b = samples[o + 2], a = samples[o + 3];
      let best = 0, bd = Infinity;
      for (let i = 0, q = 0; i < K; i++, q += 4) {
        const dr = r - flat[q], dg = g - flat[q + 1], db = b - flat[q + 2], da = a - flat[q + 3];
        const d = dr * dr + dg * dg + db * db + 2 * da * da;
        if (d < bd) { bd = d; best = i; }
      }
      const bo = best * 4;
      sums[bo] += r; sums[bo + 1] += g; sums[bo + 2] += b; sums[bo + 3] += a;
      counts[best]++;
    }
    for (let i = 0; i < K; i++) {
      if (!counts[i]) continue;      // empty cluster keeps its colour
      const o = i * 4;
      palette[i] = [
        Math.round(sums[o] / counts[i]), Math.round(sums[o + 1] / counts[i]),
        Math.round(sums[o + 2] / counts[i]), Math.round(sums[o + 3] / counts[i]),
      ];
    }
  }
  return palette;
}

/* Reused across calls: a 2MB allocation per quantisation would be pure GC
   pressure, and clearing it is a memset. */
const NEAREST_CACHE = new Int16Array(1 << 20);

function quantize(rgba, width, height, maxColors) {
  const exact = exactPalette(rgba, maxColors);
  if (exact) return exact;

  const palette = medianCutPalette(rgba, maxColors);

  /* Nearest-palette lookups are cached on a 5-bit/channel key. The cache is a
     flat Int16Array rather than a Map: the key space is 2^20, and a Map with a
     million integer entries spends more time hashing and allocating boxed keys
     than the colour search it was meant to avoid. -1 means "not yet computed".
     Palette entries are also flattened, so the inner loop reads one typed array
     instead of chasing a pointer per colour. */
  const CACHE = NEAREST_CACHE; CACHE.fill(-1);
  const pal = new Int16Array(palette.length * 4);
  for (let i = 0; i < palette.length; i++) {
    pal[i * 4] = palette[i][0]; pal[i * 4 + 1] = palette[i][1];
    pal[i * 4 + 2] = palette[i][2]; pal[i * 4 + 3] = palette[i][3];
  }
  const n = palette.length;
  const nearest = (r, g, b, a) => {
    const key = ((r >> 3) << 15) | ((g >> 3) << 10) | ((b >> 3) << 5) | (a >> 3);
    const hit = CACHE[key];
    if (hit !== -1) return hit;
    let best = 0, bd = Infinity;
    for (let i = 0, o = 0; i < n; i++, o += 4) {
      const dr = r - pal[o], dg = g - pal[o + 1], db = b - pal[o + 2], da = a - pal[o + 3];
      const d = dr * dr + dg * dg + db * db + 2 * da * da; // alpha errors weigh double
      if (d < bd) { bd = d; best = i; }
    }
    CACHE[key] = best;
    return best;
  };

  // Floyd–Steinberg, serpentine scan.
  const indices = new Uint8Array(width * height);
  const cur = new Float32Array((width + 2) * 4);
  const nxt = new Float32Array((width + 2) * 4);
  const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

  for (let y = 0; y < height; y++) {
    nxt.fill(0);
    const ltr = (y & 1) === 0;
    for (let step = 0; step < width; step++) {
      const x = ltr ? step : width - 1 - step;
      const o = (y * width + x) * 4;
      const e = (x + 1) * 4;
      const r = clamp(rgba[o] + cur[e]);
      const g = clamp(rgba[o + 1] + cur[e + 1]);
      const b = clamp(rgba[o + 2] + cur[e + 2]);
      const a = clamp(rgba[o + 3] + cur[e + 3]);
      const idx = nearest(r, g, b, a);
      indices[y * width + x] = idx;
      const p = palette[idx];
      const er = r - p[0], eg = g - p[1], eb = b - p[2], ea = a - p[3];
      const ahead = ltr ? 1 : -1;
      const f = (arr, dx, w) => {
        const q = (x + dx + 1) * 4;
        arr[q] += er * w; arr[q + 1] += eg * w; arr[q + 2] += eb * w; arr[q + 3] += ea * w;
      };
      f(cur, ahead, 7 / 16);
      f(nxt, -ahead, 3 / 16);
      f(nxt, 0, 5 / 16);
      f(nxt, ahead, 1 / 16);
    }
    cur.set(nxt);
  }
  return { indices, palette, exact: false };
}

/** Rebuild RGBA from indexed pixels — byte-identical to decoding the PNG. */
function indexedToRgba(indices, palette, width, height) {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < indices.length; i++) {
    const p = palette[indices[i]];
    const o = i * 4;
    out[o] = p[0]; out[o + 1] = p[1]; out[o + 2] = p[2]; out[o + 3] = p[3];
  }
  return out;
}

/* ------------------------------------------------------------------------- *
 * SSIM — port of quality.py. Luma-only, box window 8, aggregated at the 5th
 * percentile so a large flat background cannot hide a damaged subject.
 * ------------------------------------------------------------------------- */

function hasAlphaPixels(rgba) {
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] < 255) return true;
  return false;
}

/** Composite over a backdrop (when alpha) and convert to ITU-R 601-2 luma. */
function toLuma(rgba, n, backdrop) {
  const out = new Float32Array(n);
  if (!backdrop) {
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      out[i] = (rgba[o] * 299 + rgba[o + 1] * 587 + rgba[o + 2] * 114) / 1000;
    }
    return out;
  }
  const [br, bg, bb] = backdrop;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const a = rgba[o + 3] / 255;
    const r = rgba[o] * a + br * (1 - a);
    const g = rgba[o + 1] * a + bg * (1 - a);
    const b = rgba[o + 2] * a + bb * (1 - a);
    out[i] = (r * 299 + g * 587 + b * 114) / 1000;
  }
  return out;
}

/* Reusable scratch buffers. Each worker runs one job at a time, so a single
 * grow-only allocation serves every call without GC churn. */
let INTEGRAL = new Float64Array(0);
const HIST = new Uint32Array(65536);

/** Box mean over win×win windows via an integral image. */
function boxMean(src, W, H, win, product) {
  const iw = W + 1;
  const need = iw * (H + 1);
  if (INTEGRAL.length < need) INTEGRAL = new Float64Array(need);
  const integral = INTEGRAL;
  integral.fill(0, 0, need);
  for (let y = 0; y < H; y++) {
    let rowSum = 0;
    const srow = y * W, irow = (y + 1) * iw;
    for (let x = 0; x < W; x++) {
      rowSum += product ? src[srow + x] * product[srow + x] : src[srow + x];
      integral[irow + x + 1] = integral[irow - iw + x + 1] + rowSum;
    }
  }
  const ow = W - win + 1, oh = H - win + 1;
  const out = new Float32Array(ow * oh);
  const area = win * win;
  for (let y = 0; y < oh; y++) {
    const t = y * iw, b = (y + win) * iw;
    for (let x = 0; x < ow; x++) {
      out[y * ow + x] =
        (integral[b + x + win] - integral[t + x + win] - integral[b + x] + integral[t + x]) / area;
    }
  }
  return out;
}

/** 5th-percentile SSIM between two luma planes (percentile 0 = mean). */
function ssimLuma(a, b, W, H, percentile) {
  let win = WINDOW;
  if (Math.min(W, H) < win) win = Math.max(2, Math.min(W, H));

  const muA = boxMean(a, W, H, win);
  const muB = boxMean(b, W, H, win);
  const mAA = boxMean(a, W, H, win, a);
  const mBB = boxMean(b, W, H, win, b);
  const mAB = boxMean(a, W, H, win, b);

  const n = muA.length;
  const smap = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const ma = muA[i], mb = muB[i];
    const varA = Math.max(mAA[i] - ma * ma, 0);
    const varB = Math.max(mBB[i] - mb * mb, 0);
    const cov = mAB[i] - ma * mb;
    smap[i] = ((2 * ma * mb + C1) * (2 * cov + C2)) /
              ((ma * ma + mb * mb + C1) * (varA + varB + C2));
  }

  if (!percentile || percentile <= 0) {
    let s = 0;
    for (let i = 0; i < n; i++) s += smap[i];
    return s / n;
  }

  // Histogram percentile over [-1, 1]: resolution ~3e-5, O(n), no giant sort.
  const BINS = 65536;
  const hist = HIST;
  hist.fill(0);
  for (let i = 0; i < n; i++) {
    let v = (smap[i] + 1) * 0.5;
    if (v < 0) v = 0; else if (v > 1) v = 1;
    hist[Math.min(BINS - 1, (v * BINS) | 0)]++;
  }
  const want = (percentile / 100) * n;
  let acc = 0;
  for (let i = 0; i < BINS; i++) {
    acc += hist[i];
    if (acc >= want) return (i + 0.5) / BINS * 2 - 1;
  }
  return 1;
}

/** Full SSIM between two RGBA frames, matching quality.ssim(). */
function ssimRgba(refRgba, candRgba, W, H) {
  const n = W * H;
  const alpha = hasAlphaPixels(refRgba) || hasAlphaPixels(candRgba);
  if (!alpha) {
    return ssimLuma(toLuma(refRgba, n), toLuma(candRgba, n), W, H, 5);
  }
  let worst = Infinity;
  for (const backdrop of BACKDROPS) {
    const s = ssimLuma(toLuma(refRgba, n, backdrop), toLuma(candRgba, n, backdrop), W, H, 5);
    if (s < worst) worst = s;
  }
  return worst;
}

/** One colour channel as a plane, composited when alpha is present. */
function toChannel(rgba, n, ch, backdrop) {
  const out = new Float32Array(n);
  if (!backdrop) {
    for (let i = 0; i < n; i++) out[i] = rgba[i * 4 + ch];
    return out;
  }
  const bg = backdrop[ch];
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const a = rgba[o + 3] / 255;
    out[i] = rgba[o + ch] * a + bg * (1 - a);
  }
  return out;
}

/** Strict final check: worst per-channel SSIM p5. Luma SSIM is structurally
 *  blind to chroma damage — the README's own criticism of hand-rolled
 *  compressors — so the encode that actually ships must also survive each
 *  colour channel on its own. Search stays on cheap luma; this runs once per
 *  candidate at the end. */
function ssimRgbaStrict(refRgba, candRgba, W, H) {
  const n = W * H;
  const alpha = hasAlphaPixels(refRgba) || hasAlphaPixels(candRgba);
  const drops = alpha ? BACKDROPS : [null];
  let worst = Infinity;
  for (const backdrop of drops) {
    for (let ch = 0; ch < 3; ch++) {
      const s = ssimLuma(toChannel(refRgba, n, ch, backdrop),
                         toChannel(candRgba, n, ch, backdrop), W, H, 5);
      if (s < worst) worst = s;
    }
  }
  return worst;
}

function cropRgba(rgba, W, box) {
  const [left, top, right, bottom] = box;
  const w = right - left, h = bottom - top;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const src = ((top + y) * W + left) * 4;
    out.set(rgba.subarray(src, src + w * 4), y * w * 4);
  }
  return out;
}

/** Sampled score for the search loop — native-resolution tiles, never a
 *  downscaled copy (quality.py Metric.score_sampled), for any metric. */
function sampledScore(scoreFn, refRgba, candRgba, W, H) {
  if (W * H <= TILE_BUDGET || Math.min(W, H) < TILE) {
    return scoreFn(refRgba, candRgba, W, H);
  }
  const wanted = Math.max(2, Math.floor(TILE_BUDGET / (TILE * TILE)));
  const cols = Math.max(1, Math.min(3, Math.floor(W / TILE), wanted));
  const rows = Math.max(1, Math.min(2, Math.floor(H / TILE),
    Math.max(1, Math.floor(wanted / Math.max(1, cols)))));

  let sum = 0, count = 0;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const left = cols > 1 ? Math.floor((W - TILE) * col / (cols - 1)) : (W - TILE) >> 1;
      const top = rows > 1 ? Math.floor((H - TILE) * row / (rows - 1)) : (H - TILE) >> 1;
      const box = [left, top, left + TILE, top + TILE];
      sum += scoreFn(cropRgba(refRgba, W, box), cropRgba(candRgba, W, box), TILE, TILE);
      count++;
    }
  }
  return sum / count;
}
const ssimSampled = (r, c, W, H) => sampledScore(ssimRgba, r, c, W, H);

/* ------------------------------------------------------------------------- *
 * the metric layer. SSIMULACRA 2 is the default - the metric the desktop app
 * and the image-compression community use, colour-aware by construction.
 * SSIM p5 remains as the explicit fallback.
 * ------------------------------------------------------------------------- */

/** Full-frame SSIMULACRA 2, dual-backdrop for transparency like quality.py. */
function ss2Rgba(refRgba, candRgba, W, H) {
  const alpha = hasAlphaPixels(refRgba) || hasAlphaPixels(candRgba);
  if (!alpha) return ss2Score(refRgba, candRgba, W, H, null);
  let worst = Infinity;
  for (const backdrop of BACKDROPS) {
    const s = ss2Score(refRgba, candRgba, W, H, backdrop);
    if (s < worst) worst = s;
  }
  return worst;
}

/* Full-frame SSIMULACRA 2 above ~2.75MP would need hundreds of megabytes of
 * planes per call; on a 12MP frame the float64 version needed ~1.8GB and the
 * allocations threw, silently killing every lossy candidate. Past the budget,
 * verification runs on a 3x3 spread of native-resolution 512px tiles - denser
 * than the search's sampling, bounded in memory, and still a measurement of
 * the actual pixels rather than a downscale. */
const VERIFY_BUDGET = 2_750_000;

function denseVerify(scoreFn, refRgba, candRgba, W, H) {
  if (W * H <= VERIFY_BUDGET || Math.min(W, H) < TILE) {
    return scoreFn(refRgba, candRgba, W, H);
  }
  const cols = Math.min(3, Math.floor(W / TILE));
  const rows = Math.min(3, Math.floor(H / TILE));
  let sum = 0, count = 0;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const left = cols > 1 ? Math.floor((W - TILE) * col / (cols - 1)) : (W - TILE) >> 1;
      const top = rows > 1 ? Math.floor((H - TILE) * row / (rows - 1)) : (H - TILE) >> 1;
      const box = [left, top, left + TILE, top + TILE];
      sum += scoreFn(cropRgba(refRgba, W, box), cropRgba(candRgba, W, box), TILE, TILE);
      count++;
    }
  }
  return sum / count;
}

function metricFor(name) {
  if (name === "ssim") {
    return { name: "ssim", full: ssimRgba, verify: ssimRgba, perfect: 1.0 };
  }
  return {
    name: "ssimulacra2",
    full: ss2Rgba,
    verify: (r, c, w, h) => denseVerify(ss2Rgba, r, c, w, h),
    perfect: 100.0,
  };
}

/* ------------------------------------------------------------------------- *
 * encoders — each exposes an ascending ladder of levels, like encoders.py
 * ------------------------------------------------------------------------- */

function makeEncoders(job) {
  const { width, height, rgba, refCanvas } = job;
  let flat = null;        // white-flattened copy, drawn once, reused per level
  let exactQ;             // exact palette (or null), computed once per job
  let exactPng = null;    // its encode: identical bytes at every level that fits

  async function canvasEncode(type, quality) {
    const blob = await refCanvas.convertToBlob(
      quality == null ? { type } : { type, quality });
    if (blob.type !== type) throw new Error(`${type} not supported here`);
    return new Uint8Array(await blob.arrayBuffer());
  }

  async function jpegEncode(level) {
    // mozjpeg when it loads: trellis-tuned, always 4:4:4 like the desktop
    // JpegEncoder. jpeg only runs on alpha-free images, so rgba is opaque.
    const moz = await loadMozjpeg();
    if (moz) {
      const buf = await moz.encode({ data: rgba, width, height }, {
        quality: level, auto_subsample: false, chroma_subsample: 1,
      });
      return new Uint8Array(buf);
    }
    // Canvas fallback - flattened once, re-encoded per level.
    if (!flat) {
      flat = new OffscreenCanvas(width, height);
      const ctx = flat.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(refCanvas, 0, 0);
    }
    const blob = await flat.convertToBlob({ type: "image/jpeg", quality: level / 100 });
    return new Uint8Array(await blob.arrayBuffer());
  }

  function exactFor(level) {
    if (exactQ === undefined) exactQ = exactPalette(rgba, 256);
    return exactQ && exactQ.palette.length <= level ? exactQ : null;
  }

  async function encodePng8(level) {
    const hit = exactFor(level);
    if (hit) {
      // Identical pixels at every level the palette fits - encode once.
      if (!exactPng) {
        const data = await timedAsync("pngWrite",
          () => writeIndexedPng(hit.indices, width, height, hit.palette));
        exactPng = Object.assign(data, {
          _rgba: indexedToRgba(hit.indices, hit.palette, width, height),
          _exact: true,
        });
      }
      return exactPng;
    }
    const q = timed("quantize", () => quantize(rgba, width, height, level));
    const data = await timedAsync("pngWrite",
      () => writeIndexedPng(q.indices, width, height, q.palette));
    return Object.assign(data, {
      _rgba: indexedToRgba(q.indices, q.palette, width, height),
      _exact: false,
    });
  }

  const encoders = {
    jpeg: {
      name: "jpeg", ext: ".jpg", mime: "image/jpeg",
      supportsAlpha: false, lossless: false, levels: JPEG_QUALITY,
      encode: (level) => jpegEncode(level),
      /* Which quantisation table wins is content-dependent: on the benchmark's
         real 5MP photograph the default (3, ImageMagick) ships 371 KB where
         Annex K needs ~430 KB, and on the hard synthetic it is the other way
         round - Annex K passes at 461 KB where the default needs 597 KB. So
         neither is guessed at: after the search converges, the alternate table
         competes at the final rung and the smallest verified file ships. */
      alternates: (level) => !CODECS.mozjpeg ? [] : [{
        encode: async () => new Uint8Array(await CODECS.mozjpeg.encode(
          { data: rgba, width, height },
          { quality: level, auto_subsample: false, chroma_subsample: 1, quant_table: 0 })),
      }],
    },
    png8: {
      name: "png8", ext: ".png", mime: "image/png",
      supportsAlpha: true, lossless: false, levels: PNG8_COLORS,
      pngFamily: true,
      available: () => CAN_DEFLATE,
      encode: (level) => encodePng8(level),
    },
    png: {
      name: "png", ext: ".png", mime: "image/png",
      supportsAlpha: true, lossless: true, levels: [100],
      pngFamily: true,
      encode: () => timedAsync("pngWrite", () => canvasEncode("image/png")),
    },
    webp: {
      name: "webp", ext: ".webp", mime: "image/webp",
      supportsAlpha: true, lossless: false, levels: WEBP_QUALITY,
      available: () => CAN_WEBP,
      encode: (level) => canvasEncode("image/webp", level / 100),
    },
    avif: {
      name: "avif", ext: ".avif", mime: "image/avif",
      supportsAlpha: true, lossless: false, levels: AVIF_QUALITY,
      // The only encoder whose output depends on the fast flag, so the only one
      // that has to be encoded twice when the search lands on its top level.
      fastAffects: true,
      available: () => !!CODECS.avif,
      encode: async (level, fast) => {
        const av = await loadAvif();
        if (!av) throw new Error("avif encoder unavailable");
        const buf = await av.encode({ data: rgba, width, height }, {
          quality: level, speed: fast ? 8 : 6, subsample: 1,
        });
        return new Uint8Array(buf);
      },
    },
    // Real lossless WebP (libwebp in wasm) - the candidate that wins on flat
    // artwork, and the one the head-to-head showed the desktop taking whole
    // categories with while the web tier forfeited. Pixel-exact for visible
    // pixels, same as the desktop's Pillow path (invisible RGB under alpha 0
    // may be rewritten; that is libwebp's default and carries no visual bits).
    "webp-lossless": {
      name: "webp-lossless", ext: ".webp", mime: "image/webp",
      supportsAlpha: true, lossless: true, levels: [100],
      available: () => !!CODECS.webp,
      encode: async () => {
        const wp = await loadWebp();
        if (!wp) throw new Error("webp encoder unavailable");
        const buf = await wp.encode({ data: rgba, width, height }, {
          lossless: 1, quality: 100, method: 6,
        });
        return new Uint8Array(buf);
      },
    },
    // Palette PNG admitted to the lossless target only when pixel-exact.
    png8x: {
      name: "png8", ext: ".png", mime: "image/png",
      supportsAlpha: true, lossless: true, levels: [256], exactOnly: true,
      pngFamily: true,
      available: () => CAN_DEFLATE,
      encode: async () => {
        const hit = exactFor(256);
        if (!hit) throw new Error("more than 256 colours");
        return encodePng8(256);
      },
    },
  };
  encoders._hasExact = () => !!exactFor(256);
  return encoders;
}

/** Decode encoded bytes back to RGBA for scoring. png8 results carry their
 *  own reconstruction (byte-identical to decoding, PNG being lossless). */
async function decodeToRgba(data, mime, width, height, scratch) {
  if (data._rgba) return data._rgba;
  const bmp = await createImageBitmap(new Blob([data], { type: mime }));
  scratch.ctx.clearRect(0, 0, width, height);
  scratch.ctx.drawImage(bmp, 0, 0);
  bmp.close();
  return scratch.ctx.getImageData(0, 0, width, height).data;
}

/* ------------------------------------------------------------------------- *
 * the search — a port of core._search_one
 * ------------------------------------------------------------------------- */

async function searchOne(job, encoder, target, report) {
  const { width, height, rgba, metric } = job;
  const levels = encoder.levels;

  /* Encodes are memoised per (level, effort). Only AVIF's output depends on the
     effort flag, so for every other encoder the "re-encode the winner at full
     effort" step is a cache hit rather than a second pass over the pixels -
     which on a 12MP photograph was a whole redundant mozjpeg encode. */
  const memo = new Map();
  const encodeAt = (index, fast) => {
    const key = encoder.fastAffects ? `${index}|${fast ? 1 : 0}` : `${index}`;
    let hit = memo.get(key);
    if (!hit) {
      hit = timedAsync("encode", () =>
        timedAsync(`enc:${encoder.name}`, () => encoder.encode(levels[index], fast)));
      memo.set(key, hit);
    }
    return hit;
  };

  if (encoder.lossless || levels.length === 1) {
    report(1);
    if (PERF) PERF.encodes++;
    const data = await encodeAt(levels.length - 1, false);
    return { data, level: null, score: metric.perfect, index: levels.length - 1, encoder };
  }

  let probes = 0;
  const probe = async (index) => {
    report(++probes);
    if (PERF) PERF.probes++;
    const data = await encodeAt(index, true);
    if (data._exact) return { data, score: metric.perfect }; // pixel-identical by construction
    const cand = await timedAsync("back", () => decodeToRgba(data, encoder.mime, width, height, job.scratch));
    return { data, score: timed("ssimTiled", () => sampledScore(metric.full, rgba, cand, width, height)) };
  };

  /* Verification on the level the search landed on: full-frame within the
     memory budget, a dense native-resolution tile grid beyond it. */
  const finalScore = async (data) => {
    if (data._exact) return { score: metric.perfect };
    const cand = await timedAsync("back", () => decodeToRgba(data, encoder.mime, width, height, job.scratch));
    return { score: timed("ssimFull", () => metric.verify(rgba, cand, width, height)) };
  };

  /* Straight bisection over the whole ladder. The old version probed the top
     rung first to find out whether the format could pass at all, then bisected
     underneath it - but score rises monotonically with quality, so a rung that
     passes already proves every rung above it would. That first probe bought
     nothing in the common case and cost a full encode of the image; on a
     4.9MP photograph that is seconds. Five probes become four. */
  const top = levels.length - 1;
  let chosen = top;                       // best effort if nothing clears
  let lo = 0, hi = top;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const p = await probe(mid);
    if (p.score >= target) { chosen = mid; hi = mid - 1; }
    else lo = mid + 1;
  }

  // The winner is re-encoded at full effort; for every encoder but AVIF that is
  // a memo hit rather than a second pass over the pixels.
  if (PERF) PERF.encodes++;
  let data = await encodeAt(chosen, false);
  let { score } = await finalScore(data);

  // The sampled search can be marginally optimistic. If the honest full-frame
  // check misses, step up until it clears rather than shipping something that
  // fails the promise we just made.
  while (score < target && chosen < top) {
    report(++probes);
    chosen++;
    data = await encodeAt(chosen, false);
    ({ score } = await finalScore(data));
  }

  /* Alternate encodes compete at the finish line: the chosen rung and the one
     below it, verified with the same honest scorer, smallest passing wins.
     Bounded work - at most two extra encodes - and an alternate that is not
     smaller is discarded without even paying for its verification. Only a
     passing result is worth improving; a best-effort failure is left alone. */
  if (encoder.alternates && score >= target) {
    for (const idx of [chosen, chosen - 1]) {
      if (idx < 0) continue;
      for (const alt of encoder.alternates(levels[idx])) {
        report(++probes);
        if (PERF) PERF.encodes++;
        const altData = await timedAsync("encode",
          () => timedAsync(`enc:${encoder.name}`, alt.encode));
        if (altData.length >= data.length) continue;   // only smaller can win
        const { score: altScore } = await finalScore(altData);
        if (altScore >= target) { data = altData; score = altScore; chosen = idx; }
      }
    }
  }

  // encodeAt/finalScore travel with the result so the winner can be escalated
  // later if the chroma check rejects it, without re-running the search.
  return { data, level: levels[chosen], score, index: chosen, top, encodeAt, finalScore };
}

/* ------------------------------------------------------------------------- *
 * normalisation — decode, EXIF-rotate, cap dimensions, strip metadata
 * (the canvas round-trip strips EXIF/ICC/XMP by construction)
 * ------------------------------------------------------------------------- */

async function decodeNormalised(blob, settings) {
  let bmp;
  try {
    bmp = await createImageBitmap(blob, { imageOrientation: "from-image" });
  } catch {
    bmp = await createImageBitmap(blob); // older engines: no orientation opt
  }
  const w0 = bmp.width, h0 = bmp.height;

  let limit = settings.maxDimension || 0;
  if (settings.target === "figma") {
    limit = limit ? Math.min(limit, FIGMA_MAX_DIMENSION) : FIGMA_MAX_DIMENSION;
  }

  let W = w0, H = h0;
  if (limit && Math.max(w0, h0) > limit) {
    const scale = limit / Math.max(w0, h0);
    W = Math.max(1, Math.round(w0 * scale));
    H = Math.max(1, Math.round(h0 * scale));
  }

  // Stepped halving approximates a proper windowed filter far better than a
  // single bilinear pass when the reduction is large.
  let cur = bmp;
  while (cur.width >= W * 2 && cur.height >= H * 2) {
    const half = new OffscreenCanvas(Math.max(W, cur.width >> 1), Math.max(H, cur.height >> 1));
    const hctx = half.getContext("2d");
    hctx.imageSmoothingEnabled = true;
    hctx.imageSmoothingQuality = "high";
    hctx.drawImage(cur, 0, 0, half.width, half.height);
    if (cur !== bmp) cur.close?.();
    cur = await createImageBitmap(half);
  }

  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(cur, 0, 0, W, H);
  if (cur !== bmp) cur.close?.();
  bmp.close();

  const rgba = ctx.getImageData(0, 0, W, H).data;
  return {
    width: W, height: H, originalW: w0, originalH: h0,
    resized: W !== w0 || H !== h0,
    rgba, refCanvas: canvas,
  };
}

/* ------------------------------------------------------------------------- *
 * job runner — a port of core.compress()
 * ------------------------------------------------------------------------- */

const EXT_OF = { jpeg: ".jpg", png8: ".png", png: ".png", webp: ".webp" };

/* One-slot decode cache. When only the quality floor changes, re-running an
 * item skips the read-decode-resize phase entirely - which is what makes
 * playing with the slider feel instant. The UI routes an item back to the
 * worker that last handled it, so one slot per worker is enough. */
let DCACHE = null;

function limitFor(settings) {
  let limit = settings.maxDimension || 0;
  if (settings.target === "figma") {
    limit = limit ? Math.min(limit, FIGMA_MAX_DIMENSION) : FIGMA_MAX_DIMENSION;
  }
  return limit;
}

function sameContainer(ext, name) {
  const src = (name.match(/\.[a-z0-9]+$/i) || [""])[0].toLowerCase();
  if (ext === ".jpg") return src === ".jpg" || src === ".jpeg";
  return src === ext;
}

async function runJob(msg) {
  const { id, name, buffer, mime, settings } = msg;
  const originalBytes = buffer.byteLength;
  const post = (extra, transfer) => postMessage({ id, rev: msg.rev, ...extra }, transfer || []);
  const warnings = [];
  const metric = metricFor(settings.metric);   // ss2 unless the caller opts out

  // Animated GIFs pass through untouched, like the desktop version.
  if (/image\/gif/i.test(mime) || /\.gif$/i.test(name)) {
    if (gifFrameCount(buffer) > 1) {
      post({
        type: "done",
        result: {
          passthrough: true, skipped: true,
          note: "animated — passed through unchanged",
          fmt: "gif", ext: ".gif", mime: "image/gif",
          bytes: buffer, originalBytes, newBytes: originalBytes,
          level: null, score: null, metric: metric.name,
          candidates: [], warnings: [],
        },
      }, [buffer]);
      return;
    }
  }

  post({ type: "progress", stage: "decoding", frac: 0 });
  perfReset();

  const cacheKey = `${id}|${limitFor(settings)}`;
  let job;
  if (DCACHE && DCACHE.key === cacheKey) {
    job = DCACHE.job;
  } else {
    try {
      job = await timedAsync("decode", () => decodeNormalised(new Blob([buffer], { type: mime }), settings));
    } catch {
      post({
        type: "failed",
        error: "could not decode — the file is corrupt or this browser cannot read it",
      });
      return;
    }
    job.scratch = (() => {
      const c = new OffscreenCanvas(job.width, job.height);
      return { canvas: c, ctx: c.getContext("2d", { willReadFrequently: true }) };
    })();
    DCACHE = { key: cacheKey, job };
  }

  const alpha = hasAlphaPixels(job.rgba);
  const target = settings.qualityTarget;
  job.metric = metric;
  await probeWebp();

  const encoders = makeEncoders(job);
  let names = settings.formats && settings.formats.length
    ? settings.formats
    : TARGETS[settings.target] || TARGETS.figma;
  // Codecs load lazily, but availability gating needs them resolved first.
  // The first job of a session pays for the download; say so out loud.
  onCodecStatus = (codec) => post({ type: "progress", stage: "codec", detail: codec, frac: 0 });
  if (names.includes("avif")) await loadAvif();
  if (names.includes("jpeg")) await loadMozjpeg();
  if (names.includes("webp-lossless")) await loadWebp();
  if (names.includes("png") || names.includes("png8") || names.includes("png8x")) await loadOxipng();
  onCodecStatus = null;
  names = names.filter((n) => {
    const e = encoders[n];
    if (!e) return false;
    if (alpha && !e.supportsAlpha) return false;
    if (e.available && !e.available()) return false;
    return true;
  });

  if (!names.length) {
    post({ type: "failed", error: "no candidate format can carry this image in this browser" });
    return;
  }

  let done = 0;
  const candidates = [];
  let bestPassing = null;  // smallest candidate that clears the floor
  let bestFailing = null;  // otherwise: highest score, smaller file breaks ties
  const passing = [];      // every candidate that cleared it, for the post-passes

  for (const nameKey of names) {
    const encoder = encoders[nameKey];
    // ~log2(ladder) probes plus the final verify; close enough for a live bar.
    const expected = Math.ceil(Math.log2(encoder.levels.length || 2)) + 3;
    const report = (probes = 0) => post({
      type: "progress", stage: "encoding", detail: `${encoder.name}`,
      done, total: names.length,
      frac: (done + Math.min(probes / expected, 0.95)) / names.length,
    });
    try {
      // png8x only exists where it is pixel-exact; skip silently elsewhere.
      if (encoder.exactOnly && !encoders._hasExact()) { done++; continue; }
      const found = await searchOne(job, encoder, target, report);
      const { data, level, score } = found;
      candidates.push({ format: encoder.name, bytes: data.length, score, lossless: !!(encoder.lossless || data._exact) });
      const entry = { ...found, encoder };
      if (score >= target) {
        passing.push(entry);
        if (!bestPassing || data.length < bestPassing.data.length) bestPassing = entry;
      } else if (!bestFailing || score > bestFailing.score ||
                 (score === bestFailing.score && data.length < bestFailing.data.length)) {
        bestFailing = entry;
      }
    } catch (exc) {
      warnings.push(`${encoder.name} failed: ${exc && exc.message ? exc.message : exc}`);
    }
    done++;
  }

  /* ---- chroma verification, on the winner only ------------------------- *
   * Luma SSIM is structurally blind to chroma damage, so the encode that
   * actually ships is checked per colour channel. Channels get twice the
   * luma's distortion allowance: eyes tolerate chroma error far better than
   * luma error, which is the whole reason 4:2:0 exists, so this catches
   * catastrophic damage without outlawing ordinary JPEG.
   *
   * Running it on every candidate cost three to six extra full-frame passes
   * each. Only one candidate ships, so only that one is checked - and if it
   * fails, it is escalated or dropped and the next best is checked instead.
   * Bounded by the number of candidates. */
  /* SSIMULACRA 2 works in XYB and weighs chroma natively - the guard would be
     redundant there, and the reference implementation has no such extra pass.
     Under the SSIM fallback the guard stays, because luma-p5 cannot see
     chroma at all. */
  const chromaFloor = 1 - 2 * (1 - target);
  const chromaOk = async (entry) => {
    if (metric.name !== "ssim") return true;
    if (entry.data._exact || entry.encoder.lossless) return true;
    const cand = await timedAsync("back",
      () => decodeToRgba(entry.data, entry.encoder.mime, job.width, job.height, job.scratch));
    return timed("ssimChroma",
      () => ssimRgbaStrict(job.rgba, cand, job.width, job.height)) >= chromaFloor;
  };

  /* The gate applies only when something actually cleared the floor. If nothing
     did we are already shipping a best-effort result with a warning, and
     refusing it over chroma would turn a usable file into a failed one. */
  const rejected = new Set();
  let best = bestPassing;
  while (best && !(await chromaOk(best))) {
    // Step this candidate up its ladder until the channels clear, then let it
    // compete again at its new size.
    let escalated = false;
    while (best.index < best.top) {
      best.index++;
      best.data = await best.encodeAt(best.index, false);
      ({ score: best.score } = await best.finalScore(best.data));
      if (best.score >= target && await chromaOk(best)) { escalated = true; break; }
    }
    const row = candidates.find((c) => c.format === best.encoder.name);
    if (escalated) {
      if (row) { row.bytes = best.data.length; row.score = best.score; }
    } else {
      warnings.push(`${best.encoder.name} could not clear the colour check at any setting`);
      rejected.add(best.encoder.name);
      if (row) row.rejected = true;
    }
    // Re-pick the smallest survivor, or fall back to the best failing one.
    const live = passing.filter((p) => !rejected.has(p.encoder.name) && p.score >= target);
    best = live.length ? live.reduce((a, b) => (b.data.length < a.data.length ? b : a)) : null;
  }
  if (!best) best = bestFailing;   // nothing cleared the floor; warned about below

  if (!best) {
    post({ type: "failed", error: "no candidate produced usable output", warnings, engines: engineFlags() });
    return;
  }

  /* ---- lossless post-compression, only where it can change the outcome -- *
   * oxipng was 37% of all worker CPU when every PNG got it eagerly, and most
   * of that was spent shrinking a lossless PNG of a photograph that loses to
   * JPEG many times over. A candidate granted a 30% discount and still larger
   * than the best cannot win, so it is left alone. Compressing losslessly
   * cannot move any score, so nothing measured changes here. */
  if (CODECS.oxipng) {
    const sizeOf = (c) => c.data.length;
    let bestSize = sizeOf(best);
    const pngCandidates = passing.filter((p) => p.encoder.pngFamily && !rejected.has(p.encoder.name));
    for (const cand of pngCandidates) {
      if (sizeOf(cand) * OXI_BEST_CASE > bestSize) continue;   // cannot win
      const before = sizeOf(cand);
      cand.data = await timedAsync("oxipng", () => oxiPass(cand.data));
      const row = candidates.find((c) => c.format === cand.encoder.name);
      if (row) row.bytes = cand.data.length;
      if (cand.data.length < bestSize) { best = cand; bestSize = cand.data.length; }
      else if (cand === best) bestSize = Math.min(bestSize, cand.data.length);
      if (PERF && before === cand.data.length) PERF.oxiNoGain = (PERF.oxiNoGain || 0) + 1;
    }
    // One deeper pass on the file that actually ships. Lossless, winner-only,
    // so it costs one compression and cannot move any score.
    if (best.encoder.pngFamily) {
      best.data = await timedAsync("oxipng", () => oxiPass(best.data, 4));
      const row = candidates.find((c) => c.format === best.encoder.name);
      if (row) row.bytes = best.data.length;
    }
  }

  if (best.score < target) {
    warnings.push(`could not reach ${metric.name} ${target}; best was ${
      best.score.toFixed(metric.name === "ssim" ? 4 : 1)}`);
  }

  // Never ship a bigger file. (Stricter than the desktop rule: any regrowth
  // without a resize passes the original through, whatever the container.)
  if (best.data.length >= originalBytes && !job.resized) {
    post({
      type: "done",
      result: {
        passthrough: true, skipped: true,
        note: "already well compressed — passed through unchanged",
        fmt: best.encoder.name, ext: null, mime,
        bytes: buffer, originalBytes, newBytes: originalBytes,
        level: null, score: null, metric: metric.name,
        width: job.originalW, height: job.originalH,
        outW: job.originalW, outH: job.originalH,
        candidates, warnings,
      },
    }, [buffer]);
    return;
  }

  const payload = best.data._rgba ? new Uint8Array(best.data) : best.data; // detach helpers
  const isLossless = !!(best.encoder.lossless || best.data._exact);
  post({
    type: "done",
    engines: engineFlags(),
    perf: PERF,
    result: {
      passthrough: false, skipped: false, note: "",
      fmt: best.encoder.name, ext: best.encoder.ext, mime: best.encoder.mime,
      bytes: payload.buffer, originalBytes, newBytes: payload.length,
      level: isLossless ? null : best.level,
      score: isLossless ? null : best.score,
      lossless: isLossless, metric: metric.name,
      width: job.originalW, height: job.originalH,
      outW: job.width, outH: job.height,
      candidates, warnings,
    },
  }, [payload.buffer]);
}

function engineFlags() {
  return {
    webp: !!CAN_WEBP, png8: CAN_DEFLATE,
    mozjpeg: !!CODECS.mozjpeg, oxipng: !!CODECS.oxipng, avif: !!CODECS.avif,
    webpLossless: !!CODECS.webp,
  };
}

onmessage = (e) => {
  const msg = e.data;
  if (msg.type === "job") {
    runJob(msg).catch((exc) => {
      postMessage({ id: msg.id, rev: msg.rev, type: "failed", error: String(exc && exc.message || exc) });
    });
  } else if (msg.type === "probe") {
    probeWebp().then(() => {
      postMessage({ type: "caps", caps: { webp: !!CAN_WEBP, png8: CAN_DEFLATE } });
    });
  }
};
