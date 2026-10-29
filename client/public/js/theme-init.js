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
// Start fetching this device's common texts now (i18n.js loads exactly one language) instead of only after i18n.js has arrived and run: one
// network round trip less on a first launch. Not in Calculator Mode, which promises nothing of the real app is fetched before the unlock code.
try {
  var calcMeta = document.querySelector('meta[name="calc-mode"]');
  if (!(calcMeta && calcMeta.content === "true")) {
    var lang = localStorage.getItem("fieldvisits_lang") === "en" ? "en" : "hy";
    // the common texts (i18n/<lang>/common.js): every first screen needs them; the other areas follow after it (i18n.js, step 11)
    // Opening on Home (most launches): Home's own text area too, so it does not wait for the app's code to ask for it (about 0.3 s on
    // a slow phone). HOME_TEXT_AREAS = i18nAreas.js ROUTE_TEXT_AREAS["#/dashboard"] (i18nParity.test.js checks they match).
    var HOME_TEXT_AREAS = ["orders"];
    var path = (location.hash || "").split("?")[0];
    var areas = ["common"].concat(path === "" || path === "#" || path === "#/" || path === "#/dashboard" ? HOME_TEXT_AREAS : []);
    for (var i = 0; i < areas.length; i++) {
      var preload = document.createElement("link");
      preload.rel = "modulepreload";
      preload.href = "/js/i18n/" + lang + "/" + areas[i] + ".js";
      document.head.appendChild(preload);
    }
  }
} catch (e) {}

