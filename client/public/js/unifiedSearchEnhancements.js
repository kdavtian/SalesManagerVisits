import { icons } from "./icons.js";
import { getLang, t } from "./i18n.js";

// One visual language for every search/filter surface. These are the exact
// 24px / 1.9px-stroke forms used by Activity, so moving between tabs does
// not feel like moving between different apps.
const SEARCH_ICONS = {
  manager: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="3"/><circle cx="17.5" cy="8.6" r="2.35"/><path d="M3.5 20v-1.2A5.5 5.5 0 0 1 9 13.3h.1a5.5 5.5 0 0 1 5.5 5.5V20"/><path d="M15.1 13.8c.7-.35 1.5-.55 2.35-.55A4.55 4.55 0 0 1 22 17.8V20"/></svg>`,
  status: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.75"/><path d="m7.9 12.1 2.6 2.7 5.8-6"/></svg>`,
  outcome: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="3.75" width="14" height="16.5" rx="2.5"/><path d="M9 3.75v-.5A1.25 1.25 0 0 1 10.25 2h3.5A1.25 1.25 0 0 1 15 3.25v.5"/><path d="m8.5 11.7 1.8 1.8 4.7-5"/><path d="M8.5 17h7"/></svg>`,
  sort: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 4v16M4 7l3-3 3 3M17 20V4M14 17l3 3 3-3"/></svg>`,
  clear: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17"/></svg>`,
  region: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 10c0 4.8-7 10-7 10S5 14.8 5 10a7 7 0 1 1 14 0Z"/><circle cx="12" cy="10" r="2.25"/></svg>`,
  subregion: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.75"/><path d="m15.3 8.7-2 4.6-4.6 2 2-4.6z"/></svg>`,
  channel: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="12" cy="18" r="2"/><path d="M8 6h8M12 8v8M8 6c2.6 0 4 1.4 4 4M16 6c-2.6 0-4 1.4-4 4"/></svg>`,
  orderAdd: `<svg viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="4" width="15" height="19" rx="3"/><path d="M9 9h7M9 13h5M9 17h4"/><circle cx="20.5" cy="19.5" r="5" fill="var(--accent)" stroke="var(--bg-card)" stroke-width="2"/><path d="M20.5 17v5M18 19.5h5" stroke="white" stroke-width="1.8"/></svg>`,
};

function clearLabel() {
  return getLang() === "hy" ? "Մաքրել որոնումը" : "Clear search";
}

function installClearButton(input, container, actions) {
  if (!input || !container || container.querySelector(`[data-search-clear-for="${input.id}"]`)) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "unified-search-clear";
  button.dataset.searchClearFor = input.id;
  button.setAttribute("aria-label", clearLabel());
  button.setAttribute("title", clearLabel());
  button.innerHTML = SEARCH_ICONS.clear;
  container.insertBefore(button, actions || null);

  const sync = () => {
    button.hidden = input.value.length === 0;
  };
  input.addEventListener("input", sync);
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!input.value) return;
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus({ preventScroll: true });
    sync();
  });
  sync();
}

function ensureSelectedCheck(menu, selector) {
  if (!menu) return;
  menu.querySelectorAll(selector).forEach((option) => {
    const selected = option.getAttribute("aria-checked") === "true" || option.classList.contains("chip-active");
    option.classList.toggle("filter-dropdown-selected", selected);
    let check = option.querySelector(".activity-menu-check");
    if (selected && !check) {
      check = document.createElement("span");
      check.className = "activity-menu-check";
      check.setAttribute("aria-hidden", "true");
      check.textContent = "✓";
      option.appendChild(check);
    } else if (!selected && check) {
      check.remove();
    }
  });
}

function syncDropdownButton(button, menu, applied) {
  if (!button) return;
  const open = button.getAttribute("aria-expanded") === "true" || !menu?.hidden;
  button.classList.toggle("activity-search-filter-btn-open", open);
  button.classList.toggle("activity-search-filter-btn-active", Boolean(applied));
  let dot = button.querySelector(".activity-search-filter-dot");
  if (applied && !dot) {
    dot = document.createElement("span");
    dot.className = "activity-search-filter-dot";
    dot.setAttribute("aria-hidden", "true");
    button.appendChild(dot);
  } else if (!applied && dot) {
    dot.remove();
  }
}

function enhanceActivity() {
  const input = document.querySelector("#activity-search");
  const container = input?.closest(".activity-search-combined");
  const actions = container?.querySelector(".activity-search-actions");
  if (!input || !container || !actions) return;
  installClearButton(input, container, actions);
}

function enhanceOrders() {
  const input = document.querySelector("#order-search");
  const container = input?.closest(".activity-search-combined");
  const actions = container?.querySelector(".activity-search-actions");
  if (input && container && actions) installClearButton(input, container, actions);

  const view = input?.closest(".detail-view");
  const header = view?.querySelector(".list-header-row");
  if (view && header) {
    view.classList.add("orders-view-unified");
    // Reuse the exact header token used by Activity/Customers instead of a
    // separate Orders-only title scale and vertical rhythm.
    header.classList.add("list-header", "unified-list-header");
  }

  const filterBtn = document.querySelector("#order-filter-btn");
  if (filterBtn && !filterBtn.dataset.unifiedIcon) {
    filterBtn.dataset.unifiedIcon = "true";
    filterBtn.innerHTML = SEARCH_ICONS.channel;
  }

  const add = document.querySelector("#orders-new-btn");
  if (add && !add.dataset.unifiedOrderAdd) {
    add.dataset.unifiedOrderAdd = "true";
    add.classList.add("orders-new-action");
    add.innerHTML = SEARCH_ICONS.orderAdd;
  }
}

function customerIconFor(key) {
  if (key === "assignment") return SEARCH_ICONS.manager;
  if (key === "region") return SEARCH_ICONS.region;
  if (key === "subregion") return SEARCH_ICONS.subregion;
  if (key === "channel") return SEARCH_ICONS.channel;
  return SEARCH_ICONS.status;
}

function syncCustomerFilterButtons(filterRow) {
  filterRow?.querySelectorAll("[data-filter-btn]").forEach((button) => {
    const active = button.classList.contains("filter-icon-btn-active") || button.classList.contains("activity-search-filter-btn-active");
    button.classList.remove("filter-icon-btn", "filter-icon-btn-active");
    button.classList.add("activity-search-filter-btn", "unified-customer-filter-btn");
    if (active) button.classList.add("activity-search-filter-btn-active");
    button.innerHTML = `${customerIconFor(button.dataset.filterBtn)}${active ? '<span class="activity-search-filter-dot" aria-hidden="true"></span>' : ""}`;
  });
}

function enhanceCustomers() {
  const input = document.querySelector("#customer-search");
  const toolbar = input?.closest(".list-toolbar");
  const view = input?.closest(".list-view");
  if (!input || !toolbar || !view) return;

  const add = view.querySelector("#add-customer-btn");
  if (add && !add.dataset.mapAddIcon) {
    add.dataset.mapAddIcon = "true";
    add.classList.add("customer-map-add-action");
    // Exact same map-pin-plus glyph as the Map FAB: one visual meaning for
    // "new customer" everywhere.
    add.innerHTML = icons.mapPinPlus;
  }

  let actions = toolbar.querySelector(":scope > .activity-search-actions");
  if (!toolbar.dataset.unifiedCustomersSearch) {
    toolbar.dataset.unifiedCustomersSearch = "true";
    toolbar.classList.add("activity-search-combined", "customers-search-combined");
    actions = document.createElement("div");
    actions.className = "activity-search-actions customers-search-actions";
    toolbar.appendChild(actions);

    const sortBtn = view.querySelector("#sort-btn");
    const sortMenu = view.querySelector("#sort-menu");
    if (sortBtn && sortMenu) {
      const wrap = document.createElement("div");
      wrap.className = "activity-icon-dropdown customers-sort-wrap";
      actions.appendChild(wrap);
      wrap.append(sortBtn, sortMenu);
      sortBtn.classList.remove("icon-btn");
      sortBtn.classList.add("activity-search-filter-btn");
      sortBtn.innerHTML = SEARCH_ICONS.sort;
      sortMenu.classList.remove("dropdown-menu");
      sortMenu.classList.add("activity-search-menu", "customers-search-menu");

      const syncSort = () => {
        const selected = sortMenu.querySelector('[data-sort][aria-checked="true"]')?.dataset.sort || "name";
        ensureSelectedCheck(sortMenu, "[data-sort]");
        syncDropdownButton(sortBtn, sortMenu, selected !== "name");
      };
      sortBtn.addEventListener("click", () => requestAnimationFrame(syncSort));
      sortMenu.addEventListener("click", () => requestAnimationFrame(syncSort));
      new MutationObserver(syncSort).observe(sortMenu, { subtree: true, attributes: true, attributeFilter: ["aria-checked", "hidden"] });
      syncSort();
    }

    const filterRow = view.querySelector("#customer-filter-row");
    if (filterRow) {
      filterRow.classList.add("customer-filter-inline");
      actions.insertBefore(filterRow, actions.querySelector(".customers-sort-wrap"));
      const observer = new MutationObserver(() => syncCustomerFilterButtons(filterRow));
      observer.observe(filterRow, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
      syncCustomerFilterButtons(filterRow);
    }
  }

  actions = toolbar.querySelector(":scope > .activity-search-actions");
  installClearButton(input, toolbar, actions);
  syncCustomerFilterButtons(view.querySelector("#customer-filter-row"));
}

function mapFilterIcon(value) {
  if (value === "overdue") return icons.mapWarning;
  if (value === "visited") return SEARCH_ICONS.status;
  if (value === "planned") return SEARCH_ICONS.outcome;
  if (value === "nearby") return SEARCH_ICONS.region;
  if (value === "brands") return icons.tag;
  return icons.filter;
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

  // Fold the long horizontal Map chip strip into one Activity-style filter
  // button. Existing chip nodes/listeners are moved, not recreated, so all
  // current Map business logic (nearby, plan, brands, status) remains the
  // single source of truth.
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
    new MutationObserver(syncMapFilter).observe(filterRow, { subtree: true, attributes: true, attributeFilter: ["class", "aria-pressed"] });
    syncMapFilter();
  }

  installClearButton(input, row, actions);
}

function enhanceAll() {
  enhanceActivity();
  enhanceOrders();
  enhanceCustomers();
  enhanceMap();
}

function boot() {
  enhanceAll();
  const app = document.querySelector("#app");
  if (!app) return;
  let scheduled = false;
  const observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      enhanceAll();
    });
  });
  observer.observe(app, { childList: true, subtree: true });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
