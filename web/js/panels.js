/* The person's own panel sizes.
 *
 * Two handles - the side panel's right edge and the file list's bottom edge -
 * draggable with any pointer and steppable with arrow keys, because a
 * separator that only a mouse can move is a control keyboard users can see
 * and not use. Sizes persist per browser; double-click (or Home) puts a panel
 * back to automatic.
 *
 * The sizes land as custom properties on <html> (--side-w, --queue-h) that
 * layout.css reads with automatic fallbacks - so "no stored size" and "reset"
 * are the same state, and the CSS defaults stay the single source of what
 * automatic means.
 */

import { $ } from "./dom.js";

const SIDE = { prop: "--side-w", key: "imgc-side-w", min: 260, max: 560, step: 16 };
const QUEUE = { prop: "--queue-h", key: "imgc-queue-h", min: 120, max: 720, step: 16 };

function put(cfg, px) {
  const v = Math.round(Math.min(cfg.max, Math.max(cfg.min, px)));
  document.documentElement.style.setProperty(cfg.prop, `${v}px`);
  try { localStorage.setItem(cfg.key, String(v)); } catch { /* fine */ }
  return v;
}

function reset(cfg) {
  document.documentElement.style.removeProperty(cfg.prop);
  try { localStorage.removeItem(cfg.key); } catch { /* fine */ }
}

function restore(cfg) {
  try {
    const saved = Number(localStorage.getItem(cfg.key));
    if (Number.isFinite(saved) && saved >= cfg.min && saved <= cfg.max) {
      document.documentElement.style.setProperty(cfg.prop, `${saved}px`);
    }
  } catch { /* unreadable storage is the same as none */ }
}

/** current rendered size of the panel the handle governs */
function sizeOf(cfg, panel) {
  const r = panel.getBoundingClientRect();
  return cfg === SIDE ? r.width : r.height;
}

function bindHandle(handle, panel, cfg, sign) {
  let from = null;   // { at: pointer coord, size: panel size when the drag began }

  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.dataset.dragging = "1";
    from = { at: cfg === SIDE ? e.clientX : e.clientY, size: sizeOf(cfg, panel) };
  });
  handle.addEventListener("pointermove", (e) => {
    if (!from) return;
    const delta = ((cfg === SIDE ? e.clientX : e.clientY) - from.at) * sign;
    put(cfg, from.size + delta);
  });
  const drop = () => { from = null; delete handle.dataset.dragging; };
  handle.addEventListener("pointerup", drop);
  handle.addEventListener("pointercancel", drop);

  handle.addEventListener("dblclick", () => reset(cfg));

  handle.addEventListener("keydown", (e) => {
    const grow = cfg === SIDE ? "ArrowRight" : "ArrowUp";
    const shrink = cfg === SIDE ? "ArrowLeft" : "ArrowDown";
    if (e.key === grow || e.key === shrink) {
      e.preventDefault();
      put(cfg, sizeOf(cfg, panel) + (e.key === grow ? cfg.step : -cfg.step));
    } else if (e.key === "Home") {
      e.preventDefault();
      reset(cfg);
    }
  });
}

export function bindPanels() {
  restore(SIDE);
  restore(QUEUE);
  // The side panel grows as the pointer moves right; the file list grows as its
  // bottom edge moves DOWN. Both are the same sign, and the handle's position
  // is what makes each read the right way round.
  bindHandle($("side-handle"), $("side"), SIDE, +1);
  bindHandle($("queue-handle"), $("queue-sec"), QUEUE, +1);
}
