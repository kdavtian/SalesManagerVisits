import { FILTER_ICONS } from "./filterIcons.js";
import { getLang, t } from "./i18n.js";

const CHANNEL_ICON = FILTER_ICONS.channel;

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

// Row icons are now rendered inline by orders.js itself (importing
// ORDER_STATUS_ICONS above) rather than injected here after the fact --
// this only still decorates the status *filter tab bar*, which has no
// per-status data attribute of its own to key off of at render time.
function decorateOrdersStatusUi() {
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
    icon.innerHTML = ORDER_STATUS_ICONS[status];
  });
}

function enhanceOrdersToolbar() {
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

function enhanceOrdersView() {
  enhanceOrdersToolbar();
  decorateOrdersStatusUi();
}

function boot() {
  enhanceOrdersView();
  const app = document.querySelector("#app");
  if (!app) return;
  // Coalesced, same reasoning as the other view-enhancement observers in
  // this app -- a burst of mutations otherwise queued one rAF callback
  // per record instead of one per frame.
  let scheduled = false;
  const observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      enhanceOrdersView();
    });
  });
  observer.observe(app, { childList: true, subtree: true });
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
else boot();
