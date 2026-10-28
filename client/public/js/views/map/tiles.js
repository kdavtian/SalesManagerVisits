// Parts of renderMapInner (map.js), moved out with the refactor tool (docs/architecture-roadmap.md, step 6). Each
// function takes the screen's state as `ctx` (see the ctx object at the top of renderMapInner).
import { FALLBACK_TILE_URLS, SOFT_BLOCK_SAMPLE_SIZE, TILE_ATTRIBUTION, TILE_URLS } from "../map.js";
import { getTheme } from "../../theme.js";
import { getMapTileCacheEnabled } from "../../mapPrefs.js";

export function hideMapError(ctx) {
  ctx.mapErrorOverlay.hidden = true;
  ctx.mapRetryHint.hidden = true;
}

export function showMapError(ctx) {
  ctx.mapErrorOverlay.hidden = false;
  ctx.mapRetryHint.hidden = true;
}

export function currentProvider(ctx) {
  if (ctx.providerIndex === 0) return { url: ctx.primaryTileUrl(), subdomains: "abc" };
  return FALLBACK_TILE_URLS[ctx.providerIndex - 1];
}

export function makeTileLayer(ctx, { url, subdomains }) {
  const layer = L.tileLayer(url, { maxZoom: 19, attribution: TILE_ATTRIBUTION, subdomains });
  // OSM's usage-policy "heavy use" notice comes back as an ordinary 200 OK
  // image, not an HTTP error -- a desktop's wider viewport requests enough
  // more tiles per pan/zoom than a phone's to cross that informal
  // threshold, and once it does, every tile in view is silently replaced
  // by the same static gray/placeholder notice image forever, with
  // tileload still firing normally (the "blocked map" users have reported
  // on Windows desktops). tileerror/the 15s timeout below can never catch
  // this, since nothing about the request actually fails. Detected
  // instead by re-fetching a handful of early, different-coordinate tiles
  // and checking for an identical byte size across several of them --
  // real map tiles at different coordinates are essentially never
  // byte-for-byte the same size, while the static notice image always is.
  let softBlockChecks = 0;
  const softBlockSizes = [];
  layer.on("tileload", (e) => {
    ctx.tileEverLoaded = true;
    clearTimeout(ctx.tileHealthTimer);
    ctx.hideMapError();
    if (softBlockChecks >= SOFT_BLOCK_SAMPLE_SIZE) return;
    softBlockChecks += 1;
    const tileUrl = typeof layer.getTileUrl === "function" ? layer.getTileUrl(e.coords) : null;
    if (!tileUrl) return;
    fetch(tileUrl)
      .then((res) => res.blob())
      .then((blob) => {
        // Ignore a check that resolves after this layer has already been
        // swapped out (e.g. a provider switch already in flight) --
        // acting on it here would double-advance past the real current
        // provider.
        if (ctx.tileLayer !== layer) return;
        softBlockSizes.push(blob.size);
        const counts = new Map();
        for (const size of softBlockSizes) counts.set(size, (counts.get(size) || 0) + 1);
        if ([...counts.values()].some((count) => count >= 3)) ctx.advanceProvider();
      })
      .catch(() => {
        // CORS/network hiccup on this side-channel verification fetch --
        // the tile itself already rendered fine via the <img> tag Leaflet
        // used, so just skip this one check rather than treat it as a
        // signal either way.
      });
  });
  // A provider actively rejecting us (403, or any other real HTTP error
  // response) fires this almost immediately per tile, unlike a genuinely
  // unreachable/slow provider which just never responds -- waiting out
  // the full 15s health-check timeout below in that case leaves the map
  // visibly broken far longer than necessary once several tiles have
  // already come back with a real error. Requiring a few errors (not
  // just one) avoids over-reacting to a single edge/stale tile at the
  // map's boundary, which 404s/errors normally and isn't a sign the
  // whole provider is down.
  let errorCount = 0;
  layer.on("tileerror", () => {
    if (ctx.tileEverLoaded || ctx.tileLayer !== layer) return;
    errorCount += 1;
    if (errorCount >= 3) ctx.advanceProvider();
  });
  return layer;
}

export function primaryTileUrl(ctx) {
  return TILE_URLS[getTheme()];
}

export function advanceProvider(ctx) {
  clearTimeout(ctx.tileHealthTimer);
  if (ctx.providerIndex <= FALLBACK_TILE_URLS.length - 1) {
    ctx.providerIndex += 1;
    ctx.map.removeLayer(ctx.tileLayer);
    ctx.tileLayer = ctx.makeTileLayer(ctx.currentProvider()).addTo(ctx.map);
    ctx.startTileHealthCheck();
  } else {
    ctx.showMapError();
  }
}

// Real-world mobile latency to a foreign tile CDN (DNS + TLS + first byte,
// over 4G/5G, possibly roaming) can genuinely run past what looks like a
// generous timeout on a fast connection -- reported live from a device in
// Yerevan where even OSM's own tile server didn't clear a 9s window. 15s
// gives a slow-but-working connection real room, while still failing fast
// enough that a truly unreachable provider doesn't leave the map looking
// frozen for too long. Each provider gets its own attempt in sequence
// (OSM -> Wikimedia) before showing a real error -- both independent
// hosts failing in a row is a strong signal the device has no route to
// any map tiles at all, not a problem with one of them.
// A provider returning real HTTP errors (see tileerror above) doesn't
// have to wait out this whole window -- this is the backstop for a
// provider that simply never responds at all.
export function startTileHealthCheck(ctx) {
  ctx.tileEverLoaded = false;
  clearTimeout(ctx.tileHealthTimer);
  ctx.tileHealthTimer = setTimeout(() => {
    if (ctx.tileEverLoaded) return;
    ctx.advanceProvider();
  }, 15000);
}

export function lngToTileX(ctx, lng, z) {
  return Math.floor(((lng + 180) / 360) * 2 ** z);
}

export function latToTileY(ctx, lat, z) {
  const rad = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z);
}

export function warmTileCache(ctx) {
  if (!getMapTileCacheEnabled() || ctx.providerIndex !== 0 || navigator.onLine === false) return;
  const { url, subdomains } = ctx.currentProvider();
  const zoom = Math.round(ctx.map.getZoom());
  const bounds = ctx.map.getBounds();
  const minX = ctx.lngToTileX(bounds.getWest(), zoom) - 1;
  const maxX = ctx.lngToTileX(bounds.getEast(), zoom) + 1;
  const minY = ctx.latToTileY(bounds.getNorth(), zoom) - 1;
  const maxY = ctx.latToTileY(bounds.getSouth(), zoom) + 1;
  let issued = 0;
  // Bounded: a long map session used to keep a huge key set and fire up to 40
  // background tile fetches after EVERY pan/zoom, which piles up memory and
  // network on low-RAM phones.
  if (ctx.warmedTileKeys.size > 400) ctx.warmedTileKeys.clear();
  for (let x = minX; x <= maxX && issued < 12; x++) {
    for (let y = minY; y <= maxY && issued < 12; y++) {
      const key = `${zoom}/${x}/${y}`;
      if (ctx.warmedTileKeys.has(key)) continue;
      ctx.warmedTileKeys.add(key);
      issued += 1;
      const s = subdomains[Math.floor(Math.random() * subdomains.length)] || "";
      const tileUrl = url.replace("{s}", s).replace("{z}", zoom).replace("{x}", x).replace("{y}", y).replace("{r}", "");
      fetch(tileUrl).catch(() => {});
    }
  }
}

export function retryTiles(ctx) {
  ctx.hideMapError();
  // Cycling all 3 providers again can take up to ~45s (see
  // startTileHealthCheck's 15s-per-provider window) with the map canvas
  // otherwise looking completely blank the whole time -- this visible
  // "retrying" hint is what tells a rep the tap actually did something,
  // instead of it reading as a dead button until either a tile shows up
  // or the full error card reappears.
  ctx.mapRetryHint.hidden = false;
  ctx.providerIndex = 0;
  ctx.map.removeLayer(ctx.tileLayer);
  ctx.tileLayer = ctx.makeTileLayer(ctx.currentProvider()).addTo(ctx.map);
  ctx.startTileHealthCheck();
}

// Re-apply the matching tile style if the user flips light/dark while the
// map is mounted (Settings lives on a different tab, so this covers the
// case of returning to the map after toggling). Only matters while still
// on the primary provider -- the fallbacks have no theme variants.
export function refreshTileStyle(ctx) {
  if (ctx.providerIndex !== 0) return;
  const url = ctx.primaryTileUrl();
  if (ctx.tileLayer._url !== url) {
    ctx.map.removeLayer(ctx.tileLayer);
    ctx.tileLayer = ctx.makeTileLayer(ctx.currentProvider()).addTo(ctx.map);
    ctx.startTileHealthCheck();
  }
}

export function checkMapNotBlank(ctx) {
  clearTimeout(ctx.blankTimer);
  ctx.blankTimer = setTimeout(() => {
    if (!ctx.mapIsMeasurable() || document.visibilityState !== "visible") return;
    const tiles = ctx.mapEl.querySelectorAll(".leaflet-tile").length;
    if (tiles > 0) {
      ctx.blankChecks = 0;
      return;
    }
    ctx.blankChecks += 1;
    try {
      // A map that never received a view (nothing to draw) gets the default
      // one before re-measuring.
      if (!ctx.map._loaded) ctx.map.setView([40.1872, 44.5152], 15, { animate: false });
      ctx.map.invalidateSize();
      ctx.tileLayer?.redraw?.();
    } catch {
      // map already torn down
    }
    if (ctx.blankChecks >= 2) {
      window.dispatchEvent(new Event("app-rerender"));
      return;
    }
    ctx.checkMapNotBlank();
  }, 2500);
}
