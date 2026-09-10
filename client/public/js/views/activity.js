import { api } from "../api.js";
import { escapeHtml, formatDistance, formatAmd, categoryIcon, customerIconTint } from "../util.js";
import { t, getLang } from "../i18n.js";
import { seesAllActivity } from "../state.js";
import { openVisitDetailSheet } from "../visitDetail.js";

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

const PAGE_SIZE = 25;

const STATUS_ICON = {
  verified: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5 9-10"/></svg>`,
  pending: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/></svg>`,
  // A red octagon with "!" (Lucide's octagon-alert) -- the conventional
  // stop-sign warning glyph, distinct in shape (not just color) from the
  // verified/pending circles so "rejected" reads at a glance even without
  // color (colorblind-safe). The octagon's own fill supplies the color, so
  // .status-rejected leaves the badge background transparent instead of
  // layering a second red circle behind it. Verified/pending get their
  // visual weight from a colored circle backdrop (see
  // .activity-status-icon-sm) that fills the *entire* 20x20 container
  // regardless of how much of the 24x24 viewBox their own glyph occupies;
  // the octagon has no such backdrop, so its own path (Lucide's stock
  // 24x24 octagon-alert shape, which already spans nearly the full box)
  // fills that same footprint alone with no scaling/clipping needed.
  rejected: `<svg viewBox="0 0 24 24" width="20" height="20"><path d="M15.312 2a2 2 0 0 1 1.414.586l4.688 4.688A2 2 0 0 1 22 8.688v6.624a2 2 0 0 1-.586 1.414l-4.688 4.688a2 2 0 0 1-1.414.586H8.688a2 2 0 0 1-1.414-.586l-4.688-4.688A2 2 0 0 1 2 15.312V8.688a2 2 0 0 1 .586-1.414l4.688-4.688A2 2 0 0 1 8.688 2z" fill="currentColor"/><path d="M12 8v4" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/><circle cx="12" cy="16" r="1.1" fill="#fff"/></svg>`,
};

const ACTIVITY_FILTER_ICONS = {
  status: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.75"/><path d="m7.9 12.1 2.6 2.7 5.8-6"/></svg>`,
  outcome: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="3.75" width="14" height="16.5" rx="2.5"/><path d="M9 3.75v-.5A1.25 1.25 0 0 1 10.25 2h3.5A1.25 1.25 0 0 1 15 3.25v.5"/><path d="m8.5 11.7 1.8 1.8 4.7-5"/><path d="M8.5 17h7"/></svg>`,
  sort: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 4v16M4 7l3-3 3 3M17 20V4M14 17l3 3 3-3"/></svg>`,
};

function checkinOutcomes(c) {
  if (c.outcomes?.length) return c.outcomes;
  return c.outcome ? [c.outcome] : [];
}

// The free-text note only exists to explain an "Other" outcome, so it's
// shown inline with that label rather than hidden behind opening the visit.
// Only the note is truncated -- the outcome labels themselves are short and
// fixed, while free text can run arbitrarily long and would otherwise wrap
// the row to an unpredictable height.
const NOTE_MAX_CHARS = 48;

function outcomeSummary(c) {
  return checkinOutcomes(c)
    .map((o) => {
      const label = t(`outcome_${o}`);
      const note = String(c.note ?? "").trim();
      if (o !== "other" || !note) return label;
      const short = note.length > NOTE_MAX_CHARS ? `${note.slice(0, NOTE_MAX_CHARS).trimEnd()}…` : note;
      return `${label}: ${short}`;
    })
    .join(", ");
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
    // No badge class here: the row's status is carried solely by the
    // coloured status icon (which holds the label as its aria-label/title),
    // so a second text badge repeating it was pure duplication.
    if (status === "verified") return { cls: "status-verified", label: t("verified") };
    if (status === "pending") return { cls: "status-pending", label: t("status_pending") };
    return { cls: "status-rejected", label: t("status_rejected") };
  }

  function managerOptions() {
    const seen = new Map();
    for (const c of allCheckins) {
      if (!seen.has(c.user_id)) seen.set(c.user_id, c.user_name);
    }
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }

  // The old header was four read-only stat cards (total / verified /
  // rejected / pending), which repeated what every row's own status icon
  // already says. What the directors actually read off this screen is who
  // did the visits, so the same slot is now a row of tappable pills -- one
  // per sales manager present in the loaded range, with their share of the
  // total -- doubling as the manager filter (which is why the separate
  // manager dropdown is gone: two controls for one filter). A plain sales
  // manager only ever sees their own check-ins, so there is nothing to
  // split by and they keep a single total count instead.
  function renderManagerPills() {
    const total = allCheckins.length;
    const counts = new Map();
    for (const c of allCheckins) counts.set(String(c.user_id), (counts.get(String(c.user_id)) ?? 0) + 1);

    const pills = [
      { value: "", label: t("filter_all"), count: total },
      // Busiest manager first, not alphabetical -- who actually did the most
      // visits is the more useful thing to see first, and it's what a
      // director scanning this row for "who's active today" wants to read
      // left-to-right without hunting.
      ...managerOptions()
        .map(([id, name]) => ({
          value: String(id),
          label: name,
          count: counts.get(String(id)) ?? 0,
        }))
        .sort((a, b) => b.count - a.count),
    ];

    return `
      <div class="customer-stats-bar activity-manager-bar" id="activity-manager-bar" aria-label="${escapeHtml(t("all_managers"))}">
        ${pills
          .map(
            (p) => `
          <button type="button" class="stat-pill ${filters.manager === p.value ? "stat-pill-active" : ""}" data-manager="${escapeHtml(p.value)}" aria-pressed="${filters.manager === p.value}">
            <strong>${p.count}</strong>
            <span>${escapeHtml(p.label)}</span>
          </button>`
          )
          .join("")}
      </div>
    `;
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

      ${
        // A plain sales manager only ever sees their own check-ins, so this
        // row -- originally a manager filter, and even its single-pill
        // fallback below -- has nothing to show them beyond a count they
        // already see from the list itself. Skip it entirely for that role
        // instead of rendering a row that always reads as "1 person: you".
        canFilterByManager ? renderManagerPills() : ""
      }

      <div class="activity-search-combined" id="activity-search-combined">
        <label class="visually-hidden" for="activity-search">${t("search_customers")}</label>
        <input type="search" id="activity-search" placeholder="${t("search_customers")}" aria-label="${t("search_customers")}" value="${escapeHtml(filters.search)}" />
        <div class="activity-search-actions" aria-label="${t("filters")}">
          ${iconDropdownHtml("status", STATUS_OPTIONS, filters.status, ACTIVITY_FILTER_ICONS.status, statusLabel)}
          ${iconDropdownHtml("outcome", OUTCOME_OPTIONS, filters.outcome, ACTIVITY_FILTER_ICONS.outcome, outcomeLabel)}
          ${iconDropdownHtml("sort", SORT_OPTIONS, sortMode, ACTIVITY_FILTER_ICONS.sort, sortLabel, sortMode !== "newest")}
        </div>
      </div>

      <div class="activity-count" id="activity-count"></div>
      <div class="card-list" id="activity-list"></div>
      <button class="btn btn-block" id="activity-load-more" hidden>${t("load_more")}</button>
    `;

    container.querySelectorAll("#activity-manager-bar .stat-pill").forEach((btn) => {
      btn.addEventListener("click", () => {
        // Tapping the pill that's already on clears the filter, so "All"
        // isn't the only way back to the full list.
        filters.manager = filters.manager === btn.dataset.manager ? "" : btn.dataset.manager;
        visibleCount = PAGE_SIZE;
        renderShell();
      });
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
        const outcomeLabel = outcomeSummary(c);
        const distanceLabel = status === "rejected" ? `${formatDistance(c.distance_meters)} ${t("away")}` : formatDistance(c.distance_meters);
        let managerHeading = "";
        if (sortMode === "manager" && c.user_name !== lastManager) {
          lastManager = c.user_name;
          managerHeading = `<div class="activity-manager-group-heading">${escapeHtml(c.user_name)}</div>`;
        }
        return `${managerHeading}
        <div class="card list-row" tabindex="0" role="button" data-checkin-id="${c.id}">
          <button type="button" class="list-row-icon list-row-icon-${customerIconTint(c.customer_tier)}" data-customer-id="${c.customer_id}" aria-label="${escapeHtml(c.customer_name)}" title="${escapeHtml(c.customer_name)}">
            ${categoryIcon(c.customer_category)}
          </button>
          <div class="list-row-body">
            <div class="list-row-top">
              <strong class="activity-customer-name-btn" role="button" tabindex="0" data-customer-id="${c.customer_id}">${escapeHtml(c.customer_name)}</strong>
              <span class="list-row-trailing">
                <span class="list-row-trailing-text ${status === "rejected" ? "activity-distance-danger" : "muted"}">${distanceLabel}</span>
                <span class="activity-status-icon activity-status-icon-sm ${meta.cls}" aria-label="${escapeHtml(meta.label)}" title="${escapeHtml(meta.label)}">${STATUS_ICON[status]}</span>
              </span>
            </div>
            <div class="muted list-row-meta">${[escapeHtml(c.user_name), c.customer_region ? escapeHtml(c.customer_region) : "", formatActivityDate(c.timestamp)].filter(Boolean).join(" · ")}</div>
            <div class="list-row-bottom">
              ${outcomeLabel ? `<span class="muted activity-outcome-label">${escapeHtml(outcomeLabel)}</span>` : ""}
              ${c.amount_collected_amd != null ? `<span class="text-amount">${formatAmd(Number(c.amount_collected_amd))}</span>` : ""}
            </div>
          </div>
          <span class="chevron">&#8250;</span>
        </div>`;
      })
      .join("");

    // Tapping the row opens this visit's own details (what actually
    // happened at that stop); tapping the customer icon specifically -- not
    // the name/rest of the row -- jumps to that customer's card instead.
    // The icon is a real <button> nested in a non-button row (a <button>
    // can't contain another interactive control), so its own click is
    // stopped from bubbling up to the row's handler.
    listEl.querySelectorAll(".list-row").forEach((el) => {
      const openDetails = () => {
        const checkin = visible.find((c) => String(c.id) === el.dataset.checkinId);
        if (checkin) openVisitDetailSheet(checkin, load);
      };
      el.addEventListener("click", openDetails);
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openDetails();
        }
      });
    });

    listEl.querySelectorAll(".list-row-icon, .activity-customer-name-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        navigate(`#/customers/${btn.dataset.customerId}`);
      });
      btn.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        e.stopPropagation();
        navigate(`#/customers/${btn.dataset.customerId}`);
      });
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
