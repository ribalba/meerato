/* Service worker: offline support without serving stale app code.
 *
 * Strategy:
 *   - Navigations (the app shell): STALE-WHILE-REVALIDATE. We serve the cached
 *     shell immediately so the splash paints instantly (even offline / on a cold
 *     worker), then refresh the cache in the background so code/markup edits land
 *     on the next load. Navigation preload supplies that background refresh fetch.
 *   - Other same-origin requests (static assets, API GETs): NETWORK-FIRST. We
 *     always try the network so data and assets are fresh, falling back to cache
 *     only when offline.
 *   - Cross-origin CDN libs: cache-first — their URLs are version-pinned, so a
 *     cached copy is always correct and this keeps them available offline.
 *   - Writes (non-GET): never intercepted; the app queues them in IndexedDB.
 *
 * Bump VERSION whenever the precache list changes to evict old caches.
 */
const VERSION = "todo-v41";

// Query params a share_target navigation arrives with (see manifest.webmanifest).
const SHARE_PARAMS = ["share_title", "share_text", "share_url"];

// Same-origin shell: small and local, so precaching these is fast and safe to
// block install on.
//
// Note: "/" is deliberately NOT precached here. Fetching it during install
// competes with the in-flight navigation for the same URL and couples install
// completion (and therefore SW readiness) to a network fetch of the very
// document being loaded — a self-inflicted multi-second stall. The network-first
// handler below caches "/" on the first successful navigation anyway, so the
// offline shell fallback still works after one online load.
const LOCAL_SHELL = [
  "/static/css/app.css",
  "/static/js/db.js",
  "/static/js/api.js",
  "/static/js/sync.js",
  "/static/js/markdown.js",
  "/static/js/app.core.js",
  "/static/js/app.shell.js",
  "/static/js/app.quickadd.js",
  "/static/js/app.list.js",
  "/static/js/app.dnd.js",
  "/static/js/app.detail.js",
  "/static/js/app.watching.js",
  "/static/js/app.automation.js",
  "/static/js/app.apipage.js",
  "/static/js/app.boot.js",
  "/static/logo-192.png",
  "/manifest.webmanifest",
];

// Cross-origin CDN libs: precached in the background so a slow CDN fetch never
// delays install/activation (which would queue the very navigation that boots us).
const CDN_SHELL = [
  "https://cdn.jsdelivr.net/npm/fomantic-ui@2.9.3/dist/semantic.min.css",
  "https://cdn.jsdelivr.net/npm/fomantic-ui@2.9.3/dist/semantic.min.js",
  "https://cdn.jsdelivr.net/npm/jquery@3.7.1/dist/jquery.min.js",
  "https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js",
  "https://cdn.jsdelivr.net/npm/sortablejs@1.15.6/Sortable.min.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) => {
      // Warm the CDN cache in the background — do NOT await it, so install
      // (and therefore the controlled navigation) isn't held up by the CDN.
      Promise.allSettled(CDN_SHELL.map((url) => cache.add(url)));
      // Only block install on the fast, local shell.
      return Promise.allSettled(LOCAL_SHELL.map((url) => cache.add(url)));
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Let the browser race the network for navigations while we boot.
      if (self.registration.navigationPreload) {
        await self.registration.navigationPreload.enable();
      }
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

function putInCache(request, response) {
  const copy = response.clone();
  caches.open(VERSION).then((c) => c.put(request, copy)).catch(() => {});
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return; // writes go straight to the network

  const url = new URL(request.url);

  // Cross-origin (version-pinned CDN libs): cache-first.
  if (url.origin !== self.location.origin) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ||
          fetch(request).then((resp) => {
            putInCache(request, resp);
            return resp;
          })
      )
    );
    return;
  }

  // Navigations: stale-while-revalidate. Serve the cached shell instantly (so the
  // splash paints with no network wait), then refresh the cache in the background.
  if (request.mode === "navigate") {
    // A share_target navigation is the app shell carrying a one-off payload in its
    // query string (the page reads it from location.search). So serve it from the
    // shell's own cache entry, and never cache the URL itself. Otherwise every
    // single share would leave behind a dead entry that lives until the next
    // VERSION bump.
    const isShare = SHARE_PARAMS.some((p) => url.searchParams.has(p));

    event.respondWith(
      (async () => {
        // Exact match only — never serve the cached app shell in place of, say,
        // a /t/{token} share page that just hasn't been cached yet.
        const cached = await caches.match(isShare ? "/" : request);

        const refresh = (async () => {
          try {
            // Navigation preload already fired this fetch in parallel; use it.
            const preloaded = await event.preloadResponse;
            const resp = preloaded || (await fetch(request));
            if (!isShare) putInCache(request, resp);
            return resp;
          } catch (e) {
            return null;
          }
        })();

        if (cached) {
          // Keep the worker alive for the background refresh, but don't wait on it.
          event.waitUntil(refresh);
          return cached;
        }
        // No cached copy of this page: wait for the network, and only fall back
        // to the app shell when offline (matches the SPA's prior behavior).
        return (await refresh) || (await caches.match("/")) || Response.error();
      })()
    );
    return;
  }

  // Other same-origin (static assets, API GETs): network-first, cache on offline.
  event.respondWith(
    (async () => {
      try {
        const resp = await fetch(request);
        putInCache(request, resp);
        return resp;
      } catch (e) {
        const cached = await caches.match(request);
        if (cached) return cached;
        return Response.error();
      }
    })()
  );
});
