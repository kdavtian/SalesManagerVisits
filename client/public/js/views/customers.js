import { api } from "../api.js";
import { escapeHtml, formatDateTime } from "../util.js";
import { t } from "../i18n.js";

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
        <div class="segmented" id="filter-segmented">
          <button class="chip" data-filter="">${t("filter_all")}</button>
          <button class="chip" data-filter="visited">${t("filter_visited")}</button>
          <button class="chip" data-filter="overdue">${t("filter_overdue")}</button>
          <button class="chip" data-filter="not_visited">${t("filter_not_visited")}</button>
        </div>
      </div>
      <div id="customer-list" class="card-list"></div>
    </div>
  `;

  const searchInput = root.querySelector("#customer-search");
  const listEl = root.querySelector("#customer-list");
  const statsBar = root.querySelector("#customer-stats-bar");
  const chips = root.querySelectorAll(".chip");

  let filter = initialFilter || "";
  root.querySelectorAll(`.chip[data-filter="${filter}"]`).forEach((c) => c.classList.add("chip-active"));
  if (!filter) chips[0].classList.add("chip-active");

  let searchTimer;

  root.querySelector("#add-customer-btn").addEventListener("click", () => navigate("#/map"));

  async function loadStats() {
    const all = await api.listCustomers();
    const visitedWeek = all.filter((c) => c.visited_this_week).length;
    const overdue = all.filter((c) => c.overdue).length;
    statsBar.innerHTML = `
      <div class="stat-pill"><strong>${all.length}</strong><span>${t("filter_all")}</span></div>
      <div class="stat-pill"><strong class="text-success">${visitedWeek}</strong><span>${t("filter_visited")}</span></div>
      <div class="stat-pill"><strong class="text-danger">${overdue}</strong><span>${t("filter_overdue")}</span></div>
    `;
  }

  async function load() {
    listEl.innerHTML = `<p class="muted">…</p>`;
    const params = {};
    if (searchInput.value.trim()) params.search = searchInput.value.trim();
    if (filter) params.visited = filter;

    const customers = await api.listCustomers(params);
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
          <div class="customer-card-icon">🏪</div>
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

  searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(load, 300);
  });

  chips.forEach((chip) => {
    chip.addEventListener("click", () => {
      chips.forEach((c) => c.classList.remove("chip-active"));
      chip.classList.add("chip-active");
      filter = chip.dataset.filter;
      load();
    });
  });

  loadStats();
  load();
}
