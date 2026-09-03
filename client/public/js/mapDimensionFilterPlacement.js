const CHANNEL_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="12" cy="18" r="2"/><path d="M8 6h8M12 8v8M8 6c2.6 0 4 1.4 4 4M16 6c-2.6 0-4 1.4-4 4"/></svg>`;
const CATEGORY_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 10h16v10H4z"/><path d="M3 10l2-5h14l2 5"/><path d="M8 10v10M16 10v10"/><path d="M9 14h6"/></svg>`;

let scheduled = false;
let rowObserver = null;
let observedRow = null;

function syncDimensionButtons(row) {
  row?.querySelectorAll("[data-map-filter-btn]").forEach((button) => {
    const key = button.dataset.mapFilterBtn;
    const active = button.classList.contains("filter-icon-btn-active") || button.classList.contains("activity-search-filter-btn-active");
    button.classList.remove("filter-icon-btn", "filter-icon-btn-active");
    button.classList.add("activity-search-filter-btn", "map-dimension-filter-btn");
    button.classList.toggle("activity-search-filter-btn-active", active);
    const icon = key === "channel" ? CHANNEL_ICON : CATEGORY_ICON;
    button.innerHTML = `${icon}${active ? '<span class="activity-search-filter-dot" aria-hidden="true"></span>' : ""}`;
  });
}

function enhanceMapDimensionFilters() {
  const input = document.querySelector("#map-customer-search");
  const searchRow = input?.closest(".map-search-row.activity-search-combined");
  const actions = searchRow?.querySelector(":scope > .activity-search-actions");
  const filterRow = document.querySelector("#map-icon-filter-row");
  if (!input || !searchRow || !actions || !filterRow) return;

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

  if (observedRow !== filterRow) {
    rowObserver?.disconnect();
    observedRow = filterRow;
    rowObserver = new MutationObserver(() => requestAnimationFrame(() => syncDimensionButtons(filterRow)));
    // Map's own renderIconFilterRow replaces only this row's direct children.
    // Watching childList only avoids the feedback-loop class/markup problem
    // that caused earlier Map regressions.
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
