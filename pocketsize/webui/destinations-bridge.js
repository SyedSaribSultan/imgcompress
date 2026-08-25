/* COPIED from web/js/destinations-bridge.js by tools/sync_webui_assets.py - DO NOT EDIT.
 * Edit the file in web/ and re-run the tool; CI fails on a stale copy. */
/* Hands destinations.js over to the module graph.
 *
 * destinations.js is generated from pocketsize/destinations.py and has to stay a
 * classic script, because worker.js pulls in the very same file with
 * importScripts and that cannot take a module. Its top-level `const` bindings do
 * technically reach module code through the global lexical scope, but relying on
 * that is relying on a subtlety - so the handover is explicit and lives here.
 *
 * This is a separate file rather than an inline <script> for one specific reason:
 * the site is served under a Content-Security-Policy with no 'unsafe-inline', so
 * an inline script needs its sha256 listed in the header. That hash then has to be
 * recomputed by hand every time the script changes, and a stale one fails only in
 * production. A file is covered by 'self' and cannot go stale.
 */

"use strict";

window.DESTINATIONS = {
  DEFAULT_DESTINATION,
  DESTINATION_ORDER,
  DESTINATION_FORMATS,
  DESTINATION_NUMBERS,
  /* Video's own columns of the same table. A destination missing from these
     two takes no video at all, which is a fact the table states rather than
     something this app decides. */
  DESTINATION_VIDEO_FORMATS,
  DESTINATION_VIDEO_NUMBERS,
  OLD_TARGET_NAMES,
  DOCUMENTS_MAX_DIMENSION,
  destinationOf,
};
