// "Check-in locations": the customer's pin next to the last 5 places a rep REALLY checked in from (the GPS
// spot saved with every check-in), so a wrong pin is obvious -- and fixable right here (Change location).
// Opened by tapping "Location verified" in a visit's details, and from a blocked check-in ("too far").
import { api } from "../api.js";
import { escapeHtml } from "../util.js";
import { t } from "../i18n.js";
import { ensureLeaflet } from "../leafletLoader.js";
import { paintCheckinSpots, parseHere, spotLabel } from "../checkinSpotsLayer.js";

export async function renderCheckinSpots(root, navigate, customerId, query) {
  root.innerHTML = `<div class="detail-view"><p class="loading-state" role="status">${t("loading")}</p></div>`;
  const container = root.querySelector(".detail-view");

  let data;
  try {
    [data] = await Promise.all([api.getCheckinSpots(customerId), ensureLeaflet()]);
  } catch (err) {
    container.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    return;
  }
  const here = parseHere(query.get("here"));
  const suggest = parseHere(query.get("suggest"));
  const focusId = query.get("checkin") || null;

  container.innerHTML = `
    <div class="detail-header">
      <button class="icon-btn" id="back-btn" aria-label="${t("back")}">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
      </button>
      <div class="detail-header-title">
        <h1>${t("spots_title")}</h1>
        <span class="badge badge-neutral">${escapeHtml(data.customer.name)}</span>
      </div>
    </div>
    <div class="spots-map" id="spots-map"></div>
    <ul class="spots-legend">
      <li><span class="spots-legend-pin">&#9679;</span>${t("spots_customer_pin")}</li>
      ${suggest ? `<li><span class="spots-legend-pin spots-legend-suggest">&#9679;</span>${t("spots_suggested_pin")}</li>` : ""}
      ${data.spots.map((s, i) => `<li><button type="button" class="spots-legend-row" data-spot="${escapeHtml(String(s.id))}"><span class="spots-legend-n${s.within_range ? "" : " spots-spot-far"}">${i + 1}</span><span>${spotLabel(s)}</span></button></li>`).join("")}
      ${data.spots.length ? "" : `<li class="muted">${t("spots_none")}</li>`}
    </ul>
    <p class="muted spots-help">${t("spots_help").replace("{m}", String(data.allowance_meters))}</p>
    <div class="sheet-actions spots-actions">
      <button type="button" class="btn btn-primary btn-block" id="spots-change-location">${t("change_location")}</button>
    </div>
  `;
  container.querySelector("#back-btn").addEventListener("click", () => navigate.goBack(`#/customers/${customerId}`));
  container.querySelector("#spots-change-location").addEventListener("click", () => {
    navigate(`#/map?relocate=${customerId}${here ? `&here=${here.lat},${here.lng}` : ""}`);
  });

  const mapEl = container.querySelector("#spots-map");
  const map = L.map(mapEl, { zoomControl: true, attributionControl: false, kadPlainView: true });
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, subdomains: "abc" }).addTo(map);
  const { bounds, markers } = paintCheckinSpots(map, data, { here, suggest });
  map.fitBounds(bounds, { padding: [36, 36], maxZoom: 18 });
  setTimeout(() => map.invalidateSize(), 50);
  const focus = (id) => {
    const marker = markers.get(String(id));
    if (!marker) return;
    map.panTo(marker.getLatLng());
    marker.openPopup();
  };
  container.querySelectorAll("[data-spot]").forEach((row) => row.addEventListener("click", () => focus(row.dataset.spot)));
  if (focusId) setTimeout(() => focus(focusId), 300);
}
