import { api } from "../api.js";
import { activateCombobox, activateDialog, escapeHtml, formatRelative, formatAmd, formatDistance, haversineMeters, getCurrentPosition, CATEGORY_OPTIONS } from "../util.js";
import { t } from "../i18n.js";
import { getTheme } from "../theme.js";
import { icons } from "../icons.js";
import { canViewTeamLocations, canEditDirectly } from "../state.js";

const NEARBY_RADIUS_METERS = 5000;

const TILE_URLS = {
  dark: "https://{s}.basemaps.cartocdn.com/rastertiles/dark_matter/{z}/{x}/{y}{r}.png",
  light: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
};
const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>';

export function renderMap(root, navigate, relocateCustomerId, startInAddMode = false) {
  root.innerHTML = `
    <div class="map-view">
      <div id="leaflet-map"></div>
      ${
        relocateCustomerId
          ? `<div class="relocate-banner" id="relocate-banner">
              <span>${t("relocate_hint")}</span>
              <button type="button" id="cancel-relocate">${t("cancel")}</button>
            </div>`
          : ""
      }

      ${
        relocateCustomerId
          ? ""
          : `<div class="map-filter-row">
              <button class="map-filter-chip chip-active" data-filter="" aria-pressed="true"><span class="map-filter-chip-icon">${icons.filter}</span>${t("filter_all")}</button>
              <button class="map-filter-chip" data-filter="overdue" aria-pressed="false"><span class="map-filter-chip-icon">${icons.warning}</span>${t("filter_overdue")}</button>
              <button class="map-filter-chip" data-filter="visited" aria-pressed="false"><span class="map-filter-chip-icon">${icons.checkCircle}</span>${t("filter_visited")}</button>
              <button class="map-filter-chip" data-filter="planned" aria-pressed="false"><span class="map-filter-chip-icon">${icons.send}</span>${t("filter_planned")}</button>
              <button class="map-filter-chip" data-filter="nearby" aria-pressed="false"><span class="map-filter-chip-icon">${icons.locate}</span>${t("filter_nearby")}</button>
            </div>`
      }

      <div class="nearby-panel" id="nearby-panel" hidden>
        <div class="nearby-panel-header">
          <span id="nearby-panel-title">${t("nearby_loading")}</span>
          <button type="button" class="icon-btn" id="nearby-panel-close" aria-label="${t("cancel")}">&times;</button>
        </div>
        <div class="nearby-list card-list" id="nearby-list"></div>
        <button type="button" class="nearby-view-all" id="nearby-view-all">${t("view_all_customers")}</button>
      </div>

      <div class="map-controls">
        <div class="map-control-cluster">
          <button class="map-control-btn" id="zoom-in-btn" aria-label="${t("zoom_in")}">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
          </button>
          <div class="map-control-divider"></div>
          <button class="map-control-btn" id="zoom-out-btn" aria-label="${t("zoom_out")}">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M5 12h14"/></svg>
          </button>
        </div>
        <button class="map-control-btn map-control-standalone" id="compass-btn" hidden aria-label="${t("reset_north")}">
          <svg viewBox="0 0 24 24" width="20" height="20"><path d="M12 2l4 10-4 4-4-4z" fill="var(--accent)"/><path d="M12 22l-4-10 4-4 4 4z" fill="var(--text-dim)"/></svg>
        </button>
        <button class="map-control-btn map-control-standalone" id="locate-btn" aria-label="${t("locate_me")}">
          <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3" stroke-linecap="round"/></svg>
        </button>
        ${
          canViewTeamLocations()
            ? `<button class="map-control-btn map-control-standalone" id="team-locations-btn" aria-label="${t("team_locations")}">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="7" r="3"/><path d="M2 20c0-3 2.7-5.5 6-5.5s6 2.5 6 5.5"/><circle cx="17" cy="8" r="2.3"/><path d="M14.8 14.8c2.4.3 4.2 2.3 4.2 4.8"/></svg>
        </button>`
            : ""
        }
        <button class="map-control-btn map-control-standalone" id="plan-day-btn" aria-label="${t("plan_day")}">${icons.planDay}</button>
      </div>

      <button class="fab" id="add-customer-fab" title="${t("new_customer")}" aria-label="${t("new_customer")}" aria-pressed="false">+</button>
      <div class="map-hint" id="map-hint" role="status" ${startInAddMode ? "" : "hidden"}>${t("tap_map_hint")}</div>
      <div class="map-hint" id="team-empty-hint" hidden>${t("team_locations_empty")}</div>
      <div class="map-hint" id="planned-empty-hint" hidden>${t("planned_empty")}</div>
    </div>
  `;

  const mapEl = root.querySelector("#leaflet-map");
  const hint = root.querySelector("#map-hint");
  const teamEmptyHint = root.querySelector("#team-empty-hint");
  const fab = root.querySelector("#add-customer-fab");
  const compassBtn = root.querySelector("#compass-btn");
  const locateBtn = root.querySelector("#locate-btn");

  // Leaflet's internal pan/zoom gesture handling can fight with an ancestor
  // scroll container on iOS, producing the "freezes while panning" bug.
  // Suspend the app shell's own scrolling while the map view is mounted.
  const appMain = document.getElementById("app");
  appMain.classList.add("app-main-locked");
  document.body.classList.add("map-active");
  mapEl.style.touchAction = "none";

  const map = L.map(mapEl, {
    zoomControl: false,
    rotate: true,
    touchRotate: true,
    rotateControl: false,
    bearing: 0,
    // Attribution to OpenStreetMap/CARTO is a required condition of using
    // their free tiles (ODbL/CARTO terms) -- it can't be removed outright,
    // but the default control (with Leaflet's own "Leaflet |" branding
    // prefix) is oversized for this app. Re-added below as a minimal,
    // unobtrusive control instead.
    attributionControl: false,
  }).setView([20, 0], 2);
  L.control.attribution({ prefix: false, position: "bottomright" }).addTo(map);

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

  let addMode = startInAddMode && !relocateCustomerId;
  if (addMode) {
    fab.classList.add("fab-active");
    fab.setAttribute("aria-pressed", "true");
    mapEl.classList.add("map-picking");
  }
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
  let myLocation = null;
  let plannedCustomerIds = null;

  const plannedEmptyHint = root.querySelector("#planned-empty-hint");

  function applyFilter() {
    markerLayer.clearLayers();
    const bounds = [];
    for (const { c, marker } of lastCustomers) {
      const status = customerStatus(c);
      if (activeFilter === "nearby") {
        const distance = myLocation ? haversineMeters(myLocation.lat, myLocation.lng, c.lat, c.lng) : Infinity;
        if (distance > NEARBY_RADIUS_METERS) continue;
      } else if (activeFilter === "planned") {
        if (!plannedCustomerIds || !plannedCustomerIds.includes(c.id)) continue;
      } else if (
        activeFilter &&
        !(activeFilter === "overdue" ? status === "overdue" : activeFilter === "visited" ? status === "today" || status === "week" : true)
      ) {
        continue;
      }
      marker.addTo(markerLayer);
      bounds.push([c.lat, c.lng]);
    }
    if (activeFilter === "planned") {
      plannedEmptyHint.hidden = bounds.length > 0 || plannedCustomerIds === null;
    } else {
      plannedEmptyHint.hidden = true;
    }
    if (bounds.length) {
      try {
        map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
      } catch {
        // See note below about the rotate-plugin pane-timing quirk.
      }
    }
  }

  const nearbyPanel = root.querySelector("#nearby-panel");
  const nearbyPanelTitle = root.querySelector("#nearby-panel-title");
  const nearbyList = root.querySelector("#nearby-list");

  async function openNearbyPanel() {
    nearbyPanel.hidden = false;
    nearbyPanelTitle.textContent = t("nearby_loading");
    nearbyList.innerHTML = "";

    if (!myLocation) {
      try {
        const pos = await getCurrentPosition();
        myLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      } catch {
        nearbyPanelTitle.textContent = t("nearby_location_error");
        applyFilter();
        return;
      }
    }

    applyFilter();
    renderNearbyList();
  }

  function renderNearbyList() {
    if (!myLocation) return;
    const nearby = lastCustomers
      .map(({ c }) => ({ c, distance: haversineMeters(myLocation.lat, myLocation.lng, c.lat, c.lng) }))
      .filter((entry) => entry.distance <= NEARBY_RADIUS_METERS)
      .sort((a, b) => a.distance - b.distance);

    nearbyPanelTitle.textContent = `${t("nearby_customers")} · ${t("nearby_within")} · ${nearby.length}`;

    if (!nearby.length) {
      nearbyList.innerHTML = `<p class="muted">${t("nearby_empty")}</p>`;
      return;
    }

    nearbyList.innerHTML = nearby
      .map(({ c, distance }) => {
        const status = customerStatus(c);
        const badgeClass = status === "today" ? "badge-success" : status === "overdue" ? "badge-danger" : status === "week" ? "badge-info" : "badge-neutral";
        const badgeText = status === "today" ? t("visited_today") : status === "overdue" ? t("filter_overdue") : status === "week" ? t("visited_this_week") : t("not_visited");
        return `
        <button class="card customer-card" data-id="${c.id}">
          <div class="customer-card-main">
            <strong>${escapeHtml(c.name)}</strong>
            ${c.category ? `<span class="muted">${escapeHtml(c.category)}</span>` : ""}
            <span class="muted">${formatDistance(distance)}</span>
          </div>
          <span class="card-trailing">
            <span class="badge ${badgeClass}">${badgeText}</span>
            <span class="chevron">&#8250;</span>
          </span>
        </button>`;
      })
      .join("");

    nearbyList.querySelectorAll(".customer-card").forEach((el) => {
      el.addEventListener("click", () => navigate(`#/customers/${el.dataset.id}`));
    });
  }

  root.querySelector("#nearby-panel-close").addEventListener("click", () => {
    nearbyPanel.hidden = true;
    root.querySelectorAll(".map-filter-chip").forEach((c) => {
      c.classList.remove("chip-active");
      c.setAttribute("aria-pressed", "false");
    });
    const allChip = root.querySelector('.map-filter-chip[data-filter=""]');
    allChip.classList.add("chip-active");
    allChip.setAttribute("aria-pressed", "true");
    activeFilter = "";
    applyFilter();
  });
  root.querySelector("#nearby-view-all").addEventListener("click", () => navigate("#/customers"));

  async function loadPlannedFilter() {
    let plan;
    try {
      plan = await api.getMyVisitPlan();
    } catch {
      plan = null;
    }
    plannedCustomerIds = plan?.status === "approved" ? plan.customer_ids : [];
    applyFilter();
  }

  root.querySelectorAll(".map-filter-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      root.querySelectorAll(".map-filter-chip").forEach((c) => {
        c.classList.remove("chip-active");
        c.setAttribute("aria-pressed", "false");
      });
      chip.classList.add("chip-active");
      chip.setAttribute("aria-pressed", "true");
      activeFilter = chip.dataset.filter;
      if (activeFilter === "nearby") {
        openNearbyPanel();
      } else if (activeFilter === "planned") {
        nearbyPanel.hidden = true;
        loadPlannedFilter();
      } else {
        nearbyPanel.hidden = true;
        applyFilter();
      }
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

  // Team locations (admin/sales_director only) — foreground-only pings
  // from teammates, polled while this toggle is on and this view is
  // mounted; cleared on toggle-off and on view teardown.
  const teamBtn = root.querySelector("#team-locations-btn");
  const teamLayer = L.layerGroup();
  let teamPollId = null;

  function teamMemberIcon() {
    return L.divIcon({
      className: "",
      html: `<div class="team-dot"></div>`,
      iconSize: [16, 16],
      iconAnchor: [8, 8],
    });
  }

  async function refreshTeamLocations() {
    let locations;
    try {
      locations = await api.getTeamLocations();
    } catch {
      return;
    }
    teamLayer.clearLayers();
    for (const loc of locations) {
      L.marker([loc.lat, loc.lng], { icon: teamMemberIcon() })
        .bindPopup(
          `<div class="map-popup"><strong>${escapeHtml(loc.name)}</strong><div class="popup-category">${escapeHtml(t(`role_${loc.role}`))} · ${formatRelative(loc.updated_at)}</div></div>`
        )
        .addTo(teamLayer);
    }
    teamEmptyHint.hidden = !teamBtn.classList.contains("map-control-active") || locations.length > 0;
  }

  teamBtn?.addEventListener("click", () => {
    const active = teamBtn.classList.toggle("map-control-active");
    if (active) {
      teamLayer.addTo(map);
      refreshTeamLocations();
      teamPollId = setInterval(refreshTeamLocations, 15000);
    } else {
      map.removeLayer(teamLayer);
      clearInterval(teamPollId);
      teamPollId = null;
      teamEmptyHint.hidden = true;
    }
  });

  const PLAN_STATUS_KEY = {
    pending: "plan_status_pending",
    approved: "plan_status_approved",
    rejected: "plan_status_rejected",
  };

  async function openPlanDaySheet() {
    const overlay = document.createElement("div");
    overlay.className = "sheet-overlay sheet-overlay-light";
    overlay.innerHTML = `
      <div class="sheet">
        <h2>${t("plan_day")}</h2>
        <p class="muted">${t("plan_day_hint")}</p>
        <p class="badge badge-neutral" id="plan-status-badge"></p>
        <div class="plan-day-list" id="plan-day-list"><p class="loading-state" role="status">${t("loading")}</p></div>
        <p class="form-error" id="plan-day-error" hidden></p>
        <div class="sheet-actions">
          <button type="button" class="btn" id="cancel-plan-day">${t("cancel")}</button>
          <button type="button" class="btn btn-primary" id="save-plan-day">${t("save_plan")}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    activateDialog(overlay);

    function close() {
      overlay.remove();
    }
    overlay.querySelector("#cancel-plan-day").addEventListener("click", close);
    overlay.addEventListener("click", (e) => e.target === overlay && close());

    const listEl = overlay.querySelector("#plan-day-list");
    const badgeEl = overlay.querySelector("#plan-status-badge");
    const errorEl = overlay.querySelector("#plan-day-error");

    let existingPlan;
    try {
      existingPlan = await api.getMyVisitPlan();
    } catch {
      existingPlan = null;
    }
    const selectedIds = new Set(existingPlan?.customer_ids ?? []);

    const statusClass =
      existingPlan?.status === "approved" ? "badge-success" : existingPlan?.status === "rejected" ? "badge-danger" : "badge-neutral";
    badgeEl.className = `badge ${statusClass}`;
    badgeEl.textContent = t(existingPlan ? PLAN_STATUS_KEY[existingPlan.status] : "plan_status_none");

    const sortedCustomers = [...lastCustomers].sort((a, b) => a.c.name.localeCompare(b.c.name));
    listEl.innerHTML = sortedCustomers
      .map(
        ({ c }) => `
      <label class="plan-day-row">
        <input type="checkbox" value="${c.id}" ${selectedIds.has(c.id) ? "checked" : ""} />
        <span>${escapeHtml(c.name)}</span>
      </label>`
      )
      .join("");

    overlay.querySelector("#save-plan-day").addEventListener("click", async (e) => {
      const btn = e.target;
      btn.disabled = true;
      const ids = [...listEl.querySelectorAll("input:checked")].map((el) => Number(el.value));
      try {
        await api.saveVisitPlan(undefined, ids);
        close();
        if (activeFilter === "planned") loadPlannedFilter();
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.hidden = false;
        btn.disabled = false;
      }
    });
  }

  root.querySelector("#plan-day-btn").addEventListener("click", openPlanDaySheet);

  if (relocateCustomerId) {
    fab.hidden = true;
    mapEl.classList.add("map-picking");
    root.querySelector("#cancel-relocate")?.addEventListener("click", () => {
      navigate(`#/customers/${relocateCustomerId}`);
    });
  } else {
    fab.addEventListener("click", () => {
      addMode = !addMode;
      fab.classList.toggle("fab-active", addMode);
      fab.setAttribute("aria-pressed", String(addMode));
      hint.hidden = !addMode;
      mapEl.classList.toggle("map-picking", addMode);
    });
  }

  map.on("click", (e) => {
    if (relocateCustomerId) {
      if (placingMarker) map.removeLayer(placingMarker);
      placingMarker = L.marker(e.latlng, {
        icon: L.divIcon({ className: "", html: `<div class="pin pin-new"></div>`, iconSize: [26, 26], iconAnchor: [13, 26] }),
      }).addTo(map);
      openRelocateConfirm(e.latlng);
      return;
    }

    if (!addMode) return;

    if (placingMarker) map.removeLayer(placingMarker);
    placingMarker = L.marker(e.latlng, {
      icon: L.divIcon({ className: "", html: `<div class="pin pin-new"></div>`, iconSize: [26, 26], iconAnchor: [13, 26] }),
    }).addTo(map);

    addMode = false;
    fab.classList.remove("fab-active");
    fab.setAttribute("aria-pressed", "false");
    hint.hidden = true;
    mapEl.classList.remove("map-picking");

    openNewCustomerForm(e.latlng);
  });

  function openRelocateConfirm(latlng) {
    const overlay = document.createElement("div");
    overlay.className = "sheet-overlay sheet-overlay-light";
    overlay.innerHTML = `
      <div class="sheet">
        <h2>${t("confirm_new_location")}</h2>
        <p class="muted">${canEditDirectly() ? t("confirm_new_location_hint") : t("confirm_new_location_hint_request")}</p>
        <p class="form-error" id="relocate-error" hidden></p>
        <div class="sheet-actions">
          <button type="button" class="btn" id="cancel-relocate-confirm">${t("cancel")}</button>
          <button type="button" class="btn btn-primary" id="save-relocate">${canEditDirectly() ? t("save") : t("submit_request")}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    activateDialog(overlay);

    function close() {
      overlay.remove();
      if (placingMarker) {
        map.removeLayer(placingMarker);
        placingMarker = null;
      }
    }
    overlay.querySelector("#cancel-relocate-confirm").addEventListener("click", close);
    overlay.addEventListener("click", (e) => e.target === overlay && close());

    overlay.querySelector("#save-relocate").addEventListener("click", async (e) => {
      const btn = e.target;
      btn.disabled = true;
      const errorEl = overlay.querySelector("#relocate-error");
      const changes = { lat: latlng.lat, lng: latlng.lng };
      try {
        if (canEditDirectly()) {
          await api.updateCustomer(relocateCustomerId, changes);
        } else {
          await api.createEditRequest(relocateCustomerId, changes);
        }
        navigate(`#/customers/${relocateCustomerId}`);
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.hidden = false;
        btn.disabled = false;
      }
    });
  }

  function openNewCustomerForm(latlng) {
    const overlay = document.createElement("div");
    overlay.className = "sheet-overlay sheet-overlay-light";
    overlay.innerHTML = `
      <div class="sheet">
        <h2>${t("new_customer")}</h2>
        <form id="new-customer-form">
          <label>${t("name")}<input name="name" required /></label>
          <label>${t("category")}
            <select name="category">
              <option value="">${t("category_placeholder")}</option>
              ${CATEGORY_OPTIONS.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("")}
            </select>
          </label>
          <label>${t("phone")}<input name="phone" type="tel" /></label>
          <label>${t("address")}<input name="address" id="new-customer-address" /></label>
          <label class="erp-suggest-wrap">${t("erp_customer_id")}
            <input type="text" name="erp_customer_id" id="new-customer-erp-input" autocomplete="off" />
            <div class="erp-suggest-list" id="new-customer-erp-suggest" hidden></div>
          </label>
          <label>${t("notes")}<textarea name="notes" rows="2"></textarea></label>
          <label>${t("tin")}<input name="tin" /></label>
          <p class="form-error" id="new-customer-error" hidden></p>
          <div class="sheet-actions">
            <button type="button" class="btn" id="cancel-new-customer">${t("cancel")}</button>
            <button type="submit" class="btn btn-primary">${t("save_customer")}</button>
          </div>
        </form>
      </div>
    `;
    document.body.appendChild(overlay);
    activateDialog(overlay);

    // Keep the dropped pin visible above the sheet -- measured against the
    // sheet's actual rendered height (it varies with content/keyboard),
    // not a guessed fraction of the screen, so the pin reliably stays clear
    // of the sheet's top edge instead of being hidden behind it.
    const sheetEl = overlay.querySelector(".sheet");
    const point = map.latLngToContainerPoint(latlng);
    const sheetTop = mapEl.clientHeight - sheetEl.getBoundingClientRect().height - 40;
    if (point.y > sheetTop) {
      map.panBy([0, point.y - sheetTop], { animate: true });
    }

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

    // Auto-fill the address from the dropped pin's coordinates -- the rep
    // can still edit it by hand, this just saves typing it from scratch.
    const addressInput = overlay.querySelector("#new-customer-address");
    api
      .reverseGeocode(latlng.lat, latlng.lng)
      .then((result) => {
        if (result?.address && !addressInput.value) addressInput.value = result.address;
      })
      .catch(() => {});

    const erpInput = overlay.querySelector("#new-customer-erp-input");
    const erpSuggestList = overlay.querySelector("#new-customer-erp-suggest");
    let erpOptions = [];
    api
      .getUnlinkedErpCustomers()
      .then((results) => {
        erpOptions = [...results].sort((a, b) =>
          (a.customer_name || "").localeCompare(b.customer_name || "", undefined, { sensitivity: "base" })
        );
      })
      .catch(() => {});

    function renderErpSuggestions(query) {
      const q = query.trim().toLowerCase();
      const matches = q
        ? erpOptions.filter(
            (r) => (r.customer_name || "").toLowerCase().includes(q) || r.erp_customer_id.includes(q)
          )
        : erpOptions;
      if (!matches.length) {
        erpSuggestList.hidden = true;
        erpSuggestList.innerHTML = "";
        return;
      }
      erpSuggestList.innerHTML = matches
        .slice(0, 30)
        .map(
          (r) => `
        <div class="erp-suggest-item" data-id="${escapeHtml(r.erp_customer_id)}">
          <span>${escapeHtml(r.customer_name || r.erp_customer_id)}</span>
          ${r.debt_amd > 0 ? `<span class="muted">${formatAmd(r.debt_amd)}</span>` : ""}
        </div>`
        )
        .join("");
      erpSuggestList.hidden = false;
    }

    erpInput.addEventListener("focus", () => renderErpSuggestions(erpInput.value));
    erpInput.addEventListener("input", () => renderErpSuggestions(erpInput.value));
    erpInput.addEventListener("blur", () => {
      setTimeout(() => (erpSuggestList.hidden = true), 150);
    });
    activateCombobox(erpInput, erpSuggestList, (item) => {
      erpInput.value = item.dataset.id;
    });

    const form = overlay.querySelector("#new-customer-form");
    const errorEl = overlay.querySelector("#new-customer-error");

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const data = new FormData(form);
      const submitBtn = form.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      submitBtn.textContent = t("saving");
      form.setAttribute("aria-busy", "true");

      try {
        await api.createCustomer({
          name: data.get("name"),
          category: data.get("category") || null,
          phone: data.get("phone") || null,
          address: data.get("address") || null,
          notes: data.get("notes") || null,
          tin: data.get("tin") || null,
          erp_customer_id: data.get("erp_customer_id") || null,
          lat: latlng.lat,
          lng: latlng.lng,
        });
        overlay.remove();
        if (placingMarker) {
          map.removeLayer(placingMarker);
          placingMarker = null;
        }
        loadCustomers();
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.hidden = false;
        submitBtn.disabled = false;
        submitBtn.textContent = t("save_customer");
        form.removeAttribute("aria-busy");
      }
    });
  }

  map.whenReady(loadCustomers);

  return () => {
    if (watchId != null) navigator.geolocation.clearWatch(watchId);
    if (teamPollId) clearInterval(teamPollId);
    document.removeEventListener("visibilitychange", refreshTileStyle);
    appMain.classList.remove("app-main-locked");
    document.body.classList.remove("map-active");
    map.remove();
  };
}
