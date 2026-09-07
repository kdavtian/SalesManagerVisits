// Personal map display preferences. Stored in localStorage, matching the
// two preferences this app already keeps per device (theme.js, i18n.js's
// language) rather than the per-user notification_settings table -- how
// dense you like your own map on your own phone is a display habit tied to
// that screen, not account data worth syncing or auditing across devices.
const CLUSTER_KEY = "fieldvisits_map_cluster";
const COMPASS_KEY = "fieldvisits_map_compass";

// Default ON: clustering is what the map has always done, so an install
// with nothing stored behaves exactly as before.
export function getClusterPins() {
  return localStorage.getItem(CLUSTER_KEY) !== "off";
}

export function setClusterPins(enabled) {
  localStorage.setItem(CLUSTER_KEY, enabled ? "on" : "off");
}

// Whether the locate button's third tap enters compass/heading-tracking
// mode. Default ON (the location button's existing off -> on -> track
// cycle) so an install with nothing stored behaves exactly as before; off
// makes the button a plain show/hide toggle for reps who found the
// tracking step disorienting or don't need it.
export function getCompassMode() {
  return localStorage.getItem(COMPASS_KEY) !== "off";
}

export function setCompassMode(enabled) {
  localStorage.setItem(COMPASS_KEY, enabled ? "on" : "off");
}
