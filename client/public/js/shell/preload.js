// Warming during idle time after boot / login: the main screens' code and the country map tiles (moved out of app.js,
// docs/architecture-roadmap.md step 6).

// requestIdleCallback, with a Safari-safe fallback (WebKit has never implemented it).
export const runWhenIdle =
  window.requestIdleCallback || ((cb) => setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 50 }), 1));

// Bottom-nav tabs + Settings are the routes a rep hits over and over in a
// working day. app.js render()'s dynamic import() means the very first tap
// on each still costs a fetch -- fine on a normal SPA session where the
// module cache then makes every later tap instant, but iOS Safari discards
// a backgrounded PWA's whole page (module cache included) far more
// aggressively than Android. Without this, switching apps or unlocking the
// phone and coming back means the next tab tap is a fresh "first visit"
// again, which is exactly the "loading every time" symptom reported live
// from an iPhone. Warming these during idle time right after boot/login
// means that fetch has almost always already happened by the time a tap
// comes in, without touching the boot-time win the dynamic import()s were
// for -- this doesn't block first paint, it just gets ahead of the taps
// that follow it.
export let coreViewsPreloaded = false;

export function preloadCoreViews() {
  if (coreViewsPreloaded) return;
  coreViewsPreloaded = true;
  runWhenIdle(() => {
    // each import written out (not a list of addresses): the deploy build follows only imports it can read
    [
      () => import("../views/dashboard.js"),
      () => import("../views/activity.js"),
      () => import("../views/map.js"),
      () => import("../views/customers.js"),
      () => import("../views/customerDetail.js"), // the first card opened in a session otherwise waits for this file (and what it imports) to download
      () => import("../views/orders.js"),
      () => import("../views/settings.js"),
    ].forEach((load) => load().catch(() => {}));
    // Leaflet itself (leafletLoader.js) is loaded on demand rather than
    // unconditionally at page load now -- warmed here alongside map.js's
    // own module fetch so the two are usually both ready together by the
    // time a tap actually opens Map or Add-customer.
    import("../leafletLoader.js").then((m) => m.ensureLeaflet()).catch(() => {});
  });
}

// Same "loads too slow" complaint, for the map's basemap tiles specifically
// -- OSM tile requests from a device in Armenia can genuinely take several
// seconds each (see the tile-health-check comment in map.js), so by the
// time a rep opens the Map tab it's too late to start fetching. Warms the
// whole-country view (zoom 6-9: country-to-city, not the zoom-15
// per-customer grid, which would be tens of thousands of tiles over an area
// that isn't even known yet) into the service worker's tile cache during
// idle time, so those tiles are usually already local by the time Map is
// opened. sw.js's fetch handler already caches any tile.openstreetmap.org
// request regardless of who made it, so a plain fetch() here is enough --
// no message-passing to the service worker needed.
export const ARMENIA_TILE_BOUNDS = { west: 43.4, east: 46.7, south: 38.8, north: 41.35 };

export const ARMENIA_TILE_ZOOMS = [6, 7, 8, 9];

export const TILE_SUBDOMAINS = "abc";

export function lonToTileX(lon, z) {
  return Math.floor(((lon + 180) / 360) * 2 ** z);
}

export function latToTileY(lat, z) {
  const rad = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z);
}

export let tilesPreloadScheduled = false;

export const TILE_PREWARM_STORAGE_KEY = "fieldvisits_tiles_prewarmed_at";

export const TILE_PREWARM_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function preloadArmeniaTiles() {
  if (tilesPreloadScheduled) return;
  tilesPreloadScheduled = true;
  // Data Saver is an explicit "don't spend my data in the background"
  // signal -- unsupported on iOS Safari (this feature's main audience),
  // where it's simply undefined and this check is a no-op.
  if (navigator.connection?.saveData) return;
  let lastRun = 0;
  try {
    lastRun = Number(localStorage.getItem(TILE_PREWARM_STORAGE_KEY)) || 0;
  } catch {
    // Storage can throw in a locked-down/private-browsing context -- treat
    // that the same as "never warmed" rather than skipping the feature.
  }
  if (Date.now() - lastRun < TILE_PREWARM_INTERVAL_MS) return;
  runWhenIdle(async () => {
    const tiles = [];
    for (const z of ARMENIA_TILE_ZOOMS) {
      const xMin = lonToTileX(ARMENIA_TILE_BOUNDS.west, z);
      const xMax = lonToTileX(ARMENIA_TILE_BOUNDS.east, z);
      const yMin = latToTileY(ARMENIA_TILE_BOUNDS.north, z);
      const yMax = latToTileY(ARMENIA_TILE_BOUNDS.south, z);
      for (let x = xMin; x <= xMax; x++) {
        for (let y = yMin; y <= yMax; y++) tiles.push({ x, y, z });
      }
    }
    // A handful of parallel fetches at a time -- this is a best-effort
    // background nicety running on the user's own data/battery while the
    // app is idle, not a race to finish, so it shouldn't compete with
    // whatever the user is actually doing on the network right when the
    // app opens.
    let next = 0;
    async function worker() {
      while (next < tiles.length) {
        const { x, y, z } = tiles[next++];
        const s = TILE_SUBDOMAINS[(x + y) % TILE_SUBDOMAINS.length];
        const url = `https://${s}.tile.openstreetmap.org/${z}/${x}/${y}.png`;
        try {
          await fetch(url);
        } catch {
          // Offline or unreachable -- fine, this is best-effort warmup; the
          // real tile fetch/retry/fallback-provider logic in map.js still
          // runs normally whenever Map is actually opened.
        }
      }
    }
    await Promise.all(Array.from({ length: 4 }, worker));
    try {
      localStorage.setItem(TILE_PREWARM_STORAGE_KEY, String(Date.now()));
    } catch {
      // Non-fatal if storage isn't writable.
    }
  });
}
