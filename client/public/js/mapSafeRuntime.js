// Safe, bounded Leaflet runtime improvements for Field Visits.
// No MutationObserver, no global fetch interception, and no DOM scanning.
// This module handles viewport persistence plus a conservative OpenStreetMap
// light-map override tuned for current iPhone/Android browsers.
(function () {
  if (!window.L || window.__kadSafeMapRuntimeInstalled) return;
  window.__kadSafeMapRuntimeInstalled = true;

  const STORAGE_KEY = "kad.fieldVisits.mapView.v2";
  const FALLBACK_VIEW = { lat: 40.1872, lng: 44.5152, zoom: 15, bearing: 0 };
  const OSM_URL = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
  const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

  function readView() {
    try {
      const parsed = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "null");
      if (!parsed || !Number.isFinite(parsed.lat) || !Number.isFinite(parsed.lng) || !Number.isFinite(parsed.zoom)) return null;
      return {
        lat: parsed.lat,
        lng: parsed.lng,
        zoom: Math.max(11, Math.min(19, parsed.zoom)),
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
      const zoom = Math.min(19, map.getZoom());
      const bearing = typeof map.getBearing === "function" ? map.getBearing() : 0;
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ lat: center.lat, lng: center.lng, zoom, bearing, savedAt: Date.now() }));
    } catch {
      // View memory is convenience-only. Storage errors must never affect Map.
    }
  }

  // The original light map used standard OpenStreetMap raster tiles. Keep the
  // app's dark CARTO style intact, but route the LIGHT Voyager request back to
  // standard OSM. The important quality fix is to NOT use Leaflet detectRetina
  // or over-zoom raster tiles: on 3x iPhones that combination enlarged labels
  // and interpolated tiles, producing the visibly soft/blocky result reported
  // on device. Native OSM zoom is capped at 19 and rendered 1:1 by Leaflet.
  const nativeTileLayer = window.L.tileLayer.bind(window.L);
  window.L.tileLayer = function kadTileLayer(url, options = {}) {
    const isLightCarto = typeof url === "string" && url.includes("basemaps.cartocdn.com") && url.includes("voyager");
    if (!isLightCarto) return nativeTileLayer(url, options);

    return nativeTileLayer(OSM_URL, {
      ...options,
      subdomains: "abc",
      attribution: OSM_ATTRIBUTION,
      tileSize: 256,
      zoomOffset: 0,
      detectRetina: false,
      maxNativeZoom: 19,
      maxZoom: 19,
      minZoom: 3,
      updateWhenIdle: false,
      updateWhenZooming: true,
      updateInterval: 120,
      keepBuffer: 4,
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

    // Never let a raster map enter over-zoom territory; that is where the
    // browser has to scale a lower-resolution tile and quality falls apart.
    if (typeof map.setMaxZoom === "function") map.setMaxZoom(19);

    const nativeSetView = map.setView.bind(map);
    const nativeFitBounds = map.fitBounds.bind(map);

    map.setView = function safeSetView(center, zoom, options) {
      const requestedZoom = Number.isFinite(Number(zoom)) ? Math.min(19, Number(zoom)) : zoom;
      const isInitialWorldView =
        !bootstrapHandled &&
        Array.isArray(center) &&
        Math.abs(Number(center[0]) - 20) < 0.01 &&
        Math.abs(Number(center[1])) < 0.01 &&
        Number(requestedZoom) <= 3;

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
      // This is one-shot so the explicit Locate button continues to work.
      if (
        suppressOneAutomaticGpsSetView &&
        Date.now() - createdAt < 6000 &&
        Number(requestedZoom) === 15
      ) {
        suppressOneAutomaticGpsSetView = false;
        suppressOneAutomaticFit = false;
        return map;
      }
      suppressOneAutomaticGpsSetView = false;
      return nativeSetView(center, requestedZoom, options);
    };

    map.fitBounds = function safeFitBounds(bounds, options) {
      if (suppressOneAutomaticFit && Date.now() - createdAt < 6000) {
        suppressOneAutomaticFit = false;
        return map;
      }
      suppressOneAutomaticFit = false;
      return nativeFitBounds(bounds, { ...options, maxZoom: Math.min(19, Number(options?.maxZoom) || 19) });
    };

    map.on("moveend zoomend rotate", () => saveView(map));
    return map;
  };
})();
