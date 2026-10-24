import { api } from "../api.js";
import { reorderChipHtml } from "../reorder.js";
import { customerMatchesSearch, escapeHtml, formatDateTime, formatAmd, haversineMeters, getCurrentPosition, customerListIconHtml, categoryLabel, activateDialog, channelDisplayLabel, TIER_OPTIONS, labelColon, openInfoPopup } from "../util.js";
import { t } from "../i18n.js";
import { icons } from "../icons.js";
import { state, seesAllActivity } from "../state.js";
import { loadWithCache } from "../listCache.js";
import { indexBrandSummary, brandSearchText, matchedEverEntries, matchesSelectedChips, buildBrandChipTree, chipHtml, shortDate } from "../brandChips.js";
import { buildRegionSubregionTree, buildDirectionManagerTree, openTriStateTreeSheet, NO_GROUP_KEY } from "../regionTree.js";
import { openTypeTierSheet } from "../typeTierSheet.js";
import { FILTER_ICONS } from "../filterIcons.js";
import { potentialChipHtml } from "../potential.js";
import { emptyPotentialFilter, potentialFilterCount, matchesPotentialFilter, comparePotentialPriority, openPotentialFilterSheet } from "../potentialFilterSheet.js";
import { deskHeadHtml, wireDeskHead, paintDeskHead } from "../deskTable.js";

// The Customers list loads in pages of this size (see load()).
const CUSTOMER_PAGE = 500;

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

const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export function renderCustomers(root, navigate, initialFilter, initialPotential = "") {
  root.innerHTML = `
    <div class="list-view">
      <div class="list-header">
        <h1>${t("nav_customers")}</h1>
        <button type="button" class="settings-hint-icon cl-legend-btn" id="cl-legend-btn" aria-label="${t("cl_legend_title")}">!</button>
        <button class="list-header-add-btn" id="toggle-debt-btn" aria-label="${t("show_outstanding_debt")}" title="${t("show_outstanding_debt")}" aria-pressed="false">${icons.payment}</button>
        <button class="list-header-add-btn customer-map-add-action" id="add-customer-btn" aria-label="${t("add_customer")}" title="${t("add_customer")}">${icons.mapPinPlus}</button>
      </div>

      <div class="customer-stats-bar" id="customer-stats-bar"></div>

      <div class="list-toolbar">
        <label class="visually-hidden" for="customer-search">${t("search_customers")}</label>
        <input type="search" id="customer-search" placeholder="${t("search_customers")}" aria-label="${t("search_customers")}" />
        <button class="icon-btn" id="sort-btn" type="button" aria-label="${t("sort")}" aria-haspopup="menu" aria-expanded="false" aria-controls="sort-menu">${icons.sort}</button>
        <div id="sort-menu" class="dropdown-menu" role="menu" hidden>
          <button class="sort-menu-item" role="menuitemradio" aria-checked="true" data-sort="name"><span>${t("sort_name")}</span><span class="sort-menu-arrow" aria-hidden="true"></span></button>
          <button class="sort-menu-item" role="menuitemradio" aria-checked="false" data-sort="last_visit"><span>${t("sort_last_visit")}</span><span class="sort-menu-arrow" aria-hidden="true"></span></button>
          <button class="sort-menu-item" role="menuitemradio" aria-checked="false" data-sort="last_added"><span>${t("sort_last_added")}</span><span class="sort-menu-arrow" aria-hidden="true"></span></button>
          <button class="sort-menu-item" role="menuitemradio" aria-checked="false" data-sort="distance"><span>${t("sort_distance")}</span><span class="sort-menu-arrow" aria-hidden="true"></span></button>
        </div>
      </div>
      <div class="customer-filter-row" id="customer-filter-row"></div>
      ${deskHeadHtml("desk-thead-customers", [
        { items: [{ label: t("desk_col_customer"), key: "name" }, { label: t("desk_col_added"), key: "last_added" }] },
        { items: [{ label: t("desk_col_last_visit"), key: "last_visit" }] },
      ])}
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
  // Every sort option reverses on a second tap of the same (already
  // active) menu item -- false is always each key's normal/default
  // direction (A-Z, soonest last visit first, nearest first, most
  // recently added first), reset back to false whenever a DIFFERENT key
  // is picked so switching sorts never silently carries over a reversal
  // from the previous one.
  let sortReversed = false;
  let myLocation = null;
  let searchTimer;
  // A Set of "region::subregion" keys, per regionTree.js's own leaf-id
  // contract (buildRegionSubregionTree/renderTriStateTree) -- empty means
  // no region filter is applied at all.
  let regionSubregionKeys = new Set();
  // Set of "channel::managerId" keys (buildDirectionManagerTree leaf ids); empty = no filter.
  let assignmentKeys = new Set();
  // Customer type (category or NO_GROUP_KEY) and tier chips, several of each at once; empty = no filter.
  let typeFilters = new Set();
  let tierFilters = new Set();
  // Set of "group:value" chip ids (brandChips.js); empty = no filter. A shop
  // passes when ANY visit ever recorded ANY selected product.
  let brandChipIds = new Set();
  // Potential filter (level, reason, last visit, follow-up, volume, counterfeit); a deep link from the dashboard (?potential=4,5) preselects levels.
  let potentialFilter = emptyPotentialFilter();
  for (const tok of String(initialPotential || "").split(",")) {
    if (/^[0-5]$/.test(tok)) potentialFilter.levels.add(Number(tok));
    else if (tok === "counterfeit") potentialFilter.counterfeit = true;
    else if (tok === "due") potentialFilter.followup = "due";
  }
  // customer id -> { current, ever } from GET /customers/brand-summary;
  // loaded after the list paints, so search/filter just ignore it until then.
  let brandSummary = new Map();
  // Off by default (per task spec: "to make app run faster") -- the debt
  // lookup is a real join server-side, not free, so it's opt-in per
  // session rather than always fetched with the rest of the list.
  let showDebt = false;
  const filterRow = root.querySelector("#customer-filter-row");
  // "!" next to the title: what the icon colours and the chips on this list mean.
  root.querySelector("#cl-legend-btn").addEventListener("click", () => {
    const tiers = TIER_OPTIONS.map((o) => `<div class="cl-legend-row">${customerListIconHtml({ customer_tier: o.value, category: "" })}<span>${escapeHtml(t(o.labelKey))}</span></div>`).join("");
    const chip = (cls, text, label) => `<div class="cl-legend-row"><span class="badge ${cls}">${escapeHtml(text)}</span><span class="muted">${escapeHtml(label)}</span></div>`;
    openInfoPopup(`
      <h3 class="oc-tier-title">${t("cl_legend_title")}</h3>
      <p><strong>${t("cl_legend_icon")}</strong></p>
      <div class="cl-legend-tiers">${tiers}</div>
      <p><strong>${t("cl_legend_chips")}</strong></p>
      <div class="cl-legend-chips">${["today", "recent", "overdue", "never"].map((k) => `<span class="badge ${STATUS_BADGE[k].cls}">${escapeHtml(t(STATUS_BADGE[k].labelKey))}</span>`).join("")}</div>
      ${chip("badge-info", t("reorder_chip"), t("cl_legend_due"))}
      ${chip("badge-warning", t("reorder_chip"), t("cl_legend_late"))}`);
  });
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
  // Desktop column headings: a click is the same as picking that item in the sort menu.
  const deskHead = root.querySelector(".desk-thead-customers");
  wireDeskHead(deskHead, (key) => sortMenu.querySelector(`[data-sort="${key}"]`)?.click());
  function paintSortArrows() {
    paintDeskHead(deskHead, sortKey, sortReversed);
    sortMenu.querySelectorAll("[data-sort]").forEach((item) => {
      const arrow = item.querySelector(".sort-menu-arrow");
      arrow.textContent = item.dataset.sort === sortKey ? (sortReversed ? "▲" : "▼") : "";
    });
  }
  sortMenu.querySelectorAll("[data-sort]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (btn.dataset.sort === sortKey) sortReversed = !sortReversed;
      else sortReversed = false;
      sortKey = btn.dataset.sort;
      sortMenu.hidden = true;
      sortBtn.setAttribute("aria-expanded", "false");
      sortMenu.querySelectorAll("button").forEach((item) => item.setAttribute("aria-checked", String(item === btn)));
      paintSortArrows();
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
  paintSortArrows();
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
        <div class="sheet-actions sheet-actions-floating">
          <button type="button" class="btn" id="multi-filter-clear">${t("clear")}</button>
          <button type="button" class="btn btn-primary" id="multi-filter-done">${t("show_results")}</button>
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
    const regionCount = new Set([...regionSubregionKeys].map((k) => k.split("::")[0])).size;

    const buttons = [
      // A sales_manager is now always scoped server-side to their own
      // customers (server/src/routes/customers.js) -- every row they can
      // see is already "assigned to me", so this filter has nothing left to
      // narrow for that role and just adds a confusing no-op control.
      seesAllActivity()
        ? filterIconButton({
            key: "assignment",
            icon: icons.person,
            label: t("filter_direction_manager_title"),
            active: assignmentKeys.size > 0,
            count: assignmentKeys.size,
          })
        : "",
      allCustomers.some((c) => c.region)
        ? filterIconButton({
            key: "region",
            icon: icons.pin,
            label: t("region"),
            active: regionCount > 0,
            count: regionCount,
          })
        : "",
      brandSummary.size
        ? filterIconButton({
            key: "brands",
            icon: icons.box,
            label: t("filter_brands_title"),
            active: brandChipIds.size > 0,
            count: brandChipIds.size,
          })
        : "",
      allCustomers.some((c) => c.customer_tier === "potential")
        ? filterIconButton({
            key: "potential",
            icon: FILTER_ICONS.potential,
            label: t("pf_title"),
            active: potentialFilterCount(potentialFilter) > 0,
            count: potentialFilterCount(potentialFilter),
          })
        : "",
      allCustomers.length
        ? filterIconButton({
            key: "channel",
            icon: icons.tag,
            label: t("filter_type_tier_title"),
            active: typeFilters.size + tierFilters.size > 0,
            count: typeFilters.size + tierFilters.size,
          })
        : "",
    ]
      .filter(Boolean)
      .join("");

    filterRow.innerHTML = buttons;

    filterRow.querySelector('[data-filter-btn="assignment"]')?.addEventListener("click", () => {
      openTriStateTreeSheet(t("filter_direction_manager_title"), {
        tree: buildDirectionManagerTree(allCustomers, {
          channelLabel: channelDisplayLabel,
          noDirectionLabel: t("no_direction"),
          unassignedLabel: t("unassigned"),
        }),
        initialSelectedIds: assignmentKeys,
        countUnitLabel: t("perf_dq_customers_unit"),
        onApply: (selectedIds) => {
          assignmentKeys = selectedIds;
          renderFilterRow();
          renderStatsBar();
          renderList();
        },
      });
    });

    filterRow.querySelector('[data-filter-btn="region"]')?.addEventListener("click", () => {
      openTriStateTreeSheet(t("region"), {
        tree: buildRegionSubregionTree(allCustomers.filter((c) => c.region)),
        initialSelectedIds: regionSubregionKeys,
        countUnitLabel: t("perf_dq_customers_unit"),
        onApply: (selectedIds) => {
          regionSubregionKeys = selectedIds;
          renderFilterRow();
          renderStatsBar();
          renderList();
        },
      });
    });

    filterRow.querySelector('[data-filter-btn="brands"]')?.addEventListener("click", () => {
      openTriStateTreeSheet(t("filter_brands_title"), {
        tree: buildBrandChipTree(brandSummary, allCustomers.map((c) => c.id)),
        initialSelectedIds: brandChipIds,
        countUnitLabel: t("perf_dq_customers_unit"),
        searchPlaceholder: t("search"),
        onApply: (selectedIds) => {
          brandChipIds = selectedIds;
          renderFilterRow();
          renderStatsBar();
          renderList();
        },
      });
    });

    filterRow.querySelector('[data-filter-btn="potential"]')?.addEventListener("click", () => {
      const saved = potentialFilter;
      potentialFilter = emptyPotentialFilter();
      const rows = applyNonStatusFilters(allCustomers).filter((c) => !filter || FILTER_STATUSES[filter]?.includes(visitStatus(c)));
      potentialFilter = saved;
      openPotentialFilterSheet({
        rows,
        filter: potentialFilter,
        today: localToday(),
        onApply: (next) => {
          potentialFilter = next;
          renderFilterRow();
          renderStatsBar();
          renderList();
        },
      });
    });

    filterRow.querySelector('[data-filter-btn="channel"]')?.addEventListener("click", () => {
      // The rows the list would show with no type/tier chip on (all other filters and the status pill stay as they are).
      const saved = [typeFilters, tierFilters];
      typeFilters = new Set();
      tierFilters = new Set();
      const rows = applyNonStatusFilters(allCustomers).filter((c) => !filter || FILTER_STATUSES[filter]?.includes(visitStatus(c)));
      [typeFilters, tierFilters] = saved;
      openTypeTierSheet({
        rows,
        types: typeFilters,
        tiers: tierFilters,
        onApply: (types, tiers) => {
          typeFilters = types;
          tierFilters = tiers;
          renderFilterRow();
          renderStatsBar();
          renderList();
        },
      });
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
    if (query) list = list.filter((c) => customerMatchesSearch(c, query, brandSearchText(brandSummary.get(c.id))));
    if (brandChipIds.size) list = list.filter((c) => matchesSelectedChips(brandSummary.get(c.id), brandChipIds));
    if (regionSubregionKeys.size) {
      list = list.filter((c) => c.region && regionSubregionKeys.has(`${c.region}::${c.subregion || NO_GROUP_KEY}`));
    }
    if (typeFilters.size) list = list.filter((c) => typeFilters.has(c.category || NO_GROUP_KEY));
    if (tierFilters.size) list = list.filter((c) => tierFilters.has(c.customer_tier || "potential"));
    if (potentialFilterCount(potentialFilter)) {
      const today = localToday();
      list = list.filter((c) => matchesPotentialFilter(c, potentialFilter, today));
    }
    if (assignmentKeys.size) {
      list = list.filter((c) => assignmentKeys.has(`${c.sales_channel || NO_GROUP_KEY}::${c.assigned_manager_id ?? NO_GROUP_KEY}`));
    }
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
    // With a potential filter on, the list is the follow-up worklist: very high potential first, no potential last, soonest follow-up next.
    if (potentialFilterCount(potentialFilter) && sortKey === "name" && !sortReversed) {
      sorted.sort((a, b) => comparePotentialPriority(a, b) || a.name.localeCompare(b.name));
      return sorted;
    }
    const flip = sortReversed ? -1 : 1;
    if (sortKey === "name") {
      sorted.sort((a, b) => flip * a.name.localeCompare(b.name));
    } else if (sortKey === "last_visit") {
      sorted.sort((a, b) => flip * (new Date(b.last_visit_at || 0) - new Date(a.last_visit_at || 0)));
    } else if (sortKey === "last_added") {
      sorted.sort((a, b) => flip * (new Date(b.created_at || 0) - new Date(a.created_at || 0)));
    } else if (sortKey === "distance" && myLocation) {
      sorted.sort(
        (a, b) =>
          flip * (haversineMeters(myLocation.lat, myLocation.lng, a.lat, a.lng) - haversineMeters(myLocation.lat, myLocation.lng, b.lat, b.lng))
      );
    }
    return sorted;
  }

  const CUSTOMER_BATCH = 100;
  let listShown = CUSTOMER_BATCH;
  let lastListKey = "";
  let moreObserver = null;
  // One delegated handler for every card (cards are appended batch by batch).
  listEl.addEventListener("click", (e) => {
    const row = e.target.closest(".list-row[data-id]");
    if (row && listEl.contains(row)) navigate(`#/customers/${row.dataset.id}`);
  });

  function renderList() {
    moreObserver?.disconnect();
    let customers = applyNonStatusFilters(allCustomers);
    if (FILTER_STATUSES[filter]) customers = customers.filter((c) => FILTER_STATUSES[filter].includes(visitStatus(c)));
    customers = sortCustomers(customers);

    if (!customers.length) {
      listEl.innerHTML = `<p class="empty-state">${t("no_customers_found")}</p>`;
      return;
    }

    // Only the first batch is built; the rest is appended as the list is scrolled (4,000 cards at once froze a phone for
    // seconds). A new search / filter / sort starts again from the first batch; a data refresh of the same list keeps
    // however far the person had scrolled.
    const listKey = `${customers.length}|${customers[0]?.id}|${customers[customers.length - 1]?.id}|${filter}|${searchInput.value}`;
    if (listKey !== lastListKey) {
      lastListKey = listKey;
      listShown = CUSTOMER_BATCH;
    }
    const cardHtml = (c) => {
        // Status word and last-visit date read as ONE line (e.g.
        // "Overdue &bull; Last visit: 23 Aug, 17:20"). Exempt channels get
        // the date only -- never a status word -- and a customer who has
        // never been visited gets the status word only, since there's no
        // date to pair it with.
        const badge = visitStatusBadge(c);
        const lastVisit = c.last_visit_at ? `${t("last_visit")}${labelColon()}${formatDateTime(c.last_visit_at)}` : "";
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
            ? `<span class="customer-card-debt">${t("outstanding_debt_label")}${labelColon()}${formatAmd(Number(c.debt_amd))}</span>`
            : "";
        const reorderChip = reorderChipHtml(c);
        const potentialChip = c.customer_tier === "potential" ? potentialChipHtml(c.potential_level) : "";
        const counterfeitMark = c.counterfeit_flag ? `<span class="badge badge-danger" title="${escapeHtml(t("pl_counterfeit_resolve"))}">⚠️</span>` : "";
        const bottomRow =
          badge || lastVisit || debtLabel || reorderChip || potentialChip || counterfeitMark
            ? `<div class="list-row-bottom">
              ${badge ? `<span class="badge ${badge.cls}">${t(badge.labelKey)}</span>` : ""}
              ${potentialChip}${counterfeitMark}
              ${reorderChip}
              ${lastVisit ? `<span class="muted list-row-meta">${lastVisit}</span>` : ""}
              ${debtLabel}
            </div>`
            : "";

        // Why this customer matched a product search/filter, e.g.
        // "Fake Castrol · 3 Oct" (the latest visit that recorded it).
        const matchedBrands = matchedEverEntries(brandSummary.get(c.id), { selectedIds: brandChipIds, query: searchInput.value });
        const brandRow = matchedBrands.length
          ? `<div class="list-row-bottom product-match-row">${matchedBrands.map((m) => chipHtml(m.def, shortDate(m.last_at))).join("")}</div>`
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
            ${brandRow}
          </div>
          <span class="chevron">&#8250;</span>
        </button>
      `;
    };
    const paintMore = () => {
      moreObserver?.disconnect();
      listEl.querySelector("#customer-list-more")?.remove();
      const from = listEl.querySelectorAll(".list-row").length;
      const to = Math.min(customers.length, listShown);
      if (to > from) listEl.insertAdjacentHTML("beforeend", customers.slice(from, to).map(cardHtml).join(""));
      if (customers.length > to) {
        listEl.insertAdjacentHTML("beforeend", `<div id="customer-list-more" class="list-more" aria-hidden="true"></div>`);
        if (typeof IntersectionObserver === "function") {
          // The page scrolls inside <main id="app">, not the window: observe relative to that scroller so the margin counts
          // (an ancestor's clip hides the sentinel from a viewport-rooted observer until the very end).
          let scroller = listEl.parentElement;
          while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
          moreObserver = new IntersectionObserver(
            (entries) => {
              if (!entries.some((e) => e.isIntersecting)) return;
              listShown += CUSTOMER_BATCH;
              paintMore();
            },
            { root: scroller || null, rootMargin: "900px 0px" }
          );
          moreObserver.observe(listEl.querySelector("#customer-list-more"));
        } else {
          listShown = customers.length;
          paintMore();
        }
      }
    };
    listEl.innerHTML = "";
    paintMore();
  }

  function render() {
    renderStatsBar();
    renderFilterRow();
    renderList();
  }

  async function load() {
    // Stale-while-revalidate (see listCache.js): show last session's list
    // instantly, then swap in the live one the moment it arrives, instead
    // of a loading spinner every single time this screen opens. Keyed by
    // showDebt since that toggle changes the shape of the data (an extra
    // debt column/join), not just a filter over what's already fetched.
    // Only shown if there's no cached list to paint over it immediately --
    // set here rather than left from before so a debt-toggle reload (which
    // calls load() again) doesn't flash a blank loading state over an
    // already-visible list while its own cache lookup resolves.
    listEl.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
    let paintedOnce = false;
    try {
      await loadWithCache(
        `customers-list:${showDebt ? "with-debt" : "plain"}`,
        async () => {
          // Pages of 500 (about the whole customer list of the company today), so the list on screen no longer
          // waits for the last customer to download as the company grows. With a cached list already showing it is
          // left alone until every page is in (it would shrink to 500 for a moment otherwise); with nothing showing
          // yet, the first page paints at once and the rest are added behind it.
          const all = [];
          let cursor = {};
          for (;;) {
            const rows = await api.listCustomers({ ...(showDebt ? { include_debt: 1 } : {}), limit: CUSTOMER_PAGE, ...cursor });
            all.push(...rows);
            if (rows.length < CUSTOMER_PAGE) break;
            const last = rows[rows.length - 1];
            cursor = { after_name: last.name, after_id: last.id };
            if (!paintedOnce) {
              allCustomers = all.slice();
              render();
              paintedOnce = true;
            }
          }
          return all;
        },
        (data) => {
          allCustomers = data;
          render();
          paintedOnce = true;
        }
      );
    } catch (err) {
      if (!paintedOnce) listEl.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    }
  }

  // Products recorded at visits (for product search/filter). Best-effort:
  // a failure just leaves the product search/filter off.
  async function loadBrandSummary() {
    try {
      await loadWithCache("customers-brand-summary", () => api.getBrandSummary(), (rows) => {
        brandSummary = indexBrandSummary(rows);
        render();
      });
    } catch {
      /* optional feature */
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
  loadBrandSummary();
}
