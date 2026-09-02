import { api } from "../api.js";
import { escapeHtml, formatDistance, formatAmd } from "../util.js";
import { t, getLang } from "../i18n.js";
import { seesAllActivity } from "../state.js";

const OUTCOMES = [
  "order_placed",
  "no_order",
  "payment_collected",
  "follow_up_required",
  "assortment_check",
  "customer_unavailable",
  "complaint",
  "other",
];

const PAGE_SIZE = 15;

const STATUS_ICON = {
  verified: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5 9-10"/></svg>`,
  pending: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/></svg>`,
  rejected: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8v5"/><circle cx="12" cy="16.5" r="0.6" fill="#fff" stroke="none"/><circle cx="12" cy="12" r="9"/></svg>`,
};

const ACTIVITY_FILTER_ICONS = {
  manager: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="3"/><circle cx="17.5" cy="8.6" r="2.35"/><path d="M3.5 20v-1.2A5.5 5.5 0 0 1 9 13.3h.1a5.5 5.5 0 0 1 5.5 5.5V20"/><path d="M15.1 13.8c.7-.35 1.5-.55 2.35-.55A4.55 4.55 0 0 1 22 17.8V20"/></svg>`,
  status: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.75"/><path d="m7.9 12.1 2.6 2.7 5.8-6"/></svg>`,
  outcome: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="3.75" width="14" height="16.5" rx="2.5"/><path d="M9 3.75v-.5A1.25 1.25 0 0 1 10.25 2h3.5A1.25 1.25 0 0 1 15 3.25v.5"/><path d="m8.5 11.7 1.8 1.8 4.7-5"/><path d="M8.5 17h7"/></svg>`,
  sort: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 4v16M4 7l3-3 3 3M17 20V4M14 17l3 3 3-3"/></svg>`,
};

function checkinOutcomes(c) {
  if (c.outcomes?.length) return c.outcomes;
  return c.outcome ? [c.outcome] : [];
}

function checkinStatus(c) {
  if (!c.within_range) return "rejected";
  if (checkinOutcomes(c).includes("follow_up_required")) return "pending";
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
  const isHy = getLang() === "hy";

  let range = "today";
  let customFrom = "";
  let customTo = "";
  let allCheckins = [];
  let checkinsCapped = false;
  let visibleCount = PAGE_SIZE;
  let sortMode = "newest";
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
  const SORT_OPTIONS = [
    { value: "newest", label: isHy ? "Նորերը սկզբում" : "Newest first" },
    { value: "oldest", label: isHy ? "Հները սկզբում" : "Oldest first" },
    ...(canFilterByManager ? [{ value: "manager", label: isHy ? "Ըստ վաճառքի մենեջերի" : "By sales manager" }] : []),
  ];

  function iconDropdownHtml(key, options, currentValue, icon, label, isApplied = Boolean(currentValue)) {
    const isOpen = openDropdown === key;
    return `
      <div class="activity-icon-dropdown">
        <button type="button"
          class="activity-search-filter-btn ${isApplied ? "activity-search-filter-btn-active" : ""} ${isOpen ? "activity-search-filter-btn-open" : ""}"
          data-dropdown="${key}"
          aria-label="${escapeHtml(label)}"
          title="${escapeHtml(label)}"
          aria-haspopup="menu"
          aria-expanded="${isOpen}"
          aria-controls="activity-filter-menu-${key}">
          ${icon}
          ${isApplied ? `<span class="activity-search-filter-dot" aria-hidden="true"></span>` : ""}
        </button>
        <div class="activity-search-menu" id="activity-filter-menu-${key}" role="menu" data-dropdown-menu="${key}" ${isOpen ? "" : "hidden"}>
          ${options.map((o) => `<button type="button" role="menuitemradio" aria-checked="${o.value === currentValue}" data-value="${escapeHtml(o.value)}" class="${o.value === currentValue ? "filter-dropdown-selected" : ""}"><span>${escapeHtml(o.label)}</span>${o.value === currentValue ? `<span class="activity-menu-check" aria-hidden="true">✓</span>` : ""}</button>`).join("")}
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
    if (filters.outcome) list = list.filter((c) => checkinOutcomes(c).includes(filters.outcome));
    if (filters.search.trim()) {
      const q = filters.search.trim().toLowerCase();
      list = list.filter((c) => c.customer_name.toLowerCase().includes(q));
    }

    list = [...list].sort((a, b) => {
      if (sortMode === "oldest") return new Date(a.timestamp) - new Date(b.timestamp);
      if (sortMode === "manager") {
        const byManager = String(a.user_name || "").localeCompare(String(b.user_name || ""), undefined, { sensitivity: "base" });
        if (byManager !== 0) return byManager;
        return new Date(b.timestamp) - new Date(a.timestamp);
      }
      return new Date(b.timestamp) - new Date(a.timestamp);
    });
    return list;
  }

  function renderShell() {
    const stats = computeStats(allCheckins);
    const managerLabel = t("all_managers");
    const statusLabel = t("all_status");
    const outcomeLabel = t("all_outcomes");
    const sortLabel = isHy ? "Դասավորել" : t("sort");

    container.innerHTML = `
      <div class="list-header">
        <div><h1>${t("nav_activity")}</h1></div>
      </div>

      <div class="activity-tabs" role="tablist">
        <button role="tab" aria-selected="${range === "today"}" class="activity-tab ${range === "today" ? "activity-tab-active" : ""}" data-range="today">${t("tab_today")}</button>
        <button role="tab" aria-selected="${range === "week"}" class="activity-tab ${range === "week" ? "activity-tab-active" : ""}" data-range="week">${t("tab_week")}</button>
        <button role="tab" aria-selected="${range === "month"}" class="activity-tab ${range === "month" ? "activity-tab-active" : ""}" data-range="month">${t("tab_month")}</button>
        <button role="tab" aria-selected="${range === "custom"}" class="activity-tab ${range === "custom" ? "activity-tab-active" : ""}" data-range="custom">${t("tab_custom")}</button>
      </div>

      ${range === "custom" ? `<div class="activity-custom-range">
        <label>${t("date_from")}<input type="date" id="custom-from" value="${customFrom}" /></label>
        <label>${t("date_to")}<input type="date" id="custom-to" value="${customTo}" /></label>
      </div>` : ""}

      ${checkinsCapped ? `<p class="muted activity-capped-note">${t("activity_capped_note")}</p>` : ""}

      <div class="stat-grid activity-stat-grid">
        <div class="stat-card"><span class="stat-value">${stats.total}</span><span class="stat-label">${t("stat_total_visits")}</span></div>
        <div class="stat-card"><span class="stat-value">${stats.verified}</span><span class="stat-label">${t("verified")}</span><span class="stat-sublabel">${stats.verifiedPct}</span></div>
        <div class="stat-card"><span class="stat-value">${stats.rejected}</span><span class="stat-label">${t("status_rejected")}</span><span class="stat-sublabel">${stats.rejectedPct}</span></div>
        <div class="stat-card"><span class="stat-value">${stats.pending}</span><span class="stat-label">${t("status_pending")}</span><span class="stat-sublabel">${stats.pendingPct}</span></div>
      </div>

      <div class="activity-search-combined" id="activity-search-combined">
        <label class="visually-hidden" for="activity-search">${t("search_customers")}</label>
        <input type="search" id="activity-search" placeholder="${t("search_customers")}" aria-label="${t("search_customers")}" value="${escapeHtml(filters.search)}" />
        <div class="activity-search-actions" aria-label="${t("filters")}">
          ${canFilterByManager ? iconDropdownHtml("manager", [{ value: "", label: managerLabel }, ...managerOptions().map(([id, name]) => ({ value: String(id), label: name }))], filters.manager, ACTIVITY_FILTER_ICONS.manager, managerLabel) : ""}
          ${iconDropdownHtml("status", STATUS_OPTIONS, filters.status, ACTIVITY_FILTER_ICONS.status, statusLabel)}
          ${iconDropdownHtml("outcome", OUTCOME_OPTIONS, filters.outcome, ACTIVITY_FILTER_ICONS.outcome, outcomeLabel)}
          ${iconDropdownHtml("sort", SORT_OPTIONS, sortMode, ACTIVITY_FILTER_ICONS.sort, sortLabel, sortMode !== "newest")}
        </div>
      </div>

      <div class="activity-count" id="activity-count"></div>
      <div class="card-list" id="activity-list"></div>
      <button class="btn btn-block" id="activity-load-more" hidden>${t("load_more")}</button>
    `;

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
        requestAnimationFrame(() => container.querySelector(`.activity-tab[data-range="${range}"]`)?.focus());
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
        if (e.key !== "ArrowDown" && e.key !== "Enter" && e.key !== " ") return;
        if (e.key === "ArrowDown") e.preventDefault();
        if (e.key === "ArrowDown") {
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
        else if (key === "sort") sortMode = optBtn.dataset.value;
        openDropdown = null;
        visibleCount = PAGE_SIZE;
        renderShell();
      });
    });

    renderList();
  }

  container.addEventListener("click", (e) => {
    if (openDropdown && !e.target.closest("[data-dropdown]") && !e.target.closest("[data-dropdown-menu]")) {
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
    let lastManager = null;
    listEl.innerHTML = visible
      .map((c) => {
        const status = checkinStatus(c);
        const meta = statusMeta(status);
        const outcomeLabel = checkinOutcomes(c).map((o) => t(`outcome_${o}`)).join(", ");
        const distanceLabel = status === "rejected" ? `${formatDistance(c.distance_meters)} ${t("away")}` : formatDistance(c.distance_meters);
        let managerHeading = "";
        if (sortMode === "manager" && c.user_name !== lastManager) {
          lastManager = c.user_name;
          managerHeading = `<div class="activity-manager-group-heading">${escapeHtml(c.user_name)}</div>`;
        }
        return `${managerHeading}
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
              ${c.amount_collected_amd != null ? `<span class="badge badge-success">${formatAmd(Number(c.amount_collected_amd))}</span>` : ""}
            </div>
          </div>
          <span class="chevron">&#8250;</span>
        </button>`;
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
      if (range === "custom" && (!customFrom || !customTo)) {
        allCheckins = [];
        checkinsCapped = false;
      } else {
        const result = await api.listCheckins(params);
        allCheckins = result.rows;
        checkinsCapped = result.has_more;
      }
    } catch (err) {
      container.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
      return;
    }
    renderShell();
  }

  load();
}
