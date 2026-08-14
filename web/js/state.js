/* The store. One object, one selection, and the predicates that read them.
 *
 * Nothing here touches the DOM or the worker pool. Every other module reads this
 * and writes this, which is what keeps "what is true" in one place instead of
 * distributed across the controls that happen to display it.
 */

/* Generated from pocketsize/destinations.py, handed over by the bridge in
 * index.html. Every destination's label, frame size and quality floor comes from
 * there; not one of those values is restated in this codebase. */
export const D = window.DESTINATIONS;

export const state = {
  items: [],
  byId: new Map(),

  /* The default is taken from the default destination rather than typed out.
     Repeating its frame and quality here would make this another copy of two
     numbers - and one that only shows up before anything is stored, so a stale
     value would be wrong for exactly the people arriving for the first time.

     qualityTarget is on the SSIMULACRA 2 scale (0-100); 90 is its published
     "visually lossless" line. `formats: null` means the comparison decides; a
     one-element array means the person did. `alphaPolicy` only matters when that
     choice cannot hold the image's transparency. */
  settings: {
    target: D.DEFAULT_DESTINATION,
    metric: "ss2",
    qualityTarget: D.DESTINATION_NUMBERS[D.DEFAULT_DESTINATION].qualityTarget,
    maxDimension: D.DESTINATION_NUMBERS[D.DEFAULT_DESTINATION].maxDimension,
    /* Which edge maxDimension governs. Only ever shrinks: an image already
       inside the limit is left alone rather than enlarged. */
    dimensionMode: "longest",
    /* Bytes. 0 runs the ordinary search - smallest file that clears the floor.
       Non-zero inverts it: the best quality that fits under this. Exactly one of
       sizeTarget and "smallest" is ever the goal, which is why the plan has one
       control for both and not two. */
    sizeTarget: 0,
    formats: null,
    /* "identical - every pixel kept". While true the engine keeps only
       pixel-exact candidates and never resizes. */
    lossless: false,
    alphaPolicy: "png",
  },

  /* Bumped on every settings change. A result that comes back stamped with an
     older rev is stale and is re-queued rather than shown. */
  settingsRev: 0,

  /* What this browser can actually encode, as reported by the worker's probe.
     null means "not asked yet", which is different from false. */
  caps: { webp: null, png8: null, avif: null },

  suffix: false,

  /* The whole of the selection model: null means nothing is on the stage, an id
     means that image is. A second "opened" flag was tried and was two names for
     one idea - the only thing it bought was a way for the two to disagree. */
  selected: null,
};

export const DEFAULT_DIMENSION = D.DESTINATION_NUMBERS[D.DEFAULT_DESTINATION].maxDimension;
/* "none" is no longer a mode: "never shrink" became its own control, carried as
   maxDimension 0. A saved "none" from before simply falls back to "longest". */
export const DIMENSION_MODES = ["longest", "width", "height"];
/* Underscore-prefixed on purpose: this is a sentinel meaning "keep the file as
   it arrived", and it shares a namespace with the encoder format keys. A bare
   "original" would collide the day any encoder is called that. */
export const ORIGINAL_PICK = "__original";

export const isReady = (i) => i.status === "done" || i.status === "saved";
export const isBusy = (i) => i.status === "queued" || i.status === "working";

export function uid() {
  const a = new Uint8Array(8);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The item currently on the stage, or null. */
export function current() {
  return state.selected ? state.byId.get(state.selected) || null : null;
}

/** Put an image on the stage. Selecting something that has gone away clears the
 *  stage rather than leaving it showing a deleted result. */
export function select(id) {
  state.selected = state.byId.has(id) ? id : null;
}

/** The first image worth looking at, for when the selection has to be replaced -
 *  a removal, a clear, or the first result of a run arriving. */
export function firstInteresting() {
  return state.items.find(isReady) || state.items[0] || null;
}

/** What the engine is actually run with for one image: the plan, plus whatever
 *  that image overrides. All three of a destination's numbers can be overridden
 *  for one image, which is the shape the override always implied. */
export function effectiveSettings(item) {
  const s = { ...state.settings };
  if (item.override) {
    if (item.override.formats) { s.formats = item.override.formats; s.target = "web"; }
    if (item.override.qualityTarget != null) s.qualityTarget = item.override.qualityTarget;
    if (item.override.maxDimension != null) s.maxDimension = item.override.maxDimension;
  }
  return s;
}

/** Batch totals, over everything that has a result. */
export function totals() {
  let before = 0, after = 0, ready = 0;
  for (const it of state.items) {
    if (!isReady(it)) continue;
    before += it.originalBytes;
    after += it.newBytes;
    ready += 1;
  }
  return { before, after, ready, saved: Math.max(0, before - after) };
}
