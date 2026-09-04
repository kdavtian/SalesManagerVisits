import { getLang, t } from "./i18n.js";

const CHANNEL_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="12" cy="18" r="2"/><path d="M8 6h8M12 8v8M8 6c2.6 0 4 1.4 4 4M16 6c-2.6 0-4 1.4-4 4"/></svg>`;

const statusSvg = (content) =>
  `<svg class="order-status-svg" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.95" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${content}</svg>`;

// Production vector versions of the exact concepts approved in the generated
// icon set: document+pencil, document+send, verified order document,
// packed box, outbound box, delivered box+check, cancelled box+x.
const ORDER_STATUS_ICONS = {
  draft: statusSvg(`<path d="M7 3.5h11l6 6V27a1.5 1.5 0 0 1-1.5 1.5H7A1.5 1.5 0 0 1 5.5 27V5A1.5 1.5 0 0 1 7 3.5Z"/><path d="M18 3.5v6h6M10 13h8M10 17h7M10 21h4"/><path d="m15.5 25.5 8.1-8.1 2.9 2.9-8.1 8.1-4 .9z"/>`),
  submitted: statusSvg(`<path d="M7 3.5h11l6 6V27a1.5 1.5 0 0 1-1.5 1.5H7A1.5 1.5 0 0 1 5.5 27V5A1.5 1.5 0 0 1 7 3.5Z"/><path d="M18 3.5v6h6M10 13h8M10 17h7M10 21h4"/><path d="m15 23 13-6-6 13-2.1-5z"/><path d="m19.9 25 4.2-4.1"/>`),
  confirmed: statusSvg(`<path d="M6.5 3.5h13l6 6V26A2.5 2.5 0 0 1 23 28.5H6.5A2.5 2.5 0 0 1 4 26V6A2.5 2.5 0 0 1 6.5 3.5Z"/><path d="M19.5 3.5v6h6"/><path d="m8 11 5-2.7 5 2.7-5 2.7zM8 11v5.5l5 2.7 5-2.7V11M13 13.7v5.5"/><path d="M9 22h8"/><circle cx="23" cy="23" r="6"/><path d="m20.2 23 1.9 2 3.8-4.2"/>`),
  packed_stock_out: statusSvg(`<path d="m6 9 10-5 10 5-10 5zM6 9v13l10 5 10-5V9M16 14v13"/><path d="m10 7 10 5"/><path d="M19 18h10M25 14l4 4-4 4"/>`),
  delivered: statusSvg(`<path d="m5 9 9-4.5L23 9l-9 4.5zM5 9v12l9 4.5 9-4.5V9M14 13.5v12"/><circle cx="24" cy="23" r="6"/><path d="m21.2 23 1.9 2 3.8-4.2"/>`),
};

const STATUS_KEYS = ["draft", "submitted", "confirmed", "packed_stock_out", "delivered"];

function resolveStatusFromBadge(badge) {
  const text = badge?.textContent?.trim();
  if (!text) return "";
  for (const status of STATUS_KEYS) {
    const translated = t(`order_status_${status}`);
    if (translated && translated !== `order_status_${status}` && translated.trim() === text) return status;
  }
  return "";
}

function decorateOrdersStatusUi() {
  const filterRow = document.querySelector("#order-status-filters");
  filterRow?.querySelectorAll("[data-status]").forEach((btn) => {
    const status = btn.dataset.status || "";
    if (!status || !ORDER_STATUS_ICONS[status]) return;
    let icon = btn.querySelector(".order-filter-status-icon");
    if (!icon) {
      icon = document.createElement("span");
      icon.className = `order-filter-status-icon order-status-${status}`;
      btn.prepend(icon);
    }
    icon.innerHTML = ORDER_STATUS_ICONS[status];
  });

  const list = document.querySelector("#orders-list");
  if (!list) return;
  list.querySelectorAll("[data-order-id].activity-row-rich").forEach((row) => {
    const badge = row.querySelector(".activity-row-bottom .badge");
    const status = resolveStatusFromBadge(badge);
    if (!status || !ORDER_STATUS_ICONS[status]) return;
    let icon = row.querySelector(":scope > .order-row-status-icon");
    if (!icon) {
      icon = document.createElement("span");
      icon.className = `order-row-status-icon order-status-${status}`;
      icon.setAttribute("aria-hidden", "true");
      row.prepend(icon);
    }
    icon.className = `order-row-status-icon order-status-${status}`;
    icon.innerHTML = ORDER_STATUS_ICONS[status];
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
  const observer = new MutationObserver(() => requestAnimationFrame(enhanceOrdersView));
  observer.observe(app, { childList: true, subtree: true });
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
else boot();
