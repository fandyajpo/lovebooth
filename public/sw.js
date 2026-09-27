/**
 * Lovebooth service worker.
 *
 * Three rules, in order of how dangerous staleness would be:
 *
 *   navigations  — network first. A room must never boot against yesterday's
 *                  bundle; the cache is only what it falls back to offline.
 *   /_astro/*    — cache first. Those URLs are content-hashed, so the name is
 *                  the fingerprint and a hit is always correct.
 *   everything else on this origin — the precached manifest and icons, served
 *                  from the cache when the network cannot be reached.
 *
 * Everything that actually matters for a booth (the relay, /ice, the camera)
 * is cross-origin and never reaches here.
 */
const VERSION = 'lovebooth-v1';

/** What "the booth still opens" needs: the page, and the record the browser
 *  reads to offer the install. A missing icon must not fail the install, so
 *  each one is added on its own. */
const PRECACHE = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => Promise.all(PRECACHE.map((url) => cache.add(url).catch(() => null))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(VERSION).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() => caches.match(request).then((hit) => hit || caches.match('/'))),
    );
    return;
  }

  if (url.pathname.startsWith('/_astro/')) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ||
          fetch(request).then((response) => {
            if (response.ok) {
              const copy = response.clone();
              caches.open(VERSION).then((cache) => cache.put(request, copy));
            }
            return response;
          }),
      ),
    );
    return;
  }

  // The precached odds and ends: a hit when the network is gone, the plain
  // network otherwise — nothing else is ever written here.
  event.respondWith(caches.match(request).then((hit) => hit || fetch(request)));
});
