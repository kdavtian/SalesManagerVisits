// Desktop browsers ignore the viewport meta's user-scalable=no, so a Mac
// trackpad pinch (Chrome: ctrl+wheel, Safari: gesture events) or Cmd/Ctrl
// +/-/0 zoomed the whole app like a website. Block those everywhere except
// over the Leaflet map, which handles its own wheel/pinch zoom.
(function () {
  function onMap(e) {
    var t = e.target;
    return !!(t && t.closest && t.closest("#leaflet-map, .leaflet-container"));
  }
  window.addEventListener("wheel", function (e) {
    if ((e.ctrlKey || e.metaKey) && !onMap(e)) e.preventDefault();
  }, { passive: false });
  ["gesturestart", "gesturechange", "gestureend"].forEach(function (n) {
    document.addEventListener(n, function (e) {
      if (!onMap(e)) e.preventDefault();
    }, { passive: false });
  });
  window.addEventListener("keydown", function (e) {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (e.key === "+" || e.key === "=" || e.key === "-" || e.key === "_" || e.key === "0") e.preventDefault();
  });
})();
