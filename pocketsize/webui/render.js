/* COPIED from web/js/render.js by tools/sync_webui_assets.py - DO NOT EDIT.
 * Edit the file in web/ and re-run the tool; CI fails on a stale copy. */
/* One render pass per frame, no matter how many things asked for one.
 *
 * A batch of twenty images produces hundreds of worker messages a second, and
 * every one of them changes something on screen. Rendering synchronously on each
 * made the page stutter while the workers were already saturating the machine, so
 * callers mark what is dirty and the browser decides when to paint it.
 *
 * This module is the only thing that imports the three renderers, and nothing
 * imports it except the modules that cause change. That is what keeps the
 * dependency graph a graph: renderers never reach back.
 */

import { renderQueue } from "./queue.js";
import { renderStage } from "./compare.js";
import { renderFacts } from "./facts.js";

const dirty = { queue: false, stage: false, facts: false };
let scheduled = false;

/** Repaint now, on this tick. Used where the next thing that happens must see the
 *  document already updated - the first frame after a drop, and the harness,
 *  which cannot assert on a frame that has not been drawn. */
export function renderNow() {
  renderQueue();
  renderStage();
  renderFacts();
}

/** Ask for a repaint. With no argument everything is redrawn; naming a part
 *  redraws only that, which is what the hot path during a batch uses. */
export function scheduleRender(part) {
  if (part) dirty[part] = true;
  else dirty.queue = dirty.stage = dirty.facts = true;

  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    const todo = { ...dirty };
    dirty.queue = dirty.stage = dirty.facts = false;
    if (todo.queue) renderQueue();
    if (todo.stage) renderStage();
    if (todo.facts) renderFacts();
  });
}
