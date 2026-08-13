/* The theme, resolved and applied before first paint.
 *
 * A classic script loaded from <head>, on purpose: a module would be deferred
 * past the first paint, and someone who chose dark would watch the page flash
 * light on every visit. Classic scripts in the head block rendering, which is
 * exactly the property wanted here - the work is two property reads.
 *
 * The token layer (heyoz-tokens.css) flips its palette on data-theme="dark" /
 * "light" and knows nothing about prefers-color-scheme. So the three states
 * the header button offers - Light, Dark, Match my device - are resolved HERE:
 * an explicit choice is stamped as itself, and "match my device" is stamped as
 * whatever the OS currently answers, re-stamped live if that answer changes.
 * The choice (the MODE) lives in localStorage; the stamp is always the
 * resolved result, so the stylesheet never has an unstamped state to style.
 *
 * The header button that cycles the mode lives in main.js; it calls
 * window.__applyTheme after writing the new mode.
 */

"use strict";

(function () {
  var media = matchMedia("(prefers-color-scheme: dark)");

  function mode() {
    // The in-memory choice wins: it is what makes the button work for this
    // visit even where storage is refused (private browsing).
    if (typeof window.__themeMode === "string") {
      return window.__themeMode === "light" || window.__themeMode === "dark"
        ? window.__themeMode : "";
    }
    try {
      var saved = localStorage.getItem("imgc-theme");
      if (saved === "light" || saved === "dark") return saved;
    } catch (e) { /* private browsing; fall through to the OS */ }
    return "";
  }

  function apply() {
    var chosen = mode();
    document.documentElement.dataset.theme =
      chosen || (media.matches ? "dark" : "light");
  }

  apply();
  // Older engines only have addListener; both receive the same handler.
  if (media.addEventListener) media.addEventListener("change", apply);
  else if (media.addListener) media.addListener(apply);

  // The seam main.js drives after the button writes a new mode.
  window.__applyTheme = apply;
})();
