/* Pure formatting. No DOM, no state, no imports - every function here takes a
 * value and returns a string, which is what makes them safe to call from any
 * other module and testable without a browser.
 */

/** Bytes as a person writes them. Whole numbers below 1 KB, one decimal above:
 *  "1.4 MB" is a size, "1.4 B" is noise. */
export function human(n) {
  if (n == null || !isFinite(n)) return "—";
  const u = ["B", "KB", "MB", "GB"];
  let v = n, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${i === 0 ? v.toFixed(0) : v.toFixed(1)} ${u[i]}`;
}

/** Elapsed time at a precision a person can use. Sub-second work is reported in
 *  milliseconds because "0.1 s" reads as a rounding artefact, and anything past
 *  a minute gets minutes because "83.4 s" does not. */
export function duration(ms) {
  if (ms == null || !isFinite(ms)) return "—";
  if (ms < 950) return `${Math.max(1, Math.round(ms))} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(ms < 9950 ? 1 : 0)} s`;
  const m = Math.floor(ms / 60000);
  return `${m}m ${Math.round((ms - m * 60000) / 1000)}s`;
}

/** Format names as a person writes them. The engine's keys are lowercase
 *  identifiers; showing those raw made the interface read like debug output. */
const FORMAT_LABEL = {
  jpeg: "JPEG", png8: "PNG-8", png8x: "PNG-8 exact", png: "PNG",
  webp: "WebP", "webp-lossless": "WebP lossless", avif: "AVIF", gif: "GIF",
  // Not an encoder: the choice to keep the file exactly as it arrived, which is a
  // real candidate and the one the "Original" chip stands for. Underscored so it
  // cannot collide with an encoder key - see ORIGINAL_PICK in state.js.
  __original: "Original",
};
export const fmtLabel = (f) => FORMAT_LABEL[f] || (f ? f.toUpperCase() : "");

/** The words the format control offers, which are phrased as instructions
 *  ("always JPEG") rather than as names. The technical residue carries its
 *  meaning in place: "every pixel kept" is what lossless means, said plainly. */
export const FORMAT_CHOICE_LABEL = {
  jpeg: "JPEG", webp: "WebP", "webp-lossless": "WebP — every pixel kept",
  png: "PNG — every pixel kept", png8: "PNG — fewer colors",
  png8x: "PNG — fewer colors, every pixel kept", avif: "AVIF",
};

/** Which formats can honour "identical — every pixel kept". Everything else is
 *  disabled while that promise is selected, because a control that offers what
 *  the promise forbids is a control that lies. */
export const LOSSLESS_CAPABLE = new Set(["png", "webp-lossless", "png8x"]);

const MIME_OF = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
  bmp: "image/bmp", gif: "image/gif", tif: "image/tiff", tiff: "image/tiff",
  avif: "image/avif",
};

/** What a file actually is. Trusts the browser's own type first and falls back
 *  to the extension, because a drag from some file managers arrives typeless. */
export function mimeFor(file) {
  if (file.type) return file.type;
  const ext = (file.name.match(/\.([a-z0-9]+)$/i) || [, ""])[1].toLowerCase();
  return MIME_OF[ext] || "application/octet-stream";
}

export const SUPPORTED = /\.(png|jpe?g|webp|bmp|tiff?|gif|avif)$/i;

/** "200 KB", "1.5 MB", "204800" -> bytes. Returns 0 for anything unreadable, so
 *  a half-typed field falls back to the ordinary search rather than capping at
 *  some number nobody asked for. Mirrors cli.parse_size. */
const SIZE_UNITS = { b: 1, k: 1024, kb: 1024, m: 1024 ** 2, mb: 1024 ** 2 };
export function parseSize(text) {
  const cleaned = String(text).trim().toLowerCase().replace(/[\s,]/g, "");
  const m = cleaned.match(/^([0-9]*\.?[0-9]+)(b|kb|k|mb|m)?$/);
  if (!m) return 0;
  const value = parseFloat(m[1]) * (SIZE_UNITS[m[2] || "b"] || 1);
  return value > 0 ? Math.round(value) : 0;
}

/** Split a filename into the part a person named and the part the format owns. */
export function splitName(name) {
  const m = /^(.*?)(\.[a-z0-9]+)?$/i.exec(name) || [];
  return { base: m[1] || name, ext: m[2] || "" };
}

/** The visual-match number, in words as well as digits. Lossless work has no
 *  score to report - it is identical, not merely close - and saying "100" there
 *  would claim a measurement that never ran. */
export function scoreText(score, lossless) {
  if (lossless) return "identical";
  if (score == null || !isFinite(score)) return "—";
  return score.toFixed(1);
}

/** The words for a quality floor, for a value that arrived from somewhere other
 *  than a click - a saved setting, a destination, or a per-image override. Each
 *  rung reads strictly weaker than the one above it; the old words had 85 and 80
 *  sounding like each other's opposites. */
export function wordsForQuality(q) {
  if (q >= 95) return "perfect, even for re-editing";
  if (q >= 90) return "exactly the same to your eye";
  if (q >= 85) return "the same unless you zoom in and compare";
  if (q >= 80) return "the same at a glance";
  if (q >= 70) return "clean when shown small";
  return "visibly compressed";
}

/** A signed percentage, where the sign is the message. Used on the chips, where
 *  a version bigger than the kept one has to read as bigger. */
export function signedPct(from, to) {
  if (!from || to == null) return "";
  const pct = ((to - from) / from) * 100;
  if (Math.abs(pct) < 0.05) return "same size";
  return `${pct > 0 ? "+" : "−"}${Math.abs(pct).toFixed(0)}%`;
}
