import { FILTER_ICONS } from "./filterIcons.js";

const MANAGER_ICON = FILTER_ICONS.manager;
const CHANNEL_ICON = FILTER_ICONS.channel;
const CATEGORY_ICON = FILTER_ICONS.category;
const BRANDS_ICON = FILTER_ICONS.brands;

let scheduled = false;
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
    button.classList.remove("filter-icon-btn", "filter-icon-btn-active");
    button.classList.add("activity-search-filter-btn", "map-dimension-filter-btn");
    button.classList.toggle("activity-search-filter-btn-active", active);
    button.innerHTML = `${iconFor(key)}${active ? '<span class="activity-search-filter-dot" aria-hidden="true"></span>' : ""}`;
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

    // Competitors are intentionally hidden on ordinary Map entry. Choosing
    // COMPETITORS from the channel menu is an explicit request to see them,
    // so reveal them for that selection. When leaving that channel, only
    // undo visibility if this helper was the thing that enabled it.
    if (button.dataset.mapFilterBtn === "channel") {
      sheet.addEventListener("click", (event) => {
        const option = event.target.closest("[data-value]");
        if (!option) return;
        const mapView = document.querySelector(".map-view");
        if (!mapView) return;
        if (option.dataset.value === "COMPETITORS") {
          if (!mapView.classList.contains("kad-show-competitors")) {
            mapView.dataset.competitorsForcedByChannel = "true";
            mapView.classList.add("kad-show-competitors");
          }
        } else if (mapView.dataset.competitorsForcedByChannel === "true") {
          delete mapView.dataset.competitorsForcedByChannel;
          mapView.classList.remove("kad-show-competitors");
        }
      });
    }
  });
}

function enhanceMapDimensionFilters() {
  const input = document.querySelector("#map-customer-search");
  const searchRow = input?.closest(".map-search-row.activity-search-combined");
  const actions = searchRow?.querySelector(":scope > .activity-search-actions");
  const filterRow = document.querySelector("#map-icon-filter-row");
  if (!input || !searchRow || !actions || !filterRow) return;

  const managerBtn = actions.querySelector("#map-manager-filter-btn");
  if (managerBtn && !managerBtn.dataset.kadManagerIcon) {
    const label = managerBtn.textContent?.trim();
    if (label) {
      managerBtn.setAttribute("aria-label", label);
      managerBtn.setAttribute("title", label);
    }
    managerBtn.dataset.kadManagerIcon = "true";
    const active = managerBtn.classList.contains("activity-search-filter-btn-active");
    managerBtn.innerHTML = `${MANAGER_ICON}${active ? '<span class="activity-search-filter-dot" aria-hidden="true"></span>' : ""}`;
  }

  filterRow.classList.add("map-dimension-filter-inline");
  const primaryFilter = actions.querySelector(".map-primary-filter-wrap");
  const managerWrap = actions.querySelector("#map-manager-filter-wrap");

  if (filterRow.parentElement !== actions) {
    if (primaryFilter) actions.insertBefore(filterRow, primaryFilter);
    else if (managerWrap) managerWrap.insertAdjacentElement("afterend", filterRow);
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

function scheduleEnhance() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    enhanceMapDimensionFilters();
  });
}

function boot() {
  scheduleEnhance();
  const app = document.querySelector("#app");
  if (!app) return;
  const observer = new MutationObserver(scheduleEnhance);
  observer.observe(app, { childList: true, subtree: true });
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
else boot();
