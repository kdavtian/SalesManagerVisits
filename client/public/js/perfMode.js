// Personal device performance preference. Stored in localStorage, same
// pattern as theme.js/mapPrefs.js -- how much visual polish a given phone
// can comfortably afford is a property of that device, not account data
// worth syncing or auditing across devices.
const PERF_MODE_KEY = "fieldvisits_perf_mode";

// Default "performance": every animation/map feature this app has always
// had stays exactly as it is unless a rep opts into "efficiency" -- this
// setting only ever takes things away, never changes default behavior.
export function getPerfMode() {
  return localStorage.getItem(PERF_MODE_KEY) === "efficiency" ? "efficiency" : "performance";
}

export function setPerfMode(mode) {
  localStorage.setItem(PERF_MODE_KEY, mode === "efficiency" ? "efficiency" : "performance");
  applyPerfMode();
}

// [data-perf="efficiency"] is what styles.css's global transition/animation
// kill-switch and map.js's lighter L.map() options key off of. Applied
// synchronously pre-first-paint by perf-mode-init.js (see index.html) so
// there's no flash of animations before this module has even loaded; this
// export exists so setPerfMode's own click handler can re-apply it
// immediately too, without a full page reload.
export function applyPerfMode() {
  document.documentElement.dataset.perf = getPerfMode();
}
