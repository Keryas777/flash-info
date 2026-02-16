const CACHE_NAME = "flashinfo-v3";

/*
  IMPORTANT :
  - On ne met PAS index.html en cache.
  - On ne met PAS app.js en cache.
  - On garde le cache uniquement pour styles / assets statiques.
*/

const STATIC_ASSETS = [
  "./styles.css",
  "./manifest.webmanifest",
  // "./icons/icon-192.png",
  // "./icons/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;

  // Toujours aller chercher le HTML en réseau
  if (request.mode === "navigate") {
    event.respondWith(fetch(request));
    return;
  }

  // Cache-first uniquement pour les assets statiques
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;

      return fetch(request).then((response) => {
        return caches.open(CACHE_NAME).then((cache) => {
          cache.put(request, response.clone());
          return response;
        });
      });
    })
  );
});