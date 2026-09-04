/* The plan: the controls, and their agreement with the stored settings.
 *
 * This module reads and writes the plan's fields and nothing else. It never
 * dispatches work and never re-queues anything - main.js owns that, because
 * "the settings changed" and "therefore redo everything" are two decisions and
 * only one of them belongs to a form.
 *
 * Two rules hold throughout:
 *
 *   The words are the control. A person picks "indistinguishable"; the 0-100
 *   floor the engine runs on is derived from that and lives in a hidden input.
 *   It is a fact about the machine, not a question for anyone.
 *
 *   Nothing about a destination is written here. Its label, frame size, quality
 *   floor and permitted formats all come from destinations.js, generated from
 *   pocketsize/destinations.py.
 */

import { $, setText, show, toastAside } from "./dom.js";
import {
  state, D, DEFAULT_DIMENSION, DIMENSION_MODES,
} from "./state.js";
import {
  human, parseSize, wordsForQuality, FORMAT_CHOICE_LABEL, LOSSLESS_CAPABLE,
  fmtLabel,
} from "./format.js";
import { refreshPickers } from "./picker.js";

const QUALITY_PRESETS = [95, 90, 85, 80, 70];

/** Is the plan currently promising "identical — every pixel kept"? */
export const isLosslessPlan = () => $("quality-preset").value === "identical";

/* ---------------------------- building the lists -------------------------- */

export function renderDestinationOptions() {
  const sel = $("target");
  if (!sel || sel.children.length) return;
  for (const name of D.DESTINATION_ORDER) {
    const d = D.DESTINATION_NUMBERS[name];
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = d.label;
    opt.title = d.help;
    sel.appendChild(opt);
  }
}

/* Format is its own axis, and its options are the destination's own list.
 *
 * The list is rebuilt from the *control*, not from state.settings: the settings
 * push is debounced, so during a destination change state.settings still holds
 * the previous target, and building from it is how "design tool or document"
 * went on offering WebP - the one format it exists to refuse. */
export function renderFormatOptions() {
  const sel = $("plan-format");
  if (!sel) return;
  const allowed = D.DESTINATION_FORMATS[D.destinationOf($("target").value)] || [];
  const keep = sel.value;
  sel.textContent = "";

  const auto = document.createElement("option");
  auto.value = "";
  auto.dataset.label = "automatic — keep whichever comes out best";
  auto.textContent = auto.dataset.label;
  /* The rule, said once: the engine writes the file every allowed way and
     keeps whichever came out best. */
  auto.title = "Writes the file every allowed way and keeps the best one";
  sel.appendChild(auto);

  for (const name of allowed) {
    const opt = document.createElement("option");
    opt.value = name;
    // The plain label is kept aside so availability suffixes can be rebuilt
    // rather than appended forever.
    opt.dataset.label = `always ${FORMAT_CHOICE_LABEL[name] || name}`;
    opt.textContent = opt.dataset.label;
    sel.appendChild(opt);
  }

  // A pin the new destination cannot write falls back to the comparison rather
  // than leaving the control showing a format the engine will not run.
  sel.value = allowed.includes(keep) ? keep : "";
  if (!sel.value) state.settings.formats = null;
  reflectFormatAvailability();
}

/* Keys the worker's capability reports use, mapped to the format each one is
 * actually about. `engineFlags()` also reports engines with graceful fallbacks
 * (mozjpeg, oxipng) - those never make a format unwritable, so they are not in
 * this table, and an unknown key stays out of the sentence instead of being
 * shouted raw ("WEBPLOSSLESS"). */
const CAPS_FORMAT = {
  webp: "webp", png8: "png8", avif: "avif", webpLossless: "webp-lossless",
};
const CAPS_NOTE_LABEL = {
  webp: "WebP", png8: "PNG-8", avif: "AVIF", "webp-lossless": "lossless WebP",
};

/* What this browser cannot encode, said once, next to the actions rather than in
 * the middle of the plan - plus, while "identical" is promised, which pins would
 * break that promise. The probe answers after the first worker starts, so this
 * can run before the answer is known - and `null` means unknown, which is why
 * the test is `=== false` and not falsy. */
export function reflectFormatAvailability() {
  const sel = $("plan-format");
  const identical = isLosslessPlan();
  const missing = [];
  for (const [key, ok] of Object.entries(state.caps)) {
    const fmt = CAPS_FORMAT[key];
    if (fmt && ok === false) missing.push(fmt);
  }
  for (const opt of sel ? sel.options : []) {
    const base = opt.value.replace("-lossless", "");
    const capsDead = base && state.caps[base] === false;
    const pixelDead = identical && opt.value && !LOSSLESS_CAPABLE.has(opt.value);
    opt.disabled = capsDead || pixelDead;
    const label = opt.dataset.label || opt.textContent;
    opt.textContent = capsDead ? `${label} (unavailable here)`
      : pixelDead ? `${label} (changes pixels)`
      : label;
  }
  /* A pin the current promise forbids falls back to automatic rather than
     staying selected on a control the engine would refuse to honour. */
  if (sel && sel.value && sel.selectedOptions[0]?.disabled) {
    sel.value = "";
    state.settings.formats = null;
  }
  /* Said ONCE, as a receipt, not parked in the header forever: a standing
     warning about a capability most people never reach for habituates into
     invisibility and takes the header's credibility with it. The per-option
     "(unavailable here)" labels above carry the fact at the point of choice. */
  if (missing.length && !capsSaid) {
    capsSaid = true;
    toastAside(`This browser can't save ${missing.map((f) => CAPS_NOTE_LABEL[f] || f).join(" or ")}`
      + " — everything else still works.");
  }
}
let capsSaid = false;

/* --------------------------------- reading -------------------------------- */

/** What the controls currently say, in the shape the engine takes. */
export function currentSettings() {
  const pinned = $("plan-format").value;
  const lossless = isLosslessPlan();
  /* "no resizing" is carried as a zero limit, which is what the engine has
     always meant by it. Nobody types the zero: it is what "never — keep every
     pixel" says, and what "identical" forces, since resizing changes pixels. */
  const shrinking = !lossless && $("shrink-mode").value === "cap";
  return {
    target: D.destinationOf($("target").value),
    formats: pinned ? [pinned] : null,
    /* The promise, not a preference: the engine keeps only pixel-exact
       candidates while this is set. */
    lossless,
    metric: "ss2",
    qualityTarget: Number($("quality").value),
    maxDimension: shrinking ? Number($("maxdim").value) || 0 : 0,
    dimensionMode: $("plan-fit").value,
    sizeTarget: $("plan-goal").value === "cap" ? parseSize($("plan-cap").value) : 0,
    alphaPolicy: state.settings.alphaPolicy,
  };
}

/* --------------------------------- writing ------------------------------- */

/** Show the parts of the plan the current goal uses, hide the ones it does not,
 *  and keep the hidden floor in step with the words above it. */
export function reflectPlan() {
  const capping = $("plan-goal").value === "cap";
  show($("plan-cap"), capping);

  /* "identical" is a promise, and resizing changes pixels, so while it is
     chosen the shrink control is not merely set to never - it is off, and says
     why. The number and its unit go together; "to at most  px" with no number
     is a question with no answer. */
  const identical = isLosslessPlan();
  const shrink = $("shrink-mode");
  if (identical && shrink.value !== "never") shrink.value = "never";
  shrink.disabled = identical;
  const shrinking = !identical && shrink.value === "cap";
  show($("maxdim"), shrinking);
  show($("maxdim-unit"), shrinking);
  show($("fit-field"), shrinking);

  /* Design tools damage anything over their ceiling on import, so when the
     ceiling will override what the person asked for, the plan says so BEFORE
     it happens - never only in the result's fine print. */
  const documents = D.destinationOf($("target").value) === "documents";
  const lines = [];
  if (identical) {
    lines.push("Shrinking changes pixels, so it's off while “identical” is chosen.");
  }
  if (documents && !shrinking) {
    lines.push(`Design tools are the exception: pictures over ${D.DOCUMENTS_MAX_DIMENSION} px `
      + `will still be shrunk to ${D.DOCUMENTS_MAX_DIMENSION}, because those tools crush `
      + `anything bigger on their own.`);
  }
  const note = $("shrink-note");
  show(note, lines.length > 0);
  setText(note, lines.join(" "));

  reflectFormatAvailability();
  reflectQualityWords();
  reflectDirty();
  reflectSelectTitles();
  /* The drawn dropdowns read their words off the selects, and this function is
     what rebuilds those options and rewrites those values - so it is the one
     place that has to tell them to look again. Every other writer already ends
     up here. A no-op when js/picker.js chose not to enhance anything. */
  refreshPickers();
}

/* The sidebar is narrow and a collapsed <select> shows one line, so a long
   choice may ellipsise (controls.css accepts that for #shrink-mode). The full
   words must still be reachable ON the control, not only in the sentence under
   the plan - so every plan select carries its selected option's own words (or
   its help, where the option has some) as a hoverable title. */
function reflectSelectTitles() {
  for (const id of ["target", "quality-preset", "shrink-mode",
                    "plan-goal", "plan-format", "plan-fit"]) {
    const sel = $(id);
    const opt = sel?.selectedOptions[0];
    if (sel) sel.title = opt ? (opt.title || opt.textContent) : "";
  }
}

/* ------------------------- what differs from automatic -------------------- */

/** Whether each field currently differs from the destination's own defaults.
 *  A dot appears on changed fields (state must be visible, not remembered),
 *  and "Back to automatic" appears only while there is something to go back
 *  from. */
export function reflectDirty() {
  const d = D.DESTINATION_NUMBERS[$("target").value];
  if (!d) return;
  const identical = isLosslessPlan();
  const dirty = {
    "quality-preset": identical || Number($("quality").value) !== d.qualityTarget,
    "shrink-mode": !identical &&
      ($("shrink-mode").value === "never") !== !d.maxDimension,
    "maxdim": !identical && $("shrink-mode").value === "cap" &&
      Number($("maxdim").value) !== (d.maxDimension || DEFAULT_DIMENSION),
    "plan-goal": $("plan-goal").value !== "small",
    "plan-format": !!$("plan-format").value,
    "plan-fit": $("plan-fit").value !== "longest",
  };
  /* Grouped by the FIELD before anything is toggled: shrink-mode and maxdim
     share one row, and toggling per control let the second write erase a dot
     the first had earned. */
  const byField = new Map();
  let any = false;
  for (const [id, on] of Object.entries(dirty)) {
    const field = $(id)?.closest(".field");
    if (field) byField.set(field, byField.get(field) || on);
    any = any || on;
  }
  for (const [field, on] of byField) {
    field.toggleAttribute("data-changed", on);
    sayChanged(field, on);
  }
  show($("plan-reset"), any);
}

/* The dot (controls.css) says "not what the destination would do" to the eye;
   this says the same thing to a screen reader, inside the label the control is
   named by, so the state travels with the name - and to a hover, on the label
   the dot itself sits on. */
function sayChanged(field, on) {
  const label = field.querySelector("label");
  if (!label) return;
  let flag = label.querySelector(".vh");
  if (on && !flag) {
    flag = document.createElement("span");
    flag.className = "vh";
    flag.textContent = " — changed from automatic";
    label.appendChild(flag);
  } else if (!on && flag) {
    flag.remove();
  }
  if (on) label.title = "Changed from this destination's automatic setting";
  else label.removeAttribute("title");
}

/** One step back to the destination's own defaults. It resets the KNOBS, not
 *  the destination: where the pictures are going was the real decision, and
 *  this is not the control that made it. */
export function resetPlan() {
  const d = D.DESTINATION_NUMBERS[$("target").value];
  if (!d) return;
  $("quality").value = String(d.qualityTarget);
  $("quality-preset").value = String(Math.round(d.qualityTarget));
  $("maxdim").value = String(d.maxDimension || DEFAULT_DIMENSION);
  $("shrink-mode").value = d.maxDimension ? "cap" : "never";
  $("plan-fit").value = "longest";
  $("plan-goal").value = "small";
  $("plan-format").value = "";
  state.settings.formats = null;
  reflectPlan();
}

/** The floor and its words, kept in agreement in both directions: a click on the
 *  words writes the number, and a number that arrived from a destination or a
 *  saved setting picks the words back out. "identical" is not a floor - it is a
 *  different promise entirely, and its sentence says exactly what it costs. */
export function reflectQualityWords() {
  const sel = $("quality-preset");
  if (sel.value === "identical") {
    setText($("quality-note"),
      "Every pixel stays exactly as it is. Files come out larger this way.");
    return;
  }
  const q = Number($("quality").value);
  const exact = QUALITY_PRESETS.find((p) => p === Math.round(q));
  sel.value = exact != null ? String(exact) : "custom";
  if (exact == null) sel.querySelector('option[value="custom"]').hidden = false;

  const capping = $("plan-goal").value === "cap";
  const words = wordsForQuality(q);
  /* The sentence is the whole plan restated, so it must carry EVERY active
     constraint - a pinned file type included. A readout that omits one is the
     control/engine drift this line exists to prevent. */
  const pin = $("plan-format").value;
  const pinned = pin ? ` Always saved as ${fmtLabel(pin)}.` : "";
  setText($("quality-note"), (capping
    ? `The best quality that fits under ${human(parseSize($("plan-cap").value))}, and never worse than ${words}.`
    : `The smallest file that still looks ${words}.`) + pinned);
}

/** A click on the words. "custom" is not a choice a person can make - it only
 *  exists to describe a number that came from somewhere else - so selecting it
 *  is treated as no change. "identical" is not a number at all: the hidden
 *  floor keeps its last value, unused while the promise holds, waiting for the
 *  person to step back off it. */
export function onQualityPreset() {
  const v = $("quality-preset").value;
  if (v === "custom") return;
  if (v !== "identical") $("quality").value = String(Number(v));
  // The promise touches more than the words: the shrink row turns off and
  // pixel-changing format pins go dark, so the whole plan is reflected.
  reflectPlan();
}

/* Choosing a destination chooses its whole starting point: the frame, the floor,
   and the formats it is willing to write. Leaving the numbers behind would make
   "Thumbnail or avatar" mean nothing but a shorter format list. It moves the
   starting point; it does not lock it.
   Returns true if the format pin moved, because that needs the alpha question
   asked before anything is pushed. */
export function onDestination() {
  const pinnedBefore = $("plan-format").value;
  const d = D.DESTINATION_NUMBERS[$("target").value];
  if (d) {
    $("maxdim").value = d.maxDimension || DEFAULT_DIMENSION;
    $("shrink-mode").value = d.maxDimension ? "cap" : "never";
    $("plan-fit").value = "longest";
    $("quality").value = String(d.qualityTarget);
    /* "identical" survives a destination change on purpose: the destination
       moves the starting point, but the promise was made explicitly and a
       change of address is not a reason to break it. Stepping off "identical"
       is done on the control that made it. */
  }
  renderFormatOptions();
  reflectPlan();
  return $("plan-format").value !== pinnedBefore;
}

/* ------------------------------- persistence ------------------------------ */

export function saveSettings() {
  try {
    localStorage.setItem("imgc-settings",
      JSON.stringify({ v: 3, ...state.settings, suffix: state.suffix }));
  } catch { /* private browsing, or a full quota. Not worth interrupting for. */ }
}

/** Restore what was stored, then make every control say it.
 *
 *  The version stamp matters. Floors stored before the metric changed were SSIM
 *  fractions and mean nothing on the SSIMULACRA 2 scale, and an early scaling bug
 *  once pinned the floor to 99 and persisted it. A floor arriving without the
 *  stamp is that bug's residue rather than a choice, so it resets. */
export function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem("imgc-settings") || "{}");
    if (saved.target) state.settings.target = D.destinationOf(saved.target);
    if (saved.v >= 2 && saved.qualityTarget >= 60 && saved.qualityTarget <= 99) {
      state.settings.qualityTarget = saved.qualityTarget;
    }
    if (Number.isFinite(saved.maxDimension)) state.settings.maxDimension = saved.maxDimension;
    if (Array.isArray(saved.formats) && saved.formats.length === 1) {
      state.settings.formats = saved.formats;
    }
    if (saved.alphaPolicy === "flatten") state.settings.alphaPolicy = "flatten";
    if (Number.isFinite(saved.sizeTarget) && saved.sizeTarget >= 0) {
      state.settings.sizeTarget = saved.sizeTarget;
    }
    /* "none" was a dimension mode before "never shrink" became its own control;
       a saved "none" already carries maxDimension 0, so the mode itself just
       falls back to the default edge. */
    if (DIMENSION_MODES.includes(saved.dimensionMode)) {
      state.settings.dimensionMode = saved.dimensionMode;
    }
    if (saved.lossless === true) state.settings.lossless = true;
    state.suffix = !!saved.suffix;
  } catch { /* unreadable storage is the same as none */ }

  /* A use-case page's own promise. /compress-to-200kb must open with the size
     limit set to 200 KB - that is what its address says it does - so the
     fields a page names override what was stored, on that page, every visit.
     The attributes are written by tools/gen_seo_pages.py onto <html>; the
     front page carries none and is untouched. Nothing is locked: every
     control stays changeable once the page is open, and the page's prose says
     so in as many words. */
  const preset = document.documentElement.dataset;
  if (preset.presetTarget && D.destinationOf(preset.presetTarget)) {
    state.settings.target = preset.presetTarget;
  }
  if (preset.presetSize) {
    const bytes = parseSize(preset.presetSize);
    if (bytes > 0) state.settings.sizeTarget = bytes;
  }
  if (preset.presetFormat) {
    // renderFormatOptions() below drops a pin the destination's list refuses,
    // exactly as it does for a stored one.
    state.settings.formats = [preset.presetFormat];
  }

  renderDestinationOptions();
  $("target").value = D.destinationOf(state.settings.target);
  if (!$("target").value) {
    state.settings.target = D.DEFAULT_DESTINATION;
    $("target").value = D.DEFAULT_DESTINATION;
  }

  /* Built after the destination is settled, so a pin outside its list is
     dropped rather than shown on a control the engine would refuse to honour.
     The pin is captured FIRST: renderFormatOptions restores the select's own
     previous value - empty at boot - and clears state.settings.formats when
     the select ends up empty, so reading the pin after calling it always read
     null. A stored pin (and a page preset) silently died on every load. */
  const pin = state.settings.formats?.[0] || "";
  renderFormatOptions();
  $("plan-format").value = pin;
  state.settings.formats = pin && $("plan-format").value === pin ? [pin] : null;

  /* qualityTarget is ALREADY on the 0-100 scale. An earlier version scaled it
     here as if it were a fraction, which turned a floor of 90 into 99 and ran
     every search at maximum quality. The e2e default assertion exists because of
     this line. */
  $("quality").value = String(Math.round(state.settings.qualityTarget));
  $("maxdim").value = String(state.settings.maxDimension || DEFAULT_DIMENSION);
  $("shrink-mode").value =
    state.settings.maxDimension && !state.settings.lossless ? "cap" : "never";
  $("plan-fit").value = DIMENSION_MODES.includes(state.settings.dimensionMode)
    ? state.settings.dimensionMode : "longest";
  $("plan-goal").value = state.settings.sizeTarget ? "cap" : "small";
  if (state.settings.sizeTarget) $("plan-cap").value = human(state.settings.sizeTarget);
  if (state.settings.lossless) $("quality-preset").value = "identical";
  $("suffix-toggle").checked = state.suffix;

  reflectPlan();
}

/* ------------------- a format that cannot hold what is queued ------------- */

/* JPEG has no alpha channel. Asking for "always JPEG" with transparent artwork
 * queued is a question with two defensible answers, so it is asked once, up
 * front, instead of being resolved silently in either direction. Only images the
 * engine has actually looked at count: `alpha` is measured from the decoded
 * pixels, never guessed from the file extension. */
const CARRIES_ALPHA = { jpeg: false, webp: true, png: true, png8: true, avif: true };

export function alphaItemCount() {
  return state.items.filter((i) => i.alpha === true).length;
}

/** Does the pin now on screen need the question asked? Returns the dialog's
 *  sentence, or "" if there is nothing to ask. */
export function alphaQuestion() {
  const one = $("plan-format").value;
  const n = alphaItemCount();
  if (!one || CARRIES_ALPHA[one] !== false || !n) return "";
  return `${n} ${n === 1 ? "image has" : "images have"} transparent areas, and ` +
         `${fmtLabel(one)} has nowhere to put them. Keep those images as PNG, or ` +
         `flatten the transparency onto white and take the ${fmtLabel(one)}?`;
}
