// Small DOM-only enhancements for the semantic map-marker system.
// Keeps Leaflet/business logic untouched while making the selected customer
// visually obvious. Event delegation means markers added/re-rendered later
// by filters are covered automatically.

function bootMapMarkerEnhancements() {
  document.addEventListener("click", (event) => {
    const marker = event.target.closest?.("#leaflet-map .leaflet-marker-icon");
    if (marker && marker.querySelector(".pin:not(.pin-stop):not(.pin-new)")) {
      document.querySelectorAll("#leaflet-map .leaflet-marker-icon.kad-marker-selected").forEach((el) => {
        if (el !== marker) el.classList.remove("kad-marker-selected");
      });
      marker.classList.add("kad-marker-selected");
      return;
    }

    // Clicking the bare map clears selection; popup/control interactions do not.
    if (event.target.closest?.("#leaflet-map") && !event.target.closest?.(".leaflet-popup, .leaflet-control")) {
      document.querySelectorAll("#leaflet-map .leaflet-marker-icon.kad-marker-selected").forEach((el) => {
        el.classList.remove("kad-marker-selected");
      });
    }
  });

  // Leaflet removes the popup when another marker closes/opens. When there is
  // no popup left, clear any stale selected halo so the map never lies about
  // which customer is active.
  const observer = new MutationObserver(() => {
    const map = document.querySelector("#leaflet-map");
    if (!map || map.querySelector(".leaflet-popup")) return;
    map.querySelectorAll(".leaflet-marker-icon.kad-marker-selected").forEach((el) => {
      el.classList.remove("kad-marker-selected");
    });
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootMapMarkerEnhancements, { once: true });
} else {
  bootMapMarkerEnhancements();
}
