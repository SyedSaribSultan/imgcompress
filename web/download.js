/* The platform highlight on download.html, and the only script that page runs.
 *
 * It is a file rather than an inline script because the site's Content Security
 * Policy allows exactly one inline script - the theme bootstrap, by hash - so a
 * second one would be refused and logged as an error in every visitor's
 * console. Nothing else here needs scripting: with JavaScript off, all three
 * builds are still listed, still labelled and still one click from the releases
 * page. That is why this only ever adds a hint, and never hides, reorders or
 * disables a card.
 *
 * The guess is deliberately shallow, and the label says "probably" because of
 * it. A Mac reports "MacIntel" whether or not there is an Intel chip inside it,
 * so the architecture is asked for properly where a browser will answer
 * (Chromium's high-entropy client hints, which arrive as a promise) and assumed
 * to be Apple silicon where it will not - every Mac sold since late 2020 is
 * one. Anything unrecognised, Linux included, gets no highlight rather than a
 * wrong one; the page says in words that Linux installs with pip.
 */

"use strict";

function markLikely(os) {
  const card = document.querySelector(`.dl-card[data-os="${os}"]`);
  if (!card) return;
  card.classList.add("likely");
  const tag = card.querySelector(".dl-you");
  if (tag) tag.hidden = false;
}

const hints = navigator.userAgentData;
const platform = (hints && hints.platform) || navigator.platform || "";

if (/win/i.test(platform)) {
  markLikely("windows");
} else if (/mac/i.test(platform)) {
  if (hints && hints.getHighEntropyValues) {
    hints.getHighEntropyValues(["architecture"])
      .then((more) => markLikely(more.architecture === "x86" ? "mac-intel" : "mac-arm"))
      .catch(() => markLikely("mac-arm"));
  } else {
    markLikely("mac-arm");
  }
}
