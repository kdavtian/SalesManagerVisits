// DOM-level map marker behavior shared across Leaflet re-renders.
// Competitors are intentionally hidden by default because they are market
// intelligence, not visit-required stops. Users can explicitly reveal them
// from the map filter row without changing any other active map filter.

let showCompetitors = false;

function languageCopy() {
  const lang = document.documentElement.lang || "en";
  if (lang.startsWith("hy")) return { competitors: "Մրցակիցներ", show: "Ցույց տալ մրցակիցներին", hide: "Թաքցնել մրցակիցներին" };
  if (lang.startsWith("ru")) return { competitors: "Конкуренты", show: "Показать конкурентов", hide: "Скрыть конкурентов" };
  return { competitors: "Competitors", show: "Show competitors", hide: "Hide competitors" };
}

function competitorToggleIcon() {
  return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 10h16v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19z"/><path d="m5 10 1.2-5h11.6L19 10M8 20.5v-6h4v6M4.5 10c.8 1.4 2.6 1.4 3.5 0 .8 1.4 2.7 1.4 3.5 0 .8 1.4 2.7 1.4 3.5 0 .8 1.4 2.7 1.4 3.5 0"/><path d="M18.5 4.5 21 2"/></svg>`;
}

function applyCompetitorVisibility(mapRoot = document.querySelector("#leaflet-map")) {
  if (!mapRoot) return;
  mapRoot.querySelectorAll(".leaflet-marker-icon").forEach((marker) => {
    const pin = marker.querySelector(".pin-tier-competitor");
    if (!pin) return;

    // Competitors never carry visit-required semantics.
    pin.classList.remove("pin-status-overdue");
    pin.querySelectorAll(".pin-check").forEach((badge) => badge.remove());

    marker.classList.add("kad-competitor-marker");
    marker.hidden = !showCompetitors;
    marker.setAttribute("aria-hidden", String(!showCompetitors));
  });

  const toggle = document.querySelector("#map-competitor-toggle");
  if (toggle) {
    const copy = languageCopy();
    toggle.classList.toggle("chip-active", showCompetitors);
    toggle.setAttribute("aria-pressed", String(showCompetitors));
    toggle.setAttribute("aria-label", showCompetitors ? copy.hide : copy.show);
    toggle.title = showCompetitors ? copy.hide : copy.show;
  }

  // Nearest-customer check-in must never suggest a competitor.
  const nearestBar = document.querySelector("#nearest-customer-bar");
  const nearestName = nearestBar?.querySelector("strong")?.textContent?.trim();
  if (nearestBar && nearestName && window.__kadCompetitorNames?.has(nearestName)) nearestBar.hidden = true;
}

function ensureCompetitorToggle() {
  const mapView = document.querySelector(".map-view");
  if (!mapView || document.querySelector("#map-competitor-toggle")) return;
  const filterRow = mapView.querySelector(".map-filter-row");
  if (!filterRow) return;

  const copy = languageCopy();
  const button = document.createElement("button");
  button.type = "button";
  button.id = "map-competitor-toggle";
  button.className = "map-filter-chip map-competitor-toggle";
  button.setAttribute("aria-pressed", "false");
  button.setAttribute("aria-label", copy.show);
  button.title = copy.show;
  button.innerHTML = `<span class="map-filter-chip-icon">${competitorToggleIcon()}</span>${copy.competitors}`;
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    showCompetitors = !showCompetitors;
    applyCompetitorVisibility();
  });
  filterRow.appendChild(button);
}

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

    if (event.target.closest?.("#leaflet-map") && !event.target.closest?.(".leaflet-popup, .leaflet-control")) {
      document.querySelectorAll("#leaflet-map .leaflet-marker-icon.kad-marker-selected").forEach((el) => {
        el.classList.remove("kad-marker-selected");
      });
    }
  });

  const observer = new MutationObserver(() => {
    ensureCompetitorToggle();
    applyCompetitorVisibility();

    const map = document.querySelector("#leaflet-map");
    if (!map || map.querySelector(".leaflet-popup")) return;
    map.querySelectorAll(".leaflet-marker-icon.kad-marker-selected").forEach((el) => {
      el.classList.remove("kad-marker-selected");
    });
  });
  observer.observe(document.body, { childList: true, subtree: true });

  ensureCompetitorToggle();
  applyCompetitorVisibility();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootMapMarkerEnhancements, { once: true });
} else {
  bootMapMarkerEnhancements();
}
