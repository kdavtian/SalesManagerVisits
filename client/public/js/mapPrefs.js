// Personal map display preferences. Stored in localStorage, matching the
// two preferences this app already keeps per device (theme.js, i18n.js's
// language) rather than the per-user notification_settings table -- how
// dense you like your own map on your own phone is a display habit tied to
// that screen, not account data worth syncing or auditing across devices.
const CLUSTER_KEY = "fieldvisits_map_cluster";
const COMPASS_KEY = "fieldvisits_map_compass";
const TILE_CACHE_KEY = "fieldvisits_map_tile_cache";

// Default ON: clustering is what the map has always done, so an install
// with nothing stored behaves exactly as before.
export function getClusterPins() {
  return localStorage.getItem(CLUSTER_KEY) !== "off";
}

export function setClusterPins(enabled) {
  localStorage.setItem(CLUSTER_KEY, enabled ? "on" : "off");
}

// Whether the locate button's third tap enters compass/heading-tracking
// mode. Default OFF -- an install with nothing stored gets the plain
// show/hide locate toggle; a rep can opt into the tracking step from the
// map legend's own preference switch if they want it.
export function getCompassMode() {
  return localStorage.getItem(COMPASS_KEY) === "on";
}

export function setCompassMode(enabled) {
  localStorage.setItem(COMPASS_KEY, enabled ? "on" : "off");
}

// Best-effort "is this a capable-enough device to spend extra data/battery
// proactively warming the map tile cache" check. There's no reliable cross-
// platform memory signal (navigator.deviceMemory isn't exposed by iOS
// Safari at all), so this leans on hardwareConcurrency (CPU core count),
// which is -- a low-end/older phone typically reports 2-4, a modern
// mid-range-or-better phone 6+. Defaults to true when the API is missing
// entirely (very old browsers report nothing here at all) rather than
// hiding the option from a device we simply can't measure.
export function isStrongDevice() {
  const cores = navigator.hardwareConcurrency;
  return typeof cores !== "number" || cores >= 6;
}

// Proactive tile-cache warming, offered only on capable devices (see
// isStrongDevice) -- default OFF, since it trades extra data/battery use
// for the map being ready before a rep even pans there. When on, map.js
// prefetches a buffer ring of tiles around the current viewport on every
// pan/zoom; the service worker's existing basemaps.cartocdn.com handler
// (sw.js) caches every one of those fetches the same way it already
// caches tiles from normal panning, so this needs no service-worker
// changes of its own -- it's just requesting tiles before they're seen.
export function getMapTileCacheEnabled() {
  return localStorage.getItem(TILE_CACHE_KEY) === "on";
}

export function setMapTileCacheEnabled(enabled) {
  localStorage.setItem(TILE_CACHE_KEY, enabled ? "on" : "off");
}
