// Applied synchronously, before first paint, same reasoning as
// theme-init.js right above it in index.html: avoids a flash of full
// animations/map effects before perfMode.js's module script has loaded, and
// keeps a strict script-src CSP happy (no inline script needed).
try {
  var perfMode = localStorage.getItem("fieldvisits_perf_mode");
  document.documentElement.dataset.perf = perfMode === "efficiency" ? "efficiency" : "performance";
} catch (e) {}
