const MANAGER_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="3"/><circle cx="17" cy="9" r="2.2"/><path d="M3.5 20v-1.2A5.5 5.5 0 0 1 9 13.3h.1a5.5 5.5 0 0 1 5.5 5.5V20"/><path d="M15.3 14c.55-.25 1.15-.4 1.8-.4A4.4 4.4 0 0 1 21.5 18v2"/></svg>`;
const CHANNEL_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21V5"/><path d="M8 5h8"/><path d="M7 9H3l2.4-2.4"/><path d="M3 9l2.4 2.4"/><path d="M17 14h4l-2.4-2.4"/><path d="M21 14l-2.4 2.4"/></svg>`;
const CATEGORY_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="4" width="6" height="6" rx="1.4"/><rect x="14" y="4" width="6" height="6" rx="1.4"/><rect x="4" y="14" width="6" height="6" rx="1.4"/><rect x="14" y="14" width="6" height="6" rx="1.4"/></svg>`;

let scheduled = false;
let rowObserver = null;
let observedRow = null;

function iconFor(key) {
  if (key === "channel") return CHANNEL_ICON;
  if (key === "category") return CATEGORY_ICON;
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
