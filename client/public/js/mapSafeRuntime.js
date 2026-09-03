// Safe, bounded Leaflet runtime improvements for Field Visits.
// Important: no MutationObserver, no global fetch interception, and no DOM scans.
// This only adjusts the map instance at creation time and the tile provider.
(function () {
  if (!window.L || window.__kadSafeMapRuntimeInstalled) return;
  window.__kadSafeMapRuntimeInstalled = true;

  const STORAGE_KEY = "kad.fieldVisits.mapView.v2";
  const FALLBACK_VIEW = { lat: 40.1872, lng: 44.5152, zoom: 15, bearing: 0 };
  const OSM_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
  const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

  function readView() {
    try {
      const parsed = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "null");
      if (!parsed || !Number.isFinite(parsed.lat) || !Number.isFinite(parsed.lng) || !Number.isFinite(parsed.zoom)) return null;
      return {
        lat: parsed.lat,
        lng: parsed.lng,
        zoom: Math.max(11, Math.min(20, parsed.zoom)),
        bearing: Number.isFinite(parsed.bearing) ? parsed.bearing : 0,
      };
    } catch {
      return null;
    }
  }

  function saveView(map) {
    try {
      const center = map.getCenter();
      if (!center || !Number.isFinite(center.lat) || !Number.isFinite(center.lng)) return;
      const zoom = map.getZoom();
      const bearing = typeof map.getBearing === "function" ? map.getBearing() : 0;
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ lat: center.lat, lng: center.lng, zoom, bearing, savedAt: Date.now() }));
    } catch {
      // View memory is a convenience only; storage failure must never affect Map.
    }
  }

  // Use standard OpenStreetMap raster tiles directly. On Retina/high-DPI
  // iPhones Leaflet otherwise stretches 256px tiles across twice as many
  // physical pixels, which makes roads and labels look soft. detectRetina
  // requests one zoom level sharper and scales it correctly on-device.
  const nativeTileLayer = window.L.tileLayer.bind(window.L);
  window.L.tileLayer = function safeTileLayer(url, options = {}) {
    const isCarto = typeof url === "string" && url.includes("basemaps.cartocdn.com");
    if (!isCarto) return nativeTileLayer(url, options);
    return nativeTileLayer(OSM_URL, {
      ...options,
      subdomains: "",
      attribution: OSM_ATTRIBUTION,
      detectRetina: true,
      maxNativeZoom: 19,
      maxZoom: 20,
      updateWhenIdle: true,
      updateWhenZooming: false,
      keepBuffer: 3,
      crossOrigin: true,
    });
  };

  const nativeMapFactory = window.L.map.bind(window.L);
  window.L.map = function safeMapFactory(...args) {
    const map = nativeMapFactory(...args);
    const restored = readView();
    const createdAt = Date.now();
    let bootstrapHandled = false;
    let suppressOneAutomaticGpsSetView = Boolean(restored);
    let suppressOneAutomaticFit = Boolean(restored);

    const nativeSetView = map.setView.bind(map);
    const nativeFitBounds = map.fitBounds.bind(map);

    map.setView = function safeSetView(center, zoom, options) {
      const isInitialWorldView =
        !bootstrapHandled &&
        Array.isArray(center) &&
        Math.abs(Number(center[0]) - 20) < 0.01 &&
        Math.abs(Number(center[1])) < 0.01 &&
        Number(zoom) <= 3;

      if (isInitialWorldView) {
        bootstrapHandled = true;
        const target = restored || FALLBACK_VIEW;
        const result = nativeSetView([target.lat, target.lng], target.zoom, { ...options, animate: false });
        if (restored?.bearing && typeof map.setBearing === "function") {
          try { map.setBearing(restored.bearing); } catch {}
        }
        return result;
      }

      // map.js automatically recenters to GPS once customers load. When the
      // user is RETURNING to Map, preserve their previous viewport instead.
      // This suppression is one-shot and short-lived, so the explicit Locate
      // button continues to work normally.
      if (
        suppressOneAutomaticGpsSetView &&
        Date.now() - createdAt < 6000 &&
        Number(zoom) === 15
      ) {
        suppressOneAutomaticGpsSetView = false;
        // GPS succeeded, so map.js will not fall back to fitBounds. Do not
        // accidentally suppress the user's first real filter-driven fit.
        suppressOneAutomaticFit = false;
        return map;
      }
      suppressOneAutomaticGpsSetView = false;
      return nativeSetView(center, zoom, options);
    };

    map.fitBounds = function safeFitBounds(bounds, options) {
      if (suppressOneAutomaticFit && Date.now() - createdAt < 6000) {
        suppressOneAutomaticFit = false;
        return map;
      }
      suppressOneAutomaticFit = false;
      return nativeFitBounds(bounds, options);
    };

    map.on("moveend zoomend rotate", () => saveView(map));
    return map;
  };
})();
