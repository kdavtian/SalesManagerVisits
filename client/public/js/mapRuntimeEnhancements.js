(function () {
  const STORAGE_KEY = "kad.fieldVisits.mapView.v1";
  const YEREVAN_FALLBACK = { lat: 40.1872, lng: 44.5152, zoom: 14, bearing: 0 };
  const OSM_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
  const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

  function readStoredView() {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const value = JSON.parse(raw);
      if (!Number.isFinite(value?.lat) || !Number.isFinite(value?.lng) || !Number.isFinite(value?.zoom)) return null;
      return {
        lat: value.lat,
        lng: value.lng,
        zoom: Math.max(11, Math.min(19, value.zoom)),
        bearing: Number.isFinite(value.bearing) ? value.bearing : 0,
      };
    } catch {
      return null;
    }
  }

  function writeStoredView(map) {
    try {
      const center = map.getCenter();
      const zoom = map.getZoom();
      if (!center || !Number.isFinite(center.lat) || !Number.isFinite(center.lng) || !Number.isFinite(zoom)) return;
      const bearing = typeof map.getBearing === "function" ? map.getBearing() : 0;
      sessionStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ lat: center.lat, lng: center.lng, zoom, bearing, savedAt: Date.now() })
      );
    } catch {
      // View persistence is optional. Storage failures must never break Map.
    }
  }

  function installLeafletPatches() {
    if (!window.L || window.__kadMapRuntimeInstalled) return;
    window.__kadMapRuntimeInstalled = true;

    // CARTO's public raster endpoint is currently returning repeated API-key
    // watermark text on some mobile sessions. Transparently use the standard
    // OSM raster service instead. Required OSM attribution is preserved.
    const originalTileLayer = window.L.tileLayer.bind(window.L);
    window.L.tileLayer = function kadTileLayer(url, options = {}) {
      const isCarto = typeof url === "string" && url.includes("basemaps.cartocdn.com");
      if (!isCarto) return originalTileLayer(url, options);
      return originalTileLayer(OSM_TILE_URL, {
        ...options,
        subdomains: "",
        attribution: OSM_ATTRIBUTION,
        maxZoom: Math.min(Number(options.maxZoom) || 19, 19),
      });
    };

    const originalMapFactory = window.L.map.bind(window.L);
    window.L.map = function kadMapFactory(...args) {
      const map = originalMapFactory(...args);
      const stored = readStoredView();
      let bootstrapSetViewHandled = false;
      let protectViewportUntil = Date.now() + 6000;
      let userMoved = false;
      let internalMove = false;

      const originalSetView = map.setView.bind(map);
      const originalFitBounds = map.fitBounds.bind(map);

      function internalSetView(center, zoom, options) {
        internalMove = true;
        try {
          return originalSetView(center, zoom, options);
        } finally {
          requestAnimationFrame(() => { internalMove = false; });
        }
      }

      map.setView = function kadSetView(center, zoom, options) {
        const looksLikeWorldBootstrap =
          !bootstrapSetViewHandled &&
          Array.isArray(center) &&
          Math.abs(Number(center[0]) - 20) < 0.01 &&
          Math.abs(Number(center[1])) < 0.01 &&
          Number(zoom) <= 3;

        if (!looksLikeWorldBootstrap) return originalSetView(center, zoom, options);
        bootstrapSetViewHandled = true;

        if (stored) {
          internalSetView([stored.lat, stored.lng], stored.zoom, { animate: false });
          if (stored.bearing && typeof map.setBearing === "function") {
            try { map.setBearing(stored.bearing); } catch {}
          }
          protectViewportUntil = Date.now() + 1400;
          return map;
        }

        // Never expose the world/whole-territory view on first entry. Give an
        // immediately useful local view, then refine it to GPS when available.
        internalSetView([YEREVAN_FALLBACK.lat, YEREVAN_FALLBACK.lng], YEREVAN_FALLBACK.zoom, { animate: false });

        if (navigator.geolocation) {
          navigator.geolocation.getCurrentPosition(
            (position) => {
              if (userMoved) return;
              const { latitude, longitude } = position.coords;
              internalSetView([latitude, longitude], 15, { animate: false });
              protectViewportUntil = Date.now() + 1200;
              writeStoredView(map);
            },
            () => {
              protectViewportUntil = Date.now() + 500;
              writeStoredView(map);
            },
            { enableHighAccuracy: true, timeout: 8000, maximumAge: 5 * 60 * 1000 }
          );
        }
        return map;
      };

      // Customer loading calls fitBounds. During bootstrap that used to undo
      // GPS/local centering and zoom back out to all customers. Protect only
      // the initial seconds; later filter-driven fitBounds works normally.
      map.fitBounds = function kadFitBounds(bounds, options) {
        if (!userMoved && Date.now() < protectViewportUntil) return map;
        return originalFitBounds(bounds, options);
      };

      const noteUserInteraction = () => {
        if (internalMove) return;
        userMoved = true;
        protectViewportUntil = 0;
      };
      map.on("dragstart zoomstart", noteUserInteraction);
      map.on("moveend zoomend rotate", () => writeStoredView(map));

      return map;
    };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", installLeafletPatches, { once: true });
  } else {
    installLeafletPatches();
  }
})();
