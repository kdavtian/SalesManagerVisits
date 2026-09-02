const CACHE_VERSION = "field-visits-v34";
const TILE_CACHE = "field-visits-tiles-v2";

const APP_SHELL = [
  "/",
  "/index.html",
  "/manifest.json",
  "/css/styles.css",
  "/js/api.js",
  "/js/app.js",
  "/js/i18n.js",
  "/js/icons.js",
  "/js/theme.js",
  "/js/install.js",
  "/js/locationBroadcast.js",
  "/js/offlineQueue.js",
  "/js/pushNotifications.js",
  "/js/state.js",
  "/js/util.js",
  "/js/views/admin.js",
  "/js/views/activity.js",
  "/js/views/checkin.js",
  "/js/views/customerDetail.js",
  "/js/views/customerOrders.js",
  "/js/views/customers.js",
  "/js/views/dashboard.js",
  "/js/views/login.js",
  "/js/views/map.js",
  "/js/views/settings.js",
  "/vendor/leaflet/leaflet.js",
  "/vendor/leaflet/leaflet.css",
  "/vendor/leaflet-rotate/leaflet-rotate.js",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon.png",
  "/brand/kad-k-mark.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_VERSION && key !== TILE_CACHE)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    // Malformed/empty push payload -- fall back to a generic notification
    // rather than dropping it silently.
  }
  const title = payload.title || "KAD Motors";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: payload.body || "",
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      data: { url: payload.url || "/" },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    })
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // API calls always go to the network; never served from cache, so data
  // stays fresh. Offline check-ins are queued client-side instead.
  if (url.pathname.startsWith("/api/")) return;

  // Map tiles: stale-while-revalidate, so previously-viewed areas stay
  // browsable offline.
  if (url.hostname.endsWith("basemaps.cartocdn.com")) {
    event.respondWith(
      caches.open(TILE_CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        const network = fetch(request)
          .then((res) => {
            if (res.ok) cache.put(request, res.clone());
            return res;
          })
          .catch(() => cached);
        return cached || network;
      })
    );
    return;
  }

  // App shell navigation: try the network, fall back to the cached shell.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() => caches.match("/index.html"))
    );
    return;
  }

  // App shell (JS/CSS/etc): network-first. Cache-first previously meant a
  // deploy was invisible to already-installed clients until CACHE_VERSION
  // was manually bumped (this file's own bytes are what trigger a service
  // worker reinstall, and that string was the only thing that ever changed
  // it) -- in practice several real fixes silently never reached the
  // installed app. Network-first always picks up a new deploy on the next
  // load when online, and still falls back to the cache when offline.
  event.respondWith(
    fetch(request)
      .then((res) => {
        if (res.ok) caches.open(CACHE_VERSION).then((cache) => cache.put(request, res.clone()));
        return res;
      })
      .catch(() => caches.match(request))
  );
});
