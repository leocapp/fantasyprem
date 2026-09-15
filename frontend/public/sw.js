/*
 * Service worker.
 *
 * Deliberately caches almost nothing.
 *
 * Every page in this app is force-dynamic and most of it is time-critical:
 * lineups before a deadline, scores during a match, whether a player is
 * injured. A cached page served on Saturday morning showing Tuesday's squad is
 * worse than no page at all, because it looks correct. Offline-first is a good
 * default for a reading app and a bad one for this.
 *
 * So: hashed build assets are cached (they are immutable by construction), and
 * navigations go to the network and fall back to a static page that says the
 * connection is gone. Nothing else is stored.
 */

const VERSION = "v1";
const SHELL = `fatboys-shell-${VERSION}`;
const OFFLINE_URL = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.add(OFFLINE_URL))
      // Take over immediately rather than waiting for every tab to close. There
      // is no old version whose data could be corrupted by the new one.
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== SHELL).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;

  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Build output is content-hashed, so a hit can never be stale — a changed
  // file has a different name.
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(
      caches.open(SHELL).then(async (cache) => {
        const hit = await cache.match(request);
        if (hit) return hit;

        const response = await fetch(request);
        if (response.ok) cache.put(request, response.clone());
        return response;
      }),
    );
    return;
  }

  // Pages: always the network. The fallback exists so that losing signal on the
  // train gives an explanation rather than the browser's dinosaur.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(async () => {
        const offline = await caches.match(OFFLINE_URL);
        return offline ?? Response.error();
      }),
    );
  }
});
