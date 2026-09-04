/* The offline layer. The app is fully client-side, so after one visit it can
 * be fully offline - the whole compressor, codecs included, with no network.
 * That is the "nothing is uploaded" promise made physical.
 *
 * Strategy, chosen for a site with no build step and therefore no hashed
 * filenames:
 *
 *   - The app shell (HTML, CSS, JS, generated tables) is NETWORK-FIRST with a
 *     cache fallback: online visitors always get the latest deploy, offline
 *     visitors get the last one they saw. Nothing here is stale-while-online.
 *   - The heavy, rarely-changing payloads (wasm codecs, faces, icons) are
 *     CACHE-FIRST: they are versioned by their content's nature, and
 *     re-downloading 4MB of codec on every visit would tax exactly the
 *     low-bandwidth people this app serves.
 *
 * VERSION is bumped by hand when the cached set's SHAPE changes (a file added
 * or removed). Content changes need no bump - network-first refreshes the
 * shell, and a codec change ships under a new filename or not at all.
 */

"use strict";

const VERSION = "v14";
const SHELL = `pocketsize-shell-${VERSION}`;
const HEAVY = `pocketsize-heavy-${VERSION}`;

/* Everything the page needs to boot cold, warmed on install so "visited once"
 * means "works offline", not "works offline for the parts you happened to
 * touch". */
const PRECACHE = [
  "/",
  "/heyoz-tokens.css",
  "/fonts.css",
  "/css/base.css", "/css/layout.css", "/css/controls.css",
  "/css/queue.css", "/css/compare.css",
  "/destinations.js",
  "/js/destinations-bridge.js", "/js/theme.js", "/js/dom.js", "/js/format.js",
  "/js/state.js", "/js/views.js", "/js/render.js", "/js/settings.js",
  "/js/intake.js", "/js/engine.js", "/js/queue.js", "/js/compare.js",
  "/js/save.js", "/js/panels.js", "/js/picker.js", "/js/main.js",
  "/worker.js",
  "/ss2.module.js", "/ss2.js",
  "/site.webmanifest", "/favicon.svg", "/favicon.ico",
  "/icon-192.png", "/icon-512.png",
];

const PRECACHE_SET = new Set(PRECACHE);

/* The use-case pages, cached on first visit rather than up front - see the
   fetch handler for why. GENERATED: tools/gen_seo_pages.py writes this list
   from the same PAGES table it builds the pages and the sitemap from, and
   `--check` fails if they drift. Never hand-edit it; add a page to PAGES and
   re-run the generator. */
const USE_CASE_PAGES = new Set([
  "/compress-to-200kb",
  "/compress-to-100kb",
  "/compress-to-50kb",
  "/compress-to-1mb",
  "/compress-jpeg",
  "/compress-png",
  "/compress-webp",
  "/png-to-avif",
  "/compress-for-email",
  "/bulk-image-compressor",
]);

/* What the install BLOCKS on: the shell's own weight, the three small codecs,
 * and the two faces the page paints with. Everything here has to land before
 * "ready to work offline" can honestly be announced. */
const HEAVY_PRECACHE = [
  "/vendor/mozjpeg.js", "/vendor/mozjpeg_enc.wasm",
  "/vendor/oxipng.js", "/vendor/squoosh_oxipng_bg.wasm",
  "/vendor/webp.js", "/vendor/webp_enc_simd.wasm",
  "/fonts/caveat-latin.woff2", "/fonts/caveat-latin-ext.woff2", "/fonts/geist-mono-latin.woff2", "/fonts/geist-mono-latin-ext.woff2",
];

/* And what it does NOT block on. avif_enc.wasm is 3,485,872 bytes - 1,116,248
 * over the wire, about 64% of everything a first visit downloads - for an
 * encoder that competes on some destinations and that many visitors will never
 * choose. Waiting for it means the offline promise is not kept until the
 * largest file in the app has landed.
 *
 * It is still cached, just not as a precondition: the install kicks this off
 * and does not await it. That distinction is the whole fix, and it has to live
 * HERE rather than in the page, because the page cannot do it. The compression
 * worker loads codecs with importScripts, and a worker created before the
 * service worker took control is an uncontrolled client - its fetches bypass
 * the fetch handler entirely and are never cached. Measured: fromServiceWorker
 * was false for every codec, and avif_enc.wasm was missing from the cache
 * afterwards even though the app had just used it. Deferring it to a page-side
 * idle callback therefore did not defer the download at all; it only stopped
 * the file being stored. */
const HEAVY_DEFERRED = [
  "/vendor/avif.js", "/vendor/avif_enc.wasm",
];

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const [shell, heavy] = await Promise.all([caches.open(SHELL), caches.open(HEAVY)]);
    // addAll is atomic per cache; a 404 anywhere fails the install loudly
    // rather than shipping an offline mode with a hole in it.
    //
    // The shell set is fetched with cache: "reload" - straight from the
    // network, never the HTTP cache - because css/js are HTTP-cacheable for an
    // hour, and an install right after a deploy could otherwise atomically
    // precache brand-new HTML next to hour-old CSS. The heavy set keeps the
    // default mode on purpose: those files change under new filenames or not
    // at all, so an HTTP-cached copy is always the right copy.
    await Promise.all([
      shell.addAll(PRECACHE.map((u) => new Request(u, { cache: "reload" }))),
      heavy.addAll(HEAVY_PRECACHE),
    ]);
    /* The offline copy is now genuinely written, and that is a different moment
       from any the page can observe for itself: skipWaiting() and
       clients.claim() below mean this worker takes control part-way through
       activating, so both `controllerchange` and `navigator.serviceWorker.ready`
       resolve while the caches above may still be filling. Measured on a cold
       profile: control at ~536ms, install finished at ~933ms. Anything the page
       holds back "until the cache is ready" has to wait for this message. */
    for (const client of await self.clients.matchAll({ includeUncontrolled: true })) {
      client.postMessage({ type: "precached" });
    }
    await self.skipWaiting();

    /* Started, deliberately NOT awaited, and deliberately after skipWaiting -
       so the big codec downloads in the background while the app is already
       usable and already offline-capable. A failure here is not an install
       failure: no AVIF in the cache means the first job that wants it fetches
       it, which is exactly the behaviour before any of this. */
    heavy.addAll(HEAVY_DEFERRED).catch(() => {});
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key !== SHELL && key !== HEAVY) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;

  const heavy = url.pathname.startsWith("/vendor/") || url.pathname.startsWith("/fonts/");

  if (heavy) {
    // Cache-first: the codec you already have is the codec you need.
    e.respondWith((async () => {
      const hit = await caches.match(e.request);
      if (hit) return hit;
      const fresh = await fetch(e.request);
      if (fresh.ok) (await caches.open(HEAVY)).put(e.request, fresh.clone());
      return fresh;
    })());
    return;
  }

  // Network-first: deploys arrive on the next visit, offline gets the last one.
  e.respondWith((async () => {
    const hit = await caches.match(e.request, { ignoreSearch: url.pathname === "/" });
    try {
      /* When an offline copy exists, the network gets a few seconds and no
         more. A hanging connection (connected, but nothing moving) used to
         hold a fully-cached returning visitor on a blank page until the
         network stack gave up - the exact failure the offline layer exists to
         prevent. With no cached copy there is nothing to fall back to, so the
         fetch gets all the time it needs. */
      let fresh;
      if (hit) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 3500);
        try {
          fresh = await fetch(e.request, { signal: ctrl.signal });
        } finally {
          clearTimeout(timer);
        }
      } else {
        fresh = await fetch(e.request);
      }
      /* Only the shell's own files are written back. Caching every ok same-
         origin GET let any query-string variant of any URL grow the cache
         without bound; the offline set is the precache list, exactly. The
         entry is keyed by pathname so "/?anything" refreshes "/" instead of
         multiplying.

         The use-case pages are added on first visit rather than precached:
         precaching all of them would cost every visitor several hundred
         kilobytes for pages they will never open. Someone who arrived at
         /compress-jpeg and comes back offline gets the page they actually
         used, with its plan already set, instead of being bounced to the
         generic app. The list is finite and known, so this cannot grow
         without bound either. */
      if (fresh.ok && (PRECACHE_SET.has(url.pathname)
                       || USE_CASE_PAGES.has(url.pathname))) {
        (await caches.open(SHELL)).put(url.pathname, fresh.clone());
      }
      return fresh;
    } catch {
      if (hit) return hit;
      // A navigation with no cache entry still deserves the app, not a
      // browser error page - "/" is always precached.
      if (e.request.mode === "navigate") {
        const shell = await caches.match("/");
        if (shell) return shell;
      }
      throw new Error("offline, and never cached");
    }
  })());
});
