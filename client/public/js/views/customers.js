import { api } from "../api.js";
import { escapeHtml } from "../util.js";
import { t } from "../i18n.js";

export function renderCustomers(root, navigate) {
  root.innerHTML = `
    <div class="list-view">
      <div class="list-toolbar">
        <input type="search" id="customer-search" placeholder="${t("search_customers")}" />
        <div class="segmented">
          <button class="chip chip-active" data-filter="">${t("filter_all")}</button>
          <button class="chip" data-filter="visited">${t("filter_visited")}</button>
          <button class="chip" data-filter="not_visited">${t("filter_not_visited")}</button>
        </div>
      </div>
      <div id="customer-list" class="card-list"></div>
    </div>
  `;

  const searchInput = root.querySelector("#customer-search");
  const listEl = root.querySelector("#customer-list");
  const chips = root.querySelectorAll(".chip");

  let filter = "";
  let searchTimer;

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
        const badgeClass = c.visited_today ? "badge-success" : c.visited_this_week ? "badge-info" : "badge-neutral";
        const badgeText = c.visited_today ? t("visited_today") : c.visited_this_week ? t("visited_this_week") : t("not_visited");
        return `
        <button class="card customer-card" data-id="${c.id}">
          <div class="customer-card-main">
            <strong>${escapeHtml(c.name)}</strong>
            ${c.category ? `<span class="muted">${escapeHtml(c.category)}</span>` : ""}
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

  load();
}
