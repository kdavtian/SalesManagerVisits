import { getLang, t } from "./i18n.js";

const CHANNEL_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="12" cy="18" r="2"/><path d="M8 6h8M12 8v8M8 6c2.6 0 4 1.4 4 4M16 6c-2.6 0-4 1.4-4 4"/></svg>`;

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

function boot() {
  enhanceOrdersToolbar();
  const app = document.querySelector("#app");
  if (!app) return;

  const observer = new MutationObserver(() => enhanceOrdersToolbar());
  observer.observe(app, { childList: true, subtree: true });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
