// Orders' search bar: the sales-channel filter inside the field, the region filter (asks /order-meta/list), the status icons
// and counts on the status tabs, the clear "x" (docs/architecture-roadmap.md step 7a: these were three page-wide "enhancer"
// observers; views/orders.js now calls them right after it renders, and after every repaint for the counts).
import { api } from "../../api.js";
import { getLang } from "../../i18n.js";
import { SEARCH_ICONS, addClasses, installClearButton } from "../../searchBar.js";
import { FILTER_ICONS } from "../../filterIcons.js";
import { APP_VERSION } from "../../version.js";

export function enhanceOrders() {
  const input = document.querySelector("#order-search");
  const container = input?.closest(".activity-search-combined");
  const actions = container?.querySelector(".activity-search-actions");
  if (input && container && actions) installClearButton(input, container, actions);

  const view = input?.closest(".detail-view");
  const header = view?.querySelector(".list-header-row");
  if (view && header) {
    addClasses(view, "orders-view-unified");
    addClasses(header, "list-header", "unified-list-header");
  }

  // (the filter button's icon is the sales-channel one, set by enhanceOrdersToolbar: it filters by channel. Two enhancers used
  // to race here and the person icon won about half the time.)

  const add = document.querySelector("#orders-new-btn");
  if (add && !add.dataset.unifiedOrderAdd) {
    add.dataset.unifiedOrderAdd = "true";
    add.classList.add("orders-new-action");
    add.innerHTML = SEARCH_ICONS.orderAdd;
  }
}

const statusSvg = (content) =>
  `<svg class="order-status-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${content}</svg>`;

// Vector icons for the 5-stage order workflow (draft -> submitted ->
// confirmed -> packed_stock_out -> delivered -- see the matching
// STATUS_META/STATUS_FILTERS in views/orders.js), all drawn on the same 24px
// grid and stroke as the filter icon family (filterIcons.js). Each stage has
// its own silhouette that reads left-to-right as the order moves along:
// a page being written, a sent plane, a checked page, a box going out, a
// truck carrying the finished order. The row tiles and filter chips tint
// them per stage (see .order-tile-* in styles.css).
export const ORDER_STATUS_ICONS = {
  // The "All" filter tab -- a stack of layers.
  all: statusSvg(`<path d="m12 3-9 4.5 9 4.5 9-4.5z"/><path d="m3 12 9 4.5 9-4.5"/><path d="m3 16.5 9 4.5 9-4.5"/>`),
  draft: statusSvg(`<path d="M13.5 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h4"/><path d="M13.5 3 19 8.5V10"/><path d="M13.5 3v5.5H19"/><path d="M8.5 12.5h5M8.5 16.5h2.5"/><path d="m14.2 21 .7-3 4.7-4.7a1.5 1.5 0 0 1 2.1 2.1L17 20.1z"/>`),
  submitted: statusSvg(`<path d="M21.5 3 10.5 14"/><path d="m21.5 3-6.6 18-4.4-7-7-4.4z"/>`),
  confirmed: statusSvg(`<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="m8.7 14.4 2.2 2.2 4.4-4.6"/>`),
  packed_stock_out: statusSvg(`<path d="m3 8.2 6.5-3.2L16 8.2v7.6L9.5 19 3 15.8z"/><path d="m3 8.2 6.5 3.3L16 8.2M9.5 11.5V19"/><path d="M17.8 12.5h4M20 10.3l2.2 2.2-2.2 2.2"/>`),
  delivered: statusSvg(`<path d="M14 17.5V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10.5a1 1 0 0 0 1 1h1.5"/><path d="M14.5 17.5h-5"/><path d="M19 17.5h2a1 1 0 0 0 1-1v-3.4a1 1 0 0 0-.2-.6l-3-3.7a1 1 0 0 0-.8-.4H14"/><circle cx="17" cy="17.5" r="2"/><circle cx="7" cy="17.5" r="2"/><path d="m5.2 10 2 2 3.6-3.8"/>`),
};

const CHANNEL_ICON = FILTER_ICONS.channel;

// Row icons are now rendered inline by orders.js itself (importing
// ORDER_STATUS_ICONS above) rather than injected here after the fact --
// this only still decorates the status *filter tab bar*, which has no
// per-status data attribute of its own to key off of at render time.
export function decorateOrdersStatusUi() {
  const filterRow = document.querySelector("#order-status-filters");
  filterRow?.querySelectorAll("[data-status]").forEach((btn) => {
    // The "All" tab's data-status is "" (see STATUS_FILTERS in
    // views/orders.js) -- mapped to the "all" icon key here rather than
    // skipped, so every tab in the row gets one, not just the 5 with an
    // actual order status behind them.
    const status = btn.dataset.status || "all";
    if (!ORDER_STATUS_ICONS[status]) return;
    let icon = btn.querySelector(".order-filter-status-icon");
    if (!icon) {
      icon = document.createElement("span");
      icon.className = `order-filter-status-icon order-status-${status}`;
      btn.prepend(icon);
    }
    // innerHTML only when the icon is not there yet: rewriting it every pass queued a mutation that re-ran this forever.
    if (icon._status !== status) {
      icon.innerHTML = ORDER_STATUS_ICONS[status];
      icon._status = status;
    }
  });
}

export function enhanceOrdersToolbar() {
  const search = document.querySelector("#order-search");
  const filterBtn = document.querySelector("#order-filter-btn");
  const filterMenu = document.querySelector("#order-filter-menu");
  const toolbar = search?.closest(".list-toolbar");
  if (!search || !filterBtn || !filterMenu || !toolbar || toolbar.dataset.ordersSearchEnhanced === "true") return;
  toolbar.dataset.ordersSearchEnhanced = "true";
  toolbar.classList.add("activity-search-combined", "orders-search-combined");

  const actions = document.createElement("div");
  actions.className = "activity-search-actions orders-search-actions";
  const dropdown = document.createElement("div");
  dropdown.className = "activity-icon-dropdown";
  toolbar.insertBefore(actions, filterBtn);
  actions.appendChild(dropdown);
  dropdown.appendChild(filterBtn);
  dropdown.appendChild(filterMenu);

  filterBtn.classList.remove("icon-btn");
  filterBtn.classList.add("activity-search-filter-btn", "orders-channel-filter-btn");
  filterBtn.innerHTML = CHANNEL_ICON;

  const isHy = getLang() === "hy";
  const label = isHy ? "Զտել ըստ ուղղության" : "Filter by sales channel";
  filterBtn.setAttribute("aria-label", label);
  filterBtn.setAttribute("title", label);
  filterMenu.classList.remove("dropdown-menu");
  filterMenu.classList.add("activity-search-menu", "orders-search-menu");
  search.placeholder = isHy ? "Փնտրել պատվերներ…" : "Search orders…";
  search.setAttribute("aria-label", search.placeholder.replace("…", ""));

  let selectedChannel = "";
  function ensureDot(active) {
    let dot = filterBtn.querySelector(".activity-search-filter-dot");
    if (active && !dot) {
      dot = document.createElement("span");
      dot.className = "activity-search-filter-dot";
      dot.setAttribute("aria-hidden", "true");
      filterBtn.appendChild(dot);
    } else if (!active && dot) dot.remove();
  }

  function decorateMenu() {
    filterMenu.querySelectorAll("[data-channel]").forEach((btn) => {
      const selected = btn.getAttribute("aria-checked") === "true";
      btn.classList.toggle("filter-dropdown-selected", selected);
      let check = btn.querySelector(".activity-menu-check");
      if (selected && !check) {
        const text = document.createElement("span");
        while (btn.firstChild) text.appendChild(btn.firstChild);
        btn.appendChild(text);
        check = document.createElement("span");
        check.className = "activity-menu-check";
        check.setAttribute("aria-hidden", "true");
        check.textContent = "✓";
        btn.appendChild(check);
      } else if (!selected && check) check.remove();
      if (selected) selectedChannel = btn.dataset.channel || "";
    });
  }

  function syncState() {
    const open = filterBtn.getAttribute("aria-expanded") === "true";
    filterBtn.classList.toggle("activity-search-filter-btn-open", open);
    filterBtn.classList.toggle("activity-search-filter-btn-active", Boolean(selectedChannel));
    ensureDot(Boolean(selectedChannel));
    decorateMenu();
  }

  filterBtn.addEventListener("click", () => requestAnimationFrame(syncState));
  filterMenu.addEventListener("click", (event) => {
    const option = event.target.closest("[data-channel]");
    if (!option) return;
    selectedChannel = option.dataset.channel || "";
    requestAnimationFrame(syncState);
  });
  new MutationObserver(syncState).observe(filterBtn, { attributes: true, attributeFilter: ["aria-expanded"] });
  new MutationObserver(syncState).observe(filterMenu, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-checked", "hidden"] });
  syncState();
}

const REGION_ICON = FILTER_ICONS.region;

const COUNTED_STATUSES = ["submitted", "confirmed", "packed"];

let activeRegion = "";

let cachedSummary = null;

let cachedSummaryAt = 0;

let summaryPromise = null;

// The status counts on the chips ("Submitted 33") are other people's work too: a cached answer is good for this long,
// then the next look fetches again (it used to be kept for the whole session, so the numbers froze).
const SUMMARY_MAX_AGE_MS = 15000;

async function requestJson(path) {
  const response = await fetch(`/api${path}`, {
    credentials: "include",
    headers: { "X-App-Version": APP_VERSION },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error || `Request failed (${response.status})`);
  return body;
}

function regionLabel() {
  return getLang() === "hy" ? "Զտել ըստ մարզի" : "Filter by region";
}

function allRegionsLabel() {
  return getLang() === "hy" ? "Բոլոր մարզերը" : "All regions";
}

function setButtonState(button) {
  if (!button) return;
  button.classList.toggle("activity-search-filter-btn-active", Boolean(activeRegion));
  let dot = button.querySelector(".activity-search-filter-dot");
  if (activeRegion && !dot) {
    dot = document.createElement("span");
    dot.className = "activity-search-filter-dot";
    dot.setAttribute("aria-hidden", "true");
    button.appendChild(dot);
  } else if (!activeRegion && dot) {
    dot.remove();
  }
}

function closeRegionMenu(button, menu) {
  if (!button || !menu) return;
  menu.hidden = true;
  button.setAttribute("aria-expanded", "false");
  button.classList.remove("activity-search-filter-btn-open");
}

function selectedStatusReload() {
  const selected = document.querySelector('#order-status-filters [data-status].chip-active') ||
    document.querySelector('#order-status-filters [data-status][aria-pressed="true"]');
  selected?.click();
}

function escapeAttr(value) {
  return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function escapeText(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

function renderRegionMenu(menu, button, regions) {
  menu.innerHTML = ["", ...regions]
    .map((region) => {
      const selected = region === activeRegion;
      const label = region || allRegionsLabel();
      return `<button type="button" role="menuitemradio" aria-checked="${selected}" data-order-region="${escapeAttr(region)}"><span>${escapeText(label)}</span>${selected ? '<span class="activity-menu-check" aria-hidden="true">✓</span>' : ""}</button>`;
    })
    .join("");

  menu.querySelectorAll("[data-order-region]").forEach((option) => {
    option.addEventListener("click", (event) => {
      event.stopPropagation();
      const next = option.dataset.orderRegion || "";
      if (next === activeRegion) {
        closeRegionMenu(button, menu);
        return;
      }
      activeRegion = next;
      setButtonState(button);
      renderRegionMenu(menu, button, regions);
      closeRegionMenu(button, menu);
      selectedStatusReload();
    });
  });
}

async function getSummary(force = false) {
  if (!force && cachedSummary && Date.now() - cachedSummaryAt < SUMMARY_MAX_AGE_MS) return cachedSummary;
  if (!force && summaryPromise) return summaryPromise;
  summaryPromise = requestJson("/order-meta/summary")
    .then((result) => {
      cachedSummary = result;
      cachedSummaryAt = Date.now();
      return result;
    })
    .finally(() => {
      summaryPromise = null;
    });
  return summaryPromise;
}

function paintCounts(counts = {}) {
  const filterRow = document.querySelector("#order-status-filters");
  if (!filterRow) return;

  filterRow.querySelectorAll("[data-status]").forEach((chip) => {
    const status = chip.dataset.status || "";
    let badge = chip.querySelector(".order-status-count-badge");
    if (!COUNTED_STATUSES.includes(status)) {
      badge?.remove();
      return;
    }
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "order-status-count-badge";
      badge.setAttribute("aria-hidden", "true");
      chip.appendChild(badge);
    }
    const value = String(Number(counts[status]) || 0);
    if (badge.textContent !== value) badge.textContent = value; // unchanged -> no write (a write re-triggers the page observers)
  });
}

export async function enhanceOrdersRegionAndCounts() {
  const search = document.querySelector("#order-search");
  const actions = search?.closest(".activity-search-combined")?.querySelector(".activity-search-actions");
  const channelButton = document.querySelector("#order-filter-btn");
  if (!search || !actions || !channelButton) return;

  let regionWrap = actions.querySelector(".orders-region-filter-wrap");
  let regionButton = regionWrap?.querySelector(".orders-region-filter-btn");
  let regionMenu = regionWrap?.querySelector(".orders-region-filter-menu");

  if (!regionWrap) {
    regionWrap = document.createElement("div");
    regionWrap.className = "activity-icon-dropdown orders-region-filter-wrap";
    regionWrap.innerHTML = `
      <button type="button" class="activity-search-filter-btn orders-region-filter-btn" aria-haspopup="menu" aria-expanded="false" aria-label="${regionLabel()}" title="${regionLabel()}">${REGION_ICON}</button>
      <div class="activity-search-menu orders-search-menu orders-region-filter-menu" role="menu" hidden></div>`;

    const channelWrap = channelButton.closest(".activity-icon-dropdown");
    if (channelWrap?.parentElement === actions) channelWrap.insertAdjacentElement("afterend", regionWrap);
    else actions.prepend(regionWrap);

    regionButton = regionWrap.querySelector(".orders-region-filter-btn");
    regionMenu = regionWrap.querySelector(".orders-region-filter-menu");

    regionButton.addEventListener("click", async (event) => {
      event.stopPropagation();
      const open = regionMenu.hidden;
      if (!open) {
        closeRegionMenu(regionButton, regionMenu);
        return;
      }
      try {
        const summary = await getSummary();
        renderRegionMenu(regionMenu, regionButton, summary.regions || []);
      } catch {
        renderRegionMenu(regionMenu, regionButton, []);
      }
      regionMenu.hidden = false;
      regionButton.setAttribute("aria-expanded", "true");
      regionButton.classList.add("activity-search-filter-btn-open");
      regionMenu.querySelector('[aria-checked="true"]')?.focus();
    });

    regionMenu.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeRegionMenu(regionButton, regionMenu);
        regionButton.focus();
      }
    });
  }

  setButtonState(regionButton);
  try {
    const summary = await getSummary();
    paintCounts(summary.counts);
  } catch {
    // Informative UI only; never block the Orders list.
  }
}

// The region filter asks a different endpoint (it is not one of /orders' own filters).
export function listOrdersInRegion(params = {}, options = {}) {
  if (!activeRegion) return api.listOrders(params, options);
  const qs = new URLSearchParams({ ...params, region: activeRegion }).toString();
  return requestJson(`/order-meta/list${qs ? `?${qs}` : ""}`);
}
// Once for the app's lifetime (this module loads once): close the region menu on an outside tap, refresh the status counts
// when an order changes anywhere, forget the region when leaving Orders.
document.addEventListener("click", (event) => {
  const wrap = document.querySelector(".orders-region-filter-wrap");
  const button = wrap?.querySelector(".orders-region-filter-btn");
  const menu = wrap?.querySelector(".orders-region-filter-menu");
  if (!wrap || !button || !menu || menu.hidden || wrap.contains(event.target)) return;
  closeRegionMenu(button, menu);
});
window.addEventListener("orders-changed", async () => {
  cachedSummary = null;
  try {
    const summary = await getSummary(true);
    paintCounts(summary.counts);
  } catch {
    // informative only
  }
});
window.addEventListener("hashchange", () => {
  if (!location.hash.startsWith("#/orders")) activeRegion = "";
});
