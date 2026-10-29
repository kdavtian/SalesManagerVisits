const CACHE_VERSION = "field-visits-v491";
// Map tiles are kept in IndexedDB (TILE_DB below), not in Cache Storage (1.468.0). On iPhone, Safari's Cache Storage costs every launch
// time for EVERY entry stored in ANY of the app's caches, even when the launch only reads the start page from another cache: measured on
// WebKit, 5,000 stored tiles delayed the start page by ~0.16 s on a fast computer (a phone is several times slower), before the white
// screen, and the tile cache had no limit. The same 5,000 tiles in IndexedDB cost nothing at launch. The old "field-visits-tiles-v5"
// cache is deleted on activation like any cache not named here.
const TILE_DB = "field-visits-tiles";
const TILE_MAX_ENTRIES = 4000;
// When this worker started and when it last answered the app's start page (launchTiming.js asks for them). On iPhone the page's own clock
// starts only AFTER the worker has handed over the start page, so the wait before the white screen is only visible from here.
const WORKER_STARTED_AT = Date.now();
let lastLaunch = null;
// Whether this worker has handled anything yet: a start-page request that is its very first event means the phone started the worker for
// this launch (it was asleep), so the launch began when the worker did.
let handledEvent = false;
// Anything fetched at runtime that wasn't already in APP_SHELL gets cached
// here, kept separate from CACHE_VERSION on purpose -- see trimCache below,
// this is the one that gets capped/evicted, and it must never be able to
// touch the app-shell entries CACHE_VERSION holds (those are written once
// at install and have to survive for reliable offline core-app coverage).
const RUNTIME_CACHE = CACHE_VERSION + "-runtime";

const APP_SHELL = [
  "/",
  "/index.html",
  // manifest.json is deliberately NOT precached here -- it's generated
  // per-request from the calculator-mode admin setting (see index.js), not
  // a static file, so baking a snapshot of it into this versioned cache
  // would mean whichever branding was active at the moment this service
  // worker installed could keep being served as the "offline" fallback
  // indefinitely, regardless of later toggles. The fetch handler below is
  // already network-first for it; going without an offline fallback here
  // is the safer failure direction for a file that's only actually read
  // at PWA-install time anyway.
  // The boot stylesheets come as ONE file: css/app.css, joined by the server (step 9). The single files are inside it.
  "/css/app.css",
  // the styles of some screens only, loaded with them (js/styles.js, step 8c)
  "/css/areas/customers.css",
  "/css/areas/orders.css",
  "/css/areas/field.css",
  "/css/areas/money.css",
  "/css/areas/products.css",
  "/css/areas/reports.css",
  "/css/areas/team.css",
  "/js/styles.js",
  "/js/bootGate.js",
  "/js/calculatorLock.js",
  "/js/api.js",
  "/js/api/core.js",
  "/js/api/system.js",
  "/js/api/customers.js",
  "/js/api/orders.js",
  "/js/api/reports.js",
  "/js/api/field.js",
  "/js/api/products.js",
  "/js/api/team.js",
  "/js/api/money.js",
  "/js/api/erp.js",
  "/js/api/bonus.js",
  "/js/prefetch.js",
  "/js/app.js",
  "/js/badges.js",
  "/js/shell/nav.js",
  "/js/shell/preload.js",
  "/js/shell/routes.js",
  "/js/shell/syncBanner.js",
  "/js/activityDatePicker.js",
  "/js/searchBar.js",
  "/js/customerCardLoader.js",
  "/js/views/customer/social.js",
  "/js/mapSafeRuntime.js",
  "/js/version.js",
  "/js/launchTiming.js",
  "/js/i18n.js",
  "/js/i18nAreas.js",
  "/js/i18n-en.js",
  "/js/i18n-hy.js",
  "/js/i18n/en/common.js",
  "/js/i18n/en/customers.js",
  "/js/i18n/en/orders.js",
  "/js/i18n/en/field.js",
  "/js/i18n/en/money.js",
  "/js/i18n/en/products.js",
  "/js/i18n/en/reports.js",
  "/js/i18n/en/team.js",
  "/js/i18n/en/settings.js",
  "/js/i18n/hy/common.js",
  "/js/i18n/hy/customers.js",
  "/js/i18n/hy/orders.js",
  "/js/i18n/hy/field.js",
  "/js/i18n/hy/money.js",
  "/js/i18n/hy/products.js",
  "/js/i18n/hy/reports.js",
  "/js/i18n/hy/team.js",
  "/js/i18n/hy/settings.js",
  "/js/icons.js",
  "/js/theme.js",
  "/js/textSize.js",
  "/js/orderMenu.js",
  "/js/install.js",
  "/js/locationBroadcast.js",
  "/js/offlineQueue.js",
  "/js/listCache.js",
  "/js/productCatalog.js",
  "/js/pushNotifications.js",
  "/js/state.js",
  "/js/shared/roles.js",
  "/js/shared/notificationTypes.js",
  "/js/util.js",
  "/js/places.js",
  "/js/placesData.js",
  "/js/visitDetail.js",
  "/js/mapPrefs.js",
  "/js/leafletLoader.js",
  "/js/perfMode.js",
  "/js/theme-init.js",
  "/js/perf-mode-init.js",
  "/js/zoom-lock.js",
  "/js/browser-check.js",
  "/js/lockdownScreen.js",
  "/js/quickActions.js",
  "/js/regionTree.js",
  "/js/typeTierSheet.js",
  "/js/filterIcons.js",
  "/js/views/admin.js",
  "/js/views/admin/products.js",
  "/js/views/admin/team.js",
  "/js/views/systemHealth.js",
  "/js/erpSyncCard.js",
  "/js/statusBarTap.js",
  "/js/repColors.js",
  "/js/views/bonusChallengesAdmin.js",
  "/js/views/kadOsAdmin.js",
  "/js/views/deliveryArrivalAdmin.js",
  "/js/views/activity.js",
  "/js/views/checkin.js",
  "/js/views/fuelReport.js",
  "/js/views/customerDetail.js",
  "/js/views/customer/accountSettings.js",
  "/js/views/customer/editSheet.js",
  "/js/views/customer/erpCard.js",
  "/js/views/customer/files.js",
  "/js/views/customer/sheets.js",
  "/js/views/customerOrders.js",
  "/js/customerCardData.js",
  "/js/views/checkinSpots.js",
  "/js/views/pinReview.js",
  "/js/views/volumeReport.js",
  "/js/checkinSpotsLayer.js",
  "/js/views/customers.js",
  "/js/views/cashHandoffs.js",
  "/js/views/dashboard.js",
  "/js/views/homeKpis.js",
  "/js/views/dashboardOverview.js",
  "/js/views/login.js",
  "/js/views/map.js",
  "/js/views/map/addCustomer.js",
  "/js/views/map/filters.js",
  "/js/views/map/location.js",
  "/js/views/map/markers.js",
  "/js/views/map/planning.js",
  "/js/views/map/search.js",
  "/js/views/map/searchBar.js",
  "/js/views/map/template.js",
  "/js/views/map/tiles.js",
  "/js/views/settings.js",
  "/js/views/settings/adminRows.js",
  "/js/views/settings/markup.js",
  "/js/views/settings/notifications.js",
  "/js/views/settings/rows.js",
  "/js/views/settings/sheets.js",
  "/js/views/settingsDocTexts.js",
  "/js/views/bonuses.js",
  // The rest of app.js's routes -- all now loaded via dynamic import()
  // rather than a static import at boot (so only the screen actually
  // opened is fetched/parsed on startup), but still listed here so every
  // one of them is guaranteed already in Cache Storage the first time a
  // user navigates to it, not just on a repeat visit -- a dynamic import()
  // is still a fetch() under the hood, and this app.js's own fetch
  // handler below serves it from here instantly instead of hitting the
  // network on a field rep's possibly-slow connection.
  "/js/views/orderCreate.js",
  "/js/productFrequent.js",
  "/js/stepper.js",
  "/js/costModel.js",
  "/js/costCalculator.js",
  "/js/productBrowse.js",
  "/js/orderBulk.js",
  "/js/views/specialPrices.js",
  "/js/views/orders.js",
  "/js/views/orders/searchBar.js",
  "/js/views/notifications.js",
  "/js/views/cashExpenses.js",
  "/js/views/money.js",
  "/js/views/documents.js",
  "/js/fileViewer.js",
  "/js/addFileSheet.js",
  "/js/signaturePad.js",
  "/js/signStatement.js",
  "/js/views/reports.js",
  "/js/views/reports/common.js",
  "/js/views/reports/debt.js",
  "/js/views/reports/money.js",
  "/js/views/reports/sales.js",
  "/js/views/routePlans.js",
  "/js/views/routePlanSets.js",
  "/js/views/routeDistribution.js",
  "/js/views/teamPerformance.js",
  "/js/views/repProgress.js",
  "/js/vaghinak.js",
  "/js/views/vaghinak.js",
  "/js/views/askKad.js",
  "/js/views/opsControl.js",
  "/js/views/pricelist.js",
  "/js/views/productDetail.js",
  "/js/views/payments.js",
  "/js/views/warehouse.js",
  "/js/views/deliveryRoute.js",
  "/js/views/recorded.js",
  "/js/views/debtBalances.js",
  "/js/views/sales.js",
  // Modules that precached views import statically, plus the task / report /
  // accounting screens: without them an update installed just before going
  // offline could leave Orders, Dashboard or Customer detail unable to load.
  "/js/accountingDocSheet.js",
  "/js/accountingFiles.js",
  "/js/brandChips.js",
  "/js/debtChip.js",
  "/js/collectionOutcomeSheet.js",
  "/js/callTask.js",
  "/js/dockSheet.js",
  "/js/deskTable.js",
  "/js/customerWide.js",
  "/js/deskTopBar.js",
  "/js/reportsDesk.js",
  "/js/mapSideTable.js",
  "/js/periodButtons.js",
  "/js/orderTaskSheet.js",
  "/js/driverArrival.js",
  "/js/opsShell.js",
  "/js/views/warehouseHome.js",
  "/js/views/warehousePack.js",
  "/js/views/driverHome.js",
  "/js/views/cashflow.js",
  "/js/potential.js",
  "/js/potentialFilterSheet.js",
  "/js/returnSheet.js",
  "/js/bankStatements.js",
  "/js/views/returns.js",
  "/js/views/staff.js",
  "/js/reorder.js",
  "/js/productPricing.js",
  "/js/erpLinkSheet.js",
  "/js/errorMonitoring.js",
  "/js/orderBlankPrint.js",
  "/js/wishSheet.js",
  "/js/deskHover.js",
  "/js/fileReadySheet.js",
  "/js/syncQueueSheet.js",
  "/js/routeNavigation.js",
  "/js/orderDetailSheet.js",
  "/js/productSearch.js",
  "/js/photoLightbox.js",
  "/js/productSort.js",
  "/js/updateBanner.js",
  "/js/visitFirstCard.js",
  "/js/visitSchedule.js",
  "/js/views/accounting.js",
  "/js/views/bizReports.js",
  "/js/views/salesPayments.js",
  "/js/views/tasks.js",
  // Pre-approved marker/category artwork -- the map pins and the blue
  // category glyphs every other screen uses (see util.js).
  "/icons/markers/customer-drop.svg",
  "/icons/markers/customer-shop.svg",
  "/icons/markers/customer-workshop.svg",
  "/icons/markers/customer-other.svg",
  "/icons/markers/potential-drop.png",
  "/icons/markers/potential-shop.png",
  "/icons/markers/potential-workshop.png",
  "/icons/markers/potential-other.png",
  "/icons/markers/competitor-drop.svg",
  "/icons/markers/competitor-shop.svg",
  "/icons/markers/competitor-workshop.svg",
  "/icons/markers/competitor-other.svg",
  "/icons/markers/ring-customer.svg",
  "/icons/markers/ring-potential.svg",
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
  "/icons/app/icon-192.png",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon.png",
  "/brand/kad-k-mark.png",
  "/brand/kad-wordmark.png",
];

self.addEventListener("install", (event) => {
  handledEvent = true;
  event.waitUntil(caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  handledEvent = true;
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key !== CACHE_VERSION && key !== RUNTIME_CACHE).map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// launchTiming.js: when this worker started and when it received / answered the last start-page request (epoch milliseconds).
self.addEventListener("message", (event) => {
  if (event.data?.type !== "launch-times" || !event.ports?.[0]) return;
  event.ports[0].postMessage({ workerStartedAt: WORKER_STARTED_AT, launch: lastLaunch });
});

self.addEventListener("push", (event) => {
  handledEvent = true;
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch {}
  const title = payload.title || "KAD Motors";
  event.waitUntil(self.registration.showNotification(title, {
    body: payload.body || "",
    // The server picks the icon (K, or the calculator while Calculator Mode is on); the calculator is the safe default if one is ever missing.
    icon: payload.icon || "/icons/icon-192.png",
    badge: payload.badge || payload.icon || "/icons/icon-192.png",
    data: { url: payload.url || "/" },
  }));
});

self.addEventListener("notificationclick", (event) => {
  handledEvent = true;
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
// ---- Map tile store (IndexedDB): url -> { body: Blob, type, at } ----
let tileDbOpening = null;
function tileDb() {
  if (!tileDbOpening) {
    tileDbOpening = new Promise((resolve, reject) => {
      const open = indexedDB.open(TILE_DB, 1);
      open.onupgradeneeded = () => open.result.createObjectStore("tiles").createIndex("at", "at");
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    }).catch((err) => {
      tileDbOpening = null;
      throw err;
    });
  }
  return tileDbOpening;
}
function idbDone(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
// A stored tile as a response, or null (not stored, or the store cannot be opened: then the network answers as before).
async function readTile(url) {
  try {
    const db = await tileDb();
    const rec = await idbDone(db.transaction("tiles").objectStore("tiles").get(url));
    return rec ? new Response(rec.body, { headers: { "Content-Type": rec.type || "image/png" } }) : null;
  } catch {
    return null;
  }
}
// The store is trimmed (oldest first) every 50 new tiles, not after each one.
let tilesSinceTrim = 0;
async function saveTile(url, res) {
  try {
    const body = await res.blob();
    const db = await tileDb();
    await idbDone(db.transaction("tiles", "readwrite").objectStore("tiles").put({ body, type: res.headers.get("Content-Type"), at: Date.now() }, url));
    if (++tilesSinceTrim < 50) return;
    tilesSinceTrim = 0;
    // count + delete the oldest in ONE transaction, chained by callbacks (no await in between: older Safari closes a transaction
    // across a promise step)
    await new Promise((resolve) => {
      const tx = db.transaction("tiles", "readwrite");
      const store = tx.objectStore("tiles");
      tx.oncomplete = tx.onerror = tx.onabort = () => resolve();
      store.count().onsuccess = (e) => {
        let excess = e.target.result - TILE_MAX_ENTRIES;
        if (excess <= 0) return;
        store.index("at").openCursor().onsuccess = (ev) => {
          const c = ev.target.result;
          if (!c || excess-- <= 0) return;
          c.delete();
          c.continue();
        };
      };
    });
  } catch {
    /* storage full or unavailable: the tile was still shown, just not kept */
  }
}

async function trimCache(cache, maxEntries) {
  const keys = await cache.keys();
  const excess = keys.length - maxEntries;
  if (excess <= 0) return;
  for (const key of keys.slice(0, excess)) await cache.delete(key);
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const firstEvent = !handledEvent;
  handledEvent = true;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.pathname.startsWith("/api/")) return;

  // OpenStreetMap's own tile server (below) is what map.js reaches for
  // first, falling back to Wikimedia's OSM-data mirror (see map.js's own
  // FALLBACK_TILE_URLS) when the primary is blocked or unreachable -- a
  // device that's fallen back needs the same cache-first coverage, not
  // just the primary provider. (CARTO used to be the primary here; it now
  // requires a paid API key for every request and is no longer used.)
  // A stored tile is used as it is (map tiles hardly change; it is downloaded again once it drops out of the capped store). It used to be
  // re-downloaded and re-written on every single view.
  if (url.hostname.endsWith("tile.openstreetmap.org") || url.hostname === "maps.wikimedia.org") {
    event.respondWith(
      readTile(request.url).then((stored) => {
        if (stored) return stored;
        return fetch(request).then((res) => {
          if (res.ok) event.waitUntil(saveTile(request.url, res.clone()));
          return res;
        });
      })
    );
    return;
  }

  if (url.origin !== self.location.origin) return;

  // Cache-first for the app itself, so it opens instantly whatever the network is doing: a slow (not offline) connection never rejects fetch()
  // quickly, it just hangs, which is why this used to be network-first-with-fallback and was not instant. The start page (index.html: branding,
  // module preload list) is still re-fetched in the background on every launch to keep that one copy fresh; the other app files are not (see
  // below). The "Check for updates" banner (updateBanner.js) is what surfaces a newly deployed version, not a background fetch.
  // Looked up in the app's own store only (caches.match() searches every store, in creation order; the tile store used to come first).
  // `launch` records when the request came and when the page was found, for launchTiming.js.
  if (request.mode === "navigate") {
    const launch = { at: Date.now(), woke: firstEvent };
    lastLaunch = launch;
    event.respondWith(
      caches.open(CACHE_VERSION).then((shell) => shell.match("/index.html")).then((cached) => {
        launch.found = Date.now();
        const network = fetch(request)
          .then((res) => {
            if (res.ok) caches.open(CACHE_VERSION).then((cache) => cache.put("/index.html", res.clone()));
            return res;
          })
          .catch(() => cached);
        return cached || network;
      })
    );
    return;
  }

  // The versioned precache (APP_SHELL) is served as it is and NOT re-fetched at launch (1.422.0). It used to be re-downloaded in full in the background on
  // every single launch (~110 requests, ~680 KB, each response cloned and written to RUNTIME_CACHE) even though those copies were never served --
  // caches.match() finds the precache entry first -- so on a phone it only competed with the screens' own requests and kept the worker busy while
  // the app was starting. The files change only with a release, and a release always ships a new CACHE_VERSION (new worker -> new precache).
  event.respondWith(
    caches
      .open(CACHE_VERSION)
      .then((shell) => shell.match(request))
      .then((hit) => hit || runtimeFetch(request))
  );
});

// Everything else from this origin (not in APP_SHELL): cache, then revalidate in the background.
function runtimeFetch(request) {
  return caches.open(RUNTIME_CACHE).then((runtime) => runtime.match(request)).then((cached) => {
    const network = fetch(request)
      .then((res) => {
        if (res.ok) {
          caches.open(RUNTIME_CACHE).then(async (cache) => {
            await cache.put(request, res.clone());
            trimCache(cache, RUNTIME_CACHE_MAX_ENTRIES);
          });
        }
        return res;
      })
      .catch(() => cached);
    return cached || network;
  });
}
