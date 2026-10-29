// The Map's search bar: the status filter and the icon filters (who / category / brands) inside the search field, the clear "x",
// the compact popover of an icon filter's sheet, and the selected-pin halo. views/map.js calls these once its markup is wired
// (docs/architecture-roadmap.md step 7b: they used to be added by three page-wide "enhancer" observers).
import { t } from "../../i18n.js";
import { SEARCH_ICONS, ensureSelectedCheck, installClearButton, syncDropdownButton } from "../../searchBar.js";
import { FILTER_ICONS } from "../../filterIcons.js";

function mapFilterIcon(value) {
  if (value === "overdue") return SEARCH_ICONS.overdue;
  if (value === "visited") return SEARCH_ICONS.status;
  if (value === "visited-today") return SEARCH_ICONS.status;
  if (value === "visited-7days") return SEARCH_ICONS.recent;
  if (value === "planned") return SEARCH_ICONS.planned;
  if (value === "nearby") return SEARCH_ICONS.nearby;
  if (value === "brands") return SEARCH_ICONS.brands;
  return SEARCH_ICONS.filters;
}

export function enhanceMapSearchRow(root = document) {
  const input = root.querySelector("#map-customer-search");
  const row = input?.closest(".map-search-row");
  const view = input?.closest(".map-view");
  if (!input || !row || !view || row.dataset.unifiedMapSearch) return;
  row.dataset.unifiedMapSearch = "true";
  row.classList.add("activity-search-combined", "map-search-combined");

  const actions = document.createElement("div");
  actions.className = "activity-search-actions map-search-actions";
  row.appendChild(actions);

  const filterRow = [...view.querySelectorAll(".map-filter-row")].find((el) => el.id !== "brand-picker-row");
  if (filterRow) {
    const wrap = document.createElement("div");
    wrap.className = "activity-icon-dropdown map-primary-filter-wrap";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "activity-search-filter-btn";
    button.setAttribute("aria-haspopup", "menu");
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-label", t("filter"));
    button.setAttribute("title", t("filter"));
    button.innerHTML = SEARCH_ICONS.status;
    actions.appendChild(wrap);
    wrap.append(button, filterRow);
    filterRow.classList.add("activity-search-menu", "map-search-filter-menu");
    filterRow.hidden = true;

    const syncMapFilter = () => {
      const selected = filterRow.querySelector(".map-filter-chip.chip-active");
      const value = selected?.dataset.filter || "";
      filterRow.querySelectorAll(".map-filter-chip").forEach((chip) => {
        chip.setAttribute("role", "menuitemradio");
        chip.setAttribute("aria-checked", String(chip === selected));
        chip.classList.add("unified-map-menu-option");
        // only the status chips (data-filter): the Competitors toggle keeps its own icon (it used to get the generic filter icon
        // after the first filter was picked)
        const iconHost = chip.querySelector(".map-filter-chip-icon");
        if (iconHost && chip.dataset.filter !== undefined) iconHost.innerHTML = mapFilterIcon(chip.dataset.filter);
      });
      ensureSelectedCheck(filterRow, ".map-filter-chip");
      syncDropdownButton(button, filterRow, Boolean(value));
    };

    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const open = filterRow.hidden;
      filterRow.hidden = !open;
      button.setAttribute("aria-expanded", String(open));
      syncMapFilter();
      if (open) filterRow.querySelector(".chip-active")?.focus();
    });
    filterRow.addEventListener("click", (event) => {
      if (!event.target.closest(".map-filter-chip")) return;
      filterRow.hidden = true;
      button.setAttribute("aria-expanded", "false");
      requestAnimationFrame(syncMapFilter);
    });
    view.addEventListener("click", (event) => {
      if (!filterRow.hidden && !wrap.contains(event.target)) {
        filterRow.hidden = true;
        button.setAttribute("aria-expanded", "false");
        syncMapFilter();
      }
    });
    // Existing Map logic writes aria-pressed when the active filter changes.
    // Watch only that source-of-truth attribute so our own styling/classes do
    // not recursively retrigger this observer.
    new MutationObserver(syncMapFilter).observe(filterRow, { subtree: true, attributes: true, attributeFilter: ["aria-pressed"] });
    syncMapFilter();
  }

  installClearButton(input, row, actions);
}

const MANAGER_ICON = FILTER_ICONS.manager;

const CHANNEL_ICON = FILTER_ICONS.channel;

const CATEGORY_ICON = FILTER_ICONS.category;

const BRANDS_ICON = FILTER_ICONS.brands;

let rowObserver = null;

let observedRow = null;

function iconFor(key) {
  if (key === "channel") return CHANNEL_ICON;
  if (key === "category") return CATEGORY_ICON;
  if (key === "brandchips") return BRANDS_ICON;
  return MANAGER_ICON;
}

function syncDimensionButtons(row) {
  row?.querySelectorAll("[data-map-filter-btn]").forEach((button) => {
    const key = button.dataset.mapFilterBtn;
    const active = button.classList.contains("filter-icon-btn-active") || button.classList.contains("activity-search-filter-btn-active");
    // Skip when the button already shows this state: a no-op class/innerHTML write still queues a mutation record, which
    // wakes the row's own observer (below) again.
    const sig = `${key}|${active}`;
    if (button._dimSig === sig) return;
    for (const n of ["filter-icon-btn", "filter-icon-btn-active"]) if (button.classList.contains(n)) button.classList.remove(n);
    for (const n of ["activity-search-filter-btn", "map-dimension-filter-btn"]) if (!button.classList.contains(n)) button.classList.add(n);
    if (button.classList.contains("activity-search-filter-btn-active") !== active) button.classList.toggle("activity-search-filter-btn-active", active);
    button.innerHTML = `${iconFor(key)}${active ? '<span class="activity-search-filter-dot" aria-hidden="true"></span>' : ""}`;
    button._dimSig = sig;
  });
}

function compactNativeFilterSheet(button) {
  requestAnimationFrame(() => {
    const overlays = [...document.querySelectorAll("body > .sheet-overlay")];
    const overlay = overlays.reverse().find((el) => el.querySelector(".filter-sheet"));
    if (!overlay || overlay.dataset.mapCompactPopover === "true") return;
    const sheet = overlay.querySelector(".filter-sheet");
    const rect = button.getBoundingClientRect();
    const width = Math.min(260, window.innerWidth - 24);
    const left = Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12));
    const top = Math.min(rect.bottom + 8, window.innerHeight - 300);
    overlay.dataset.mapCompactPopover = "true";
    // The tapped button reads as "open" while its popover is showing, like
    // the manager and status buttons already do.
    button.classList.add("activity-search-filter-btn-open");
    new MutationObserver((_, observer) => {
      if (overlay.isConnected) return;
      button.classList.remove("activity-search-filter-btn-open");
      observer.disconnect();
    }).observe(document.body, { childList: true });
    overlay.classList.add("map-dimension-popover-overlay");
    sheet.classList.add("map-dimension-popover");
    sheet.style.setProperty("--map-popover-left", `${left}px`);
    sheet.style.setProperty("--map-popover-top", `${Math.max(12, top)}px`);
  });
}

export function enhanceMapDimensionFilters(root = document) {
  const input = root.querySelector("#map-customer-search");
  const searchRow = input?.closest(".map-search-row.activity-search-combined");
  const actions = searchRow?.querySelector(":scope > .activity-search-actions");
  const filterRow = root.querySelector("#map-icon-filter-row");
  if (!input || !searchRow || !actions || !filterRow) return;

  if (!filterRow.classList.contains("map-dimension-filter-inline")) filterRow.classList.add("map-dimension-filter-inline");
  const primaryFilter = actions.querySelector(".map-primary-filter-wrap");

  if (filterRow.parentElement !== actions) {
    if (primaryFilter) actions.insertBefore(filterRow, primaryFilter);
    else actions.appendChild(filterRow);
  } else if (primaryFilter && filterRow.nextElementSibling !== primaryFilter) {
    actions.insertBefore(filterRow, primaryFilter);
  }

  syncDimensionButtons(filterRow);

  filterRow.querySelectorAll("[data-map-filter-btn]").forEach((button) => {
    if (button.dataset.compactMenuBound) return;
    button.dataset.compactMenuBound = "true";
    button.addEventListener("click", () => compactNativeFilterSheet(button));
  });

  if (observedRow !== filterRow) {
    rowObserver?.disconnect();
    observedRow = filterRow;
    rowObserver = new MutationObserver(() => requestAnimationFrame(() => {
      syncDimensionButtons(filterRow);
      filterRow.querySelectorAll("[data-map-filter-btn]").forEach((button) => {
        if (button.dataset.compactMenuBound) return;
        button.dataset.compactMenuBound = "true";
        button.addEventListener("click", () => compactNativeFilterSheet(button));
      });
    }));
    rowObserver.observe(filterRow, { childList: true });
  }
}

// The selected customer's pin gets a halo; a tap on the bare map, or its popup closing, takes it away (so the map never shows a
// pin as chosen when nothing is open).
export function wireMarkerSelection(map, mapEl) {
  const clear = (except = null) =>
    mapEl.querySelectorAll(".leaflet-marker-icon.kad-marker-selected").forEach((el) => {
      if (el !== except) el.classList.remove("kad-marker-selected");
    });
  mapEl.addEventListener("click", (event) => {
    const marker = event.target.closest?.(".leaflet-marker-icon");
    if (marker && marker.querySelector(".pin:not(.pin-stop):not(.pin-new)")) {
      clear(marker);
      marker.classList.add("kad-marker-selected");
      return;
    }
    if (!event.target.closest?.(".leaflet-popup, .leaflet-control")) clear();
  });
  // Counted from Leaflet's own events, not looked up on the page: a closing popup fades out and stays in the page for 200 ms,
  // and switching pins closes one popup and opens the next in the same tap.
  let openPopups = 0;
  map.on("popupopen", () => (openPopups += 1));
  map.on("popupclose", () => {
    openPopups = Math.max(0, openPopups - 1);
    requestAnimationFrame(() => {
      if (openPopups === 0) clear();
    });
  });
}

function competitorIcon() {
  return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 10h16v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19z"/><path d="m5 10 1.2-5h11.6L19 10M8 20.5v-6h4v6M4.5 10c.8 1.4 2.6 1.4 3.5 0 .8 1.4 2.7 1.4 3.5 0 .8 1.4 2.7 1.4 3.5 0 .8 1.4 2.7 1.4 3.5 0"/></svg>`;
}

function labels() {
  const lang = document.documentElement.lang || "en";
  if (lang.startsWith("hy")) return { label: "Մրցակիցներ", show: "Ցույց տալ մրցակիցներին", hide: "Թաքցնել մրցակիցներին" };
  if (lang.startsWith("ru")) return { label: "Конкуренты", show: "Показать конкурентов", hide: "Скрыть конкурентов" };
  return { label: "Competitors", show: "Show competitors", hide: "Hide competitors" };
}

// The "Competitors" chip in the status filter: competitors are hidden on every Map entry, the chip shows them (was mapSafeUi.js,
// which mounted it from outside with retries after each route change; step 7b).
export function attachCompetitorToggle(root = document) {
  const mapView = root.querySelector(".map-view");
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

  const syncButton = () => {
    const visible = mapView.classList.contains("kad-show-competitors");
    button.classList.toggle("chip-active", visible);
    button.setAttribute("aria-pressed", String(visible));
    button.setAttribute("aria-label", visible ? copy.hide : copy.show);
    button.title = visible ? copy.hide : copy.show;
  };

  button.addEventListener("click", () => {
    mapView.classList.toggle("kad-show-competitors");
    syncButton();
  });

  // Existing Map filters reset .chip-active on every filter chip. Re-sync
  // this independent intelligence toggle immediately after those handlers
  // run, without observing or scanning the DOM.
  mapView.addEventListener("click", (event) => {
    if (event.target.closest(".map-filter-chip") || event.target.closest("#nearby-panel-close")) {
      requestAnimationFrame(syncButton);
    }
  });

  filterRow.appendChild(button);
  return true;
}
