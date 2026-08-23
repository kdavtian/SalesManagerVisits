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
        <input type="search" id="customer-search" placeholder="${t("search_customers")}" />
        <button class="icon-btn" id="sort-btn" type="button" aria-label="${t("sort")}">${icons.sort}</button>
        <div id="sort-menu" class="dropdown-menu" hidden>
          <button data-sort="name">${t("sort_name")}</button>
          <button data-sort="last_visit">${t("sort_last_visit")}</button>
          <button data-sort="distance">${t("sort_distance")}</button>
        </div>
      </div>
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

  root.querySelector("#add-customer-btn").addEventListener("click", () => navigate("#/map"));

  sortBtn.addEventListener("click", () => {
    sortMenu.hidden = !sortMenu.hidden;
  });
  sortMenu.querySelectorAll("[data-sort]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      sortKey = btn.dataset.sort;
      sortMenu.hidden = true;
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
  document.addEventListener("click", (e) => {
    if (!sortMenu.hidden && !sortMenu.contains(e.target) && e.target !== sortBtn && !sortBtn.contains(e.target)) {
      sortMenu.hidden = true;
    }
  });

  let allCustomers = [];

  function renderStatsBar() {
    const counts = {
      "": allCustomers.length,
      visited: allCustomers.filter((c) => c.visited_this_week).length,
      overdue: allCustomers.filter((c) => c.overdue).length,
      not_visited: allCustomers.filter((c) => !c.visited_this_week).length,
    };
    statsBar.innerHTML = FILTERS.map(
      (f) => `
        <button class="stat-pill ${filter === f.key ? "stat-pill-active" : ""}" data-filter="${f.key}">
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
    customers = sortCustomers(customers);

    if (!customers.length) {
      listEl.innerHTML = `<p class="muted">${t("no_customers_found")}</p>`;
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
    renderList();
  }

  async function load() {
    listEl.innerHTML = `<p class="muted">…</p>`;
    allCustomers = await api.listCustomers();
    render();
  }

  searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(renderList, 300);
  });

  load();
}
