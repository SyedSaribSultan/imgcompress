/* The two things every module needs from the document, and nothing else.
 *
 * `$` is by id on purpose. Every element this app addresses has one, so there is
 * no query-selector coupling to class names or nesting - a stylesheet can be
 * rewritten from scratch without breaking a single line of behaviour. That is
 * not a hypothetical: it is exactly what just happened to this app.
 */

export const $ = (id) => document.getElementById(id);

export const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Set text only when it changed. Writing the same string back is a layout
 *  invalidation for nothing, and these run on every frame of a batch. */
export function setText(el, text) {
  if (el && el.textContent !== text) el.textContent = text;
}

/** Show or hide, and say so to assistive tech at the same time. `hidden` is the
 *  single carrier of visibility here - there is no CSS class that also hides
 *  things, so there is no way for the two to disagree. */
export function show(el, on) {
  if (el) el.hidden = !on;
}

/** A transient acknowledgement. Never the only place something is said: a
 *  failure also lands on the row it belongs to, and this is the receipt. */
let toastTimer;
export function toast(message) {
  const el = $("toast");
  if (!el || !message) return;
  el.textContent = message;
  el.dataset.up = "1";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { delete el.dataset.up; }, 3200);
}
