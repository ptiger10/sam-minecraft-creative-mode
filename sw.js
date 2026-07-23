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

const CACHE_NAME = "blocky-world";

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

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
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
        const fresh = await fetch(request);
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
