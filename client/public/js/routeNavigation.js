// Multi-stop route helpers for the Map's planned stops: leg/total distances and "open the whole
// route in a maps app". Only https links are used (no app-scheme launch racing a fallback timer,
// see util.js openNavigation): Google Maps and Yandex Maps both resolve them to the installed app.
// The distances are straight-line x ROAD_FACTOR -- a good "about N km" for planning, not turn-by-turn.
import { t } from "./i18n.js";
import { activateDialog, escapeHtml, haversineMeters } from "./util.js";

export const ROAD_FACTOR = 1.3;
// Google Maps URLs take 9 waypoints + a destination.
export const MAX_ROUTE_STOPS = 10;

// points: [{ lat, lng }] in visiting order; origin: { lat, lng } | null (where the rep is).
// Returns { legs: [meters per stop, from the previous stop (the first from origin when known, else null)], total }.
export function routeLegs(points, origin = null) {
  const legs = [];
  let total = 0;
  let prev = origin;
  for (const p of points) {
    const meters = prev ? haversineMeters(prev.lat, prev.lng, p.lat, p.lng) * ROAD_FACTOR : null;
    legs.push(meters);
    if (meters != null) total += meters;
    prev = p;
  }
  return { legs, total };
}

const coord = (p) => `${p.lat},${p.lng}`;

export function googleRouteUrl(points, origin = null) {
  const last = points[points.length - 1];
  const via = points.slice(0, -1).map(coord).join("|");
  return `https://www.google.com/maps/dir/?api=1&travelmode=driving${origin ? `&origin=${coord(origin)}` : ""}&destination=${coord(last)}${via ? `&waypoints=${encodeURIComponent(via)}` : ""}`;
}

export function yandexRouteUrl(points, origin = null) {
  const parts = [origin ? coord(origin) : "", ...points.map(coord)];
  return `https://yandex.com/maps/?rtext=${parts.map(encodeURIComponent).join("~")}&rtt=auto`;
}

// stops: [{ lat, lng }] still to visit, in order. Asks which app, then opens the whole route.
export function openRouteInMaps(stops, origin = null) {
  if (!stops.length) return;
  const used = stops.slice(0, MAX_ROUTE_STOPS);
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `
    <div class="sheet" role="dialog" aria-modal="true">
      <h2>${t("route_open_title")}</h2>
      <p class="muted">${escapeHtml(t("route_open_stops").replace("{n}", used.length))}${stops.length > used.length ? ` ${escapeHtml(t("route_open_limit").replace("{n}", MAX_ROUTE_STOPS))}` : ""}</p>
      <div class="nav-choice-list">
        <button type="button" class="nav-choice-btn" data-app="google">${t("open_in_google_maps")}</button>
        <button type="button" class="nav-choice-btn" data-app="yandex">${t("route_yandex_maps")}</button>
      </div>
      <div class="sheet-actions">
        <button type="button" class="btn btn-block" id="cancel-route-open">${t("cancel")}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  activateDialog(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener("click", (e) => e.target === overlay && close());
  overlay.querySelector("#cancel-route-open").addEventListener("click", close);
  overlay.querySelector('[data-app="google"]').addEventListener("click", () => {
    close();
    window.location.href = googleRouteUrl(used, origin);
  });
  overlay.querySelector('[data-app="yandex"]').addEventListener("click", () => {
    close();
    window.location.href = yandexRouteUrl(used, origin);
  });
}
