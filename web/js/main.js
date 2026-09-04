/* Boot, and every event listener in the app.
 *
 * This is the only module that binds handlers. The renderers run constantly and
 * rebuild elements as they go, so if they also attached listeners the app would
 * accumulate them by the hundred during a batch. Instead everything is delegated
 * from a container that never gets replaced, and the handler reads the target's
 * data attribute to find out what was clicked.
 *
 * It is also the only module that knows a change to the plan means "redo
 * everything". settings.js reads and writes the form; deciding what that costs is
 * a separate judgement and lives here.
 */

import { $, setText, show, toast, toastAside } from "./dom.js";
import { bindPanels } from "./panels.js";
import { state, current, select, isReady, isBusy, totals } from "./state.js";
import { scheduleRender, renderNow } from "./render.js";
import { human, splitName } from "./format.js";
import {
  loadSettings, currentSettings, saveSettings, reflectPlan, reflectQualityWords,
  onQualityPreset, onDestination, alphaQuestion, alphaItemCount, resetPlan,
} from "./settings.js";
import {
  startEngine, dispatch, requeue, removeItems, cancelAll, setBatchEndHandler, pool,
  holdWork, warmCodecs,
} from "./engine.js";
import { addFiles, filesFromDataTransfer, countItemWords } from "./intake.js";
import { chooseCandidate, previewCandidate, endPreview } from "./views.js";
import {
  setMode, getMode, applySplit, applyZoom, zoomAt, stepZoom, resetZoom, panBy,
  onSelectionChanged, getZoom, getPan, setView,
} from "./compare.js";
import { readOverride, invalidateRedo } from "./facts.js";
import { downloadAll, downloadOne, copyImage } from "./save.js";

/* ---------------------------- settings -> engine -------------------------- */

/* Debounced, because these are live controls: dragging a number field would
 * otherwise re-queue the whole batch on every keystroke. The plan is the
 * whole-queue control, so changing it means everything is redone to match -
 * but nothing on screen is blanked: finished results stay visible, marked
 * stale, until their replacements land, and workers mid-flight are told to
 * stop rather than left computing answers nobody will see. */
let pushTimer;
function pushSettings() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    state.settings = currentSettings();
    state.settingsRev++;
    saveSettings();
    requeue(state.items.map((i) => i.id), { keepResult: true });
  }, 350);
}

/* The transparency question. Asked once when a format that cannot hold alpha is
 * pinned while transparent images are queued, and never resolved silently. */
function onFormatPin() {
  const question = alphaQuestion();
  if (!question) { pushSettings(); return; }
  $("alpha-ask-body").textContent = question;
  // The buttons state their consequence, count included: "Keep 2 as PNG" is a
  // decision; "Keep those as PNG" is a hope.
  const n = alphaItemCount();
  setText($("alpha-keep"), `Keep ${n === 1 ? "it" : `all ${n}`} as PNG`);
  $("alpha-ask").showModal();
}

function settleAlpha(policy) {
  if (policy) {
    state.settings.alphaPolicy = policy;
    $("alpha-ask").close();
    pushSettings();
    return;
  }
  /* Cancelled, so the control goes back to the setting actually in force.
     That is read from state.settings rather than from a variable remembered
     before the dialog opened - by the time onFormatPin runs, the <select> is
     already showing the new value, so there is nothing left to remember. Reading
     the live settings is also the stronger guarantee: it puts the control back in
     agreement with what the engine is running, which is the whole point. */
  $("plan-format").value = state.settings.formats?.[0] || "";
  $("alpha-ask").close();
  reflectPlan();
}

/* ---------------------------------- theme --------------------------------- */

/* Three MODES, cycled on one button: match my device -> light -> dark. The
 * mode is the person's choice and lives in localStorage; the stamp on <html>
 * is always the RESOLVED theme (js/theme.js resolves "match my device" to the
 * OS's answer, live). This control therefore reads and writes the mode, never
 * the stamp - the stamp is derived. The button's visible word is the CURRENT
 * mode: a control that showed the next state read as already being in it. */
const THEME_WORD = { "": "Match my device", light: "Light", dark: "Dark" };
const THEME_NEXT = { "": "light", light: "dark", dark: "" };

function themeMode() {
  if (typeof window.__themeMode === "string") {
    return window.__themeMode === "light" || window.__themeMode === "dark"
      ? window.__themeMode : "";
  }
  try {
    const saved = localStorage.getItem("imgc-theme");
    if (saved === "light" || saved === "dark") return saved;
  } catch { /* private browsing reads as "match my device" */ }
  return "";
}

function reflectTheme() {
  const cur = themeMode();
  const btn = $("theme-btn");
  // The word, not the whole button: the glyph beside it stays put.
  setText($("theme-word"), `Theme: ${THEME_WORD[cur]}`);
  btn.title = `Switch to ${THEME_WORD[THEME_NEXT[cur]]}`;
  btn.setAttribute("aria-label",
    `Theme: ${THEME_WORD[cur]}. Click to switch to ${THEME_WORD[THEME_NEXT[cur]]}.`);
}

function bindTheme() {
  $("theme-btn").addEventListener("click", () => {
    const next = THEME_NEXT[themeMode()];
    window.__themeMode = next;          // holds for the visit even without storage
    try {
      if (next) localStorage.setItem("imgc-theme", next);
      else localStorage.removeItem("imgc-theme");
    } catch { /* private browsing; the in-memory mode above still applies */ }
    if (window.__applyTheme) window.__applyTheme();
    reflectTheme();
  });
  reflectTheme();
}

/* -------------------------------- selection ------------------------------- */

function pick(id) {
  if (state.selected === id) return;
  select(id);
  invalidateRedo();
  onSelectionChanged();
  scheduleRender();
}

/* --------------------------------- binding -------------------------------- */

function bindIntake() {
  const open = () => $("file-input").click();
  $("add-btn").addEventListener("click", open);
  $("empty-add").addEventListener("click", open);
  $("file-input").addEventListener("change", (e) => {
    addFiles(e.target.files);
    e.target.value = "";        // so re-picking the same file fires again
  });

  /* Clearing six results in one click is not a decision to confirm - it is a
     decision to be able to take back. The items leave the screen at once and
     the bytes are only truly let go when the undo window closes; undo does not
     tax the common case the way a confirm dialog would. */
  $("clear-btn").addEventListener("click", () => {
    if (state.items.some(isBusy)) cancelAll();
    const kept = state.items.splice(0, state.items.length);
    state.byId.clear();
    state.selected = null;
    scheduleRender();
    /* What the plan says can depend on what is in the queue, so emptying it
       has to take those sentences back down - and putting them back is part of
       undo. */
    reflectPlan();
    let undone = false;
    toast(`Cleared ${countItemWords(kept)}`, {
      label: "Undo",
      onAction: () => {
        undone = true;
        for (const it of kept) { state.items.push(it); state.byId.set(it.id, it); }
        select(kept[0]?.id);
        scheduleRender();
        reflectPlan();
      },
    });
    /* The object URLs are released only after the undo window has passed -
       revoking them up front would make undo restore broken previews. */
    setTimeout(() => {
      if (undone) return;
      for (const it of kept) {
        if (it.beforeURL) URL.revokeObjectURL(it.beforeURL);
        if (it.afterURL) URL.revokeObjectURL(it.afterURL);
        if (it.thumbURL) URL.revokeObjectURL(it.thumbURL);
      }
    }, 12_000);
  });

  /* The whole window is the drop target. A drop zone that is only part of the
     page is a thing to aim at, and there is no reason to make anyone aim. The
     overlay says what letting go will do, and to how many - feedforward for
     the gesture in flight. */
  let dragDepth = 0;
  addEventListener("dragenter", (e) => {
    if (!e.dataTransfer?.types?.includes("Files")) return;
    dragDepth++;
    document.body.dataset.drag = "1";
    const dragged = [...(e.dataTransfer.items || [])].filter((i) => i.kind === "file");
    const n = dragged.length;
    /* The noun follows what is actually in the drag. A clip announced as "this
       picture" is the interface mis-naming the thing being held over it -
       feedforward that is wrong is worse than none. Types are not always
       exposed during a drag, so anything unrecognised keeps the old wording
       rather than guessing. */
    const noun = n === 1 ? "this picture" : `${n} pictures`;
    /* The fallback runs when a drag exposes no usable item types at all, so it
       cannot name what is coming - "files" is the honest word there, and the
       true count and nouns arrive above whenever the browser tells us. */
    setText($("drop-say"), n ? `Drop to add ${noun}` : "Drop to add files");
    show($("drop-say"), true);
  });
  addEventListener("dragover", (e) => {
    if (e.dataTransfer?.types?.includes("Files")) e.preventDefault();
  });
  addEventListener("dragleave", () => {
    if (--dragDepth <= 0) {
      dragDepth = 0;
      delete document.body.dataset.drag;
      show($("drop-say"), false);
    }
  });
  addEventListener("drop", async (e) => {
    if (!e.dataTransfer?.types?.includes("Files")) return;
    e.preventDefault();
    dragDepth = 0;
    delete document.body.dataset.drag;
    show($("drop-say"), false);
    addFiles(await filesFromDataTransfer(e.dataTransfer));
  });

  addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); addFiles(files); }
  });
}

function bindPlan() {
  $("target").addEventListener("change", () => {
    // onDestination reports whether the format pin moved; only then does the
    // transparency question apply, and it must be answered before anything is
    // pushed - that path waits for an answer.
    if (onDestination()) onFormatPin();
    else pushSettings();
  });

  $("plan-format").addEventListener("change", onFormatPin);

  $("plan-goal").addEventListener("change", () => { reflectPlan(); pushSettings(); });
  $("quality-preset").addEventListener("change", () => { onQualityPreset(); pushSettings(); });
  $("shrink-mode").addEventListener("change", () => { reflectPlan(); pushSettings(); });
  $("plan-fit").addEventListener("change", () => { reflectPlan(); pushSettings(); });

  for (const id of ["plan-cap", "maxdim"]) {
    $(id).addEventListener("input", () => { reflectQualityWords(); pushSettings(); });
  }

  $("suffix-toggle").addEventListener("change", () => {
    state.suffix = $("suffix-toggle").checked;
    saveSettings();
    scheduleRender("queue");     // the names in the footer follow it
  });

  for (const [id, policy] of [["alpha-keep", "png"], ["alpha-flatten", "flatten"]]) {
    $(id).addEventListener("click", () => settleAlpha(policy));
  }
  $("alpha-cancel").addEventListener("click", () => settleAlpha(null));
  // Escape closes a dialog natively, and that is a cancel like any other.
  $("alpha-ask").addEventListener("cancel", (e) => { e.preventDefault(); settleAlpha(null); });

  // One step back to the destination's defaults, shown only while something
  // differs from them.
  $("plan-reset").addEventListener("click", () => { resetPlan(); pushSettings(); });

  /* The disclosure remembers its state: someone who works from More choices
     should not have to reopen it every visit. */
  const more = $("more-choices");
  try { more.open = localStorage.getItem("imgc-more") === "1"; } catch { /* fine */ }
  /* A use-case page that presets a field living under More choices opens the
     disclosure, whatever was remembered: a preset the person cannot see would
     be the resize-disclosure rule broken one level up. */
  const preset = document.documentElement.dataset;
  if (preset.presetSize || preset.presetFormat) more.open = true;
  more.addEventListener("toggle", () => {
    try { localStorage.setItem("imgc-more", more.open ? "1" : "0"); } catch { /* fine */ }
  });
}

function bindQueue() {
  const list = $("queue-list");

  list.addEventListener("click", (e) => {
    /* The row's own actions come first: remove and retry act on the row they
       sit on, without moving the selection to it. */
    const act = e.target.closest(".row-act");
    if (act) {
      const id = act.closest(".row")?.dataset.id;
      if (!id) return;
      if (act.classList.contains("rm")) removeItems([id]);
      else requeue([id]);
      return;
    }
    const row = e.target.closest(".row");
    if (row) pick(row.dataset.id);
  });

  /* Arrow keys move the selection, Delete removes it. The list is a listbox, so
     these are the interactions its role promises - implementing the role without
     them would be a claim the app does not honour. */
  list.addEventListener("keydown", (e) => {
    const i = state.items.findIndex((it) => it.id === state.selected);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = state.items[i + (e.key === "ArrowDown" ? 1 : -1)];
      if (next) pick(next.id);
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      if (state.selected) removeItems([state.selected]);
    }
  });
}

function bindStage() {
  for (const m of ["split", "after", "diff"]) {
    $(`mode-${m}`).addEventListener("click", () => setMode(m));
  }

  $("split").addEventListener("input", applySplit);
  /* Double-click the caliper to recentre it - the convention every adjustable
     split obeys. Swallowed before it bubbles to the stage, whose own dblclick
     means "reset zoom". */
  $("split").addEventListener("dblclick", (e) => {
    e.stopPropagation();
    $("split").value = "50";
    applySplit();
  });

  // The empty stage carries its own exit.
  $("stage-choose").addEventListener("click", () => $("file-input").click());

  $("zoom-in").addEventListener("click", () => stepZoom(1));
  $("zoom-out").addEventListener("click", () => stepZoom(-1));
  $("zoom-reset").addEventListener("click", resetZoom);

  /* Zoom and pan are bound to #stage, not to #view inside it. The split slider is
     a full-bleed overlay, so a listener on #view would never see a wheel or a
     drag whenever split mode is on - events bubble up from the slider, not down
     into its siblings. #stage is the common ancestor of both. */
  const stage = $("stage");
  const view = $("view");

  stage.addEventListener("wheel", (e) => {
    e.preventDefault();
    zoomAt(e.deltaY < 0 ? 1 : -1, e.clientX, e.clientY);
  }, { passive: false });
  stage.addEventListener("dblclick", resetZoom);

  /* Panning. In split mode the pointer belongs to the divider, so panning there is
     Shift-drag; in the other two modes a plain drag is a pan. */
  let dragging = null;
  stage.addEventListener("pointerdown", (e) => {
    // The floating bars are controls, not canvas. A press on one is a press on it.
    if (e.target.closest(".stage-bar")) return;
    if (getMode() === "split" && !e.shiftKey) return;
    dragging = { x: e.clientX, y: e.clientY };
    view.dataset.panning = "1";
  });
  stage.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    panBy(e.clientX - dragging.x, e.clientY - dragging.y);
    dragging = { x: e.clientX, y: e.clientY };
  });
  addEventListener("pointerup", () => { dragging = null; delete view.dataset.panning; });

  $("stop-btn").addEventListener("click", cancelAll);

  /* Renaming is an edit, not a fact about the result, which is why it is a field
     on the stage rather than a line in the details. The extension stays the
     format's own. */
  /* Renaming is an edit, not a fact about the result, which is why it is a field on
     the stage rather than a line in the details. The extension stays the format's
     own - what is being renamed is the part a person chose.
     Committed on `input`, on `change` and on Enter, not just on `input`: the field
     is the authority on the name, and it must be read at every point the name can
     have settled. A value that arrived without a keystroke - assistive tech, a
     script - fires no input event, and the name would silently keep the old one. */
  const commitName = () => {
    const it = current();
    if (!it) return;
    it.name = $("out-name").value + splitName(it.name).ext;
    scheduleRender("queue");
  };
  $("out-name").addEventListener("input", commitName);
  $("out-name").addEventListener("change", commitName);

  /* Enter means "done renaming". There is nothing to submit, so what Enter has to
     do is give the focus back - a lone text field that swallows Enter leaves a
     keyboard user with no way out but Tab. */
  $("out-name").addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    commitName();
    $("out-name").blur();
  });

  $("dl-one").addEventListener("click", () => downloadOne(current()));
  $("copy-one").addEventListener("click", () => copyImage(current()));
  $("save-btn").addEventListener("click", downloadAll);

  /* Focus mode: the comparison and nothing else. The regions are hidden, not
     destroyed - the queue keeps working behind it. */
  $("focus-btn").addEventListener("click", toggleFocus);

  // A resize changes the fit scale and therefore where the divider cuts.
  addEventListener("resize", () => { applyZoom(); applySplit(); });

  measureBar();
}

/* The dashboard fills the screen below the bar, so it needs the bar's height as
   a number. Measured rather than guessed: the bar wraps to a second line on a
   small window, and a guessed height was already the cause of one misplaced
   element in this shell (see #batch in layout.css). A ResizeObserver keeps it
   true through wrapping, theme changes and font loading alike. */
function measureBar() {
  const bar = $("bar");
  const write = () => document.documentElement.style.setProperty(
    "--bar-h", `${Math.round(bar.getBoundingClientRect().height)}px`);
  write();
  if (typeof ResizeObserver === "function") new ResizeObserver(write).observe(bar);
}

function bindFacts() {
  $("cands").addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    const said = chooseCandidate(chip.dataset.format);
    if (said) { toast(said); scheduleRender(); }
  });

  /* Hovering a chip tries that encode on, on the stage, and commits nothing -
     the cheapest possible exploration of a choice. Pointer hover only: on a
     touch screen there is no hover, and the tap already commits. */
  $("cands").addEventListener("mouseover", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip || chip.disabled) return;
    if (previewCandidate(chip.dataset.format)) scheduleRender("stage");
  });
  $("cands").addEventListener("mouseleave", () => {
    if (endPreview()) scheduleRender("stage");
  });

  /* The resize disclosure's own undo: zero the shrink for this one picture
     and run it again. */
  $("keep-size").addEventListener("click", () => {
    const it = current();
    if (!it) return;
    it.override = { ...(it.override || {}), maxDimension: 0 };
    invalidateRedo();
    requeue([it.id]);
    toast("Running again at full size");
  });

  $("ov-apply").addEventListener("click", () => {
    const it = current();
    if (!it) return;
    it.override = readOverride();
    invalidateRedo();
    requeue([it.id]);
  });

  $("ov-reset").addEventListener("click", () => {
    const it = current();
    if (!it) return;
    it.override = null;
    $("ov-format").value = "";
    $("ov-quality").value = "";
    invalidateRedo();
    requeue([it.id]);
  });

  $("remove-btn").addEventListener("click", () => {
    if (state.selected) removeItems([state.selected]);
  });
}

/* Focus mode: everything but the comparison steps aside. Entered and left
 * with F or the stage button; Escape also leaves, because Escape means "out". */
function setFocus(on) {
  if (on) document.body.dataset.focus = "1";
  else delete document.body.dataset.focus;
  $("focus-btn").setAttribute("aria-pressed", String(!!on));
  // The stage's box just changed size; the fit and the caliper follow it.
  applyZoom();
  applySplit();
  // A mode must never trap anyone: the way out is stated the first time in.
  if (on) hintOnce("focus", "Press Esc or F to leave focus mode.");
}

/* One-time hints. Each is said exactly once per browser, ever - a hint that
 * repeats is a nag, and a hint never said leaves a feature undiscoverable. */
function hintOnce(key, message, action) {
  const k = `imgc-hint-${key}`;
  try {
    if (localStorage.getItem(k)) return;
    localStorage.setItem(k, "1");
  } catch { /* private browsing: better to occasionally repeat than never say */ }
  // Hints are asides: they wait behind anything already showing.
  toastAside(message, action);
}
function toggleFocus() { setFocus(!document.body.dataset.focus); }

/* The three keys worth having, and nothing that needs a legend to discover.
 * Holding Space flickers between the two images on top of each other, which is
 * how a difference at a floor of 90 actually becomes visible. */
function bindKeys() {
  let flickerFrom = null;
  addEventListener("keydown", (e) => {
    const typing = /^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(e.target.tagName);
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;

    if (e.code === "Space" && !flickerFrom) {
      e.preventDefault();
      flickerFrom = getMode();
      setMode(flickerFrom === "after" ? "split" : "after");
    } else if (e.key === "d" || e.key === "D") {
      setMode(getMode() === "diff" ? "split" : "diff");
    } else if (e.key === "f" || e.key === "F") {
      toggleFocus();
    } else if (e.key === "Escape" && document.body.dataset.focus) {
      setFocus(false);
    } else if (e.key === "?") {
      $("help").showModal();
    }
  });
  addEventListener("keyup", (e) => {
    if (e.code === "Space" && flickerFrom) { setMode(flickerFrom); flickerFrom = null; }
  });
}

/* ------------------------------ harness seam ------------------------------ */

/* The browser tests drive this app through a real Chrome and assert on what it
 * actually believes - how many items exist, which candidate won, what the floor
 * was on a fresh profile. When the app was one classic script all of that was
 * reachable because everything was a global by accident.
 *
 * It is now a module graph, so nothing is reachable by accident. This is the seam,
 * declared on purpose and in one place, rather than scattered as a dozen
 * incidental leaks. Nothing in the app reads window.imgc - it is write-only from
 * the app's side, so deleting it would break tests and nothing else.
 */
window.imgc = {
  state, pool, dispatch, scheduleRender, renderNow, toast, human,
  chooseCandidate, currentSettings, select: pick,
  // Zoom geometry, for the probe that asserts the frame stays centred.
  zoom: getZoom, pan: getPan, setView, mode: getMode, setMode, applyZoom, resetZoom,
  // Pause the run, so the anchor frame is observable. See engine.holdWork.
  holdWork,
  /* Reconciling the hidden floor back into the words. The harness drives this
     directly to guard the floor-99 bug: a floor the words disagree with is a
     control displaying one thing while the engine runs another. */
  reflectQualityWords,
};
// `state` alone, because that is the name the whole harness already asks for.
window.state = state;

/* ---------------------------------- boot --------------------------------- */

loadSettings();
state.settings = currentSettings();
bindTheme();
bindPanels();
bindIntake();
bindPlan();
bindQueue();
bindStage();
bindFacts();
bindKeys();

/* The wordmark and "?" both open the one help card. */
$("brand-btn").addEventListener("click", () => $("help").showModal());
$("help-close").addEventListener("click", () => $("help").close());

setBatchEndHandler(() => {
  const t = totals();
  if (!t.ready) return;
  /* The outcome, framed as the person's own gain - this is the moment the
     product's value is remembered by. */
  toast(`Done — ${t.ready} picture${t.ready === 1 ? "" : "s"} ready, saved you `
    + `${human(t.saved)}. Drag the line to check any of them.`);
  /* And the product's superpower, taught exactly once, at the first moment it
     is usable. */
  hintOnce("flick", "Tip: hold Space to flick between before and after — "
    + "the fastest way to spot a difference.");
  /* Installing is offered once, and only after the product has shown its
     worth - a prompt before value is a prompt declined. */
  if (installable) {
    hintOnce("install", "Install Pocketsize? It works fully offline — "
      + "nothing ever leaves your device.", {
      label: "Install",
      onAction: () => { installable.prompt(); installable = null; },
    });
  }
});

/* The browser announces installability; the nudge above decides when to use
 * it. Captured quietly so the browser's own mini-infobar does not interrupt. */
let installable = null;
addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installable = e;
});

// Ask what this browser can encode before anything is dropped, so the format
// control never offers something the engine would refuse.
startEngine();
scheduleRender();
dispatch();

/* The app is fully client-side, so it can be fully offline: the service
   worker caches everything the page needs, and after the first visit the
   whole compressor runs with no network at all - which is the privacy promise
   made physical. Registration failing (old browser, file: URL) costs nothing
   but the offline capability. */
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").then((reg) => {
    /* A silent superpower earns no trust: the first time the offline layer
       finishes warming, it is announced - exactly once. */
    const announce = () => hintOnce("offline",
      "Ready to work offline — this whole app now runs without internet.");
    if (navigator.serviceWorker.controller) return;   // already installed before
    const sw = reg.installing || reg.waiting;
    if (!sw) return;
    sw.addEventListener("statechange", () => {
      if (sw.state === "activated") announce();
    });
  }).catch(() => {});

  /* Warm the codecs only once this page is service-worker-controlled, so the
     warm reads the freshly installed cache. Before this, the warm fired on a
     timer and RACED the install's own download of the same files - a first
     visit could fetch the 3.5 MB AVIF codec twice. Repeat visits are
     controlled immediately, so they warm immediately. */
  if (navigator.serviceWorker.controller) warmTheCodecs();
  else navigator.serviceWorker.addEventListener("controllerchange", () => warmTheCodecs(), { once: true });
} else {
  // No offline layer to wait for - warm once the first paint is out the door.
  setTimeout(warmTheCodecs, 1000);
}

/* Waits for the offline copy to be ready, so this reads the cache instead of
 * racing the install's own download of the very same files. */
function warmTheCodecs() {
  warmCodecs();
}

/* Installed as an app, the OS can hand files straight here - right-click an
   image, "Open with Pocketsize". The launch queue is that handoff. */
if ("launchQueue" in window && window.launchQueue.setConsumer) {
  window.launchQueue.setConsumer(async (launch) => {
    const files = [];
    for (const handle of launch.files || []) {
      try { files.push(await handle.getFile()); } catch { /* skip the unreadable */ }
    }
    if (files.length) addFiles(files);
  });
}
