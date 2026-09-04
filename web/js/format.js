/* Pure formatting. No DOM, no state, no imports - every function here takes a
 * value and returns a string, which is what makes them safe to call from any
 * other module and testable without a browser.
 *
 * NUMBERS FOLLOW THE READER, WORDS DO NOT. Most of the world writes 1,5 MB
 * where this file used to hard-code 1.5 MB, and a decimal point in the wrong
 * place is not a cosmetic detail on a page whose entire argument is a
 * measured number - "90,5" read as "905" is a different claim. So every
 * figure goes through Intl with the browser's own locale, which costs nothing
 * and needs no translator.
 *
 * The COPY is still English. That is a real limit and it is deliberate rather
 * than forgotten: this product's constraint is five-year-old-readable literal
 * prose, and hitting that register in another language is work for a person
 * who speaks it, not for a machine translation that would be technically
 * correct and violate the one rule the writing exists to keep. Formatting is
 * the half that can be done right today, so it is.
 */

/** The reader's own locale, resolved once.
 *
 *  `undefined` is what Intl wants for "use the browser's preference", and it
 *  is deliberately not pinned to a constant: a person who has set their
 *  machine to German has already told us how they write a number, and asking
 *  them again in an app with zero required decisions would be a decision. */
const LOCALE = undefined;

/* Built once each. Constructing an Intl formatter is the expensive part; the
 * queue formats several numbers per row per frame, so these are hoisted out
 * of the call. */
const WHOLE = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 });
const ONE_DP = new Intl.NumberFormat(LOCALE, {
  minimumFractionDigits: 1, maximumFractionDigits: 1,
});

/** Bytes as a person writes them, in their own notation. Whole numbers below
 *  1 KB, one decimal above: "1.4 MB" is a size, "1.4 B" is noise - and it is
 *  "1,4 MB" for the majority of the world that writes it that way. */
export function human(n) {
  if (n == null || !isFinite(n)) return "—";
  const u = ["B", "KB", "MB", "GB"];
  let v = n, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${i === 0 ? WHOLE.format(v) : ONE_DP.format(v)} ${u[i]}`;
}

/** Elapsed time at a precision a person can use. Sub-second work is reported in
 *  milliseconds because "0.1 s" reads as a rounding artefact, and anything past
 *  a minute gets minutes because "83.4 s" does not. */
export function duration(ms) {
  if (ms == null || !isFinite(ms)) return "—";
  if (ms < 950) return `${WHOLE.format(Math.max(1, Math.round(ms)))} ms`;
  if (ms < 60000) {
    const s = ms / 1000;
    return `${(ms < 9950 ? ONE_DP : WHOLE).format(s)} s`;
  }
  const m = Math.floor(ms / 60000);
  return `${WHOLE.format(m)}m ${WHOLE.format(Math.round((ms - m * 60000) / 1000))}s`;
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

/** The MIME types intake may admit when the extension check fails (a paste, a
 *  drag from a file manager that renames). Deliberately the same set as
 *  SUPPORTED and never a bare `image/` prefix - that prefix admitted
 *  image/svg+xml, which the engine cannot process and the extension list
 *  deliberately excludes. */
export const SUPPORTED_MIME = new Set(Object.values(MIME_OF));

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
  // The single most load-bearing number in the product, so it is written the
  // way the reader writes one: "90,5" is what most of the world means by 90.5,
  // and reading it as 905 would misstate the whole claim.
  return ONE_DP.format(score);
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
  // The sign is written here rather than by Intl on purpose: this uses a
  // true minus sign (U+2212), which lines up with the digits in a tabular
  // column where the hyphen a formatter emits would not.
  return `${pct > 0 ? "+" : "−"}${WHOLE.format(Math.abs(pct))}%`;
}
