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
// True only once leaflet.js AND its plugins AND mapSafeRuntime are all in
// place. `window.L` alone is NOT proof of that: leaflet.js sets it long
// before the rotate/markercluster plugins finish, so a tap on Map while the
// idle preload was mid-flight (or after one plugin failed to load) used to
// see `L` and skip straight to building the map without them -- the
// "map won't open until I restart the app" bug.
let fullyLoaded = false;
const LOAD_TIMEOUT_MS = 20000;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    // A script already in the page (a failed earlier attempt left its tag
    // behind, or an attempt still running) is removed first so the retry
    // really re-requests it and never stacks duplicates.
    document.head.querySelectorAll("script[data-leaflet-dep]").forEach((el) => {
      if (el.getAttribute("src") === src) el.remove();
    });
    const script = document.createElement("script");
    script.src = src;
    script.dataset.leafletDep = "1";
    const timer = setTimeout(() => {
      script.remove();
      reject(new Error(`Timed out loading ${src}`));
    }, LOAD_TIMEOUT_MS);
    script.onload = () => {
      clearTimeout(timer);
      resolve();
    };
    script.onerror = () => {
      clearTimeout(timer);
      script.remove();
      reject(new Error(`Failed to load ${src}`));
    };
    document.head.appendChild(script);
  });
}

function loadStylesheet(href) {
  return new Promise((resolve, reject) => {
    if (document.head.querySelector(`link[data-leaflet-dep][href="${href}"]`)?.dataset.loaded) return resolve();
    document.head.querySelectorAll("link[data-leaflet-dep]").forEach((el) => {
      if (el.getAttribute("href") === href) el.remove();
    });
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.dataset.leafletDep = "1";
    const timer = setTimeout(() => {
      link.remove();
      reject(new Error(`Timed out loading ${href}`));
    }, LOAD_TIMEOUT_MS);
    link.onload = () => {
      clearTimeout(timer);
      link.dataset.loaded = "1";
      resolve();
    };
    link.onerror = () => {
      clearTimeout(timer);
      link.remove();
      reject(new Error(`Failed to load ${href}`));
    };
    document.head.appendChild(link);
  });
}

// Runs a plugin script only if its marker is still missing (leaflet.js
// itself is loaded once; a retry after a later step failed must not
// re-execute it -- that would replace window.L and orphan the plugins).
const needs = (check) => !check();

export function ensureLeaflet() {
  if (fullyLoaded) return Promise.resolve();
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    await Promise.all([
      loadStylesheet("/vendor/leaflet/leaflet.css"),
      loadStylesheet("/vendor/leaflet-markercluster/MarkerCluster.css"),
      loadStylesheet("/vendor/leaflet-markercluster/MarkerCluster.Default.css"),
    ]);
    // Scripts depend on each other, so they load one at a time in order;
    // each step is skipped when its own marker already exists, which makes
    // a retry resume from the step that failed.
    if (needs(() => window.L?.map)) await loadScript("/vendor/leaflet/leaflet.js");
    if (needs(() => window.L?.Map?.prototype?.setBearing)) await loadScript("/vendor/leaflet-rotate/leaflet-rotate.js");
    if (needs(() => window.__kadSafeMapRuntimeInstalled)) await loadScript("/js/mapSafeRuntime.js");
    if (needs(() => window.L?.markerClusterGroup)) await loadScript("/vendor/leaflet-markercluster/leaflet.markercluster.js");
    fullyLoaded = true;
  })().catch((err) => {
    // Let the next call retry instead of permanently caching a rejection
    // (a transient network blip shouldn't strand the Map tab for the rest
    // of the session).
    loadPromise = null;
    throw err;
  });
  return loadPromise;
}
