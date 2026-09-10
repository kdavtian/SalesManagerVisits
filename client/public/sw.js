const CACHE_VERSION = "field-visits-v125";
const TILE_CACHE = "field-visits-tiles-v4";
// Anything fetched at runtime that wasn't already in APP_SHELL gets cached
// here, kept separate from CACHE_VERSION on purpose -- see trimCache below,
// this is the one that gets capped/evicted, and it must never be able to
// touch the app-shell entries CACHE_VERSION holds (those are written once
// at install and have to survive for reliable offline core-app coverage).
const RUNTIME_CACHE = CACHE_VERSION + "-runtime";

const APP_SHELL = [
  "/",
  "/index.html",
  "/manifest.json",
  "/css/styles.css",
  "/css/activity-search-filters.css",
  "/css/activity-date-picker.css",
  "/css/orders-search-filters.css",
  "/css/unified-search.css",
  "/css/order-map-filter-enhancements.css",
  "/css/field-visit-enhancements.css",
  "/css/customer-social.css",
  "/css/map-marker-system.css",
  "/css/map-safe-enhancements.css",
  "/js/api.js",
  "/js/app.js",
  "/js/activityDatePicker.js",
  "/js/ordersSearchEnhancements.js",
  "/js/unifiedSearchEnhancements.js",
  "/js/customerPortfolioUi.js",
  "/js/ordersRegionStatusEnhancements.js",
  "/js/mapDimensionFilterPlacement.js",
  "/js/fieldVisitEnhancements.js",
  "/js/customerSocialProfiles.js",
  "/js/mapMarkerEnhancements.js",
  "/js/mapSafeRuntime.js",
  "/js/mapSafeUi.js",
  "/js/competitorPolicySafe.js",
  "/js/version.js",
  "/js/i18n.js",
  "/js/icons.js",
  "/js/theme.js",
  "/js/install.js",
  "/js/locationBroadcast.js",
  "/js/offlineQueue.js",
  "/js/pushNotifications.js",
  "/js/state.js",
  "/js/util.js",
  "/js/visitDetail.js",
  "/js/mapPrefs.js",
  "/js/leafletLoader.js",
  "/js/perfMode.js",
  "/js/perf-mode-init.js",
  "/js/quickActions.js",
  "/js/views/admin.js",
  "/js/views/activity.js",
  "/js/views/checkin.js",
  "/js/views/customerDetail.js",
  "/js/views/customerOrders.js",
  "/js/views/customers.js",
  "/js/views/cashHandoffs.js",
  "/js/views/dashboard.js",
  "/js/views/dashboardOverview.js",
  "/js/views/login.js",
  "/js/views/map.js",
  "/js/views/settings.js",
  // The rest of app.js's routes -- all now loaded via dynamic import()
  // rather than a static import at boot (so only the screen actually
  // opened is fetched/parsed on startup), but still listed here so every
  // one of them is guaranteed already in Cache Storage the first time a
  // user navigates to it, not just on a repeat visit -- a dynamic import()
  // is still a fetch() under the hood, and this app.js's own fetch
  // handler below serves it from here instantly instead of hitting the
  // network on a field rep's possibly-slow connection.
  "/js/views/orderCreate.js",
  "/js/views/orders.js",
  "/js/views/notifications.js",
  "/js/views/cashExpenses.js",
  "/js/views/reports.js",
  "/js/views/routePlans.js",
  "/js/views/teamPerformance.js",
  "/js/views/pricelist.js",
  "/js/views/payments.js",
  "/js/views/warehouse.js",
  "/js/views/deliveryRoute.js",
  "/js/views/recorded.js",
  "/js/views/debtBalances.js",
  // Pre-approved marker/category artwork -- the map pins and the blue
  // category glyphs every other screen uses (see util.js).
  "/icons/markers/bronze-drop.png",
  "/icons/markers/bronze-shop.png",
  "/icons/markers/bronze-workshop.png",
  "/icons/markers/bronze-other.png",
  "/icons/markers/silver-drop.png",
  "/icons/markers/silver-shop.png",
  "/icons/markers/silver-workshop.png",
  "/icons/markers/silver-other.png",
  "/icons/markers/gold-drop.png",
  "/icons/markers/gold-shop.png",
  "/icons/markers/gold-workshop.png",
  "/icons/markers/gold-other.png",
  "/icons/markers/potential-drop.png",
  "/icons/markers/potential-shop.png",
  "/icons/markers/potential-workshop.png",
  "/icons/markers/potential-other.png",
  "/icons/markers/competitor-drop.png",
  "/icons/markers/competitor-shop.png",
  "/icons/markers/competitor-workshop.png",
  "/icons/markers/competitor-other.png",
  "/icons/categories/blue-drop.png",
  "/icons/categories/blue-shop.png",
  "/icons/categories/blue-workshop.png",
  "/icons/categories/blue-other.png",
  "/vendor/leaflet/leaflet.js",
  "/vendor/leaflet/leaflet.css",
  "/vendor/leaflet-rotate/leaflet-rotate.js",
  "/vendor/leaflet-markercluster/leaflet.markercluster.js",
  "/vendor/leaflet-markercluster/MarkerCluster.css",
  "/vendor/leaflet-markercluster/MarkerCluster.Default.css",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon.png",
  "/brand/kad-k-mark.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key !== CACHE_VERSION && key !== RUNTIME_CACHE && key !== TILE_CACHE).map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("push", (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch {}
  const title = payload.title || "KAD Motors";
  event.waitUntil(self.registration.showNotification(title, {
    body: payload.body || "",
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    data: { url: payload.url || "/" },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/";
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
    for (const client of clients) {
      if ("focus" in client) {
        client.navigate(url);
        return client.focus();
      }
    }
    return self.clients.openWindow(url);
  }));
});

// The runtime cache below (anything fetched that wasn't already in
// APP_SHELL) had no cap -- every same-origin, non-API GET response ever
// requested got cached forever, only cleared on a full CACHE_VERSION bump.
// On a storage-constrained device that grows without bound across a long
// session. Trimmed to the oldest entries past a soft cap after every write,
// same pattern Workbox's own expiration plugin uses -- cache insertion
// order isn't formally guaranteed by the spec, but every shipping browser
// preserves it, so this is a reliable enough approximation of "evict
// oldest first" without pulling in a library for it. APP_SHELL itself
// (written only at install time, in CACHE_VERSION) is never touched here.
const RUNTIME_CACHE_MAX_ENTRIES = 150;
async function trimCache(cache, maxEntries) {
  const keys = await cache.keys();
  const excess = keys.length - maxEntries;
  if (excess <= 0) return;
  for (const key of keys.slice(0, excess)) await cache.delete(key);
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.pathname.startsWith("/api/")) return;

  if (url.hostname.endsWith("basemaps.cartocdn.com")) {
    event.respondWith(caches.open(TILE_CACHE).then(async (cache) => {
      const cached = await cache.match(request);
      const network = fetch(request).then((res) => {
        if (res.ok) cache.put(request, res.clone());
        return res;
      }).catch(() => cached);
      return cached || network;
    }));
    return;
  }

  if (url.origin !== self.location.origin) return;
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match("/index.html")));
    return;
  }
  event.respondWith(fetch(request).then((res) => {
    if (res.ok) {
      caches.open(RUNTIME_CACHE).then(async (cache) => {
        await cache.put(request, res.clone());
        trimCache(cache, RUNTIME_CACHE_MAX_ENTRIES);
      });
    }
    return res;
  }).catch(() => caches.match(request)));
});
