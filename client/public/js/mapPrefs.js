// Personal map display preferences. Stored in localStorage, matching the
// two preferences this app already keeps per device (theme.js, i18n.js's
// language) rather than the per-user notification_settings table -- how
// dense you like your own map on your own phone is a display habit tied to
// that screen, not account data worth syncing or auditing across devices.
const CLUSTER_KEY = "fieldvisits_map_cluster";

// Default ON: clustering is what the map has always done, so an install
// with nothing stored behaves exactly as before.
export function getClusterPins() {
  return localStorage.getItem(CLUSTER_KEY) !== "off";
}

export function setClusterPins(enabled) {
  localStorage.setItem(CLUSTER_KEY, enabled ? "on" : "off");
}
