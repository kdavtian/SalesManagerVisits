// Leaflet + its two plugins (rotate, markercluster) plus mapSafeRuntime.js
// used to be classic <script> tags loaded unconditionally in index.html --
// ~208KB of JS parsed and executed on every single app boot, even for a
// session that never opens the Map tab or the "Add new customer" flow.
// Loaded on demand instead: map.js and deliveryRoute.js (the only two
// consumers of the global `L`) call ensureLeaflet() before touching it,
// and app.js's idle-preload warms it in the background right after boot
// the same way it already does for the bottom-nav view modules, so it's
// almost always already loaded by the time a tap actually needs it.
let loadPromise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(script);
  });
}

function loadStylesheet(href) {
  return new Promise((resolve, reject) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.onload = () => resolve();
    link.onerror = () => reject(new Error(`Failed to load ${href}`));
    document.head.appendChild(link);
  });
}

export function ensureLeaflet() {
  if (window.L) return Promise.resolve();
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    // Stylesheets can load in any order; the scripts can't -- leaflet.js
    // must be in place before the rotate/markercluster plugins (which
    // extend L) or mapSafeRuntime.js (which checks for it) run, so those
    // are awaited one at a time in dependency order rather than in
    // parallel.
    await Promise.all([
      loadStylesheet("/vendor/leaflet/leaflet.css"),
      loadStylesheet("/vendor/leaflet-markercluster/MarkerCluster.css"),
      loadStylesheet("/vendor/leaflet-markercluster/MarkerCluster.Default.css"),
    ]);
    await loadScript("/vendor/leaflet/leaflet.js");
    await loadScript("/vendor/leaflet-rotate/leaflet-rotate.js");
    await loadScript("/js/mapSafeRuntime.js");
    await loadScript("/vendor/leaflet-markercluster/leaflet.markercluster.js");
  })().catch((err) => {
    // Let the next call retry instead of permanently caching a rejection
    // (a transient network blip shouldn't strand the Map tab for the rest
    // of the session).
    loadPromise = null;
    throw err;
  });
  return loadPromise;
}
