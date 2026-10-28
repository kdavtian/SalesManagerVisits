import { t } from "./i18n.js";
import { SEARCH_ICONS, installClearButton, installInlineClearButton, ensureSelectedCheck, syncDropdownButton } from "./searchBar.js";

// What is left here is the Map's search row (and the map's address search box): step 7b folds it into the map together
// with the other map enhancers. Every other screen now builds its own search bar with searchBar.js
// (docs/architecture-roadmap.md, step 7a).

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

function enhanceMap() {
  const input = document.querySelector("#map-customer-search");
  const row = input?.closest(".map-search-row");
  const view = input?.closest(".map-view");
  if (!input || !row || !view || row.dataset.unifiedMapSearch) return;
  row.dataset.unifiedMapSearch = "true";
  row.classList.add("activity-search-combined", "map-search-combined");

  const actions = document.createElement("div");
  actions.className = "activity-search-actions map-search-actions";
  row.appendChild(actions);

  const managerWrap = view.querySelector("#map-manager-filter-wrap");
  const managerBtn = view.querySelector("#map-manager-filter-btn");
  const managerMenu = view.querySelector("#map-manager-filter-menu");
  if (managerWrap && managerBtn && managerMenu) {
    actions.appendChild(managerWrap);
    managerWrap.classList.add("activity-icon-dropdown", "map-manager-icon-wrap");
    managerBtn.classList.remove("filter-dropdown-btn");
    managerBtn.classList.add("activity-search-filter-btn");
    const label = managerBtn.querySelector("#map-manager-filter-label");
    label?.classList.add("visually-hidden");
    managerBtn.querySelector("svg")?.remove();
    managerBtn.insertAdjacentHTML("afterbegin", SEARCH_ICONS.manager);
    managerMenu.classList.remove("filter-dropdown-menu");
    managerMenu.classList.add("activity-search-menu", "map-search-menu");

    const syncManager = () => {
      ensureSelectedCheck(managerMenu, "[data-value]");
      const selected = managerMenu.querySelector('[data-value][aria-checked="true"]')?.dataset.value || "";
      syncDropdownButton(managerBtn, managerMenu, Boolean(selected));
    };
    managerBtn.addEventListener("click", () => requestAnimationFrame(syncManager));
    managerMenu.addEventListener("click", () => requestAnimationFrame(syncManager));
    new MutationObserver(syncManager).observe(managerMenu, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-checked", "hidden"] });
    syncManager();
  }

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
        const iconHost = chip.querySelector(".map-filter-chip-icon");
        if (iconHost) iconHost.innerHTML = mapFilterIcon(chip.dataset.filter || "");
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

function enhanceAll() {
  enhanceMap();
  installInlineClearButton(document.querySelector("#address-search-input"));
}

function boot() {
  enhanceAll();
  // document.body, not #app: the map's address search mounts its sheet directly on body.
  let scheduled = false;
  const observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      enhanceAll();
    });
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
