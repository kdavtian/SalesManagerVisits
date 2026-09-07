import { api } from "../api.js";
import { escapeHtml, formatDateTime, formatAmd, haversineMeters, getCurrentPosition, customerListIconHtml, categoryLabel, activateDialog, channelDisplayLabel } from "../util.js";
import { t } from "../i18n.js";
import { icons } from "../icons.js";
import { state, seesAllActivity } from "../state.js";

const FILTERS = [
  { key: "", labelKey: "filter_all" },
  { key: "visited", labelKey: "filter_visited" },
  { key: "overdue", labelKey: "filter_overdue" },
  { key: "not_visited", labelKey: "filter_not_visited" },
];

// One derived visit status per customer, used for BOTH the stat-pill counts
// and each row's badge so the two can never disagree (they used to: the
// pills counted "not visited" as "no check-in in the last 7 days" while
// "overdue" was computed from each customer's own visit_frequency_days, so
// a customer on a 30-day cadence visited 10 days ago was counted as
// "Not visited" even though they were perfectly on schedule -- and exempt
// channels were counted too).
//
// The buckets are mutually exclusive and evaluated in this order:
//   exempt   -- channel is never visited in the field (server's
//               requires_visit flag, i.e. KF/CAS/CVO/PCO/OEM) or the record
//               is a competitor, not a customer: never labelled at all.
//   today    -- checked in today.
//   never    -- no check-in has ever been recorded. Ranked ABOVE overdue
//               because the server counts a never-visited customer as
//               overdue too, and "Not visited" is both the more specific
//               and the more actionable of the two labels -- if it lost
//               the tie, the "Not visited" pill could only ever show 0.
//   overdue  -- visited before, but past their own visit_frequency_days
//               window.
//   recent   -- visited within the last 7 days and not overdue.
//   on_track -- visited longer ago than that but still inside their own
//               cadence window. Deliberately carries no status word:
//               labelling these "Not visited" was the actual bug, since a
//               customer on a 30-day cadence visited 10 days ago is on
//               schedule, not neglected.
// Exported so the customer DETAIL header derives its status badge from this
// exact function rather than re-deriving one of its own -- the two screens
// disagreeing was the bug this helper was written to fix in the first place.
export function visitStatus(c) {
  // `visit_required` is set to false by the competitor policy wrapper;
  // `requires_visit` is the server's channel-exemption flag.
  if (c.requires_visit === false || c.visit_required === false) return "exempt";
  if (c.visited_today) return "today";
  if (!c.last_visit_at) return "never";
  if (c.overdue) return "overdue";
  if (c.visited_this_week) return "recent";
  return "on_track";
}

export const STATUS_BADGE = {
  today: { cls: "badge-success", labelKey: "visited_today" },
  overdue: { cls: "badge-danger", labelKey: "filter_overdue" },
  recent: { cls: "badge-info", labelKey: "visited_this_week" },
  never: { cls: "badge-neutral", labelKey: "never_visited" },
};

// The badge (class + label key) for a customer's derived visit status, or
// null for a status that deliberately carries no badge (exempt/on_track).
// A never-visited customer whose cadence window has already elapsed is
// genuinely urgent, so it keeps the alarming colour even though the more
// specific "Not visited" wording wins over "Overdue".
export function visitStatusBadge(c) {
  const status = visitStatus(c);
  if (status === "never" && c.overdue) return { ...STATUS_BADGE.never, cls: "badge-danger" };
  return STATUS_BADGE[status] ?? null;
}

// Which derived statuses each stat pill / list filter selects.
const FILTER_STATUSES = {
  visited: ["today", "recent"],
  overdue: ["overdue"],
  not_visited: ["never"],
};

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
  // Sales channel is the one filter where "show me A OR B" is a real query
  // (e.g. comparing two distribution channels side by side), so it's a
  // multi-select Set rather than the single-value strings above.
  let channelFilters = new Set();
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

  function filterIconButton({ key, icon, label, active, count, onClick }) {
    // A multi-select filter shows how many are selected right on the
    // button (e.g. "Direction (2)") -- same active-state visual language
    // (tinted icon + dot) as every single-value filter button, just with
    // an accessible-name suffix so screen readers get the count too.
    const a11yLabel = count > 1 ? `${label} (${count})` : label;
    // data-filter-count survives unifiedSearchEnhancements.js's innerHTML
    // rewrite of this button (it restyles these buttons for the combined
    // search bar and rebuilds their icon/dot markup from scratch on every
    // re-render) -- carrying the count as an attribute, not just as markup,
    // is what lets that script also show the "(2)" badge in its own markup.
    return `<button type="button" class="filter-icon-btn ${active ? "filter-icon-btn-active" : ""}" data-filter-btn="${key}" data-filter-count="${count || 0}" aria-label="${escapeHtml(a11yLabel)}" title="${escapeHtml(a11yLabel)}">
      ${icon}
      ${count > 1 ? `<span class="filter-icon-count" aria-hidden="true">${count}</span>` : active ? `<span class="filter-icon-dot" aria-hidden="true"></span>` : ""}
    </button>`;
  }

  // Checkbox-style bottom sheet for filters where selecting more than one
  // value is a real, useful query (see channelFilters above) -- unlike
  // openFilterSheet, tapping an option toggles it without closing the
  // sheet; the selection only commits when Done is tapped (Cancel via the
  // overlay/backdrop discards it, matching how the single-select sheet's
  // tap-to-close-with-that-value reads as "commit immediately").
  function openMultiFilterSheet(titleText, options, currentSet, onApply) {
    const working = new Set(currentSet);
    const overlay = document.createElement("div");
    overlay.className = "sheet-overlay";
    overlay.innerHTML = `
      <div class="sheet filter-sheet">
        <h2>${escapeHtml(titleText)}</h2>
        <div class="filter-sheet-options">
          ${options
            .map(
              (o) => `
            <button type="button" class="filter-sheet-option ${working.has(o.value) ? "filter-sheet-option-selected" : ""}" data-value="${escapeHtml(o.value)}">
              <span>${escapeHtml(o.label)}</span>
              <span class="filter-sheet-check" ${working.has(o.value) ? "" : "hidden"}>${icons.checkCircle}</span>
            </button>
          `
            )
            .join("")}
        </div>
        <div class="sheet-actions">
          <button type="button" class="btn" id="multi-filter-clear">${t("clear")}</button>
          <button type="button" class="btn btn-primary" id="multi-filter-done">${t("done")}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    activateDialog(overlay);
    overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());
    overlay.querySelectorAll(".filter-sheet-option").forEach((btn) => {
      btn.addEventListener("click", () => {
        const value = btn.dataset.value;
        if (working.has(value)) working.delete(value);
        else working.add(value);
        btn.classList.toggle("filter-sheet-option-selected", working.has(value));
        btn.querySelector(".filter-sheet-check").hidden = !working.has(value);
      });
    });
    overlay.querySelector("#multi-filter-clear").addEventListener("click", () => {
      working.clear();
      overlay.remove();
      onApply(working);
    });
    overlay.querySelector("#multi-filter-done").addEventListener("click", () => {
      overlay.remove();
      onApply(working);
    });
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
        ? filterIconButton({
            key: "channel",
            icon: icons.route,
            label: t("filter_direction_title"),
            active: channelFilters.size > 0,
            count: channelFilters.size,
          })
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
          renderStatsBar();
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
          renderStatsBar();
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
          renderStatsBar();
          renderList();
        }
      );
    });

    filterRow.querySelector('[data-filter-btn="channel"]')?.addEventListener("click", () => {
      openMultiFilterSheet(
        t("filter_direction_title"),
        channels.map((c) => ({ value: c, label: channelDisplayLabel(c) })),
        channelFilters,
        (selected) => {
          channelFilters = selected;
          renderFilterRow();
          renderStatsBar();
          renderList();
        }
      );
    });
  }

  // Every filter EXCEPT the visited/overdue/not_visited tri-state, applied
  // once and shared by both the pill counts and the list -- so a region
  // filter (say) narrows the pill numbers to that region, but the pill
  // you're currently sitting on never narrows its own sibling counts (the
  // tri-state itself is applied separately, on top, only for the list).
  function applyNonStatusFilters(customers) {
    let list = customers;
    const query = searchInput.value.trim().toLowerCase();
    if (query) list = list.filter((c) => c.name.toLowerCase().includes(query));
    if (regionFilter) list = list.filter((c) => c.region === regionFilter);
    if (subregionFilter) list = list.filter((c) => c.subregion === subregionFilter);
    if (channelFilters.size) list = list.filter((c) => c.sales_channel && channelFilters.has(c.sales_channel));
    if (assignmentFilter === "mine") list = list.filter((c) => c.assigned_manager_id === state.user.id);
    else if (assignmentFilter === "others") list = list.filter((c) => c.assigned_manager_id !== state.user.id);
    return list;
  }

  function renderStatsBar() {
    const base = applyNonStatusFilters(allCustomers);
    const counts = {
      "": base.length,
      visited: 0,
      overdue: 0,
      not_visited: 0,
    };
    for (const c of base) {
      const status = visitStatus(c);
      for (const [key, statuses] of Object.entries(FILTER_STATUSES)) {
        if (statuses.includes(status)) counts[key] += 1;
      }
    }
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
    // While the debt view is on, the whole point of the list is "who owes us
    // the most", so debt DESC overrides the chosen sort for the duration --
    // sortKey itself is left untouched, so flipping the toggle back off
    // restores whatever order the user had picked rather than resetting it.
    if (showDebt) {
      sorted.sort((a, b) => {
        const debtA = Number(a.debt_amd) || 0;
        const debtB = Number(b.debt_amd) || 0;
        // Customers with no debt at all sort last, then alphabetically among
        // themselves so that tail of the list stays readable.
        if (debtA !== debtB) return debtB - debtA;
        return a.name.localeCompare(b.name);
      });
      return sorted;
    }
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
    let customers = applyNonStatusFilters(allCustomers);
    if (FILTER_STATUSES[filter]) customers = customers.filter((c) => FILTER_STATUSES[filter].includes(visitStatus(c)));
    customers = sortCustomers(customers);

    if (!customers.length) {
      listEl.innerHTML = `<p class="empty-state">${t("no_customers_found")}</p>`;
      return;
    }

    listEl.innerHTML = customers
      .map((c) => {
        // Status word and last-visit date read as ONE line (e.g.
        // "Overdue &bull; Last visit: 23 Aug, 17:20"). Exempt channels get
        // the date only -- never a status word -- and a customer who has
        // never been visited gets the status word only, since there's no
        // date to pair it with.
        const badge = visitStatusBadge(c);
        const lastVisit = c.last_visit_at ? `${t("last_visit")}: ${formatDateTime(c.last_visit_at)}` : "";
        const idAndType = [
          c.erp_customer_id ? `ID: ${escapeHtml(String(c.erp_customer_id))}` : "",
          c.category ? escapeHtml(categoryLabel(c.category)) : "",
          c.sales_channel ? escapeHtml(channelDisplayLabel(String(c.sales_channel))) : "",
        ]
          .filter(Boolean)
          .join(" &bull; ");

        // A plain sales manager sees their own book at full strength and
        // everyone else's customers dimmed -- they stay visible/searchable
        // (per the assignment filter above) but visually recede so the rep
        // stays focused on what's theirs. Every other role sees all
        // customers the same way.
        const isOthers =
          state.user.role === "sales_manager" && c.assigned_manager_id != null && c.assigned_manager_id !== state.user.id;

        const debtLabel =
          showDebt && c.debt_amd != null && Number(c.debt_amd) > 0
            ? `<span class="customer-card-debt">${t("outstanding_debt_label")}: ${formatAmd(Number(c.debt_amd))}</span>`
            : "";
        const bottomRow =
          badge || lastVisit || debtLabel
            ? `<div class="list-row-bottom">
              ${badge ? `<span class="badge ${badge.cls}">${t(badge.labelKey)}</span>` : ""}
              ${lastVisit ? `<span class="muted list-row-meta">${lastVisit}</span>` : ""}
              ${debtLabel}
            </div>`
            : "";

        return `
        <button class="card list-row ${isOthers ? "customer-card-unassigned" : ""}" data-id="${c.id}">
          ${customerListIconHtml(c)}
          <div class="list-row-body">
            <div class="list-row-top">
              <strong>${escapeHtml(c.name)}</strong>
            </div>
            ${idAndType ? `<div class="muted list-row-meta">${idAndType}</div>` : ""}
            ${bottomRow}
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
    searchTimer = setTimeout(() => {
      renderStatsBar();
      renderList();
    }, 300);
  });

  load();
}
