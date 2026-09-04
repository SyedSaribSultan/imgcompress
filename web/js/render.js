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
 *
 * Two things the frame budget alone does not solve:
 *
 * WHICH ROWS. Coalescing to one pass per frame still repaints every row in that
 * pass. At two hundred images that is two hundred rows redrawn because eight of
 * them moved, on the same main thread the workers are already saturating. So a
 * caller can name the item that changed, and renderQueue repaints only what is
 * in the dirty set. Naming nothing still means "all of it", because a caller
 * that does not know what moved must not be silently believed.
 *
 * WHETHER TO SCHEDULE AT ALL. requestAnimationFrame does not fire in a
 * backgrounded tab, and a batch of two hundred runs for minutes - people switch
 * away. Every worker message would keep setting flags against a frame that never
 * arrives, and the backlog resolves in one catch-up pass on return. While hidden,
 * the dirty marks are kept and no frame is asked for; coming back paints once,
 * synchronously, so the first thing seen is current rather than a frame stale.
 */

import { renderQueue } from "./queue.js";
import { renderStage } from "./compare.js";

const dirty = { queue: false, stage: false };
/* Which items changed. Empty with dirty.queue set means "every row" - the state
 * a caller reaches by not naming one, and the state a full repaint needs. */
const dirtyItems = new Set();
let allItemsDirty = false;
let scheduled = false;

/** The ids that changed since the last paint, or null for "all of them".
 *  Read by renderQueue; nothing else should need it. */
export function takeDirtyItems() {
  if (allItemsDirty || !dirtyItems.size) return null;
  return dirtyItems;
}

function paint() {
  const todo = { ...dirty };
  dirty.queue = dirty.stage = false;
  if (todo.queue) renderQueue();
  if (todo.stage) renderStage();
  dirtyItems.clear();
  allItemsDirty = false;
}

/** Repaint now, on this tick. Used where the next thing that happens must see the
 *  document already updated - the first frame after a drop, and the harness,
 *  which cannot assert on a frame that has not been drawn. */
export function renderNow() {
  allItemsDirty = true;
  renderQueue();
  renderStage();
  dirtyItems.clear();
  allItemsDirty = false;
}

/** Ask for a repaint. With no argument everything is redrawn; naming a part
 *  redraws only that, which is what the hot path during a batch uses. A second
 *  argument names the one item that changed, so a batch repaints the rows that
 *  moved rather than the whole list. */
export function scheduleRender(part, id) {
  if (part) dirty[part] = true;
  else dirty.queue = dirty.stage = true;

  /* A queue repaint with no id named is a repaint of everything: the caller is
     saying something changed without saying what, and guessing narrower than
     that is how a row goes stale on screen. */
  if (dirty.queue) {
    if (id == null) allItemsDirty = true;
    else dirtyItems.add(id);
  }

  if (scheduled) return;

  /* Hidden: keep the marks, ask for nothing. The frame would not come, and the
     flags would pile up until it did. */
  if (document.hidden) return;

  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    paint();
  });
}

/* Coming back from a backgrounded tab. Everything that happened while away is
   still marked, and it is painted at once rather than waiting for the next
   thing to change - a batch that finished in the background should be finished
   on screen the moment it is looked at. */
document.addEventListener("visibilitychange", () => {
  if (document.hidden || scheduled) return;
  if (!dirty.queue && !dirty.stage) return;
  paint();
});
