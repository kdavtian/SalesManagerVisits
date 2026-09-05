import { api } from "../api.js";
import { activateCombobox, activateDialog, escapeHtml, formatRelative, formatAmd, formatDateTime, formatDistance, normalizePhone, haversineMeters, getCurrentPosition, tierSelectorHtml, activateTierSelector, categorySelectorHtml, activateCategorySelector, categoryIcon, categoryLabel, CATEGORY_LIST, REGION_LIST, YEREVAN_DISTRICTS, SALES_CHANNELS, matchRegion, matchSubregion } from "../util.js";
import { t } from "../i18n.js";
import { getTheme } from "../theme.js";
import { icons } from "../icons.js";
import { canViewTeamLocations, canEditDirectly, canPlanForOthers, state } from "../state.js";

const NEARBY_RADIUS_METERS = 5000;

// Fixed display order for the Map tab's channel filter (per explicit
// request), independent of SALES_CHANNELS' own order used elsewhere --
// Potential right after "All channels" (customers with no ERP link yet
// are the ones a rep is most likely to be filtering for), then field
// reps' own channels, then the non-field channels. Anything not listed
// here (shouldn't happen, but a new channel could exist before this list
// is updated) sorts alphabetically after these.
const MAP_CHANNEL_ORDER = ["POTENTIAL", "SM YVN", "SM Davtashen", "SM Shirak", "SM B2B", "PCO", "CVO", "OEM", "KF", "CAS"];
function sortMapChannels(channels) {
  return [...channels].sort((a, b) => {
    const ia = MAP_CHANNEL_ORDER.indexOf(a);
    const ib = MAP_CHANNEL_ORDER.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.localeCompare(b);
  });
}

// customerPortfolioUi.js writes POTENTIAL/COMPETITORS in all caps into
// sales_channel so they sort and filter like any other channel value --
// but as filter-sheet labels they should read as normal words, not
// shouting, same as every other channel label.
function channelDisplayLabel(channel) {
  if (channel === "POTENTIAL") return t("tier_potential");
  if (channel === "COMPETITORS") return t("brand_group_competitors");
  return channel;
}

// Mirrors the brand_status shape recorded at check-in (see BRAND_GROUPS in
// checkin.js) -- castrol/lotos/royal get their own status tags, each
// competitor is a flat presence flag inside brand_status.competitors.
const BRAND_FILTER_OPTIONS = [
  { value: "castrol", labelKey: "brand_group_castrol" },
  { value: "lotos", labelKey: "brand_group_lotos" },
  { value: "royal", labelKey: "brand_group_royal" },
  ...["mobil", "motul", "shell", "liquimoly", "bardahl", "aral", "oscar", "zic", "russian_oil"].map((v) => ({
    value: `competitor:${v}`,
    labelKey: `competitor_${v}`,
  })),
];

const TILE_URLS = {
  dark: "https://{s}.basemaps.cartocdn.com/rastertiles/dark_matter/{z}/{x}/{y}{r}.png",
  light: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
};
// Some networks (certain mobile carriers in particular) block or can't
// resolve the CARTO CDN outright, not just intermittently -- reported live
// from a real device, not a hypothetical. Two independent OSM-tile mirrors
// on different infrastructure (OSMF's own servers, then Wikimedia's) back
// it up -- diversifying against one CDN having a bad day, not just one
// provider. Neither has dark styling of its own, so both are used for
// either theme -- a working light map beats no map.
const FALLBACK_TILE_URLS = [
  { url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", subdomains: "abc" },
  { url: "https://maps.wikimedia.org/osm-intl/{z}/{x}/{y}.png", subdomains: "" },
];
const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>';

export function renderMap(root, navigate, relocateCustomerId, startInAddMode = false, startInPlanMode = false) {
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
          : `<div class="map-top-controls">
              <div class="map-search-row">
                <input type="search" id="map-customer-search" placeholder="${t("map_search_placeholder")}" aria-label="${t("map_search_placeholder")}" />
                ${
                  canViewTeamLocations()
                    ? `<div class="filter-dropdown-wrap" id="map-manager-filter-wrap">
                         <button type="button" class="filter-dropdown-btn" id="map-manager-filter-btn" aria-haspopup="menu" aria-expanded="false">
                           <span id="map-manager-filter-label">${t("all_managers")}</span>
                           <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
                         </button>
                         <div class="filter-dropdown-menu" id="map-manager-filter-menu" role="menu" hidden></div>
                       </div>`
                    : ""
                }
              </div>
              <p class="map-search-no-results" id="map-search-no-results" hidden>${t("map_search_no_results")}</p>
              <div class="customer-filter-row" id="map-icon-filter-row"></div>
              <div class="map-filter-row">
                <button class="map-filter-chip chip-active" data-filter="" aria-pressed="true"><span class="map-filter-chip-icon">${icons.filter}</span>${t("filter_all")}</button>
                <button class="map-filter-chip" data-filter="overdue" aria-pressed="false"><span class="map-filter-chip-icon">${icons.mapWarning}</span>${t("filter_overdue")}</button>
                <button class="map-filter-chip" data-filter="visited" aria-pressed="false"><span class="map-filter-chip-icon">${icons.checkCircle}</span>${t("filter_visited")}</button>
                <button class="map-filter-chip" data-filter="planned" aria-pressed="false"><span class="map-filter-chip-icon">${icons.send}</span>${t("filter_planned")}</button>
                <button class="map-filter-chip" data-filter="nearby" aria-pressed="false"><span class="map-filter-chip-icon">${icons.locate}</span>${t("filter_nearby")}</button>
                <button class="map-filter-chip" data-filter="brands" aria-pressed="false"><span class="map-filter-chip-icon">${icons.tag}</span>${t("filter_brands")}</button>
              </div>
              <div class="map-filter-row" id="brand-picker-row" hidden></div>
              <div class="map-brand-legend" id="brand-legend" hidden>
                <span><span class="brand-legend-dot brand-legend-available"></span>${t("brand_legend_available")}</span>
                <span><span class="brand-legend-dot brand-legend-unavailable"></span>${t("brand_legend_unavailable")}</span>
                <span><span class="brand-legend-dot brand-legend-unknown"></span>${t("brand_legend_unknown")}</span>
              </div>
            </div>`
      }

      <div class="nearby-panel" id="nearby-panel" hidden>
        <div class="nearby-panel-header">
          <span id="nearby-panel-title">${t("nearby_loading")}</span>
          <button type="button" class="icon-btn" id="nearby-panel-close" aria-label="${t("cancel")}">${icons.close}</button>
        </div>
        <div class="nearby-list card-list" id="nearby-list"></div>
        <button type="button" class="nearby-view-all" id="nearby-view-all">${t("view_all_customers")}</button>
      </div>

      <!-- Bottom-docked (not a full-screen modal) so the map and its
           draggable pin stay interactive while this is showing -- a modal
           .sheet-overlay sits above everything and would swallow every tap
           and drag on the map underneath it. -->
      <div class="location-picker-panel" id="location-picker-panel" hidden></div>

      <div class="nearby-panel" id="planned-stops-panel" hidden>
        <div class="nearby-panel-header">
          <span>${t("route_stops")}</span>
          <span class="nearby-panel-header-actions">
            <button type="button" class="btn btn-sm" id="optimize-route-btn">${t("optimize_route")}</button>
            <button type="button" class="icon-btn" id="planned-stops-close" aria-label="${t("cancel")}">${icons.close}</button>
          </span>
        </div>
        <div class="stop-list" id="stop-list"></div>
      </div>

      <div class="map-controls">
        <div class="map-control-cluster">
          <button class="map-control-btn" id="zoom-in-btn" aria-label="${t("zoom_in")}">
            ${icons.plus}
          </button>
          <div class="map-control-divider"></div>
          <button class="map-control-btn" id="zoom-out-btn" aria-label="${t("zoom_out")}">
            ${icons.minus}
          </button>
        </div>
        <button class="map-control-btn map-control-standalone" id="locate-btn" aria-label="${t("locate_me")}">
          ${icons.locate}
        </button>
        <button class="map-control-btn map-control-standalone" id="compass-btn" aria-label="${t("reset_north")}" hidden>
          ${icons.compass}
        </button>
        ${
          canViewTeamLocations()
            ? `<button class="map-control-btn map-control-standalone" id="team-locations-btn" aria-label="${t("team_locations")}">${icons.team}</button>`
            : ""
        }
        <button class="map-control-btn map-control-standalone" id="plan-day-btn" aria-label="${t("plan_day")}">
          ${icons.planDay}
        </button>
        <button class="map-control-btn map-control-standalone map-control-legend-btn" id="map-legend-btn" aria-label="${t("map_legend")}" aria-expanded="false" aria-haspopup="dialog">
          ${icons.info}
        </button>
      </div>

      <div class="map-legend-panel" id="map-legend-panel" role="dialog" aria-label="${t("map_legend_title")}" hidden>
        <div class="map-legend-header">
          <span>${t("map_legend_title")}</span>
          <button type="button" class="icon-btn" id="map-legend-close" aria-label="${t("close")}">${icons.close}</button>
        </div>
        <ul class="map-legend-list">
          <li><span class="map-legend-swatch map-legend-swatch-pin"></span>${t("map_legend_tier")}</li>
          <li><span class="map-legend-swatch map-legend-swatch-badge map-legend-swatch-visited">&#10003;</span>${t("map_legend_visited")}</li>
          <li><span class="map-legend-swatch map-legend-swatch-badge map-legend-swatch-overdue">!</span>${t("map_legend_overdue")}</li>
          <li><span class="map-legend-swatch map-legend-swatch-selected"></span>${t("map_legend_selected")}</li>
          <li><span class="map-legend-swatch map-legend-swatch-cluster">9</span>${t("map_legend_cluster")}</li>
        </ul>
      </div>

      <button class="fab" id="add-customer-fab" title="${t("new_customer")}" aria-label="${t("new_customer")}" aria-pressed="false">${icons.mapPinPlus}</button>
      ${
        relocateCustomerId
          ? ""
          : `<div class="nearest-customer-bar" id="nearest-customer-bar" hidden>
              <button type="button" class="nearest-checkin-btn" id="nearest-checkin-btn" aria-label="${t("check_in")}">${icons.mapPinCheck}</button>
              <div class="nearest-customer-info" id="nearest-customer-info"></div>
            </div>`
      }
      <div class="map-hint" id="map-hint" role="status" ${startInAddMode ? "" : "hidden"}>${t("tap_map_hint")}</div>
      <div class="map-error-overlay" id="map-error-overlay" role="alert" hidden>
        <div class="map-error-card">
          <p>${t("map_load_failed")}</p>
          <button type="button" class="btn btn-primary" id="map-error-retry">${t("try_again")}</button>
        </div>
      </div>
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
  const nearestBar = root.querySelector("#nearest-customer-bar");
  const nearestCheckinBtn = root.querySelector("#nearest-checkin-btn");
  const nearestInfo = root.querySelector("#nearest-customer-info");
  let nearestCustomer = null;

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

  // Root cause of "the map doesn't show anything": the tile provider
  // (CARTO, a third-party CDN) can be unreachable -- blocked by a
  // network/firewall, an ad/tracker blocker, or just down -- and until now
  // nothing detected that. Leaflet just sits there with an empty gray
  // .map-view forever, which reads exactly as "the map isn't showing" with
  // no way for the user to tell what's wrong or do anything about it. Track
  // whether any tile has actually loaded, and surface a real error with a
  // retry instead of failing silently.
  const mapErrorOverlay = root.querySelector("#map-error-overlay");
  let tileEverLoaded = false;
  let tileHealthTimer = null;
  // 0 = primary (CARTO); 1..FALLBACK_TILE_URLS.length = that fallback's index+1.
  let providerIndex = 0;

  function hideMapError() {
    mapErrorOverlay.hidden = true;
  }

  function showMapError() {
    mapErrorOverlay.hidden = false;
  }

  function currentProvider() {
    if (providerIndex === 0) return { url: primaryTileUrl(), subdomains: "abcd" };
    return FALLBACK_TILE_URLS[providerIndex - 1];
  }

  function makeTileLayer({ url, subdomains }) {
    const layer = L.tileLayer(url, { maxZoom: 19, attribution: TILE_ATTRIBUTION, subdomains });
    layer.on("tileload", () => {
      tileEverLoaded = true;
      clearTimeout(tileHealthTimer);
      hideMapError();
    });
    return layer;
  }

  function primaryTileUrl() {
    return TILE_URLS[getTheme()];
  }

  // Real-world mobile latency to a foreign tile CDN (DNS + TLS + first byte,
  // over 4G/5G, possibly roaming) can genuinely run past what looks like a
  // generous timeout on a fast connection -- reported live from a device in
  // Yerevan where even OSM's own tile server didn't clear a 9s window. 15s
  // gives a slow-but-working connection real room, while still failing fast
  // enough that a truly unreachable provider doesn't leave the map looking
  // frozen for too long. Each provider gets its own attempt in sequence
  // (CARTO -> OSM -> Wikimedia) before showing a real error -- three
  // independent hosts/CDNs failing in a row is a strong signal the device
  // has no route to any map tiles at all, not a problem with one of them.
  function startTileHealthCheck() {
    tileEverLoaded = false;
    clearTimeout(tileHealthTimer);
    tileHealthTimer = setTimeout(() => {
      if (tileEverLoaded) return;
      if (providerIndex <= FALLBACK_TILE_URLS.length - 1) {
        providerIndex += 1;
        map.removeLayer(tileLayer);
        tileLayer = makeTileLayer(currentProvider()).addTo(map);
        startTileHealthCheck();
      } else {
        showMapError();
      }
    }, 15000);
  }

  let tileLayer = makeTileLayer(currentProvider()).addTo(map);
  startTileHealthCheck();

  root.querySelector("#map-error-retry").addEventListener("click", () => {
    hideMapError();
    providerIndex = 0;
    map.removeLayer(tileLayer);
    tileLayer = makeTileLayer(currentProvider()).addTo(map);
    startTileHealthCheck();
  });

  // Re-apply the matching tile style if the user flips light/dark while the
  // map is mounted (Settings lives on a different tab, so this covers the
  // case of returning to the map after toggling). Only matters while still
  // on the primary provider -- the fallbacks have no theme variants.
  function refreshTileStyle() {
    if (providerIndex !== 0) return;
    const url = primaryTileUrl();
    if (tileLayer._url !== url) {
      map.removeLayer(tileLayer);
      tileLayer = makeTileLayer(currentProvider()).addTo(map);
      startTileHealthCheck();
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
  compassBtn.addEventListener("click", () => {
    map.setBearing(0);
  });

  // Leaflet's built-in doubleClickZoom listens for a native "dblclick" DOM
  // event, but mapEl's touch-action:none (needed to stop the app-shell
  // scroll fight above) also stops iOS/Android from synthesizing dblclick
  // from a double-tap -- so double-tap-to-zoom silently stopped working.
  // Detect it ourselves from raw touchend timing/distance instead.
  let lastTapTime = 0;
  let lastTapPoint = null;
  function onMapTouchEnd(e) {
    if (e.touches.length > 0 || e.changedTouches.length !== 1) {
      lastTapTime = 0;
      lastTapPoint = null;
      return;
    }
    if (e.target.closest(".leaflet-control, .leaflet-popup")) return;
    const point = map.mouseEventToContainerPoint(e.changedTouches[0]);
    const now = Date.now();
    if (lastTapPoint && now - lastTapTime < 350 && point.distanceTo(lastTapPoint) < 30) {
      e.preventDefault();
      map.setZoomAround(map.containerPointToLatLng(point), map.getZoom() + 1);
      lastTapTime = 0;
      lastTapPoint = null;
    } else {
      lastTapTime = now;
      lastTapPoint = point;
    }
  }
  mapEl.addEventListener("touchend", onMapTouchEnd);

  let addMode = startInAddMode && !relocateCustomerId;
  if (addMode) {
    fab.classList.add("fab-active");
    fab.setAttribute("aria-pressed", "true");
    mapEl.classList.add("map-picking");
  }
  let placingMarker = null;
  const markerLayer = L.layerGroup().addTo(map);
  // Customer pins specifically (not plan-day stop numbers, not team member
  // dots) get clustered -- a real customer base packed into a district
  // renders as dozens of overlapping 22px pins otherwise, which is
  // unreadable and near-impossible to tap accurately. Clustering collapses
  // that into a count badge that splits apart as you zoom in; pins already
  // spread out (a rural territory, or once you're zoomed to street level)
  // render exactly as before since there's nothing to cluster.
  const customerClusterGroup = L.markerClusterGroup({
    maxClusterRadius: 60,
    disableClusteringAtZoom: 17,
    spiderfyOnMaxZoom: true,
    showCoverageOnHover: false,
    iconCreateFunction(cluster) {
      const count = cluster.getChildCount();
      const size = count < 10 ? 32 : count < 50 ? 38 : 44;
      return L.divIcon({
        html: `<div class="pin-cluster" style="width:${size}px;height:${size}px;line-height:${size}px;">${count}</div>`,
        className: "",
        iconSize: [size, size],
      });
    },
  }).addTo(map);

  // A plain solid teardrop with nothing inside read as "blank"/broken once
  // dropped -- an X glyph makes it obvious this pin is just a pending
  // placement, and it's also the tap target that cancels it (see the click
  // handler wired onto placingMarker below, in addition to the sheet's own
  // Cancel button).
  const NEW_PIN_HTML = `<div class="pin pin-new"><span class="pin-glyph"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></span></div>`;

  function customerStatus(c) {
    if (c.visited_today) return "today";
    if (c.overdue) return "overdue";
    if (c.visited_this_week) return "week";
    return "pending";
  }

  const TIERS_ON_PINS = new Set(["bronze", "silver", "gold", "competitor"]);

  // Pin shape+color now encode the customer's *tier*, and the small glyph
  // inside encodes their *category* -- so glancing at the map answers "where
  // are my gold oil-change customers" or "where are potential workshops" in
  // one look, instead of needing to open each pin. Visit status (today's
  // check, overdue) is still shown, just as a smaller badge/ring rather than
  // owning the pin's whole color the way it used to.
  function customerIcon(c, status) {
    const tier = TIERS_ON_PINS.has(c.customer_tier) ? c.customer_tier : "potential";
    const isCoin = tier === "bronze" || tier === "silver" || tier === "gold";
    const check = status === "today" ? '<span class="pin-check">&#10003;</span>' : "";
    const overdueClass = status === "overdue" ? "pin-status-overdue" : "";
    return L.divIcon({
      className: "",
      html: `<div class="pin pin-tier-${tier} ${isCoin ? "pin-coin" : ""} ${overdueClass}"><span class="${isCoin ? "pin-glyph-flat" : "pin-glyph"}">${categoryIcon(c.category)}</span>${check}</div>`,
      iconSize: [22, 22],
      iconAnchor: [11, 22],
      popupAnchor: [0, -22],
    });
  }

  let activeFilter = "";
  let managerFilter = "";
  let searchQuery = "";
  let selectedBrand = "";
  let channelFilter = "";
  let categoryFilter = "";
  let brandStatusByCustomer = null;

  // Same 44px icon-button + bottom-sheet pattern as the Customers tab's own
  // filter row (openFilterSheet there is identical) -- duplicated here
  // rather than imported since it's a private closure over that view's own
  // state, not an exported helper.
  function openMapFilterSheet(titleText, options, currentValue, onSelect) {
    const overlay = document.createElement("div");
    overlay.className = "sheet-overlay";
    overlay.innerHTML = `
      <div class="sheet filter-sheet">
        <h2>${escapeHtml(titleText)}</h2>
        <div class="filter-sheet-options">
          ${options
            .map(
              (o) => `
            <button type="button" class="filter-sheet-option ${o.value === currentValue ? "filter-sheet-option-selected" : ""}" data-value="${escapeHtml(o.value)}">
              <span>${escapeHtml(o.label)}</span>
              ${o.value === currentValue ? `<span class="filter-sheet-check">${icons.checkCircle}</span>` : ""}
            </button>
          `
            )
            .join("")}
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    activateDialog(overlay);
    overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());
    overlay.querySelectorAll(".filter-sheet-option").forEach((btn) => {
      btn.addEventListener("click", () => {
        onSelect(btn.dataset.value);
        overlay.remove();
      });
    });
  }

  function mapFilterIconButton({ key, icon, label, active }) {
    return `<button type="button" class="filter-icon-btn ${active ? "filter-icon-btn-active" : ""}" data-map-filter-btn="${key}" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}">
      ${icon}
      ${active ? `<span class="filter-icon-dot" aria-hidden="true"></span>` : ""}
    </button>`;
  }

  const iconFilterRow = root.querySelector("#map-icon-filter-row");

  function renderIconFilterRow() {
    if (!iconFilterRow) return;
    const channels = sortMapChannels([...new Set(lastCustomers.map(({ c }) => c.sales_channel).filter(Boolean))]);
    const categories = [...new Set(lastCustomers.map(({ c }) => c.category).filter(Boolean))];

    iconFilterRow.innerHTML = [
      channels.length
        ? mapFilterIconButton({ key: "channel", icon: icons.route, label: t("filter_direction_title"), active: channelFilter !== "" })
        : "",
      categories.length
        ? mapFilterIconButton({ key: "category", icon: icons.store, label: t("category"), active: categoryFilter !== "" })
        : "",
    ]
      .filter(Boolean)
      .join("");

    iconFilterRow.querySelector('[data-map-filter-btn="channel"]')?.addEventListener("click", () => {
      openMapFilterSheet(
        t("filter_direction_title"),
        [{ value: "", label: t("all_channels") }, ...channels.map((c) => ({ value: c, label: channelDisplayLabel(c) }))],
        channelFilter,
        (value) => {
          channelFilter = value;
          renderIconFilterRow();
          applyFilter();
        }
      );
    });

    iconFilterRow.querySelector('[data-map-filter-btn="category"]')?.addEventListener("click", () => {
      openMapFilterSheet(
        t("category"),
        [{ value: "", label: t("all_categories") }, ...categories.map((v) => ({ value: v, label: categoryLabel(v) }))],
        categoryFilter,
        (value) => {
          categoryFilter = value;
          renderIconFilterRow();
          applyFilter();
        }
      );
    });
  }

  // available/full_range -> green, unavailable -> red (or absent from the
  // competitors list -> unknown grey, since that list is presence-only --
  // a competitor not ticked was never confirmed absent, just not recorded).
  function brandAvailabilityStatus(c) {
    const status = brandStatusByCustomer?.get(c.id);
    if (!status) return "unknown";
    if (selectedBrand.startsWith("competitor:")) {
      const key = selectedBrand.slice("competitor:".length);
      return (status.competitors ?? []).includes(key) ? "available" : "unknown";
    }
    const tags = status[selectedBrand] ?? [];
    if (tags.includes("available") || tags.includes("full_range")) return "available";
    if (tags.includes("unavailable")) return "unavailable";
    return "unknown";
  }

  function brandAvailabilityIcon(c) {
    const level = brandAvailabilityStatus(c);
    return L.divIcon({
      className: "",
      html: `<div class="brand-dot brand-dot-${level}"></div>`,
      iconSize: [18, 18],
      iconAnchor: [9, 9],
      popupAnchor: [0, -9],
    });
  }
  let lastCustomers = [];
  let resolveCustomersReady;
  // Lets anything that needs the full customer list (like the plan sheet)
  // wait for the initial load instead of racing it -- lastCustomers is
  // still [] for a beat after the map view mounts.
  const customersReady = new Promise((resolve) => {
    resolveCustomersReady = resolve;
  });
  let myLocation = null;
  // The very first time the map settles on a view, prefer centering on the
  // user's current position at a close zoom (so nearby customers are
  // already visible) over the default "fit every customer" behavior, which
  // zooms out to the whole territory and makes people zoom back in
  // manually just to see what's around them.
  let initialViewApplied = false;
  let plannedCustomerIds = null;
  let routeLine = null;
  const stopMarkers = [];

  const plannedEmptyHint = root.querySelector("#planned-empty-hint");
  const plannedStopsPanel = root.querySelector("#planned-stops-panel");
  const stopListEl = root.querySelector("#stop-list");

  function numberedIcon(n, visited) {
    return L.divIcon({
      className: "",
      html: `<div class="pin pin-stop ${visited ? "pin-stop-visited" : ""}">${visited ? "&#10003;" : n}</div>`,
      iconSize: [26, 26],
      iconAnchor: [13, 26],
      popupAnchor: [0, -26],
    });
  }

  function renderStopListPanel() {
    stopMarkers.forEach((m) => markerLayer.removeLayer(m));
    stopMarkers.length = 0;
    if (routeLine) {
      map.removeLayer(routeLine);
      routeLine = null;
    }

    if (activeFilter !== "planned" || !plannedCustomerIds?.length) {
      plannedStopsPanel.hidden = true;
      stopListEl.innerHTML = "";
      return;
    }

    const stops = plannedCustomerIds.map((id) => lastCustomers.find((entry) => entry.c.id === id)).filter(Boolean);
    if (!stops.length) {
      plannedStopsPanel.hidden = true;
      return;
    }

    const latlngs = [];
    stops.forEach(({ c }, i) => {
      const visited = customerStatus(c) === "today";
      const marker = L.marker([c.lat, c.lng], { icon: numberedIcon(i + 1, visited) }).addTo(markerLayer);
      marker.on("click", () => navigate(`#/customers/${c.id}`));
      stopMarkers.push(marker);
      latlngs.push([c.lat, c.lng]);
    });
    // Leaflet's SVG renderer sets stroke via setAttribute, which doesn't
    // resolve CSS custom properties -- read the theme's actual color value.
    const accentColor = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#0969da";
    routeLine = L.polyline(latlngs, { color: accentColor, weight: 3, opacity: 0.8, dashArray: "6 6" }).addTo(map);

    plannedStopsPanel.hidden = false;
    stopListEl.innerHTML = stops
      .map(({ c }, i) => {
        const visited = customerStatus(c) === "today";
        return `
        <div class="stop-row" data-index="${i}">
          <span class="stop-number ${visited ? "stop-number-done" : ""}">${visited ? "&#10003;" : i + 1}</span>
          <span class="stop-name">${escapeHtml(c.name)}</span>
          <span class="stop-reorder">
            <button type="button" class="icon-btn" data-move="up" data-index="${i}" ${i === 0 ? "disabled" : ""} aria-label="${t("move_up")}">&uarr;</button>
            <button type="button" class="icon-btn" data-move="down" data-index="${i}" ${i === stops.length - 1 ? "disabled" : ""} aria-label="${t("move_down")}">&darr;</button>
          </span>
        </div>`;
      })
      .join("");

    stopListEl.querySelectorAll("[data-move]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const i = Number(btn.dataset.index);
        const j = btn.dataset.move === "up" ? i - 1 : i + 1;
        [plannedCustomerIds[i], plannedCustomerIds[j]] = [plannedCustomerIds[j], plannedCustomerIds[i]];
        renderStopListPanel();
        try {
          await api.saveVisitPlan(undefined, plannedCustomerIds);
        } catch {
          // Order is still reflected locally; the next plan load will
          // reconcile if the save genuinely failed.
        }
      });
    });

    stopListEl.querySelectorAll(".stop-name").forEach((el, i) => {
      el.addEventListener("click", () => navigate(`#/customers/${stops[i].c.id}`));
    });
  }

  root.querySelector("#planned-stops-close").addEventListener("click", () => {
    plannedStopsPanel.hidden = true;
  });

  // Greedy nearest-neighbor ordering -- not a true shortest-route solver,
  // but for the handful of stops a single rep plans in a day it gets close
  // enough while staying instant and dependency-free. Starts from the
  // rep's live location when available (locate button already tapped),
  // otherwise from whichever stop is currently first.
  function nearestNeighborOrder(ids) {
    const remaining = ids.map((id) => lastCustomers.find((entry) => entry.c.id === id)).filter(Boolean);
    if (!remaining.length) return ids;
    const ordered = [];
    let current = myLocation ?? { lat: remaining[0].c.lat, lng: remaining[0].c.lng };
    while (remaining.length) {
      let bestIndex = 0;
      let bestDistance = Infinity;
      remaining.forEach((entry, i) => {
        const distance = haversineMeters(current.lat, current.lng, entry.c.lat, entry.c.lng);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestIndex = i;
        }
      });
      const [chosen] = remaining.splice(bestIndex, 1);
      ordered.push(chosen.c.id);
      current = { lat: chosen.c.lat, lng: chosen.c.lng };
    }
    return ordered;
  }

  root.querySelector("#optimize-route-btn").addEventListener("click", async () => {
    if (!plannedCustomerIds?.length) return;
    plannedCustomerIds = nearestNeighborOrder(plannedCustomerIds);
    renderStopListPanel();
    try {
      await api.saveVisitPlan(undefined, plannedCustomerIds);
    } catch {
      // Order is still reflected locally; the next plan load will
      // reconcile if the save genuinely failed.
    }
  });

  function applyFilter() {
    markerLayer.clearLayers();
    customerClusterGroup.clearLayers();
    const bounds = [];
    let searchMatchCount = 0;
    // Competitors are hidden by default (see .map-competitor-toggle /
    // map-safe-enhancements.css, which hides their individual pins via
    // CSS). Clustering happens in JS before that CSS rule ever applies, so
    // without this check a cluster badge would count competitors that are
    // never actually visible once it splits apart -- leaving the number on
    // the badge wrong. Reading the toggle's own class keeps this in sync
    // without depending on anything from that module directly.
    const showCompetitors = root.querySelector(".map-view")?.classList.contains("kad-show-competitors");
    for (const { c, marker } of lastCustomers) {
      const status = customerStatus(c);
      if (c.customer_tier === "competitor" && !showCompetitors) continue;
      if (managerFilter && String(c.assigned_manager_id) !== managerFilter) continue;
      if (channelFilter && c.sales_channel !== channelFilter) continue;
      if (categoryFilter && c.category !== categoryFilter) continue;
      if (searchQuery) {
        const haystack = `${c.name} ${c.address ?? ""} ${c.category ?? ""} ${c.erp_customer_id ?? ""}`.toLowerCase();
        if (!haystack.includes(searchQuery)) continue;
      }
      searchMatchCount += 1;
      if (activeFilter === "brands") {
        marker.setIcon(selectedBrand ? brandAvailabilityIcon(c) : customerIcon(c, status));
      } else if (activeFilter === "nearby") {
        const distance = myLocation ? haversineMeters(myLocation.lat, myLocation.lng, c.lat, c.lng) : Infinity;
        if (distance > NEARBY_RADIUS_METERS) continue;
        marker.setIcon(customerIcon(c, status));
      } else if (activeFilter === "planned") {
        continue;
      } else {
        if (
          activeFilter &&
          !(activeFilter === "overdue" ? status === "overdue" : activeFilter === "visited" ? status === "today" || status === "week" : true)
        ) {
          continue;
        }
        marker.setIcon(customerIcon(c, status));
      }
      marker.addTo(customerClusterGroup);
      bounds.push([c.lat, c.lng]);
    }
    if (searchNoResults) searchNoResults.hidden = !(searchQuery && searchMatchCount === 0);
    if (activeFilter === "planned") {
      renderStopListPanel();
      if (plannedCustomerIds?.length) {
        bounds.push(...plannedCustomerIds.map((id) => lastCustomers.find((e) => e.c.id === id)).filter(Boolean).map(({ c }) => [c.lat, c.lng]));
      }
      plannedEmptyHint.hidden = bounds.length > 0 || plannedCustomerIds === null;
    } else {
      plannedStopsPanel.hidden = true;
      plannedEmptyHint.hidden = true;
    }
    if (bounds.length) {
      // The very first time the map settles (plain browsing, not while
      // relocating/adding a customer or opening straight into Plan Day),
      // prefer centering on the user's own position at a close zoom over
      // fitBounds-to-everyone -- fitBounds naturally zooms out to fit the
      // whole territory, which is the opposite of what someone opening the
      // map wants to see first (what's near them right now).
      if (!initialViewApplied && !relocateCustomerId && !startInAddMode && !startInPlanMode) {
        initialViewApplied = true;
        getCurrentPosition({ timeout: 4000 })
          .then((pos) => {
            myLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
            map.setView([myLocation.lat, myLocation.lng], 15);
            refreshNearestCustomerBar();
          })
          .catch(() => {
            try {
              map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
            } catch {
              // See note below about the rotate-plugin pane-timing quirk.
            }
          });
        return;
      }
      try {
        map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
      } catch {
        // See note below about the rotate-plugin pane-timing quirk.
      }
    }
  }

  // Bottom-left "nearest customer" widget — an icon-only check-in shortcut
  // plus a glance at who's closest, without opening a panel or a popup.
  // Recomputed whenever the customer list or the user's own location
  // changes (see the calls to this after each of those below); nothing to
  // do here at all in relocate mode, where the widget isn't rendered.
  function refreshNearestCustomerBar() {
    if (!nearestBar) return;
    if (!myLocation || !lastCustomers.length) {
      nearestBar.hidden = true;
      nearestCustomer = null;
      return;
    }
    let nearest = null;
    let nearestDist = Infinity;
    for (const { c } of lastCustomers) {
      const d = haversineMeters(myLocation.lat, myLocation.lng, c.lat, c.lng);
      if (d < nearestDist) {
        nearestDist = d;
        nearest = c;
      }
    }
    if (!nearest) {
      nearestBar.hidden = true;
      nearestCustomer = null;
      return;
    }
    nearestCustomer = nearest;
    nearestInfo.innerHTML = `<strong>${escapeHtml(nearest.name)}</strong><span class="muted">${formatDistance(nearestDist)}</span>`;
    nearestBar.hidden = false;
  }

  nearestCheckinBtn?.addEventListener("click", () => {
    if (nearestCustomer) navigate(`#/checkin/${nearestCustomer.id}`);
  });

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
        refreshNearestCustomerBar();
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
            ${c.category ? `<span class="muted">${escapeHtml(categoryLabel(c.category))}</span>` : ""}
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
    await customersReady;
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
      if (activeFilter !== "brands") selectedBrand = "";
      brandPickerRow.hidden = activeFilter !== "brands";
      brandLegend.hidden = activeFilter !== "brands" || !selectedBrand;
      if (activeFilter === "nearby") {
        openNearbyPanel();
      } else if (activeFilter === "planned") {
        nearbyPanel.hidden = true;
        loadPlannedFilter();
      } else if (activeFilter === "brands") {
        nearbyPanel.hidden = true;
        loadBrandStatus();
      } else {
        nearbyPanel.hidden = true;
        applyFilter();
      }
    });
  });

  const brandPickerRow = root.querySelector("#brand-picker-row");
  const brandLegend = root.querySelector("#brand-legend");
  if (brandPickerRow) {
    brandPickerRow.innerHTML = BRAND_FILTER_OPTIONS.map(
      (o) => `<button type="button" class="map-filter-chip brand-picker-chip" data-brand="${o.value}" aria-pressed="false">${t(o.labelKey)}</button>`
    ).join("");
    brandPickerRow.querySelectorAll(".brand-picker-chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        brandPickerRow.querySelectorAll(".brand-picker-chip").forEach((c) => {
          c.classList.toggle("chip-active", c === chip);
          c.setAttribute("aria-pressed", String(c === chip));
        });
        selectedBrand = chip.dataset.brand;
        brandLegend.hidden = false;
        applyFilter();
      });
    });
  }

  let brandStatusLoaded = false;
  async function loadBrandStatus() {
    if (!brandStatusLoaded) {
      try {
        const rows = await api.getBrandStatusByCustomer();
        brandStatusByCustomer = new Map(rows.map((r) => [r.customer_id, r.brand_status]));
      } catch {
        brandStatusByCustomer = new Map();
      }
      brandStatusLoaded = true;
    }
    applyFilter();
  }

  const mapSearchInput = root.querySelector("#map-customer-search");
  const searchNoResults = root.querySelector("#map-search-no-results");
  mapSearchInput?.addEventListener("input", () => {
    searchQuery = mapSearchInput.value.trim().toLowerCase();
    applyFilter();
  });

  // The competitor visibility toggle is mounted separately (see
  // mapSafeUi.js) and is deliberately CSS-only/DOM-only with no direct call
  // into this module. Re-clustering on its click (delegated, since the
  // button doesn't exist yet at render time) keeps cluster badge counts
  // honest -- see the showCompetitors check in applyFilter above.
  root.addEventListener("click", (e) => {
    if (e.target.closest(".map-competitor-toggle")) applyFilter();
  });

  // Manager filter -- director/ceo/admin only (canViewTeamLocations gate
  // above decides whether the control even renders). Populated from the
  // same "plannable" roster the route-planning picker uses, since that's
  // already the right list (sales managers only) with no extra endpoint.
  const managerFilterBtn = root.querySelector("#map-manager-filter-btn");
  const managerFilterMenu = root.querySelector("#map-manager-filter-menu");
  const managerFilterLabel = root.querySelector("#map-manager-filter-label");
  if (managerFilterBtn) {
    api
      .listPlannableUsers()
      .then((users) => {
        managerFilterMenu.innerHTML = `
          <button type="button" role="menuitemradio" aria-checked="true" class="filter-dropdown-selected" data-value="">${t("all_managers")}</button>
          ${users.map((u) => `<button type="button" role="menuitemradio" aria-checked="false" data-value="${u.id}">${escapeHtml(u.name)}</button>`).join("")}
        `;
        managerFilterMenu.querySelectorAll("button").forEach((btn) => {
          btn.addEventListener("click", (e) => {
            e.stopPropagation();
            managerFilter = btn.dataset.value;
            managerFilterLabel.textContent = btn.textContent;
            managerFilterMenu.querySelectorAll("button").forEach((b) => {
              b.classList.toggle("filter-dropdown-selected", b === btn);
              b.setAttribute("aria-checked", String(b === btn));
            });
            managerFilterMenu.hidden = true;
            managerFilterBtn.setAttribute("aria-expanded", "false");
            applyFilter();
          });
        });
      })
      .catch(() => {});

    managerFilterBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      managerFilterMenu.hidden = !managerFilterMenu.hidden;
      managerFilterBtn.setAttribute("aria-expanded", String(!managerFilterMenu.hidden));
    });
    root.addEventListener("click", () => {
      if (!managerFilterMenu.hidden) {
        managerFilterMenu.hidden = true;
        managerFilterBtn.setAttribute("aria-expanded", "false");
      }
    });
  }

  async function loadCustomers() {
    const customers = await api.listCustomers();
    markerLayer.clearLayers();
    customerClusterGroup.clearLayers();
    lastCustomers = [];

    const bounds = [];
    for (const c of customers) {
      const status = customerStatus(c);
      const marker = L.marker([c.lat, c.lng], { icon: customerIcon(c, status) });
      marker.bindPopup(`
        <div class="map-popup">
          <strong>${escapeHtml(c.name)}</strong>
          ${c.category ? `<div class="popup-category">${escapeHtml(categoryLabel(c.category))}</div>` : ""}
          <div class="popup-facts" id="popup-facts-${c.id}"><p class="popup-loading">${t("loading")}</p></div>
          <div class="popup-actions">
            <button data-action="checkin" data-id="${c.id}" class="btn-accent"><span>${icons.mapPinCheck}</span>${t("check_in")}</button>
            <button data-action="details" data-id="${c.id}">${t("more")}</button>
          </div>
        </div>
      `);
      marker.on("popupopen", async (e) => {
        const popupEl = e.popup.getElement();
        popupEl.querySelector('[data-action="details"]').addEventListener("click", () => {
          navigate(`#/customers/${c.id}`);
        });
        popupEl.querySelector('[data-action="checkin"]').addEventListener("click", () => {
          navigate(`#/checkin/${c.id}`);
        });

        const factsEl = popupEl.querySelector(`#popup-facts-${c.id}`);
        try {
          const [detail, plannedVisits] = await Promise.all([
            api.getCustomer(c.id),
            api.customerPlannedVisits(c.id),
          ]);
          const lastVisitLabel = detail.last_visit_at ? formatDateTime(detail.last_visit_at) : t("never_visited");
          const debtLabel = detail.erp_debt_amd != null ? formatAmd(detail.erp_debt_amd) : "—";
          const plannedLabel = plannedVisits.length
            ? plannedVisits.map((p) => new Date(p.plan_date).toLocaleDateString(undefined, { month: "short", day: "numeric" })).join(", ")
            : t("no_planned_visits");
          factsEl.innerHTML = `
            <div class="popup-fact"><span class="muted">${t("outstanding_debt")}</span><strong>${escapeHtml(debtLabel)}</strong></div>
            <div class="popup-fact"><span class="muted">${t("last_visit")}</span><strong>${escapeHtml(lastVisitLabel)}</strong></div>
            <div class="popup-fact"><span class="muted">${t("planned_visit_dates")}</span><strong>${escapeHtml(plannedLabel)}</strong></div>
          `;
        } catch {
          factsEl.innerHTML = "";
        }
      });
      lastCustomers.push({ c, marker });
      bounds.push([c.lat, c.lng]);
    }

    resolveCustomersReady();
    renderIconFilterRow();
    applyFilter();
    refreshNearestCustomerBar();

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
          myLocation = { lat: latitude, lng: longitude };
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
          refreshNearestCustomerBar();
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
  let teamEmptyHintTimer = null;

  function teamMemberIcon() {
    return L.divIcon({
      className: "",
      html: `<div class="team-dot"></div>`,
      iconSize: [16, 16],
      iconAnchor: [8, 8],
    });
  }

  async function refreshTeamLocations({ fitBounds = false } = {}) {
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
    // Only zoom to fit on the toggle-on load, not on every 15s poll refresh
    // -- otherwise the map would yank the viewport out from under someone
    // who's since panned/zoomed to look at a specific area.
    if (fitBounds && locations.length) {
      try {
        map.fitBounds(
          locations.map((loc) => [loc.lat, loc.lng]),
          { padding: [50, 50], maxZoom: 15 }
        );
      } catch {
        // See the rotate-plugin pane-timing note elsewhere in this file.
      }
    }
    clearTimeout(teamEmptyHintTimer);
    if (teamBtn.classList.contains("map-control-active") && locations.length === 0) {
      teamEmptyHint.hidden = false;
      // Toast-style: shows briefly then dismisses itself, instead of
      // sitting on the map indefinitely while the toggle stays on.
      teamEmptyHintTimer = setTimeout(() => {
        teamEmptyHint.hidden = true;
      }, 2000);
    } else {
      teamEmptyHint.hidden = true;
    }
  }

  teamBtn?.addEventListener("click", () => {
    const active = teamBtn.classList.toggle("map-control-active");
    if (active) {
      teamLayer.addTo(map);
      refreshTeamLocations({ fitBounds: true });
      teamPollId = setInterval(refreshTeamLocations, 15000);
    } else {
      map.removeLayer(teamLayer);
      clearInterval(teamPollId);
      teamPollId = null;
      clearTimeout(teamEmptyHintTimer);
      teamEmptyHint.hidden = true;
    }
  });

  const PLAN_STATUS_KEY = {
    pending: "plan_status_pending",
    approved: "plan_status_approved",
    rejected: "plan_status_rejected",
  };

  const WEEKDAY_KEYS = ["weekday_sun", "weekday_mon", "weekday_tue", "weekday_wed", "weekday_thu", "weekday_fri", "weekday_sat"];
  // Display order only -- the underlying day_of_week values stay 0=Sun..6=Sat
  // (matching JS Date#getDay(), which the visit_plan_rules schema is built
  // on), but the week is shown Monday-first everywhere in the UI.
  const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

  async function openPlanDaySheet() {
    const overlay = document.createElement("div");
    overlay.className = "sheet-overlay sheet-overlay-light";
    overlay.innerHTML = `
      <div class="sheet">
        <h2>${t("plan_day")}</h2>
        ${
          canPlanForOthers()
            ? `<label>${t("planning_for")}
                <select id="plan-target-select">
                  <option value="">${t("myself")}</option>
                </select>
              </label>`
            : ""
        }
        <div class="plan-mode-tabs" role="tablist">
          <button type="button" class="plan-mode-tab plan-mode-tab-active" data-mode="today" role="tab" aria-selected="true" aria-controls="plan-body" tabindex="0">${t("plan_mode_today")}</button>
          <button type="button" class="plan-mode-tab" data-mode="recurring" role="tab" aria-selected="false" aria-controls="plan-body" tabindex="-1">${t("plan_mode_recurring")}</button>
        </div>
        <div id="plan-body" role="tabpanel"><p class="loading-state" role="status">${t("loading")}</p></div>
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

    // The customer checklist below reads lastCustomers, which is still
    // empty for a beat after the map view mounts -- wait for it so the
    // list isn't rendered permanently blank.
    await customersReady;

    const bodyEl = overlay.querySelector("#plan-body");
    const errorEl = overlay.querySelector("#plan-day-error");
    const targetSelect = overlay.querySelector("#plan-target-select");
    const saveBtn = overlay.querySelector("#save-plan-day");

    let targetUserId = null;
    let mode = "today";
    let selectedWeekday = new Date().getDay();

    if (targetSelect) {
      try {
        const plannable = await api.listPlannableUsers();
        targetSelect.insertAdjacentHTML(
          "beforeend",
          plannable.map((u) => `<option value="${u.id}">${escapeHtml(u.name)}${u.position ? ` (${escapeHtml(u.position)})` : ""}</option>`).join("")
        );
      } catch {
        // Leave just "Myself" if this fails -- not fatal.
      }
      targetSelect.addEventListener("change", () => {
        targetUserId = targetSelect.value || null;
        renderBody();
      });
    }

    const planModeTabs = [...overlay.querySelectorAll(".plan-mode-tab")];
    function selectPlanMode(tab) {
        planModeTabs.forEach((t2) => {
          t2.classList.remove("plan-mode-tab-active");
          t2.setAttribute("aria-selected", "false");
          t2.tabIndex = -1;
        });
        tab.classList.add("plan-mode-tab-active");
        tab.setAttribute("aria-selected", "true");
        tab.tabIndex = 0;
        mode = tab.dataset.mode;
        renderBody();
    }
    planModeTabs.forEach((tab, index) => {
      tab.addEventListener("click", () => selectPlanMode(tab));
      tab.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const nextIndex = (index + (event.key === "ArrowRight" ? 1 : -1) + planModeTabs.length) % planModeTabs.length;
        planModeTabs[nextIndex].focus();
        selectPlanMode(planModeTabs[nextIndex]);
      });
    });

    async function renderBody() {
      errorEl.hidden = true;
      bodyEl.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
      if (mode === "today") {
        await renderTodayMode();
      } else {
        await renderRecurringMode();
      }
    }

    async function renderTodayMode() {
      let existingPlan;
      try {
        existingPlan = await api.getMyVisitPlan(undefined, targetUserId);
      } catch {
        existingPlan = null;
      }
      const selectedIds = new Set(existingPlan?.customer_ids ?? []);
      const statusClass =
        existingPlan?.status === "approved" ? "badge-success" : existingPlan?.status === "rejected" ? "badge-danger" : "badge-neutral";
      const statusLabel = existingPlan
        ? existingPlan.source === "rule"
          ? t("plan_status_from_rule")
          : t(PLAN_STATUS_KEY[existingPlan.status])
        : t("plan_status_none");

      // Scope the checklist to whoever the plan is actually for -- the
      // customers assigned to that rep, not the entire map. Without this a
      // director planning for one SM would be picking from every other
      // rep's customers too.
      const effectiveTargetId = targetUserId ? Number(targetUserId) : state.user.id;
      const sortedCustomers = lastCustomers
        .filter(({ c }) => Number(c.assigned_manager_id) === effectiveTargetId)
        .sort((a, b) => a.c.name.localeCompare(b.c.name));
      bodyEl.innerHTML = `
        <p class="badge ${statusClass}" id="plan-status-badge">${statusLabel}</p>
        <p class="muted">${t("plan_day_hint")}</p>
        <div class="plan-day-list" id="plan-day-list">
          ${
            sortedCustomers.length
              ? sortedCustomers
                  .map(
                    ({ c }) => `
            <label class="plan-day-row">
              <input type="checkbox" value="${c.id}" ${selectedIds.has(c.id) ? "checked" : ""} />
              <span>${escapeHtml(c.name)}</span>
            </label>`
                  )
                  .join("")
              : `<p class="empty-state">${t("no_assigned_customers")}</p>`
          }
        </div>
      `;

      saveBtn.onclick = async () => {
        saveBtn.disabled = true;
        const ids = [...bodyEl.querySelectorAll("#plan-day-list input:checked")].map((el) => Number(el.value));
        try {
          await api.saveVisitPlan(undefined, ids, targetUserId);
          close();
          if (activeFilter === "planned") loadPlannedFilter();
        } catch (err) {
          errorEl.textContent = err.message;
          errorEl.hidden = false;
          saveBtn.disabled = false;
        }
      };
    }

    async function renderRecurringMode() {
      let regions = [];
      let rules = [];
      try {
        [regions, rules] = await Promise.all([api.getCustomerRegions(), api.getVisitPlanRules(targetUserId)]);
      } catch {
        regions = [];
        rules = [];
      }
      const regionNames = [...new Set(regions.map((r) => r.region))];
      const currentRule = rules.find((r) => r.day_of_week === selectedWeekday);
      const areas = currentRule?.areas ?? [];

      bodyEl.innerHTML = `
        <p class="muted">${t("plan_recurring_hint").replace("[weekday]", t(WEEKDAY_KEYS[selectedWeekday]))}</p>
        <div class="weekday-picker" id="weekday-picker">
          ${WEEKDAY_ORDER.map(
            (i) => `<button type="button" class="weekday-btn ${i === selectedWeekday ? "weekday-btn-active" : ""}" data-day="${i}">${t(WEEKDAY_KEYS[i])}</button>`
          ).join("")}
        </div>
        <div class="plan-area-list" id="plan-area-list">
          ${
            areas.length
              ? areas
                  .map(
                    (a, i) => `
              <div class="plan-area-row" data-index="${i}">
                <span>${escapeHtml(a.region)}${a.subregion ? ` · ${escapeHtml(a.subregion)}` : ""}</span>
                <button type="button" class="icon-btn plan-area-remove" data-index="${i}" aria-label="${t("cancel")}">${icons.close}</button>
              </div>`
                  )
                  .join("")
              : `<p class="muted">${t("no_areas_yet")}</p>`
          }
        </div>
        <div class="plan-area-add-row">
          <select id="plan-add-region">
            <option value="">${t("region")}</option>
            ${regionNames.map((r) => `<option value="${escapeHtml(r)}">${escapeHtml(r)}</option>`).join("")}
          </select>
          <select id="plan-add-subregion">
            <option value="">${t("all_subregions")}</option>
          </select>
          <button type="button" class="btn btn-sm plan-add-area-btn" id="plan-add-area-btn" aria-label="${t("add_area")}">${icons.plus}</button>
        </div>
      `;

      let workingAreas = areas.map((a) => ({ ...a }));
      const regionSelect = bodyEl.querySelector("#plan-add-region");
      const subregionSelect = bodyEl.querySelector("#plan-add-subregion");

      regionSelect.addEventListener("change", () => {
        const subregions = regions.filter((r) => r.region === regionSelect.value && r.subregion).map((r) => r.subregion);
        subregionSelect.innerHTML = `<option value="">${t("all_subregions")}</option>${subregions
          .map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`)
          .join("")}`;
      });

      function paintAreaList() {
        const listEl = bodyEl.querySelector("#plan-area-list");
        listEl.innerHTML = workingAreas.length
          ? workingAreas
              .map(
                (a, i) => `
          <div class="plan-area-row" data-index="${i}">
            <span>${escapeHtml(a.region)}${a.subregion ? ` · ${escapeHtml(a.subregion)}` : ""}</span>
            <button type="button" class="icon-btn plan-area-remove" data-index="${i}" aria-label="${t("cancel")}">${icons.close}</button>
          </div>`
              )
              .join("")
          : `<p class="muted">${t("no_areas_yet")}</p>`;
        listEl.querySelectorAll(".plan-area-remove").forEach((btn) => {
          btn.addEventListener("click", () => {
            workingAreas.splice(Number(btn.dataset.index), 1);
            paintAreaList();
          });
        });
      }
      paintAreaList();

      bodyEl.querySelector("#plan-add-area-btn").addEventListener("click", () => {
        if (!regionSelect.value) return;
        workingAreas.push({ region: regionSelect.value, subregion: subregionSelect.value || null });
        paintAreaList();
      });

      bodyEl.querySelectorAll(".weekday-btn").forEach((btn) => {
        btn.addEventListener("click", async () => {
          // Persist whatever was staged for the day being left before switching.
          try {
            await api.saveVisitPlanRule(selectedWeekday, workingAreas, targetUserId);
          } catch {
            // Non-fatal -- the explicit Save button below is the primary save path.
          }
          selectedWeekday = Number(btn.dataset.day);
          renderRecurringMode();
        });
      });

      saveBtn.onclick = async () => {
        saveBtn.disabled = true;
        try {
          await api.saveVisitPlanRule(selectedWeekday, workingAreas, targetUserId);
          close();
          if (activeFilter === "planned") loadPlannedFilter();
        } catch (err) {
          errorEl.textContent = err.message;
          errorEl.hidden = false;
          saveBtn.disabled = false;
        }
      };
    }

    await renderBody();
  }

  root.querySelector("#plan-day-btn").addEventListener("click", () => {
    openPlanDaySheet();
  });
  if (startInPlanMode) openPlanDaySheet();

  const legendBtn = root.querySelector("#map-legend-btn");
  const legendPanel = root.querySelector("#map-legend-panel");
  const closeLegend = () => {
    legendPanel.hidden = true;
    legendBtn.setAttribute("aria-expanded", "false");
  };
  legendBtn.addEventListener("click", () => {
    const open = legendPanel.hidden;
    legendPanel.hidden = !open;
    legendBtn.setAttribute("aria-expanded", String(open));
  });
  root.querySelector("#map-legend-close").addEventListener("click", closeLegend);
  root.addEventListener("click", (event) => {
    if (!legendPanel.hidden && !legendPanel.contains(event.target) && event.target !== legendBtn && !legendBtn.contains(event.target)) {
      closeLegend();
    }
  });

  // ---- Shared customer-location picker (Add Customer + Relocate) ----
  // One flow services both: propose a location (a fresh GPS fix, the
  // customer's existing saved coordinates, or a plain tap), let the rep
  // drag the pin or search an address instead, and only ever write lat/lng
  // once they explicitly tap Confirm. The panel is a bottom-docked HUD
  // (.location-picker-panel), not a modal .sheet-overlay -- a full-screen
  // overlay would sit above the whole map and block exactly the dragging
  // and panning this flow depends on.
  const locationPanel = root.querySelector("#location-picker-panel");
  let geocodeToken = 0; // discards a stale reverse-geocode reply if the pin moved again before it returned

  function removePlacingMarker() {
    if (placingMarker) {
      map.removeLayer(placingMarker);
      placingMarker = null;
    }
  }

  function closeLocationPanel() {
    locationPanel.hidden = true;
    locationPanel.innerHTML = "";
    if (!relocateCustomerId) fab.hidden = false;
  }

  // Full abandon: closes the panel and removes the pin entirely. Used when
  // the rep backs out of picking a location altogether (tapping the FAB a
  // second time to cancel). Not used when handing off to the customer-
  // details form below -- that keeps the pin on the map and takes over its
  // lifecycle itself.
  function cancelLocationPicker() {
    closeLocationPanel();
    removePlacingMarker();
    if (!relocateCustomerId) {
      addMode = false;
      fab.classList.remove("fab-active");
      fab.setAttribute("aria-pressed", "false");
      mapEl.classList.remove("map-picking");
    }
  }

  // Location confirmed -- resets the picker's own UI state but leaves the
  // pin on the map for openNewCustomerForm to keep showing (and to remove
  // itself, on that form's own cancel/save).
  function handoffToCustomerForm(latlng) {
    closeLocationPanel();
    addMode = false;
    fab.classList.remove("fab-active");
    fab.setAttribute("aria-pressed", "false");
    mapEl.classList.remove("map-picking");
    // Freeze the pin in place -- the details form below doesn't listen for
    // further drags (it reverse-geocodes once, at open), so leaving it
    // draggable would let a drag here reopen the location panel on top of
    // that form instead of updating it.
    placingMarker?.dragging?.disable();
    openNewCustomerForm(latlng);
  }

  // Places (or moves) the one draggable "proposed location" pin, distinct
  // from the blue "me" dot (.me-dot, only shown via the Locate button) so
  // there's never any doubt which marker is about to be saved. Dragging it
  // re-runs the same confirm step against the new spot -- nothing is
  // written until Confirm is tapped.
  function placeLocationPin(latlng, opts) {
    if (placingMarker) {
      placingMarker.setLatLng(latlng);
    } else {
      placingMarker = L.marker(latlng, {
        icon: L.divIcon({ className: "", html: NEW_PIN_HTML, iconSize: [26, 26], iconAnchor: [13, 26] }),
        draggable: true,
        autoPan: true,
      }).addTo(map);
      placingMarker.on("dragend", () => {
        showLocationPanel(placingMarker.getLatLng(), { ...opts, source: "dragged_pin", accuracy: undefined, onConfirm: opts.onConfirm });
      });
    }
    showLocationPanel(latlng, opts);
  }

  // The panel is bottom-docked at the same spot the FAB sits in, so the two
  // would visually stack -- hide the FAB for as long as the panel is open
  // and give the panel its own close (X) instead, consistent with the
  // rest of the app's dismiss-vs-back convention (this is a temporary
  // overlay panel, not a pushed page, so X rather than a back arrow).
  function renderLocationPanelShell(bodyHtml) {
    fab.hidden = true;
    locationPanel.hidden = false;
    locationPanel.innerHTML = `
      <button type="button" class="icon-btn location-picker-close" id="location-panel-close" aria-label="${t("cancel")}">${icons.close}</button>
      ${bodyHtml}
    `;
    locationPanel.querySelector("#location-panel-close").addEventListener("click", cancelLocationPicker);
  }

  // The one confirm panel for "here's the proposed location" -- title and
  // accuracy line vary with how the pin got there, everything else
  // (address line, Confirm/Change-address actions, drag-to-adjust hint) is
  // identical whether it came from a fresh GPS fix, a dragged pin, a
  // searched address, or an existing customer's saved location.
  function showLocationPanel(latlng, { source, accuracy, onConfirm }) {
    const title =
      source === "dragged_pin"
        ? t("new_selected_address")
        : source === "geocoded_address"
          ? t("location_updated_title")
          : t("selected_location");
    const lowAccuracy = accuracy != null && accuracy > 50;
    renderLocationPanelShell(`
      <h2>${title}</h2>
      <p class="location-picker-address" id="location-panel-address">${escapeHtml(t("loading"))}</p>
      ${
        accuracy != null
          ? `<p class="location-picker-accuracy ${lowAccuracy ? "location-picker-accuracy-low" : ""}">${icons.locate}${
              lowAccuracy
                ? t("low_accuracy_warning").replace("{m}", String(Math.round(accuracy)))
                : t("gps_accuracy_label").replace("{m}", String(Math.round(accuracy)))
            }</p>`
          : ""
      }
      <p class="muted location-picker-hint">${t("drag_pin_hint")}</p>
      <div class="location-picker-actions">
        <button type="button" class="btn" id="location-panel-address-btn">${t("change_address")}</button>
        <button type="button" class="btn btn-primary" id="location-panel-confirm-btn">${t("confirm_location")}</button>
      </div>
    `);

    const myToken = ++geocodeToken;
    api
      .reverseGeocode(latlng.lat, latlng.lng)
      .then((result) => {
        if (myToken !== geocodeToken) return; // pin moved again since this request went out
        const addressEl = document.getElementById("location-panel-address");
        if (addressEl) addressEl.textContent = result?.address || t("address_unknown");
      })
      .catch(() => {
        if (myToken !== geocodeToken) return;
        const addressEl = document.getElementById("location-panel-address");
        if (addressEl) addressEl.textContent = t("address_unknown");
      });

    locationPanel.querySelector("#location-panel-address-btn").addEventListener("click", () => {
      openAddressSearchSheet((result) => {
        const newLatLng = L.latLng(result.lat, result.lng);
        map.panTo(newLatLng);
        placeLocationPin(newLatLng, { source: "geocoded_address", onConfirm });
      });
    });
    locationPanel.querySelector("#location-panel-confirm-btn").addEventListener("click", () => {
      const finalLatLng = placingMarker ? placingMarker.getLatLng() : latlng;
      closeLocationPanel();
      onConfirm(finalLatLng);
    });
  }

  function showLocationErrorPanel(onRetry, onEnterAddress) {
    renderLocationPanelShell(`
      <h2>${t("location_failed_title")}</h2>
      <div class="location-picker-actions">
        <button type="button" class="btn" id="location-panel-error-address">${t("enter_address")}</button>
        <button type="button" class="btn btn-primary" id="location-panel-error-retry">${t("try_again")}</button>
      </div>
    `);
    locationPanel.querySelector("#location-panel-error-retry").addEventListener("click", onRetry);
    locationPanel.querySelector("#location-panel-error-address").addEventListener("click", onEnterAddress);
  }

  // Debounced address search -- only geocodes on an explicit result tap,
  // never per keystroke, so typing never jumps the map or burns API calls
  // on every character.
  function openAddressSearchSheet(onSelect) {
    const overlay = document.createElement("div");
    overlay.className = "sheet-overlay";
    overlay.innerHTML = `
      <div class="sheet">
        <h2>${t("search_address_title")}</h2>
        <label class="visually-hidden" for="address-search-input">${t("search_address_placeholder")}</label>
        <input type="search" id="address-search-input" placeholder="${t("search_address_placeholder")}" />
        <div class="address-search-results" id="address-search-results"></div>
      </div>
    `;
    document.body.appendChild(overlay);
    activateDialog(overlay);
    overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());

    const input = overlay.querySelector("#address-search-input");
    const resultsEl = overlay.querySelector("#address-search-results");
    let searchTimer;
    let searchToken = 0;

    input.addEventListener("input", () => {
      clearTimeout(searchTimer);
      const q = input.value.trim();
      if (q.length < 3) {
        resultsEl.innerHTML = "";
        return;
      }
      searchTimer = setTimeout(async () => {
        const myToken = ++searchToken;
        resultsEl.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
        let results;
        try {
          results = await api.searchAddress(q);
        } catch (err) {
          if (myToken !== searchToken) return;
          resultsEl.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
          return;
        }
        if (myToken !== searchToken) return; // a newer query already superseded this one
        if (!results.length) {
          resultsEl.innerHTML = `<p class="empty-state">${t("no_address_results")}</p>`;
          return;
        }
        resultsEl.innerHTML = results
          .map((r, i) => `<button type="button" class="address-search-result" data-index="${i}">${escapeHtml(r.address)}</button>`)
          .join("");
        resultsEl.querySelectorAll("[data-index]").forEach((btn) => {
          btn.addEventListener("click", () => {
            overlay.remove();
            onSelect(results[Number(btn.dataset.index)]);
          });
        });
      }, 400);
    });

    requestAnimationFrame(() => input.focus());
  }

  function startAddCustomerFlow() {
    renderLocationPanelShell(`<p class="location-picker-address">${escapeHtml(t("locating_you"))}</p>`);
    getCurrentPosition({ timeout: 8000 })
      .then((pos) => {
        const latlng = L.latLng(pos.coords.latitude, pos.coords.longitude);
        map.setView(latlng, Math.max(map.getZoom(), 16));
        placeLocationPin(latlng, {
          source: "gps",
          accuracy: pos.coords.accuracy,
          onConfirm: handoffToCustomerForm,
        });
      })
      .catch(() => {
        showLocationErrorPanel(
          () => startAddCustomerFlow(),
          () => {
            openAddressSearchSheet((result) => {
              const latlng = L.latLng(result.lat, result.lng);
              map.setView(latlng, 16);
              placeLocationPin(latlng, {
                source: "geocoded_address",
                onConfirm: handoffToCustomerForm,
              });
            });
          }
        );
      });
  }

  if (relocateCustomerId) {
    fab.hidden = true;
    mapEl.classList.add("map-picking");
    root.querySelector("#cancel-relocate")?.addEventListener("click", () => {
      navigate(`#/customers/${relocateCustomerId}`);
    });
    customersReady.then(() => {
      const existing = lastCustomers.find((entry) => String(entry.c.id) === String(relocateCustomerId));
      const startLatLng = existing ? L.latLng(existing.c.lat, existing.c.lng) : map.getCenter();
      if (existing) map.setView(startLatLng, Math.max(map.getZoom(), 16));
      placeLocationPin(startLatLng, { source: "existing_customer", onConfirm: openRelocateConfirmDetails });
    });
  } else {
    // Tapping the FAB a second time while already picking cancels --
    // mirrors the button's own pressed/active state, so there's always one
    // obvious way to back out beyond navigating away entirely.
    fab.addEventListener("click", () => {
      if (addMode) {
        cancelLocationPicker();
        return;
      }
      addMode = true;
      fab.classList.add("fab-active");
      fab.setAttribute("aria-pressed", "true");
      mapEl.classList.add("map-picking");
      startAddCustomerFlow();
    });
  }

  // Manual fallback: while addMode/relocate is active, a plain tap anywhere
  // on the map also drops (or moves) the pin -- the GPS-first flow above is
  // the default, not the only way in, per the task's "let the user accept
  // it, drag it, or place it themselves" requirement.
  map.on("click", (e) => {
    if (relocateCustomerId) {
      placeLocationPin(e.latlng, { source: "dragged_pin", onConfirm: openRelocateConfirmDetails });
      return;
    }
    if (!addMode) return;
    placeLocationPin(e.latlng, { source: "dragged_pin", onConfirm: handoffToCustomerForm });
  });

  // Final "save this?" step for an existing customer once a location has
  // already been confirmed via the shared picker above -- kept separate
  // from openNewCustomerForm because relocating writes immediately (or
  // files an edit request) instead of opening the full customer-details
  // form again.
  function openRelocateConfirmDetails(latlng) {
    closeLocationPanel();
    placingMarker?.dragging?.disable();
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

    // Cancelling this step doesn't abandon the whole picker -- it goes back
    // to the draggable-pin confirm panel so the rep can still adjust or
    // re-search before deciding again, rather than dead-ending with a
    // frozen pin and no visible way to continue.
    function backToPicker() {
      overlay.remove();
      placingMarker?.dragging?.enable();
      showLocationPanel(latlng, { source: "existing_customer", onConfirm: openRelocateConfirmDetails });
    }
    overlay.querySelector("#cancel-relocate-confirm").addEventListener("click", backToPicker);
    overlay.addEventListener("click", (e) => e.target === overlay && backToPicker());

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
        overlay.remove();
        navigate(`#/customers/${relocateCustomerId}`);
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.hidden = false;
        btn.disabled = false;
      }
    });
  }

  if (addMode) startAddCustomerFlow();

  function openNewCustomerForm(latlng) {
    const overlay = document.createElement("div");
    overlay.className = "sheet-overlay sheet-overlay-light";
    overlay.innerHTML = `
      <div class="sheet">
        <h2>${t("new_customer")}</h2>
        <form id="new-customer-form">
          ${tierSelectorHtml("potential")}
          ${categorySelectorHtml(CATEGORY_LIST[0].value)}
          <label>${t("name")}<input name="name" required /></label>
          <label>${t("phone")}<input name="phone" type="tel" value="+374 " /></label>
          <label>${t("address")}<input name="address" id="new-customer-address" /></label>
          <div class="form-row-2">
            <label>${t("region")}
              <select name="region" id="new-customer-region">
                <option value="">${t("select_placeholder")}</option>
                ${REGION_LIST.map((r) => `<option value="${escapeHtml(r)}">${escapeHtml(r)}</option>`).join("")}
              </select>
            </label>
            <label id="new-customer-subregion-wrap">${t("subregion")}<input name="subregion" id="new-customer-subregion" /></label>
          </div>
          <label>${t("sales_channel")}
            <select name="sales_channel">
              <option value="">${t("select_placeholder")}</option>
              ${SALES_CHANNELS.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("")}
            </select>
          </label>
          <div class="form-row-2">
            <label class="erp-suggest-wrap">${t("erp_customer_id")}
              <input type="text" name="erp_customer_id" id="new-customer-erp-input" autocomplete="off" />
              <div class="erp-suggest-list" id="new-customer-erp-suggest" hidden></div>
            </label>
            <label>${t("tin")}<input name="tin" /></label>
          </div>
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
    activateDialog(overlay);
    activateTierSelector(overlay);
    activateCategorySelector(overlay);

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
    // The dropped pin itself doubles as a cancel target -- tapping it (its
    // X glyph makes that discoverable) closes the sheet the same as the
    // Cancel button.
    placingMarker?.on("click", close);

    // Auto-fill address/region/subregion from the dropped pin's coordinates
    // -- the rep can still correct any of these by hand, this just saves
    // typing/picking from scratch. Region/subregion are best-effort matches
    // against the fixed lists (see matchRegion/matchSubregion in util.js),
    // never silently trusted as exact.
    const addressInput = overlay.querySelector("#new-customer-address");
    const regionSelect = overlay.querySelector("#new-customer-region");
    const subregionWrap = overlay.querySelector("#new-customer-subregion-wrap");

    function renderSubregionField(region, guess) {
      if (region === "Yerevan") {
        subregionWrap.innerHTML = `${t("subregion")}
          <select name="subregion" id="new-customer-subregion">
            <option value="">${t("select_placeholder")}</option>
            ${YEREVAN_DISTRICTS.map(
              (d) => `<option value="${escapeHtml(d)}" ${d === guess ? "selected" : ""}>${escapeHtml(d)}</option>`
            ).join("")}
          </select>`;
      } else {
        subregionWrap.innerHTML = `${t("subregion")}<input name="subregion" id="new-customer-subregion" value="${escapeHtml(guess || "")}" />`;
      }
    }
    regionSelect.addEventListener("change", () => renderSubregionField(regionSelect.value, ""));

    api
      .reverseGeocode(latlng.lat, latlng.lng)
      .then((result) => {
        if (result?.address && !addressInput.value) addressInput.value = result.address;
        const guessedRegion = matchRegion(result?.region);
        if (guessedRegion) {
          regionSelect.value = guessedRegion;
          renderSubregionField(guessedRegion, matchSubregion(result?.subregion, guessedRegion));
        }
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
        const phoneDigits = normalizePhone(data.get("phone"));
        await api.createCustomer({
          name: data.get("name"),
          category: data.get("category") || null,
          phone: phoneDigits.length > 3 ? `+${phoneDigits}` : null,
          address: data.get("address") || null,
          notes: data.get("notes") || null,
          tin: data.get("tin") || null,
          erp_customer_id: data.get("erp_customer_id") || null,
          customer_tier: data.get("customer_tier") || null,
          region: data.get("region") || null,
          subregion: data.get("subregion") || null,
          sales_channel: data.get("sales_channel") || null,
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
    clearTimeout(teamEmptyHintTimer);
    clearTimeout(tileHealthTimer);
    mapEl.removeEventListener("touchend", onMapTouchEnd);
    document.removeEventListener("visibilitychange", refreshTileStyle);
    appMain.classList.remove("app-main-locked");
    document.body.classList.remove("map-active");
    map.remove();
  };
}
