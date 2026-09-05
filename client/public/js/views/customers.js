import { api } from "../api.js";
import { escapeHtml, formatDateTime, formatAmd, haversineMeters, getCurrentPosition, customerListIconHtml, categoryLabel, activateDialog } from "../util.js";
import { t } from "../i18n.js";
import { icons } from "../icons.js";
import { state, seesAllActivity } from "../state.js";

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
        <h1>${t("nav_customers")}</h1>
        <button class="list-header-add-btn" id="toggle-debt-btn" aria-label="${t("show_outstanding_debt")}" title="${t("show_outstanding_debt")}" aria-pressed="false">${icons.payment}</button>
        <button class="list-header-add-btn" id="add-customer-btn" aria-label="${t("add_customer")}" title="${t("add_customer")}">${icons.plus}</button>
      </div>

      <div class="customer-stats-bar" id="customer-stats-bar"></div>

      <div class="list-toolbar">
        <label class="visually-hidden" for="customer-search">${t("search_customers")}</label>
        <input type="search" id="customer-search" placeholder="${t("search_customers")}" aria-label="${t("search_customers")}" />
        <button class="icon-btn" id="sort-btn" type="button" aria-label="${t("sort")}" aria-haspopup="menu" aria-expanded="false" aria-controls="sort-menu">${icons.sort}</button>
        <div id="sort-menu" class="dropdown-menu" role="menu" hidden>
          <button role="menuitemradio" aria-checked="true" data-sort="name">${t("sort_name")}</button>
          <button role="menuitemradio" aria-checked="false" data-sort="last_visit">${t("sort_last_visit")}</button>
          <button role="menuitemradio" aria-checked="false" data-sort="distance">${t("sort_distance")}</button>
        </div>
      </div>
      <div class="customer-filter-row" id="customer-filter-row"></div>
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
  let assignmentFilter = ""; // "", "mine", "others"
  let channelFilter = "";
  // Off by default (per task spec: "to make app run faster") -- the debt
  // lookup is a real join server-side, not free, so it's opt-in per
  // session rather than always fetched with the rest of the list.
  let showDebt = false;
  const filterRow = root.querySelector("#customer-filter-row");
  const debtToggleBtn = root.querySelector("#toggle-debt-btn");

  root.querySelector("#add-customer-btn").addEventListener("click", () => navigate("#/map?add=1"));
  debtToggleBtn.addEventListener("click", () => {
    showDebt = !showDebt;
    debtToggleBtn.classList.toggle("list-header-add-btn-active", showDebt);
    debtToggleBtn.setAttribute("aria-pressed", String(showDebt));
    load();
  });

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

  // A compact 44px icon button that opens a full-height-label bottom sheet
  // -- keeps the toolbar to a fixed, screen-width-independent size no
  // matter how long the Armenian option text is (the old text-label
  // dropdown row didn't fit 4 of them on an iPhone-width screen and forced
  // the whole page to scroll sideways).
  function openFilterSheet(titleText, options, currentValue, onSelect) {
    const overlay = document.createElement("div");
    overlay.className = "sheet-overlay";
    overlay.innerHTML = `
      <div class="sheet filter-sheet">
        <h2>${escapeHtml(titleText)}</h2>
        <div class="filter-sheet-options">
          ${options
            .map(
              (o) => `
            <button type="button" class="filter-sheet-option ${o.value === currentValue ? "filter-sheet-option-selected" : ""}" data-value="${escapeHtml(o.value)}">
              <span>${escapeHtml(o.label)}</span>
              ${o.value === currentValue ? `<span class="filter-sheet-check">${icons.checkCircle}</span>` : ""}
            </button>
          `
            )
            .join("")}
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    activateDialog(overlay);
    overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());
    overlay.querySelectorAll(".filter-sheet-option").forEach((btn) => {
      btn.addEventListener("click", () => {
        onSelect(btn.dataset.value);
        overlay.remove();
      });
    });
  }

  function filterIconButton({ key, icon, label, active, onClick }) {
    return `<button type="button" class="filter-icon-btn ${active ? "filter-icon-btn-active" : ""}" data-filter-btn="${key}" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}">
      ${icon}
      ${active ? `<span class="filter-icon-dot" aria-hidden="true"></span>` : ""}
    </button>`;
  }

  function renderFilterRow() {
    const regions = [...new Set(allCustomers.map((c) => c.region).filter(Boolean))].sort();
    const subregions = [
      ...new Set(
        allCustomers
          .filter((c) => !regionFilter || c.region === regionFilter)
          .map((c) => c.subregion)
          .filter(Boolean)
      ),
    ].sort();
    const channels = seesAllActivity()
      ? [...new Set(allCustomers.map((c) => c.sales_channel).filter(Boolean))].sort()
      : [];

    const buttons = [
      filterIconButton({
        key: "assignment",
        icon: icons.person,
        label: t("filter_assignment_title"),
        active: assignmentFilter !== "",
      }),
      regions.length
        ? filterIconButton({ key: "region", icon: icons.pin, label: t("region"), active: regionFilter !== "" })
        : "",
      subregions.length
        ? filterIconButton({ key: "subregion", icon: icons.compass, label: t("subregion"), active: subregionFilter !== "" })
        : "",
      channels.length
        ? filterIconButton({ key: "channel", icon: icons.route, label: t("filter_direction_title"), active: channelFilter !== "" })
        : "",
    ]
      .filter(Boolean)
      .join("");

    filterRow.innerHTML = buttons;

    filterRow.querySelector('[data-filter-btn="assignment"]')?.addEventListener("click", () => {
      openFilterSheet(
        t("filter_assignment_title"),
        [
          { value: "", label: t("all_customers") },
          { value: "mine", label: t("assigned_to_me") },
          { value: "others", label: t("assigned_to_others") },
        ],
        assignmentFilter,
        (value) => {
          assignmentFilter = value;
          renderFilterRow();
          renderList();
        }
      );
    });

    filterRow.querySelector('[data-filter-btn="region"]')?.addEventListener("click", () => {
      openFilterSheet(
        t("region"),
        [{ value: "", label: t("all_regions") }, ...regions.map((r) => ({ value: r, label: r }))],
        regionFilter,
        (value) => {
          regionFilter = value;
          subregionFilter = "";
          renderFilterRow();
          renderList();
        }
      );
    });

    filterRow.querySelector('[data-filter-btn="subregion"]')?.addEventListener("click", () => {
      openFilterSheet(
        t("subregion"),
        [{ value: "", label: t("all_subregions") }, ...subregions.map((s) => ({ value: s, label: s }))],
        subregionFilter,
        (value) => {
          subregionFilter = value;
          renderFilterRow();
          renderList();
        }
      );
    });

    filterRow.querySelector('[data-filter-btn="channel"]')?.addEventListener("click", () => {
      openFilterSheet(
        t("filter_direction_title"),
        [{ value: "", label: t("all_channels") }, ...channels.map((c) => ({ value: c, label: c }))],
        channelFilter,
        (value) => {
          channelFilter = value;
          renderFilterRow();
          renderList();
        }
      );
    });
  }

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
    if (channelFilter) customers = customers.filter((c) => c.sales_channel === channelFilter);
    if (assignmentFilter === "mine") customers = customers.filter((c) => c.assigned_manager_id === state.user.id);
    else if (assignmentFilter === "others") customers = customers.filter((c) => c.assigned_manager_id !== state.user.id);
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
        const idAndType = [c.erp_customer_id ? `ID: ${escapeHtml(String(c.erp_customer_id))}` : "", c.category ? escapeHtml(categoryLabel(c.category)) : ""]
          .filter(Boolean)
          .join(" &bull; ");

        // A plain sales manager sees their own book at full strength and
        // everyone else's customers dimmed -- they stay visible/searchable
        // (per the assignment filter above) but visually recede so the rep
        // stays focused on what's theirs. Every other role sees all
        // customers the same way.
        const isOthers =
          state.user.role === "sales_manager" && c.assigned_manager_id != null && c.assigned_manager_id !== state.user.id;

        return `
        <button class="card list-row ${isOthers ? "customer-card-unassigned" : ""}" data-id="${c.id}">
          ${customerListIconHtml(c)}
          <div class="list-row-body">
            <div class="list-row-top">
              <strong>${escapeHtml(c.name)}</strong>
            </div>
            ${idAndType ? `<div class="muted list-row-meta">${idAndType}</div>` : ""}
            <div class="muted list-row-meta">${lastVisit}</div>
            <div class="list-row-bottom">
              <span class="badge ${badgeClass}">${badgeText}</span>
              ${
                showDebt && c.debt_amd != null && Number(c.debt_amd) > 0
                  ? `<span class="customer-card-debt">${t("outstanding_debt_label")}: ${formatAmd(Number(c.debt_amd))}</span>`
                  : ""
              }
            </div>
          </div>
          <span class="chevron">&#8250;</span>
        </button>
      `;
      })
      .join("");

    listEl.querySelectorAll(".list-row").forEach((el) => {
      el.addEventListener("click", () => navigate(`#/customers/${el.dataset.id}`));
    });
  }

  function render() {
    renderStatsBar();
    renderFilterRow();
    renderList();
  }

  async function load() {
    listEl.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
    try {
      allCustomers = await api.listCustomers(showDebt ? { include_debt: 1 } : {});
      render();
    } catch (err) {
      listEl.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    }
  }

  searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(renderList, 300);
  });

  load();
}
