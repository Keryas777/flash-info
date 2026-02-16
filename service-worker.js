/* Flash Info PWA - Service Worker */
const CACHE_NAME = "flashinfo-v2";

const ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.webmanifest",
  // Icônes si tu les ajoutes :
  // "./icons/icon-192.png",
  // "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.map((key) => (key !== CACHE_NAME ? caches.delete(key) : null))
      )
    )
  );
  self.clients.claim();
});

// Stratégie :
// - HTML (navigation) -> Network First (évite de rester coincé sur une vieille version)
// - Assets (css/js/etc.) -> Cache First
self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // On ne gère que le même origin
  if (url.origin !== self.location.origin) return;

  // Navigation / page HTML
  const isNavigation =
    req.mode === "navigate" ||
    (req.destination === "document") ||
    (req.headers.get("accept") || "").includes("text/html");

  if (isNavigation) {
    event.respondWith(networkFirst(req));
    return;
  }

  // Assets
  event.respondWith(cacheFirst(req));
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const fresh = await fetch(request);
    // Met en cache la version fraîche
    cache.put(request, fresh.clone());
    return fresh;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    // fallback sur index.html si dispo
    const fallback = await cache.match("./index.html");
    return fallback || Response.error();
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const fresh = await fetch(request);
    cache.put(request, fresh.clone());
    return fresh;
  } catch (err) {
    return Response.error();
  }
}