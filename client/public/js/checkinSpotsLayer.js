// Draws "where was this customer really visited from" on a Leaflet map: the customer's pin, the
// allowance circle around it, the last check-in spots (1 = newest) and, optionally, "you are here".
// Shared by the check-in locations page (views/checkinSpots.js) and the Change location map (views/map.js),
// so a rep or manager always sees the real GPS evidence next to the pin they are about to correct.
import { escapeHtml, formatDateTime, formatDistance, cssColor } from "./util.js";
import { t } from "./i18n.js";

const pinIcon = () =>
  L.divIcon({
    className: "spots-pin",
    html: '<svg viewBox="0 0 24 32" width="28" height="36" aria-hidden="true"><path d="M12 0C5.4 0 0 5.2 0 11.7 0 20 12 32 12 32s12-12 12-20.3C24 5.2 18.6 0 12 0z" fill="#d6291f" stroke="#fff" stroke-width="1.5"/><circle cx="12" cy="11.5" r="4.5" fill="#fff"/></svg>',
    iconSize: [28, 36],
    iconAnchor: [14, 36],
  });
const spotIcon = (n, withinRange) =>
  L.divIcon({
    className: "spots-spot",
    html: `<span class="${withinRange ? "" : "spots-spot-far"}">${n}</span>`,
    iconSize: [26, 26],
  });
const hereIcon = () => L.divIcon({ className: "spots-here", html: "<span></span>", iconSize: [20, 20] });

export function spotLabel(spot) {
  return `${escapeHtml(spot.user_name)} · ${formatDateTime(spot.timestamp)} · ${formatDistance(spot.distance_meters)}`;
}

// data = GET /customers/:id/checkin-spots; here = {lat, lng} | null;
// onUse(latlng) adds a "Use this spot" button to each popup (the Change location flow);
// showPin = false skips the customer pin + allowance circle (the Change location map draws its own pin).
// Returns { bounds, markers: Map(checkinId -> marker) }.
export function paintCheckinSpots(map, data, { here = null, onUse = null, showPin = true } = {}) {
  const { customer, spots, allowance_meters: allowance } = data;
  const bounds = L.latLngBounds([[customer.lat, customer.lng]]);
  const markers = new Map();

  if (showPin && allowance > 0) {
    L.circle([customer.lat, customer.lng], {
      radius: allowance,
      color: cssColor("--accent", "#0969da"),
      weight: 1,
      dashArray: "4 4",
      fillOpacity: 0.06,
      interactive: false,
    }).addTo(map);
  }
  if (showPin) {
    L.marker([customer.lat, customer.lng], { icon: pinIcon(), zIndexOffset: 500 }).addTo(map).bindPopup(`<strong>${escapeHtml(customer.name)}</strong><br>${t("spots_customer_pin")}`);
  }

  spots.forEach((spot, i) => {
    const marker = L.marker([spot.lat, spot.lng], { icon: spotIcon(i + 1, spot.within_range) }).addTo(map);
    marker.bindPopup(
      `<strong>#${i + 1}</strong> ${spotLabel(spot)}${onUse ? `<br><button type="button" class="btn btn-sm btn-primary spots-use-btn" data-use-spot>${t("spots_use_this")}</button>` : ""}`
    );
    if (onUse) {
      marker.on("popupopen", (e) => {
        e.popup.getElement()?.querySelector("[data-use-spot]")?.addEventListener("click", () => {
          map.closePopup();
          onUse(L.latLng(spot.lat, spot.lng));
        });
      });
    }
    markers.set(spot.id, marker);
    bounds.extend([spot.lat, spot.lng]);
  });

  if (here) {
    const marker = L.marker([here.lat, here.lng], { icon: hereIcon(), zIndexOffset: 400 }).addTo(map);
    marker.bindPopup(
      `<strong>${t("spots_you_are_here")}</strong>${onUse ? `<br><button type="button" class="btn btn-sm btn-primary spots-use-btn" data-use-spot>${t("spots_use_this")}</button>` : ""}`
    );
    if (onUse) {
      marker.on("popupopen", (e) => {
        e.popup.getElement()?.querySelector("[data-use-spot]")?.addEventListener("click", () => {
          map.closePopup();
          onUse(L.latLng(here.lat, here.lng));
        });
      });
    }
    markers.set("here", marker);
    bounds.extend([here.lat, here.lng]);
  }
  return { bounds, markers };
}

// "40.18,44.51" (the ?here= query value) -> {lat, lng} | null
export function parseHere(value) {
  const [lat, lng] = String(value ?? "").split(",").map(Number);
  return Number.isFinite(lat) && Number.isFinite(lng) && value ? { lat, lng } : null;
}
