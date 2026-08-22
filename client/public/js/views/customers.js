import { api } from "../api.js";
import { escapeHtml } from "../util.js";

export function renderCustomers(root, navigate) {
  root.innerHTML = `
    <div class="list-view">
      <div class="list-toolbar">
        <input type="search" id="customer-search" placeholder="Search customers…" />
        <div class="chip-row">
          <button class="chip chip-active" data-filter="">All</button>
          <button class="chip" data-filter="visited">Visited this week</button>
          <button class="chip" data-filter="not_visited">Not visited</button>
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
    listEl.innerHTML = `<p class="muted">Loading…</p>`;
    const params = {};
    if (searchInput.value.trim()) params.search = searchInput.value.trim();
    if (filter) params.visited = filter;

    const customers = await api.listCustomers(params);
    if (!customers.length) {
      listEl.innerHTML = `<p class="muted">No customers found.</p>`;
      return;
    }

    listEl.innerHTML = customers
      .map(
        (c) => `
        <button class="card customer-card" data-id="${c.id}">
          <div class="customer-card-main">
            <strong>${escapeHtml(c.name)}</strong>
            ${c.category ? `<span class="muted">${escapeHtml(c.category)}</span>` : ""}
          </div>
          <span class="badge ${c.visited_this_week ? "badge-success" : "badge-neutral"}">
            ${c.visited_this_week ? "Visited this week" : "Not visited"}
          </span>
        </button>
      `
      )
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
