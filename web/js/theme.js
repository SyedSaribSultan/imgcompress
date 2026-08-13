/* The theme, applied before first paint.
 *
 * A classic script loaded from <head>, on purpose: a module would be deferred
 * past the first paint, and someone who chose dark would watch the page flash
 * light on every visit. Classic scripts in the head block rendering, which is
 * exactly the property wanted here - the work is two property reads.
 *
 * Three states. "Match my device" is the default and stamps nothing, so the
 * CSS's prefers-color-scheme rules decide. An explicit choice stamps
 * data-theme on <html>, and the stylesheet gives the stamp priority over the
 * OS in both directions. The header button that cycles these lives in main.js;
 * this file only makes the saved choice true before anything is drawn.
 */

"use strict";

(function () {
  var saved = null;
  try { saved = localStorage.getItem("imgc-theme"); } catch (e) { /* fine */ }
  if (saved === "light" || saved === "dark") {
    document.documentElement.dataset.theme = saved;
  }
})();
