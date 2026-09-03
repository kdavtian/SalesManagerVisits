import { api } from "./api.js";
import { APP_VERSION } from "./version.js";
import { getLang, t } from "./i18n.js";

const REGION_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 10c0 4.8-7 10-7 10S5 14.8 5 10a7 7 0 1 1 14 0Z"/><circle cx="12" cy="10" r="2.25"/></svg>`;
const COUNTED_STATUSES = ["submitted", "confirmed", "packed"];

let activeRegion = "";
let cachedSummary = null;
let summaryPromise = null;
let scheduled = false;

const originalListOrders = api.listOrders.bind(api);

async function requestJson(path) {
  const response = await fetch(`/api${path}`, {
    credentials: "include",
    headers: { "X-App-Version": APP_VERSION },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error || `Request failed (${response.status})`);
  return body;
}

api.listOrders = (params = {}) => {
  if (!activeRegion) return originalListOrders(params);
  const qs = new URLSearchParams({ ...params, region: activeRegion }).toString();
  return requestJson(`/order-meta/list${qs ? `?${qs}` : ""}`);
};

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
  if (!force && cachedSummary) return cachedSummary;
  if (!force && summaryPromise) return summaryPromise;
  summaryPromise = requestJson("/order-meta/summary")
    .then((result) => {
      cachedSummary = result;
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
    badge.textContent = String(Number(counts[status]) || 0);
  });
}

async function enhanceOrdersRegionAndCounts() {
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

function scheduleEnhance() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    enhanceOrdersRegionAndCounts();
  });
}

function boot() {
  scheduleEnhance();
  const app = document.querySelector("#app");
  if (app) {
    const observer = new MutationObserver(scheduleEnhance);
    observer.observe(app, { childList: true, subtree: true });
  }

  // One delegated outside-click handler for the lifetime of the app. This
  // avoids accumulating document listeners when the Orders tab is mounted
  // repeatedly during navigation.
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
    } catch {}
  });

  window.addEventListener("hashchange", () => {
    if (!location.hash.startsWith("#/orders")) activeRegion = "";
    scheduleEnhance();
  });
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
else boot();
