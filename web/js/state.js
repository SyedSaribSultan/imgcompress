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

  /* And the same question asked of the video worker: does this browser have
     WebCodecs at all, and which of our formats will it write. null means the
     answer has not come back yet, which is why nothing tests it as falsy -
     "we have not asked" and "it cannot" are different things to say to a
     person holding a video. */
  videoCaps: null,

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

/** What this run is actually about.
 *
 *  One place answers it, because "is there a video in the queue" decides what
 *  several different parts of the interface should say, and a module that works
 *  it out for itself is a module that can disagree with the others. A mixed
 *  queue is the ordinary case, not an edge case: a person drops a folder and it
 *  has both in it.
 *
 *  Both flags rather than one enum, for the same reason: `mixed` as a third
 *  state would make every caller handle three cases when what each one actually
 *  wants to know is "do I need to speak about pictures" and "do I need to speak
 *  about video" - which are independent questions with independent answers. */
export function queueKinds() {
  let hasImages = false, hasVideo = false;
  for (const it of state.items) {
    if (it.isVideo) hasVideo = true;
    else hasImages = true;
    if (hasImages && hasVideo) break;
  }
  return { hasImages, hasVideo };
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

/** Can this browser re-encode video at all? Three states, and only one of them
 *  is a yes: unknown (nobody has asked), no (no WebCodecs, or no encoder it
 *  will admit to), and a list of formats. */
export function canEncodeVideo() {
  const c = state.videoCaps;
  return !!(c && c.webcodecs && Array.isArray(c.formats) && c.formats.length);
}

/** The one sentence for a browser that cannot do this. Approved copy (V8), in
 *  one place so the intake refusal and a job that reaches the engine anyway
 *  say exactly the same thing. */
export const NO_VIDEO_HERE =
  "This browser can't re-encode video yet — the desktop app can.";

/* ------------------------------ how big is too big ----------------------- */

/* Two thresholds, because there are two different honest answers.
 *
 * A video encode in a browser costs memory that does not shrink to nothing:
 * the codec pipeline, a window of decoded frames, the staging buffer. Measured
 * after the streaming work, the encode itself adds roughly 1.3 GB on a 287 MB
 * clip and 1.8-2.2 GB on a 663 MB one - sub-linear, but never small. On a
 * machine with 8 GB shared with everything else, a big enough file still ends
 * in swapping, and swapping stops the whole computer rather than one tab.
 *
 * So: above HEAVY, say plainly that it will take a while and the machine will
 * be busy - and then do it, because the person asked. Above TOO_BIG, do not
 * start; recommend the desktop tier, which streams from disk and has no
 * equivalent ceiling (its own limit is 4 GB, and it is not holding the file in
 * a tab). Refusing is friendlier than freezing.
 *
 * These are deliberately not derived from `deviceMemory`: it is absent on
 * Safari and Firefox entirely and rounded to a power of two where it exists,
 * so a threshold built on it would be a guess wearing a number. A flat, stated
 * limit is honest and the desktop route is always available. */
export const HEAVY_VIDEO_BYTES = 200 * 1024 * 1024;
export const TOO_BIG_VIDEO_BYTES = 2 * 1024 * 1024 * 1024;

/** Said before a long job starts, not after it. Plain about the cost, because
 *  "your computer will be busy" is the part a person needs in order to decide
 *  whether to start it now or after lunch. */
export const HEAVY_VIDEO_WARNING =
  "That's a big video. It will take a while, and your computer will be busy "
  + "while it works.";

/** Said instead of starting. Names the way forward rather than only the
 *  refusal - the same shape as NO_VIDEO_HERE. */
export const TOO_BIG_VIDEO_HERE =
  "That video is too big to compress in a browser tab — the desktop app "
  + "handles it straight from your disk.";

/** What the engine is actually run with for one VIDEO.
 *
 *  Video reads the video columns of the destination table and never the image
 *  ones: the frame cap, the floor and the byte ceiling are different numbers
 *  for the same destination, and mixing them would silently run a video at a
 *  picture's settings. Returns null when this destination takes no video -
 *  which the table itself decides, exactly as the desktop engine reads it.
 *
 *  Zero new decisions: nothing here is a question. The person chose where the
 *  video is going and that is the whole of it. */
export function videoPlan(item) {
  const target = D.destinationOf(state.settings.target);
  const numbers = D.DESTINATION_VIDEO_NUMBERS[target];
  if (!numbers) return null;
  const picture = D.DESTINATION_NUMBERS[target];

  /* The floor. A destination carries one for video and another for pictures,
     and the video one is the default. But "Must still look" is the person
     speaking about quality out loud, so when it has been moved off the
     destination's own picture default, that answer is theirs and it counts
     for the video too - the same rule the command line follows, where a
     quality given on the line overrides the destination's and nothing else
     does. */
  const spoken = picture && state.settings.qualityTarget !== picture.qualityTarget;
  const floor = item?.override?.qualityTarget
    ?? (spoken ? state.settings.qualityTarget : numbers.qualityTarget);

  return {
    target,
    formats: D.DESTINATION_VIDEO_FORMATS[target] || [],
    /* The frame cap is the destination's, and a per-video override can zero it
       - which is what the resize disclosure's own undo does. */
    maxDimension: item?.override?.maxDimension ?? numbers.maxDimension,
    qualityTarget: floor,
    sizeCapBytes: Math.round((numbers.sizeCapMb || 0) * 1024 * 1024),
    audio: numbers.audio,
  };
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
