// Map-only UI enhancements. No MutationObserver and no recurring polling.
// A short bounded mount retry is used because the SPA renders the Map view
// after the route changes; once attached, normal event handlers do the rest.
import { t } from "./i18n.js";

function competitorIcon() {
  return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 10h16v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19z"/><path d="m5 10 1.2-5h11.6L19 10M8 20.5v-6h4v6M4.5 10c.8 1.4 2.6 1.4 3.5 0 .8 1.4 2.7 1.4 3.5 0 .8 1.4 2.7 1.4 3.5 0 .8 1.4 2.7 1.4 3.5 0"/></svg>`;
}

function labels() {
  const lang = document.documentElement.lang || "en";
  if (lang.startsWith("hy")) return { label: "Մրցակիցներ", show: "Ցույց տալ մրցակիցներին", hide: "Թաքցնել մրցակիցներին" };
  if (lang.startsWith("ru")) return { label: "Конкуренты", show: "Показать конкурентов", hide: "Скрыть конкурентов" };
  return { label: "Competitors", show: "Show competitors", hide: "Hide competitors" };
}

function attachCompetitorToggle() {
  const mapView = document.querySelector(".map-view");
  if (!mapView || mapView.dataset.safeUiReady === "1") return Boolean(mapView);
  const filterRow = mapView.querySelector(".map-filter-row");
  if (!filterRow) return false;

  mapView.dataset.safeUiReady = "1";
  mapView.classList.remove("kad-show-competitors"); // hidden by default on every Map entry

  const copy = labels();
  const button = document.createElement("button");
  button.type = "button";
  button.className = "map-filter-chip map-competitor-toggle";
  button.setAttribute("aria-pressed", "false");
  button.setAttribute("aria-label", copy.show);
  button.title = copy.show;
  button.innerHTML = `<span class="map-filter-chip-icon">${competitorIcon()}</span>${copy.label}`;

  button.addEventListener("click", () => {
    const visible = mapView.classList.toggle("kad-show-competitors");
    button.classList.toggle("chip-active", visible);
    button.setAttribute("aria-pressed", String(visible));
    button.setAttribute("aria-label", visible ? copy.hide : copy.show);
    button.title = visible ? copy.hide : copy.show;
  });

  filterRow.appendChild(button);
  return true;
}

function mountForCurrentRoute() {
  if (!location.hash.startsWith("#/map")) return;
  let attempts = 0;
  const tryMount = () => {
    if (attachCompetitorToggle()) return;
    attempts += 1;
    if (attempts < 20 && location.hash.startsWith("#/map")) setTimeout(tryMount, 50);
  };
  tryMount();
}

window.addEventListener("hashchange", mountForCurrentRoute);
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mountForCurrentRoute, { once: true });
} else {
  mountForCurrentRoute();
}
