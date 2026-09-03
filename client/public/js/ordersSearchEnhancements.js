import { getLang, t } from "./i18n.js";

const CHANNEL_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="12" cy="18" r="2"/><path d="M8 6h8M12 8v8M8 6c2.6 0 4 1.4 4 4M16 6c-2.6 0-4 1.4-4 4"/></svg>`;

const statusSvg = (content) =>
  `<svg class="order-status-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${content}</svg>`;

// One coherent mono-line family, based on the approved order-status concepts.
// Using currentColor keeps the icons crisp, theme-safe and reusable in both
// small filter chips and larger list-row status medallions.
const ORDER_STATUS_ICONS = {
  draft: statusSvg(`<path d="M6 3.5h8l4 4V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z"/><path d="M14 3.5v4h4M8 10h6M8 13h4"/><path d="m12.5 18 4.6-4.6 1.5 1.5-4.6 4.6-2 .5z"/>`),
  submitted: statusSvg(`<path d="M6 3.5h8l4 4V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z"/><path d="M14 3.5v4h4M8 10h6M8 13h4"/><path d="m12.5 17.5 7-3-3 7-1.1-2.9z"/>`),
  confirmed: statusSvg(`<path d="M5 4h9l4 4v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z"/><path d="M14 4v4h4"/><path d="m8.5 14 2 2 4-4"/><path d="M8 9h4"/>`),
  packed: statusSvg(`<path d="m4 7 8-4 8 4-8 4zM4 7v10l8 4 8-4V7M12 11v10"/><path d="M7.5 5.2 16 9"/>`),
  stock_out: statusSvg(`<path d="m3.5 7 7-3.5 7 3.5-7 3.5zM3.5 7v9l7 3.5 4-2"/><path d="M10.5 10.5v9M14.5 14.5H22M18.5 11l3.5 3.5-3.5 3.5"/>`),
  delivered: statusSvg(`<path d="m3.5 7 7-3.5 7 3.5-7 3.5zM3.5 7v9l7 3.5 7-3.5V7M10.5 10.5v9"/><circle cx="18" cy="17" r="4"/><path d="m16.2 17 1.2 1.2 2.4-2.6"/>`),
  cancelled: statusSvg(`<path d="m3.5 7 7-3.5 7 3.5-7 3.5zM3.5 7v9l7 3.5 7-3.5V7M10.5 10.5v9"/><circle cx="18" cy="17" r="4"/><path d="m16.6 15.6 2.8 2.8M19.4 15.6l-2.8 2.8"/>`),
};

const STATUS_KEYS = ["draft", "submitted", "confirmed", "packed", "stock_out", "delivered", "cancelled"];

function resolveStatusFromBadge(badge) {
  const text = badge?.textContent?.trim();
  if (!text) return "";
  for (const status of STATUS_KEYS) {
    const key = `order_status_${status}`;
    const translated = t(key);
    if (translated && translated !== key && translated.trim() === text) return status;
  }
  return "";
}

function decorateOrdersStatusUi() {
  const filterRow = document.querySelector("#order-status-filters");
  if (filterRow) {
    filterRow.querySelectorAll("[data-status]").forEach((btn) => {
      const status = btn.dataset.status || "";
      if (!status || !ORDER_STATUS_ICONS[status] || btn.querySelector(".order-filter-status-icon")) return;
      const icon = document.createElement("span");
      icon.className = `order-filter-status-icon order-status-${status}`;
      icon.innerHTML = ORDER_STATUS_ICONS[status];
      btn.prepend(icon);
    });
  }

  const list = document.querySelector("#orders-list");
  if (!list) return;
  list.querySelectorAll("[data-order-id].activity-row-rich").forEach((row) => {
    if (row.querySelector(":scope > .order-row-status-icon")) return;
    const badge = row.querySelector(".activity-row-bottom .badge");
    const status = resolveStatusFromBadge(badge);
    if (!status || !ORDER_STATUS_ICONS[status]) return;

    const icon = document.createElement("span");
    icon.className = `order-row-status-icon order-status-${status}`;
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML = ORDER_STATUS_ICONS[status];
    row.prepend(icon);
    row.dataset.orderStatus = status;
  });
}

function enhanceOrdersToolbar() {
  const search = document.querySelector("#order-search");
  const filterBtn = document.querySelector("#order-filter-btn");
  const filterMenu = document.querySelector("#order-filter-menu");
  const toolbar = search?.closest(".list-toolbar");

  if (!search || !filterBtn || !filterMenu || !toolbar || toolbar.dataset.ordersSearchEnhanced === "true") return;
  toolbar.dataset.ordersSearchEnhanced = "true";

  // Match Activity: one compact search field with the action inside it.
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
    } else if (!active && dot) {
      dot.remove();
    }
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
      } else if (!selected && check) {
        check.remove();
      }

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

  new MutationObserver(syncState).observe(filterBtn, {
    attributes: true,
    attributeFilter: ["aria-expanded"],
  });
  new MutationObserver(syncState).observe(filterMenu, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["aria-checked", "hidden"],
  });

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

  // Existing Orders already re-renders status filters/list rows after API
  // updates. One app-scoped observer covers those replacements; the decorator
  // is idempotent and exits immediately outside Orders.
  const observer = new MutationObserver(() => requestAnimationFrame(enhanceOrdersView));
  observer.observe(app, { childList: true, subtree: true });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
