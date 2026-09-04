/* The plan's dropdowns, dressed in the product's own clothes.
 *
 * A native <select> opens the operating system's popup, and no page can style
 * that list - so the only way for the open menu to look like the rest of this
 * app is to draw it. That is a real cost: the native control brings keyboard
 * navigation, type-ahead, touch, the mobile picker sheet and screen-reader
 * semantics for nothing, and every one of them has to be earned back by hand.
 *
 * So this is an ENHANCEMENT, not a replacement. The <select> stays in the
 * document, keeps its id, keeps its options, and remains the model: every
 * `.value` read, every `selectedOptions` lookup and every `change` listener in
 * settings.js goes on working untouched, and this file never became a second
 * place that knows what the plan is. It is hidden from sight and from the
 * accessibility tree, a button and a listbox are drawn beside it, and choosing
 * an option writes back to the select and dispatches the same `change` event
 * the platform would have.
 *
 * That shape is what makes the failure modes survivable. If this module throws
 * on load, if the browser is too old for :has() or popover, if JavaScript is
 * off entirely - the native control is still there, still styled, still
 * working. The interface gets less pretty and stays completely usable.
 *
 * Coarse pointers keep the native control on purpose. A phone's select opens a
 * full-height sheet with momentum scrolling and a big hit area, which is better
 * than anything drawn in a 320px-wide sidebar; replacing it with a floating div
 * would be losing to win an argument about styling.
 *
 * Keyboard model, per the ARIA combobox/listbox pattern:
 *
 *   closed   Enter, Space, Down, Up, Alt+Down   open
 *            Home, End                          open at the first/last option
 *            printable characters               open and jump (type-ahead)
 *   open     Up, Down                           move the active option
 *            Home, End                          first, last
 *            Enter, Space, Tab                  commit the active option
 *            Escape                             close, commit nothing
 *            printable characters               type-ahead within the list
 *
 * Focus never leaves the button while the list is open: the list is
 * `aria-activedescendant`-driven, so a screen reader follows the active option
 * without the focus ring going somewhere the eye cannot see.
 */

import { $ } from "./dom.js";

/* How long a run of keystrokes counts as one word. The platform's own
   type-ahead uses about this, and the point is that "pn" finds "PNG" while a
   pause then "g" starts again at "GIF". */
const TYPE_AHEAD_MS = 800;

/** Every enhanced control, so a re-render can refresh their labels. */
const pickers = new Map();   // select element -> controller

let openPicker = null;

/* One listener for the whole document rather than one per control: an outside
   click closes whatever is open, and there is never more than one. */
function closeOnOutside(e) {
  if (!openPicker) return;
  if (!openPicker.root.contains(e.target)) openPicker.close(false);
}
document.addEventListener("pointerdown", closeOnOutside, true);
/* A scroll anywhere outside the list closes it. An absolutely-positioned menu
   that stays put while the page moves under it is worse than one that goes. */
window.addEventListener("scroll", () => openPicker?.close(false), true);
window.addEventListener("resize", () => openPicker?.close(false));

/** The options a select currently offers, skipping the ones it is hiding. */
function readOptions(sel) {
  return [...sel.options]
    .filter((o) => !o.hidden)
    .map((o) => ({
      value: o.value,
      label: o.textContent.trim(),
      title: o.title || "",
      disabled: o.disabled,
    }));
}

function build(sel) {
  const root = document.createElement("div");
  root.className = "picker";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "picker-btn";
  button.id = `${sel.id}-btn`;
  button.setAttribute("aria-haspopup", "listbox");
  button.setAttribute("aria-expanded", "false");

  const value = document.createElement("span");
  value.className = "picker-value";
  button.append(value);

  const list = document.createElement("div");
  list.className = "picker-list";
  list.id = `${sel.id}-list`;
  list.setAttribute("role", "listbox");
  list.hidden = true;

  /* The button is labelled by the same <label> the select had. Without this the
     accessible name would be the current VALUE and nothing would ever say which
     question it answers. */
  const label = sel.labels && sel.labels[0];
  if (label) {
    if (!label.id) label.id = `${sel.id}-label`;
    button.setAttribute("aria-labelledby", `${label.id} ${button.id}`);
    /* Clicking the label should open the control it labels. The native <label>
       association points at the hidden select, so it is re-pointed by hand. */
    label.addEventListener("click", (e) => { e.preventDefault(); button.focus(); });
  }

  root.append(button, list);
  sel.after(root);

  const ctl = { root, button, list, value, sel, options: [], active: -1, typed: "", typedAt: 0 };

  /* ------------------------------ rendering ------------------------------ */

  ctl.paint = () => {
    ctl.options = readOptions(sel);
    const current = sel.selectedOptions[0];
    value.textContent = current ? current.textContent.trim() : "";
    button.title = current ? (current.title || current.textContent.trim()) : "";
    button.disabled = sel.disabled;

    list.replaceChildren(...ctl.options.map((o, i) => {
      const item = document.createElement("div");
      item.className = "picker-opt";
      item.id = `${sel.id}-opt-${i}`;
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(o.value === sel.value));
      if (o.disabled) item.setAttribute("aria-disabled", "true");
      item.dataset.value = o.value;
      if (o.title) item.title = o.title;
      item.textContent = o.label;
      return item;
    }));
  };

  const setActive = (i) => {
    const items = [...list.children];
    if (!items.length) return;
    ctl.active = Math.max(0, Math.min(items.length - 1, i));
    items.forEach((el, n) => el.classList.toggle("is-active", n === ctl.active));
    const el = items[ctl.active];
    button.setAttribute("aria-activedescendant", el.id);
    /* nearest, not center: a list that jumps the active option to the middle on
       every arrow press makes the whole menu move under a reader who is only
       stepping one row. */
    el.scrollIntoView({ block: "nearest" });
  };

  /* -------------------------------- opening ------------------------------ */

  ctl.open = (startAt) => {
    if (button.disabled || openPicker === ctl) return;
    openPicker?.close(false);
    ctl.paint();
    list.hidden = false;
    root.dataset.open = "1";
    button.setAttribute("aria-expanded", "true");
    button.setAttribute("aria-controls", list.id);
    openPicker = ctl;

    /* Open with the current choice active, so the first arrow press moves from
       where you are rather than from the top of the list. */
    const i = startAt != null
      ? startAt
      : Math.max(0, ctl.options.findIndex((o) => o.value === sel.value));
    setActive(i);

    /* Where it opens, and how tall it may be - both measured, because a list of
       seven destinations near the bottom of a short window would otherwise open
       off the screen or be clipped by the sidebar's own scroller.

       It goes to whichever side has more room and is then capped to that room,
       so the list always fits the viewport and scrolls inside itself rather
       than relying on an ancestor not to clip it. */
    const GAP = 8;
    const r = button.getBoundingClientRect();
    const below = innerHeight - r.bottom - GAP;
    const above = r.top - GAP;
    const up = below < Math.min(list.scrollHeight, 320) && above > below;
    root.dataset.drop = up ? "up" : "down";
    list.style.setProperty("--picker-max", `${Math.max(96, up ? above : below)}px`);
    /* And how far right it may run before the window edge. The sidebar clips
       its own overflow, so the list is positioned to escape it: fixed to the
       viewport, at the button's own coordinates. That is what lets a menu be
       wider than the 147px column it belongs to without the panel cutting it
       off, and why the position has to be rewritten every time it opens. */
    const room = innerWidth - r.left - GAP;
    list.style.setProperty("--picker-wide", `${Math.max(180, Math.min(360, room))}px`);
    list.style.left = `${r.left}px`;
    list.style.minWidth = `${r.width}px`;
    if (up) {
      list.style.top = "auto";
      list.style.bottom = `${innerHeight - r.top + 4}px`;
    } else {
      list.style.bottom = "auto";
      list.style.top = `${r.bottom + 4}px`;
    }
  };

  ctl.close = (refocus) => {
    if (openPicker === ctl) openPicker = null;
    list.hidden = true;
    delete root.dataset.open;
    button.setAttribute("aria-expanded", "false");
    button.removeAttribute("aria-activedescendant");
    ctl.active = -1;
    if (refocus) button.focus();
  };

  /** Write the choice back to the select, which is the model. */
  ctl.commit = (i) => {
    const o = ctl.options[i];
    if (!o || o.disabled) return;
    const changed = sel.value !== o.value;
    sel.value = o.value;
    ctl.paint();
    ctl.close(true);
    /* The same event the platform fires, so every existing listener in
       settings.js runs exactly as it did with a native select. bubbles:true
       because some of them are bound on a container. */
    if (changed) sel.dispatchEvent(new Event("change", { bubbles: true }));
  };

  /* ------------------------------ type-ahead ----------------------------- */

  const typeAhead = (ch) => {
    const now = performance.now();
    ctl.typed = (now - ctl.typedAt > TYPE_AHEAD_MS) ? ch : ctl.typed + ch;
    ctl.typedAt = now;
    const from = ctl.active < 0 ? 0 : ctl.active;
    const n = ctl.options.length;
    /* Search forward from the active option and wrap, so repeated presses of
       the same letter walk through every option starting with it. */
    const start = ctl.typed.length === 1 ? from + 1 : from;
    for (let k = 0; k < n; k++) {
      const i = (start + k) % n;
      const o = ctl.options[i];
      if (!o.disabled && o.label.toLowerCase().startsWith(ctl.typed)) return i;
    }
    return -1;
  };

  /* -------------------------------- events ------------------------------- */

  button.addEventListener("click", () => {
    if (openPicker === ctl) ctl.close(true); else ctl.open();
  });

  button.addEventListener("keydown", (e) => {
    const isOpen = openPicker === ctl;
    const k = e.key;

    if (!isOpen) {
      if (k === "Enter" || k === " " || k === "ArrowDown" || k === "ArrowUp") {
        e.preventDefault(); ctl.open(); return;
      }
      if (k === "Home") { e.preventDefault(); ctl.open(0); return; }
      if (k === "End") { e.preventDefault(); ctl.open(readOptions(sel).length - 1); return; }
      if (k.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        ctl.open();
        const i = typeAhead(k.toLowerCase());
        if (i >= 0) setActive(i);
        return;
      }
      return;
    }

    switch (k) {
      case "ArrowDown": e.preventDefault(); setActive(ctl.active + 1); break;
      case "ArrowUp": e.preventDefault(); setActive(ctl.active - 1); break;
      case "Home": e.preventDefault(); setActive(0); break;
      case "End": e.preventDefault(); setActive(ctl.options.length - 1); break;
      case "Enter":
      case " ":
        e.preventDefault(); ctl.commit(ctl.active); break;
      case "Escape":
        e.preventDefault();
        /* Escape must not also close a dialog or leave focus mode behind this
           control - the list is the innermost thing open, so it eats the key. */
        e.stopPropagation();
        ctl.close(true);
        break;
      case "Tab":
        /* Tab commits and then moves on, which is what a native select does.
           Not prevented: the focus should still travel. */
        ctl.commit(ctl.active);
        break;
      default:
        if (k.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
          e.preventDefault();
          const i = typeAhead(k.toLowerCase());
          if (i >= 0) setActive(i);
        }
    }
  });

  /* Pointer: highlight follows the cursor, and the click commits. mousedown is
     prevented so the button never loses focus mid-press - losing it would fire
     the outside-close handler before the click landed. */
  list.addEventListener("mousedown", (e) => e.preventDefault());
  list.addEventListener("mouseover", (e) => {
    const item = e.target.closest(".picker-opt");
    if (item) setActive([...list.children].indexOf(item));
  });
  list.addEventListener("click", (e) => {
    const item = e.target.closest(".picker-opt");
    if (item) ctl.commit([...list.children].indexOf(item));
  });

  /* The app changes these selects from code - a destination swap rebuilds the
     format list, a preset writes a value. Both paths already end in a change
     event or a reflect pass, so the visible control follows the model rather
     than needing every writer to know it exists. */
  sel.addEventListener("change", () => ctl.paint());

  ctl.paint();
  return ctl;
}

/** Repaint every enhanced control from its select. Called after the app
 *  rebuilds options or writes values without dispatching change. */
export function refreshPickers() {
  for (const ctl of pickers.values()) ctl.paint();
}

/** Enhance the plan's selects. Safe to call once, at boot.
 *
 *  Coarse pointers are left alone: the platform's own picker sheet beats
 *  anything this can draw in a narrow sidebar. The check is a media query
 *  rather than a user-agent sniff, and it is evaluated once - a control that
 *  swapped shape when a laptop's touchscreen was tapped would be worse than
 *  either choice on its own.
 */
export function bindPickers() {
  if (window.matchMedia("(pointer: coarse)").matches) return;

  for (const sel of document.querySelectorAll("#plan-sec select")) {
    if (pickers.has(sel)) continue;
    /* The select stays in the document as the model, out of sight and out of
       the accessibility tree so a screen reader does not meet the same control
       twice. Not `hidden`, and not display:none: a form control removed from
       layout cannot be focused, and the label click handler above depends on
       the element still being real. */
    sel.classList.add("picker-native");
    sel.setAttribute("aria-hidden", "true");
    sel.tabIndex = -1;
    pickers.set(sel, build(sel));
  }
}
