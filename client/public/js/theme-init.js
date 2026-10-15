// Applied synchronously, before first paint, to avoid a flash of the
// wrong theme. Light is the default; dark only applies if chosen.
// Kept as a separate same-origin file (not an inline <script> in
// index.html) so the page can run a strict script-src CSP without
// carving out an 'unsafe-inline' exception.
try {
  var t = localStorage.getItem("fieldvisits_theme");
  if (t === "dark") document.documentElement.dataset.theme = "dark";
} catch (e) {}
try {
  var ts = localStorage.getItem("fieldvisits_text_size");
  if (ts === "large" || ts === "xlarge") document.documentElement.dataset.textSize = ts;
} catch (e) {}
