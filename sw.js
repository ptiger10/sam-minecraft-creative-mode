/*
 * Service worker: makes Blocky World playable with no internet at all.
 *
 * How it works:
 *  - On install we download every file the game needs into a cache.
 *  - On every request we try the network first (so you always get the newest
 *    version when you're online) and quietly refresh the cached copy.
 *  - If the network is unreachable we answer from the cache instead, so the
 *    game keeps working on a plane, in a tunnel, or with Wi-Fi off.
 *
 * Because we go network-first there is no cache version to bump when a file
 * changes — the next online visit picks it up automatically.
 */

// v2: flushes caches that may hold redirect-flagged responses Safari rejects.
const CACHE_NAME = "blocky-world-v2";

// Everything the game needs to run. Keep this list in sync with the files
// referenced from index.html.
const ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./css/style.css",
  "./vendor/three.min.js",
  "./js/data.js",
  "./js/world.js",
  "./js/player.js",
  "./js/game.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
];

// Safari refuses to display a page when a service worker answers a
// navigation with a response that was produced via an HTTP redirect
// ("Response served by service worker has redirections"). GitHub Pages
// redirects some URLs (e.g. a missing trailing slash), so any response we
// cache or hand back could carry the `redirected` flag. Re-wrapping the
// body in a fresh Response drops that flag.
async function cleanResponse(response) {
  if (!response || !response.redirected) return response;
  const body = await response.blob();
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await Promise.all(
        ASSETS.map(async (url) => {
          const response = await fetch(url, { cache: "no-cache" });
          if (!response.ok) {
            throw new Error(`Failed to cache ${url}: ${response.status}`);
          }
          await cache.put(url, await cleanResponse(response));
        })
      );
    })()
  );
  // Take over from any older service worker right away.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Drop caches left behind by older versions of this worker.
      const names = await caches.keys();
      await Promise.all(
        names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Only handle plain same-origin GETs; let everything else pass through.
  if (request.method !== "GET" || !request.url.startsWith(self.location.origin)) {
    return;
  }

  event.respondWith(
    (async () => {
      try {
        // For navigations, fetch by URL: a navigation Request uses redirect
        // mode "manual", and passing it straight to fetch() can yield a
        // redirected response that Safari then rejects. Fetching the URL
        // follows redirects normally, and cleanResponse() strips the flag.
        const fresh = await cleanResponse(
          request.mode === "navigate" ? await fetch(request.url) : await fetch(request)
        );
        // Keep the cache up to date for the next offline session.
        if (fresh && fresh.ok) {
          const cache = await caches.open(CACHE_NAME);
          cache.put(request, fresh.clone());
        }
        return fresh;
      } catch (err) {
        // Offline: serve the cached copy. For page navigations fall back to
        // index.html (it's the only page there is).
        const cached = await caches.match(request, { ignoreSearch: true });
        if (cached) return cached;
        if (request.mode === "navigate") {
          const index = await caches.match("./index.html");
          if (index) return index;
        }
        throw err;
      }
    })()
  );
});
