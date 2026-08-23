import { api } from "../api.js";
import { escapeHtml } from "../util.js";
import { t } from "../i18n.js";
import { getTheme } from "../theme.js";

const TILE_URLS = {
  dark: "https://{s}.basemaps.cartocdn.com/rastertiles/dark_matter/{z}/{x}/{y}{r}.png",
  light: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
};
const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>';

export function renderMap(root, navigate) {
  root.innerHTML = `
    <div class="map-view">
      <div id="leaflet-map"></div>

      <div class="map-filter-row">
        <button class="map-filter-chip chip-active" data-filter="">${t("filter_all")}</button>
        <button class="map-filter-chip" data-filter="overdue">${t("filter_overdue")}</button>
        <button class="map-filter-chip" data-filter="visited">${t("filter_visited")}</button>
      </div>

      <div class="map-controls">
        <div class="map-control-cluster">
          <button class="map-control-btn" id="zoom-in-btn" aria-label="Zoom in">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
          </button>
          <div class="map-control-divider"></div>
          <button class="map-control-btn" id="zoom-out-btn" aria-label="Zoom out">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M5 12h14"/></svg>
          </button>
        </div>
        <button class="map-control-btn map-control-standalone" id="compass-btn" hidden aria-label="Reset north">
          <svg viewBox="0 0 24 24" width="20" height="20"><path d="M12 2l4 10-4 4-4-4z" fill="var(--accent)"/><path d="M12 22l-4-10 4-4 4 4z" fill="var(--text-dim)"/></svg>
        </button>
        <button class="map-control-btn map-control-standalone" id="locate-btn" aria-label="${t("locate_me")}">
          <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3" stroke-linecap="round"/></svg>
        </button>
      </div>

      <button class="fab" id="add-customer-fab" title="${t("new_customer")}">+</button>
      <div class="map-hint" id="map-hint" hidden>${t("tap_map_hint")}</div>
    </div>
  `;

  const mapEl = root.querySelector("#leaflet-map");
  const hint = root.querySelector("#map-hint");
  const fab = root.querySelector("#add-customer-fab");
  const compassBtn = root.querySelector("#compass-btn");
  const locateBtn = root.querySelector("#locate-btn");

  // Leaflet's internal pan/zoom gesture handling can fight with an ancestor
  // scroll container on iOS, producing the "freezes while panning" bug.
  // Suspend the app shell's own scrolling while the map view is mounted.
  const appMain = document.getElementById("app");
  appMain.classList.add("app-main-locked");
  mapEl.style.touchAction = "none";

  const map = L.map(mapEl, {
    zoomControl: false,
    rotate: true,
    touchRotate: true,
    rotateControl: false,
    bearing: 0,
  }).setView([20, 0], 2);

  let tileLayer = L.tileLayer(TILE_URLS[getTheme()], {
    maxZoom: 19,
    attribution: TILE_ATTRIBUTION,
    subdomains: "abcd",
  }).addTo(map);

  // Re-apply the matching tile style if the user flips light/dark while the
  // map is mounted (Settings lives on a different tab, so this covers the
  // case of returning to the map after toggling).
  function refreshTileStyle() {
    const url = TILE_URLS[getTheme()];
    if (tileLayer._url !== url) {
      map.removeLayer(tileLayer);
      tileLayer = L.tileLayer(url, {
        maxZoom: 19,
        attribution: TILE_ATTRIBUTION,
        subdomains: "abcd",
      }).addTo(map);
    }
  }
  document.addEventListener("visibilitychange", refreshTileStyle);

  // Wait for Leaflet's own internal setup (panes, position tracking) to
  // finish before touching layout — calling invalidateSize/fitBounds too
  // early throws inside the rotate plugin's pane-position bookkeeping.
  map.whenReady(() => {
    try {
      map.invalidateSize();
    } catch {
      // See the matching try/catch around fitBounds below.
    }
  });

  map.on("rotate", () => {
    const bearing = map.getBearing();
    compassBtn.hidden = Math.abs(bearing) < 1;
    const needle = compassBtn.querySelector("svg");
    if (needle) needle.style.transform = `rotate(${-bearing}deg)`;
  });

  root.querySelector("#zoom-in-btn").addEventListener("click", () => map.zoomIn());
  root.querySelector("#zoom-out-btn").addEventListener("click", () => map.zoomOut());
  compassBtn.addEventListener("click", () => map.setBearing(0));

  let addMode = false;
  let placingMarker = null;
  const markerLayer = L.layerGroup().addTo(map);

  function customerStatus(c) {
    if (c.visited_today) return "today";
    if (c.overdue) return "overdue";
    if (c.visited_this_week) return "week";
    return "pending";
  }

  const PIN_CLASS = { today: "pin-today", overdue: "pin-overdue", week: "pin-week", pending: "pin-pending" };

  function customerIcon(status) {
    const check = status === "today" ? '<span class="pin-check">&#10003;</span>' : "";
    return L.divIcon({
      className: "",
      html: `<div class="pin ${PIN_CLASS[status]}">${check}</div>`,
      iconSize: [22, 22],
      iconAnchor: [11, 22],
      popupAnchor: [0, -22],
    });
  }

  let activeFilter = "";
  let lastCustomers = [];

  function applyFilter() {
    markerLayer.clearLayers();
    const bounds = [];
    for (const { c, marker } of lastCustomers) {
      const status = customerStatus(c);
      if (activeFilter && !(activeFilter === "overdue" ? status === "overdue" : activeFilter === "visited" ? status === "today" || status === "week" : true)) {
        continue;
      }
      marker.addTo(markerLayer);
      bounds.push([c.lat, c.lng]);
    }
    if (bounds.length) {
      try {
        map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
      } catch {
        // See note below about the rotate-plugin pane-timing quirk.
      }
    }
  }

  root.querySelectorAll(".map-filter-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      root.querySelectorAll(".map-filter-chip").forEach((c) => c.classList.remove("chip-active"));
      chip.classList.add("chip-active");
      activeFilter = chip.dataset.filter;
      applyFilter();
    });
  });

  async function loadCustomers() {
    const customers = await api.listCustomers();
    markerLayer.clearLayers();
    lastCustomers = [];

    const bounds = [];
    for (const c of customers) {
      const status = customerStatus(c);
      const marker = L.marker([c.lat, c.lng], { icon: customerIcon(status) });
      marker.bindPopup(`
        <div class="map-popup">
          <strong>${escapeHtml(c.name)}</strong>
          ${c.category ? `<div class="popup-category">${escapeHtml(c.category)}</div>` : ""}
          <div class="popup-actions">
            <button data-action="details" data-id="${c.id}">${t("details")}</button>
            <button data-action="checkin" data-id="${c.id}" class="btn-accent">${t("check_in")}</button>
          </div>
        </div>
      `);
      marker.on("popupopen", (e) => {
        const popupEl = e.popup.getElement();
        popupEl.querySelector('[data-action="details"]').addEventListener("click", () => {
          navigate(`#/customers/${c.id}`);
        });
        popupEl.querySelector('[data-action="checkin"]').addEventListener("click", () => {
          navigate(`#/checkin/${c.id}`);
        });
      });
      lastCustomers.push({ c, marker });
      bounds.push([c.lat, c.lng]);
    }

    applyFilter();

    if (!bounds.length && navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => map.setView([pos.coords.latitude, pos.coords.longitude], 13),
        () => {}
      );
    }
  }

  // "My location" — blue dot + accuracy circle, kept live with watchPosition.
  let meMarker = null;
  let meAccuracyCircle = null;
  let watchId = null;

  function meIcon() {
    return L.divIcon({ className: "", html: `<div class="me-dot"></div>`, iconSize: [18, 18], iconAnchor: [9, 9] });
  }

  locateBtn.addEventListener("click", () => {
    if (!navigator.geolocation) return;
    locateBtn.classList.add("map-control-active");

    if (watchId == null) {
      watchId = navigator.geolocation.watchPosition(
        (pos) => {
          const { latitude, longitude, accuracy } = pos.coords;
          const latlng = [latitude, longitude];
          if (!meMarker) {
            meMarker = L.marker(latlng, { icon: meIcon(), zIndexOffset: 1000 }).addTo(map);
            meAccuracyCircle = L.circle(latlng, {
              radius: accuracy,
              color: "#0a84ff",
              weight: 1,
              fillColor: "#0a84ff",
              fillOpacity: 0.12,
            }).addTo(map);
            map.setView(latlng, Math.max(map.getZoom(), 15));
          } else {
            meMarker.setLatLng(latlng);
            meAccuracyCircle.setLatLng(latlng).setRadius(accuracy);
          }
        },
        () => {
          locateBtn.classList.remove("map-control-active");
        },
        { enableHighAccuracy: true }
      );
    } else if (meMarker) {
      map.setView(meMarker.getLatLng(), Math.max(map.getZoom(), 15));
    }
  });

  fab.addEventListener("click", () => {
    addMode = !addMode;
    fab.classList.toggle("fab-active", addMode);
    hint.hidden = !addMode;
    mapEl.classList.toggle("map-picking", addMode);
  });

  map.on("click", (e) => {
    if (!addMode) return;

    if (placingMarker) map.removeLayer(placingMarker);
    placingMarker = L.marker(e.latlng, {
      icon: L.divIcon({ className: "", html: `<div class="pin pin-new"></div>`, iconSize: [26, 26], iconAnchor: [13, 26] }),
    }).addTo(map);

    addMode = false;
    fab.classList.remove("fab-active");
    hint.hidden = true;
    mapEl.classList.remove("map-picking");

    // Keep the dropped pin visible above the bottom sheet that's about to
    // cover ~55% of the screen.
    const point = map.latLngToContainerPoint(e.latlng);
    // Leave clearance for the pin's own height above the sheet's top edge.
    const sheetTop = mapEl.clientHeight * 0.45 - 40;
    if (point.y > sheetTop) {
      map.panBy([0, point.y - sheetTop], { animate: true });
    }

    openNewCustomerForm(e.latlng);
  });

  function openNewCustomerForm(latlng) {
    const overlay = document.createElement("div");
    overlay.className = "sheet-overlay sheet-overlay-light";
    overlay.innerHTML = `
      <div class="sheet">
        <h2>${t("new_customer")}</h2>
        <form id="new-customer-form">
          <label>${t("name")}<input name="name" required /></label>
          <label>${t("category")}<input name="category" placeholder="${t("category_placeholder")}" /></label>
          <label>${t("phone")}<input name="phone" type="tel" /></label>
          <label>${t("address")}<input name="address" /></label>
          <label>${t("notes")}<textarea name="notes" rows="2"></textarea></label>
          <p class="form-error" id="new-customer-error" hidden></p>
          <div class="sheet-actions">
            <button type="button" class="btn" id="cancel-new-customer">${t("cancel")}</button>
            <button type="submit" class="btn btn-primary">${t("save_customer")}</button>
          </div>
        </form>
      </div>
    `;
    document.body.appendChild(overlay);

    function close() {
      overlay.remove();
      if (placingMarker) {
        map.removeLayer(placingMarker);
        placingMarker = null;
      }
    }

    overlay.querySelector("#cancel-new-customer").addEventListener("click", close);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
    });

    const form = overlay.querySelector("#new-customer-form");
    const errorEl = overlay.querySelector("#new-customer-error");

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const data = new FormData(form);
      const submitBtn = form.querySelector('button[type="submit"]');
      submitBtn.disabled = true;

      try {
        await api.createCustomer({
          name: data.get("name"),
          category: data.get("category") || null,
          phone: data.get("phone") || null,
          address: data.get("address") || null,
          notes: data.get("notes") || null,
          lat: latlng.lat,
          lng: latlng.lng,
        });
        overlay.remove();
        placingMarker = null;
        loadCustomers();
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.hidden = false;
        submitBtn.disabled = false;
      }
    });
  }

  map.whenReady(loadCustomers);

  return () => {
    if (watchId != null) navigator.geolocation.clearWatch(watchId);
    document.removeEventListener("visibilitychange", refreshTileStyle);
    appMain.classList.remove("app-main-locked");
    map.remove();
  };
}
