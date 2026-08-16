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

const VERSION = "v4";
const SHELL = `pocketsize-shell-${VERSION}`;
const HEAVY = `pocketsize-heavy-${VERSION}`;

/* Everything the page needs to boot cold, warmed on install so "visited once"
 * means "works offline", not "works offline for the parts you happened to
 * touch". */
const PRECACHE = [
  "/",
  "/heyoz-tokens.css",
  "/fonts.css",
  "/css/base.css", "/css/media-accent.css", "/css/layout.css", "/css/controls.css",
  "/css/queue.css", "/css/compare.css", "/css/facts.css",
  "/destinations.js",
  "/js/destinations-bridge.js", "/js/theme.js", "/js/dom.js", "/js/format.js",
  "/js/state.js", "/js/views.js", "/js/render.js", "/js/settings.js",
  "/js/intake.js", "/js/engine.js", "/js/queue.js", "/js/compare.js",
  "/js/facts.js", "/js/save.js", "/js/panels.js", "/js/main.js",
  "/worker.js",
  "/video-worker.js",
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
  "/compress-video",
  "/compress-video-for-discord",
  "/compress-video-for-email",
]);

const HEAVY_PRECACHE = [
  "/vendor/mozjpeg.js", "/vendor/mozjpeg_enc.wasm",
  "/vendor/oxipng.js", "/vendor/squoosh_oxipng_bg.wasm",
  "/vendor/webp.js", "/vendor/webp_enc_simd.wasm",
  "/vendor/mediabunny.min.js",
  "/vendor/avif.js", "/vendor/avif_enc.wasm",
  "/fonts/geist-latin.woff2", "/fonts/geist-latin-ext.woff2",
  "/fonts/geist-mono-latin.woff2", "/fonts/geist-mono-latin-ext.woff2",
  "/fonts/bricolage-grotesque-latin.woff2", "/fonts/bricolage-grotesque-latin-ext.woff2",
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
    await self.skipWaiting();
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
         there are thirteen of them and precaching all of them would cost
         every visitor several hundred kilobytes for twelve pages they will
         never open. Someone who arrived at /compress-video and comes back
         offline gets the page they actually used, with its plan already set,
         instead of being bounced to the generic app. The list is finite and
         known, so this cannot grow without bound either. */
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
