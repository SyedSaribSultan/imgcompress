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

import { $, toast } from "./dom.js";
import { state, current, select, isReady, isBusy, totals } from "./state.js";
import { scheduleRender, renderNow } from "./render.js";
import { human, splitName } from "./format.js";
import {
  loadSettings, currentSettings, saveSettings, reflectPlan, reflectQualityWords,
  onQualityPreset, onDestination, alphaQuestion,
} from "./settings.js";
import {
  startEngine, dispatch, requeue, removeItems, cancelAll, setBatchEndHandler, pool,
  holdWork,
} from "./engine.js";
import { addFiles, filesFromDataTransfer } from "./intake.js";
import { chooseCandidate } from "./views.js";
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

/* Three states, cycled on one button: match my device -> light -> dark. The
 * saved choice is applied before first paint by js/theme.js (a head script);
 * this is only the control. The button's visible word is the CURRENT state -
 * a control that showed the next state read as already being in it. */
const THEME_WORD = { "": "Match my device", light: "Light", dark: "Dark" };
const THEME_NEXT = { "": "light", light: "dark", dark: "" };

function reflectTheme() {
  const cur = document.documentElement.dataset.theme || "";
  const btn = $("theme-btn");
  btn.textContent = `Theme: ${THEME_WORD[cur]}`;
  btn.title = `Switch to ${THEME_WORD[THEME_NEXT[cur]]}`;
  btn.setAttribute("aria-label",
    `Theme: ${THEME_WORD[cur]}. Click to switch to ${THEME_WORD[THEME_NEXT[cur]]}.`);
}

function bindTheme() {
  $("theme-btn").addEventListener("click", () => {
    const next = THEME_NEXT[document.documentElement.dataset.theme || ""];
    if (next) document.documentElement.dataset.theme = next;
    else delete document.documentElement.dataset.theme;
    try {
      if (next) localStorage.setItem("imgc-theme", next);
      else localStorage.removeItem("imgc-theme");
    } catch { /* private browsing; the choice still holds for this visit */ }
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

  $("clear-btn").addEventListener("click", () => {
    if (state.items.some(isBusy)) cancelAll();
    removeItems(state.items.map((i) => i.id));
    toast("Cleared");
  });

  /* The whole window is the drop target. A drop zone that is only part of the
     page is a thing to aim at, and there is no reason to make anyone aim. */
  let dragDepth = 0;
  addEventListener("dragenter", (e) => {
    if (!e.dataTransfer?.types?.includes("Files")) return;
    dragDepth++;
    document.body.dataset.drag = "1";
  });
  addEventListener("dragover", (e) => {
    if (e.dataTransfer?.types?.includes("Files")) e.preventDefault();
  });
  addEventListener("dragleave", () => {
    if (--dragDepth <= 0) { dragDepth = 0; delete document.body.dataset.drag; }
  });
  addEventListener("drop", async (e) => {
    if (!e.dataTransfer?.types?.includes("Files")) return;
    e.preventDefault();
    dragDepth = 0;
    delete document.body.dataset.drag;
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
}

function bindQueue() {
  const list = $("queue-list");

  list.addEventListener("click", (e) => {
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

  // A resize changes the fit scale and therefore where the divider cuts.
  addEventListener("resize", () => { applyZoom(); applySplit(); });
}

function bindFacts() {
  $("cands").addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    const said = chooseCandidate(chip.dataset.format);
    if (said) { toast(said); scheduleRender(); }
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

/* The two keys worth having, and nothing that needs a legend to discover.
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
bindIntake();
bindPlan();
bindQueue();
bindStage();
bindFacts();
bindKeys();

setBatchEndHandler(() => {
  const t = totals();
  if (!t.ready) return;
  toast(`Done — ${t.ready} picture${t.ready === 1 ? "" : "s"} ready, `
    + `${human(t.saved)} smaller. Drag the line to check any of them.`);
});

// Ask what this browser can encode before anything is dropped, so the format
// control never offers something the engine would refuse.
startEngine();
scheduleRender();
dispatch();
