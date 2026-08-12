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
 *   imgcompress/destinations.py.
 */

import { $, setText, show } from "./dom.js";
import {
  state, D, DEFAULT_DIMENSION, DIMENSION_MODES,
} from "./state.js";
import {
  human, parseSize, wordsForQuality, FORMAT_CHOICE_LABEL, fmtLabel,
} from "./format.js";

const QUALITY_PRESETS = [95, 90, 85, 80, 70];

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
  auto.textContent = "whichever format wins";
  auto.title = "Writes the image every allowed way and keeps the best one";
  sel.appendChild(auto);

  for (const name of allowed) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = `always ${FORMAT_CHOICE_LABEL[name] || name}`;
    sel.appendChild(opt);
  }

  // A pin the new destination cannot write falls back to the comparison rather
  // than leaving the control showing a format the engine will not run.
  sel.value = allowed.includes(keep) ? keep : "";
  if (!sel.value) state.settings.formats = null;
  reflectFormatAvailability();
}

/* What this browser cannot encode, said once, next to the actions rather than in
 * the middle of the plan. The probe answers after the first worker starts, so
 * this can run before the answer is known - and `null` means unknown, which is
 * why the test is `=== false` and not falsy. */
export function reflectFormatAvailability() {
  const sel = $("plan-format");
  const missing = [];
  for (const [fmt, ok] of Object.entries(state.caps)) {
    if (ok === false) missing.push(fmt);
  }
  for (const opt of sel ? sel.options : []) {
    const base = opt.value.replace("-lossless", "");
    const dead = base && state.caps[base] === false;
    opt.disabled = dead;
    if (dead && !opt.textContent.endsWith("(unavailable here)")) {
      opt.textContent = `${opt.textContent} (unavailable here)`;
    }
  }
  const note = $("caps-note");
  if (!note) return;
  show(note, missing.length > 0);
  setText(note, missing.length
    ? `This browser cannot write ${missing.map(fmtLabel).join(" or ")}`
    : "");
}

/* --------------------------------- reading -------------------------------- */

/** What the controls currently say, in the shape the engine takes. */
export function currentSettings() {
  const pinned = $("plan-format").value;
  const fit = $("plan-fit").value;
  return {
    target: D.destinationOf($("target").value),
    formats: pinned ? [pinned] : null,
    metric: "ss2",
    qualityTarget: Number($("quality").value),
    /* "no resizing" is carried as a zero limit, which is what the engine has
       always meant by it. The difference is that nobody has to type the zero, or
       know that it means that. */
    maxDimension: fit === "none" ? 0 : Number($("maxdim").value) || 0,
    dimensionMode: fit,
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
  /* The whole row goes, label and unit with it. Hiding only the input left "No
     wider than px" sitting there as a question with no answer. */
  show($("maxdim-field"), $("plan-fit").value !== "none");
  reflectQualityWords();
}

/** The floor and its words, kept in agreement in both directions: a click on the
 *  words writes the number, and a number that arrived from a destination or a
 *  saved setting picks the words back out. */
export function reflectQualityWords() {
  const q = Number($("quality").value);
  const sel = $("quality-preset");
  const exact = QUALITY_PRESETS.find((p) => p === Math.round(q));
  sel.value = exact != null ? String(exact) : "custom";
  if (exact == null) sel.querySelector('option[value="custom"]').hidden = false;

  const capping = $("plan-goal").value === "cap";
  const words = wordsForQuality(q);
  setText($("quality-note"), capping
    ? `The best quality that fits under ${human(parseSize($("plan-cap").value))}, and never worse than ${words}.`
    : `The smallest file that still looks ${words}.`);
}

/** A click on the words. "custom" is not a choice a person can make - it only
 *  exists to describe a number that came from somewhere else - so selecting it
 *  is treated as no change. */
export function onQualityPreset() {
  const v = $("quality-preset").value;
  if (v === "custom") return;
  $("quality").value = String(Number(v));
  reflectQualityWords();
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
    $("plan-fit").value = d.maxDimension ? "longest" : "none";
    $("quality").value = String(d.qualityTarget);
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
    if (DIMENSION_MODES.includes(saved.dimensionMode)) {
      state.settings.dimensionMode = saved.dimensionMode;
    }
    state.suffix = !!saved.suffix;
  } catch { /* unreadable storage is the same as none */ }

  renderDestinationOptions();
  $("target").value = D.destinationOf(state.settings.target);
  if (!$("target").value) {
    state.settings.target = D.DEFAULT_DESTINATION;
    $("target").value = D.DEFAULT_DESTINATION;
  }

  // Built after the destination is settled, so a stored pin outside its list is
  // dropped rather than shown on a control the engine would refuse to honour.
  renderFormatOptions();
  $("plan-format").value = state.settings.formats?.[0] || "";
  if (!$("plan-format").value) state.settings.formats = null;

  /* qualityTarget is ALREADY on the 0-100 scale. An earlier version scaled it
     here as if it were a fraction, which turned a floor of 90 into 99 and ran
     every search at maximum quality. The e2e default assertion exists because of
     this line. */
  $("quality").value = String(Math.round(state.settings.qualityTarget));
  $("maxdim").value = String(state.settings.maxDimension || DEFAULT_DIMENSION);
  $("plan-fit").value = state.settings.maxDimension ? state.settings.dimensionMode : "none";
  $("plan-goal").value = state.settings.sizeTarget ? "cap" : "small";
  if (state.settings.sizeTarget) $("plan-cap").value = human(state.settings.sizeTarget);
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
