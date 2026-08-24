import { api } from "../api.js";
import { escapeHtml, formatDistance } from "../util.js";
import { t } from "../i18n.js";
import { seesAllActivity } from "../state.js";

const OUTCOMES = [
  "order_placed",
  "no_order",
  "payment_collected",
  "follow_up_required",
  "customer_unavailable",
  "complaint",
  "stock_issue",
  "other",
];

const PAGE_SIZE = 15;

const STATUS_ICON = {
  verified: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5 9-10"/></svg>`,
  pending: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/></svg>`,
  rejected: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8v5"/><circle cx="12" cy="16.5" r="0.6" fill="#fff" stroke="none"/><circle cx="12" cy="12" r="9"/></svg>`,
};

function checkinStatus(c) {
  if (!c.within_range) return "rejected";
  if (c.outcome === "follow_up_required") return "pending";
  return "verified";
}

function formatActivityDate(iso) {
  const d = new Date(iso);
  const now = new Date();
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const isSameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);

  if (isSameDay(d, now)) return `${t("tab_today")}, ${time}`;
  if (isSameDay(d, yesterday)) return `${t("yesterday")}, ${time}`;
  return `${d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}, ${time}`;
}

export async function renderActivity(root, navigate) {
  root.innerHTML = `<div class="activity-view"><p class="loading-state" role="status">${t("loading")}</p></div>`;
  const container = root.querySelector(".activity-view");

  const canFilterByManager = seesAllActivity();

  let range = "week";
  let customFrom = "";
  let customTo = "";
  let allCheckins = [];
  let visibleCount = PAGE_SIZE;
  let filtersOpen = true;
  let sortAsc = false;
  let openDropdown = null;

  const filters = { search: "", manager: "", status: "", outcome: "" };

  const STATUS_OPTIONS = [
    { value: "", label: t("all_status") },
    { value: "verified", label: t("verified") },
    { value: "pending", label: t("status_pending") },
    { value: "rejected", label: t("status_rejected") },
  ];
  const OUTCOME_OPTIONS = [
    { value: "", label: t("all_outcomes") },
    ...OUTCOMES.map((o) => ({ value: o, label: t(`outcome_${o}`) })),
  ];

  const CHEVRON_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>`;

  // Native <select> popovers on iOS render as a full-width dark OS sheet
  // that overlaps the stat cards/list below -- these dropdowns use the same
  // in-page custom-menu pattern already used for Customers' sort menu
  // instead, so the list stays fully visible and the app controls its own
  // layout.
  function dropdownHtml(key, options, currentValue) {
    const current = options.find((o) => o.value === currentValue) ?? options[0];
    return `
      <div class="filter-dropdown-wrap">
        <button type="button" class="filter-dropdown-btn" data-dropdown="${key}" aria-haspopup="menu" aria-expanded="${openDropdown === key}" aria-controls="filter-menu-${key}">
          <span>${escapeHtml(current.label)}</span>
          ${CHEVRON_ICON}
        </button>
        <div class="filter-dropdown-menu" id="filter-menu-${key}" role="menu" data-dropdown-menu="${key}" ${openDropdown === key ? "" : "hidden"}>
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

  function statusMeta(status) {
    if (status === "verified") return { cls: "status-verified", badge: "badge-success", label: t("verified") };
    if (status === "pending") return { cls: "status-pending", badge: "badge-warning", label: t("status_pending") };
    return { cls: "status-rejected", badge: "badge-danger", label: t("status_rejected") };
  }

  function computeStats(list) {
    const total = list.length;
    const verified = list.filter((c) => checkinStatus(c) === "verified").length;
    const rejected = list.filter((c) => checkinStatus(c) === "rejected").length;
    const pending = list.filter((c) => checkinStatus(c) === "pending").length;
    const pct = (n) => (total ? `${((n / total) * 100).toFixed(1)}%` : "—");
    return { total, verified, rejected, pending, verifiedPct: pct(verified), rejectedPct: pct(rejected), pendingPct: pct(pending) };
  }

  function managerOptions() {
    const seen = new Map();
    for (const c of allCheckins) {
      if (!seen.has(c.user_id)) seen.set(c.user_id, c.user_name);
    }
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }

  function applyFilters() {
    let list = allCheckins;
    if (filters.manager) list = list.filter((c) => String(c.user_id) === filters.manager);
    if (filters.status) list = list.filter((c) => checkinStatus(c) === filters.status);
    if (filters.outcome) list = list.filter((c) => c.outcome === filters.outcome);
    if (filters.search.trim()) {
      const q = filters.search.trim().toLowerCase();
      list = list.filter((c) => c.customer_name.toLowerCase().includes(q));
    }
    list = [...list].sort((a, b) =>
      sortAsc ? new Date(a.timestamp) - new Date(b.timestamp) : new Date(b.timestamp) - new Date(a.timestamp)
    );
    return list;
  }

  function renderShell() {
    const stats = computeStats(allCheckins);
    container.innerHTML = `
      <div class="list-header">
        <div>
          <h1>${t("nav_activity")}</h1>
          <p class="muted">${t("activity_subtitle")}</p>
        </div>
        <button class="btn btn-sm" id="toggle-filters-btn">${t("filters")}</button>
      </div>

      <div class="activity-tabs" role="tablist">
        <button role="tab" aria-selected="${range === "today"}" class="activity-tab ${range === "today" ? "activity-tab-active" : ""}" data-range="today">${t("tab_today")}</button>
        <button role="tab" aria-selected="${range === "week"}" class="activity-tab ${range === "week" ? "activity-tab-active" : ""}" data-range="week">${t("tab_week")}</button>
        <button role="tab" aria-selected="${range === "month"}" class="activity-tab ${range === "month" ? "activity-tab-active" : ""}" data-range="month">${t("tab_month")}</button>
        <button role="tab" aria-selected="${range === "custom"}" class="activity-tab ${range === "custom" ? "activity-tab-active" : ""}" data-range="custom">${t("tab_custom")}</button>
      </div>

      ${
        range === "custom"
          ? `<div class="activity-custom-range">
              <label>${t("date_from")}<input type="date" id="custom-from" value="${customFrom}" /></label>
              <label>${t("date_to")}<input type="date" id="custom-to" value="${customTo}" /></label>
            </div>`
          : ""
      }

      <div class="stat-grid activity-stat-grid">
        <div class="stat-card"><span class="stat-value">${stats.total}</span><span class="stat-label">${t("stat_total_visits")}</span><span class="stat-sublabel">${t("stat_all_checkins")}</span></div>
        <div class="stat-card"><span class="stat-value">${stats.verified}</span><span class="stat-label">${t("verified")}</span><span class="stat-sublabel">${stats.verifiedPct}</span></div>
        <div class="stat-card"><span class="stat-value">${stats.rejected}</span><span class="stat-label">${t("status_rejected")}</span><span class="stat-sublabel">${stats.rejectedPct}</span></div>
        <div class="stat-card"><span class="stat-value">${stats.pending}</span><span class="stat-label">${t("status_pending")}</span><span class="stat-sublabel">${stats.pendingPct}</span></div>
      </div>

      <div class="activity-filters" id="activity-filters" ${filtersOpen ? "" : "hidden"}>
        <label class="visually-hidden" for="activity-search">${t("search_customers")}</label>
        <input type="search" id="activity-search" placeholder="${t("search_customers")}" value="${escapeHtml(filters.search)}" />
        <div class="activity-filter-row">
          ${
            canFilterByManager
              ? dropdownHtml(
                  "manager",
                  [{ value: "", label: t("all_managers") }, ...managerOptions().map(([id, name]) => ({ value: String(id), label: name }))],
                  filters.manager
                )
              : ""
          }
          ${dropdownHtml("status", STATUS_OPTIONS, filters.status)}
          ${dropdownHtml("outcome", OUTCOME_OPTIONS, filters.outcome)}
          <button class="icon-btn" id="sort-toggle-btn" aria-label="${t("sort")}" style="transform: scaleY(${sortAsc ? -1 : 1})">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v16M12 20l-5-5M12 20l5-5"/></svg>
          </button>
        </div>
      </div>

      <div class="activity-count" id="activity-count"></div>
      <div class="card-list" id="activity-list"></div>
      <button class="btn btn-block" id="activity-load-more" hidden>${t("load_more")}</button>
    `;

    root.querySelector("#toggle-filters-btn").addEventListener("click", () => {
      filtersOpen = !filtersOpen;
      renderShell();
    });

    container.querySelectorAll(".activity-tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        range = btn.dataset.range;
        visibleCount = PAGE_SIZE;
        renderShell();
        load();
      });
      btn.addEventListener("keydown", (e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        const tabs = [...container.querySelectorAll(".activity-tab")];
        const delta = e.key === "ArrowRight" ? 1 : -1;
        tabs[(tabs.indexOf(btn) + delta + tabs.length) % tabs.length]?.click();
        requestAnimationFrame(() => {
          const selected = container.querySelector(`.activity-tab[data-range="${range}"]`);
          selected?.focus();
        });
      });
    });

    if (range === "custom") {
      const fromInput = container.querySelector("#custom-from");
      const toInput = container.querySelector("#custom-to");
      const onCustomChange = () => {
        customFrom = fromInput.value;
        customTo = toInput.value;
        if (customFrom && customTo) {
          visibleCount = PAGE_SIZE;
          load();
        }
      };
      fromInput.addEventListener("change", onCustomChange);
      toInput.addEventListener("change", onCustomChange);
    }

    const searchInput = container.querySelector("#activity-search");
    let searchTimer;
    searchInput.addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        filters.search = searchInput.value;
        visibleCount = PAGE_SIZE;
        renderList();
      }, 250);
    });

    container.querySelectorAll("[data-dropdown]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const key = btn.dataset.dropdown;
        openDropdown = openDropdown === key ? null : key;
        renderShell();
        if (openDropdown) requestAnimationFrame(() => container.querySelector(`[data-dropdown-menu="${key}"] button`)?.focus());
      });
      btn.addEventListener("keydown", (e) => {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          openDropdown = btn.dataset.dropdown;
          renderShell();
          requestAnimationFrame(() => container.querySelector(`[data-dropdown-menu="${openDropdown}"] button`)?.focus());
        }
      });
    });
    container.querySelectorAll("[data-dropdown-menu] button").forEach((optBtn) => {
      optBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const key = optBtn.closest("[data-dropdown-menu]").dataset.dropdownMenu;
        if (key === "manager") filters.manager = optBtn.dataset.value;
        else if (key === "status") filters.status = optBtn.dataset.value;
        else if (key === "outcome") filters.outcome = optBtn.dataset.value;
        openDropdown = null;
        visibleCount = PAGE_SIZE;
        renderShell();
      });
    });
    container.querySelector("#sort-toggle-btn").addEventListener("click", () => {
      sortAsc = !sortAsc;
      renderShell();
      renderList();
    });

    renderList();
  }

  container.addEventListener("click", () => {
    if (openDropdown) {
      openDropdown = null;
      renderShell();
    }
  });

  container.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && openDropdown) {
      const key = openDropdown;
      openDropdown = null;
      renderShell();
      requestAnimationFrame(() => container.querySelector(`[data-dropdown="${key}"]`)?.focus());
    }
  });

  function renderList() {
    const listEl = container.querySelector("#activity-list");
    const countEl = container.querySelector("#activity-count");
    const loadMoreBtn = container.querySelector("#activity-load-more");
    const filtered = applyFilters();

    countEl.textContent = `${filtered.length} ${t("visits_count")}`;

    if (!filtered.length) {
      listEl.innerHTML = `<p class="empty-state">${t("no_activity_found")}</p>`;
      loadMoreBtn.hidden = true;
      return;
    }

    const visible = filtered.slice(0, visibleCount);
    listEl.innerHTML = visible
      .map((c) => {
        const status = checkinStatus(c);
        const meta = statusMeta(status);
        const outcomeLabel = c.outcome ? t(`outcome_${c.outcome}`) : "";
        const distanceLabel = status === "rejected" ? `${formatDistance(c.distance_meters)} ${t("away")}` : formatDistance(c.distance_meters);
        return `
        <button class="card activity-row-rich" data-customer-id="${c.customer_id}">
          <span class="activity-status-icon ${meta.cls}">${STATUS_ICON[status]}</span>
          <div class="activity-row-body">
            <div class="activity-row-top">
              <strong>${escapeHtml(c.customer_name)}</strong>
              <span class="activity-row-trailing ${status === "rejected" ? "activity-distance-danger" : "muted"}">${distanceLabel}</span>
            </div>
            <div class="muted activity-row-meta">${escapeHtml(c.user_name)} · ${formatActivityDate(c.timestamp)}</div>
            <div class="activity-row-bottom">
              <span class="badge ${meta.badge}">${meta.label}</span>
              ${outcomeLabel ? `<span class="muted">${escapeHtml(outcomeLabel)}</span>` : ""}
            </div>
          </div>
          <span class="chevron">&#8250;</span>
        </button>
      `;
      })
      .join("");

    listEl.querySelectorAll(".activity-row-rich").forEach((el) => {
      el.addEventListener("click", () => navigate(`#/customers/${el.dataset.customerId}`));
    });

    loadMoreBtn.hidden = visibleCount >= filtered.length;
    loadMoreBtn.onclick = () => {
      visibleCount += PAGE_SIZE;
      renderList();
    };
  }

  async function load() {
    const params = {};
    if (range === "custom") {
      if (customFrom) params.from = customFrom;
      if (customTo) params.to = customTo;
    } else {
      params.range = range;
    }

    try {
      allCheckins = range === "custom" && (!customFrom || !customTo) ? [] : await api.listCheckins(params);
    } catch (err) {
      container.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
      return;
    }
    renderShell();
  }

  load();
}
