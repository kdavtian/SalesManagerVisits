import { api } from "../api.js";
import { escapeHtml, formatDateTime, haversineMeters, getCurrentPosition } from "../util.js";
import { t } from "../i18n.js";
import { icons } from "../icons.js";

const FILTERS = [
  { key: "", labelKey: "filter_all" },
  { key: "visited", labelKey: "filter_visited" },
  { key: "overdue", labelKey: "filter_overdue" },
  { key: "not_visited", labelKey: "filter_not_visited" },
];

export function renderCustomers(root, navigate, initialFilter) {
  root.innerHTML = `
    <div class="list-view">
      <div class="list-header">
        <div>
          <h1>${t("nav_customers")}</h1>
          <p class="muted">${t("customers_subtitle")}</p>
        </div>
        <button class="btn btn-primary btn-sm" id="add-customer-btn">+ ${t("add_customer")}</button>
      </div>

      <div class="customer-stats-bar" id="customer-stats-bar"></div>

      <div class="list-toolbar">
        <label class="visually-hidden" for="customer-search">${t("search_customers")}</label>
        <input type="search" id="customer-search" placeholder="${t("search_customers")}" />
        <button class="icon-btn" id="sort-btn" type="button" aria-label="${t("sort")}" aria-haspopup="menu" aria-expanded="false" aria-controls="sort-menu">${icons.sort}</button>
        <div id="sort-menu" class="dropdown-menu" role="menu" hidden>
          <button role="menuitemradio" aria-checked="true" data-sort="name">${t("sort_name")}</button>
          <button role="menuitemradio" aria-checked="false" data-sort="last_visit">${t("sort_last_visit")}</button>
          <button role="menuitemradio" aria-checked="false" data-sort="distance">${t("sort_distance")}</button>
        </div>
      </div>
      <div class="region-filter-row" id="region-filter-row"></div>
      <div id="customer-list" class="card-list"></div>
    </div>
  `;

  const searchInput = root.querySelector("#customer-search");
  const listEl = root.querySelector("#customer-list");
  const statsBar = root.querySelector("#customer-stats-bar");
  const sortBtn = root.querySelector("#sort-btn");
  const sortMenu = root.querySelector("#sort-menu");

  let filter = initialFilter || "";
  let sortKey = "name";
  let myLocation = null;
  let searchTimer;
  let regionFilter = "";
  let subregionFilter = "";
  let openRegionMenu = null;
  const regionFilterRow = root.querySelector("#region-filter-row");

  root.querySelector("#add-customer-btn").addEventListener("click", () => navigate("#/map?add=1"));

  sortBtn.addEventListener("click", () => {
    sortMenu.hidden = !sortMenu.hidden;
    sortBtn.setAttribute("aria-expanded", String(!sortMenu.hidden));
    if (!sortMenu.hidden) sortMenu.querySelector("button")?.focus();
  });
  sortMenu.querySelectorAll("[data-sort]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      sortKey = btn.dataset.sort;
      sortMenu.hidden = true;
      sortBtn.setAttribute("aria-expanded", "false");
      sortMenu.querySelectorAll("button").forEach((item) => item.setAttribute("aria-checked", String(item === btn)));
      if (sortKey === "distance" && !myLocation) {
        try {
          const pos = await getCurrentPosition();
          myLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        } catch {
          // Fall through and sort with whatever we have (no distance available).
        }
      }
      render();
    });
  });
  root.addEventListener("click", (e) => {
    if (!sortMenu.hidden && !sortMenu.contains(e.target) && e.target !== sortBtn && !sortBtn.contains(e.target)) {
      sortMenu.hidden = true;
      sortBtn.setAttribute("aria-expanded", "false");
    }
  });

  sortMenu.addEventListener("keydown", (e) => {
    const items = [...sortMenu.querySelectorAll("button")];
    const index = items.indexOf(document.activeElement);
    if (e.key === "Escape") {
      sortMenu.hidden = true;
      sortBtn.setAttribute("aria-expanded", "false");
      sortBtn.focus();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const delta = e.key === "ArrowDown" ? 1 : -1;
      items[(index + delta + items.length) % items.length]?.focus();
    }
  });

  let allCustomers = [];

  const CHEVRON_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>`;

  // Reuses the in-page dropdown pattern from the Activity filters (native
  // <select> popovers render as a full-width dark OS sheet on iOS that
  // overlaps the list below).
  function regionDropdownHtml(key, options, currentValue) {
    const current = options.find((o) => o.value === currentValue) ?? options[0];
    return `
      <div class="filter-dropdown-wrap">
        <button type="button" class="filter-dropdown-btn" data-region-dropdown="${key}" aria-haspopup="menu" aria-expanded="${openRegionMenu === key}" aria-controls="region-menu-${key}">
          <span>${escapeHtml(current.label)}</span>
          ${CHEVRON_ICON}
        </button>
        <div class="filter-dropdown-menu" id="region-menu-${key}" role="menu" data-region-dropdown-menu="${key}" ${openRegionMenu === key ? "" : "hidden"}>
          ${options
            .map(
              (o) =>
                `<button type="button" role="menuitemradio" aria-checked="${o.value === currentValue}" data-value="${escapeHtml(o.value)}" class="${o.value === currentValue ? "filter-dropdown-selected" : ""}">${escapeHtml(o.label)}</button>`
            )
            .join("")}
        </div>
      </div>
    `;
  }

  function renderRegionFilterRow() {
    const regions = [...new Set(allCustomers.map((c) => c.region).filter(Boolean))].sort();
    if (!regions.length) {
      regionFilterRow.innerHTML = "";
      return;
    }
    const subregions = [
      ...new Set(
        allCustomers
          .filter((c) => !regionFilter || c.region === regionFilter)
          .map((c) => c.subregion)
          .filter(Boolean)
      ),
    ].sort();

    regionFilterRow.innerHTML = `
      ${regionDropdownHtml("region", [{ value: "", label: t("all_regions") }, ...regions.map((r) => ({ value: r, label: r }))], regionFilter)}
      ${subregions.length ? regionDropdownHtml("subregion", [{ value: "", label: t("all_subregions") }, ...subregions.map((s) => ({ value: s, label: s }))], subregionFilter) : ""}
    `;

    regionFilterRow.querySelectorAll("[data-region-dropdown]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const key = btn.dataset.regionDropdown;
        openRegionMenu = openRegionMenu === key ? null : key;
        renderRegionFilterRow();
      });
    });
    regionFilterRow.querySelectorAll("[data-region-dropdown-menu] button").forEach((optBtn) => {
      optBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const key = optBtn.closest("[data-region-dropdown-menu]").dataset.regionDropdownMenu;
        if (key === "region") {
          regionFilter = optBtn.dataset.value;
          subregionFilter = "";
        } else {
          subregionFilter = optBtn.dataset.value;
        }
        openRegionMenu = null;
        renderRegionFilterRow();
        renderList();
      });
    });
  }

  root.addEventListener("click", () => {
    if (openRegionMenu) {
      openRegionMenu = null;
      renderRegionFilterRow();
    }
  });

  function renderStatsBar() {
    const counts = {
      "": allCustomers.length,
      visited: allCustomers.filter((c) => c.visited_this_week).length,
      overdue: allCustomers.filter((c) => c.overdue).length,
      not_visited: allCustomers.filter((c) => !c.visited_this_week).length,
    };
    statsBar.innerHTML = FILTERS.map(
      (f) => `
        <button class="stat-pill ${filter === f.key ? "stat-pill-active" : ""}" data-filter="${f.key}" aria-pressed="${filter === f.key}">
          <strong>${counts[f.key]}</strong><span>${t(f.labelKey)}</span>
        </button>
      `
    ).join("");
    statsBar.querySelectorAll(".stat-pill").forEach((btn) => {
      btn.addEventListener("click", () => {
        filter = btn.dataset.filter;
        render();
      });
    });
  }

  function sortCustomers(customers) {
    const sorted = [...customers];
    if (sortKey === "name") {
      sorted.sort((a, b) => a.name.localeCompare(b.name));
    } else if (sortKey === "last_visit") {
      sorted.sort((a, b) => new Date(b.last_visit_at || 0) - new Date(a.last_visit_at || 0));
    } else if (sortKey === "distance" && myLocation) {
      sorted.sort(
        (a, b) =>
          haversineMeters(myLocation.lat, myLocation.lng, a.lat, a.lng) -
          haversineMeters(myLocation.lat, myLocation.lng, b.lat, b.lng)
      );
    }
    return sorted;
  }

  function renderList() {
    let customers = allCustomers;
    const query = searchInput.value.trim().toLowerCase();
    if (query) customers = customers.filter((c) => c.name.toLowerCase().includes(query));
    if (filter === "visited") customers = customers.filter((c) => c.visited_this_week);
    else if (filter === "overdue") customers = customers.filter((c) => c.overdue);
    else if (filter === "not_visited") customers = customers.filter((c) => !c.visited_this_week);
    if (regionFilter) customers = customers.filter((c) => c.region === regionFilter);
    if (subregionFilter) customers = customers.filter((c) => c.subregion === subregionFilter);
    customers = sortCustomers(customers);

    if (!customers.length) {
      listEl.innerHTML = `<p class="empty-state">${t("no_customers_found")}</p>`;
      return;
    }

    listEl.innerHTML = customers
      .map((c) => {
        let badgeClass = "badge-neutral";
        let badgeText = t("not_visited");
        if (c.visited_today) {
          badgeClass = "badge-success";
          badgeText = t("visited_today");
        } else if (c.overdue) {
          badgeClass = "badge-danger";
          badgeText = t("filter_overdue");
        } else if (c.visited_this_week) {
          badgeClass = "badge-info";
          badgeText = t("visited_this_week");
        }
        const lastVisit = c.last_visit_at
          ? `${t("last_visit")}: ${formatDateTime(c.last_visit_at)}`
          : t("never_visited");

        return `
        <button class="card customer-card" data-id="${c.id}">
          <div class="customer-card-main">
            <strong>${escapeHtml(c.name)}</strong>
            ${c.category ? `<span class="muted">${escapeHtml(c.category)}</span>` : ""}
            <span class="muted customer-card-last-visit">${lastVisit}</span>
          </div>
          <span class="card-trailing">
            <span class="badge ${badgeClass}">${badgeText}</span>
            <span class="chevron">&#8250;</span>
          </span>
        </button>
      `;
      })
      .join("");

    listEl.querySelectorAll(".customer-card").forEach((el) => {
      el.addEventListener("click", () => navigate(`#/customers/${el.dataset.id}`));
    });
  }

  function render() {
    renderStatsBar();
    renderRegionFilterRow();
    renderList();
  }

  async function load() {
    listEl.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
    allCustomers = await api.listCustomers();
    render();
  }

  searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(renderList, 300);
  });

  load();
}
