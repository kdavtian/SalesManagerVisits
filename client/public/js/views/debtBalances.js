// Read-only Debt Balances viewer (item 4). Pulls from the ERP-synced
// erp_customer_data.debt_amd (see server/src/routes/debtBalances.js) --
// no write-back, no new ledger/aging workflow. A sales_manager gets a flat
// list already scoped to their own book server-side; director/admin/ceo/
// accountant additionally get a Flat/By-manager toggle and a manager
// filter, grouping the same payload client-side.
import { api } from "../api.js";
import { escapeHtml, formatAmd, syncBadgeHtml, parseDateOnly } from "../util.js";
import { state } from "../state.js";
import { t, getLang } from "../i18n.js";
import { loadWithCache } from "../listCache.js";
import { icons } from "../icons.js";
import { dueChipHtml } from "../debtChip.js";

// For last_visit_at, a real timestamp (checkins.timestamp) -- correctly
// converted to the viewer's local calendar date, since it names an
// actual instant.
function formatDate(value) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

// For last_payment_date, a plain calendar date (Postgres `date`, no time
// component) from the ERP sync -- `new Date("2026-09-05")` parses that as
// UTC midnight, which toLocaleDateString() then renders as Sep 4 in any
// timezone behind UTC (this was the reported bug: the last-payment date
// showing one day earlier than the ERP actually has it). Read the y/m/d
// digits straight out of the string and build a local Date from them
// instead, so it's never round-tripped through UTC and can't shift by a
// day, matching the fix util.js's formatDateDMY already uses for the
// same class of bug.
function formatDateOnly(value) {
  if (!value) return "—";
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
  if (!match) return formatDate(value);
  const [, yyyy, mm, dd] = match;
  return new Date(Number(yyyy), Number(mm) - 1, Number(dd)).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// Local calendar-date components, not toISOString() -- see sales.js's own
// formatDateInput for why (UTC-conversion day-shift east of UTC).
function formatDateInput(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// "15 Sep 2026" style, same short-date convention as sales.js's own
// formatSalesDateCaption -- parseDateOnly rather than `new Date(value)`
// since this is a date-only string.
function formatAsOfCaption(dateOnly) {
  const d = parseDateOnly(dateOnly);
  if (!d) return String(dateOnly ?? "");
  const month = d.toLocaleDateString(getLang() === "hy" ? "hy" : "en", { month: "short" });
  return `${d.getDate()} ${month} ${d.getFullYear()}`;
}

export async function renderDebtBalances(root, navigate) {
  const canGroup = state.user.role !== "sales_manager";
  let mode = "flat";
  let managerFilter = "";
  // "" = all, "overdue" = the oldest unpaid invoice is past its due date, "not_due" = unpaid but within the term.
  let dueFilter = "";
  // Empty string = live erp_customer_data.debt_amd snapshot (the default,
  // and the only mode before this feature). A chosen date instead computes
  // a running balance from full order/cashflow history as of that date
  // (see server/src/routes/debtBalances.js) -- never assumed to equal the
  // live figure even for today, since the ERP sync can lag behind the
  // in-app collections the live snapshot already adjusts for.
  let asOfDate = "";

  root.innerHTML = `
    <div class="detail-view">
      <div class="detail-header">
        <button class="icon-btn" id="back-btn" aria-label="${t("back")}">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
        </button>
        <div class="detail-header-title"><h1>${t("debt_balances_title")}</h1></div>
        <div class="debt-as-of-filter-wrap" id="debt-as-of-filter-wrap">
          <button type="button" class="debt-as-of-filter-btn" tabindex="-1" aria-hidden="true">
            <span class="debt-as-of-filter-value" id="debt-as-of-value">${t("debt_balances_as_of_live")}</span>
          </button>
          <input type="date" class="debt-as-of-picker-input" id="debt-as-of-input" value="" max="${formatDateInput(new Date())}" aria-label="${t("debt_balances_as_of_date")}" />
          <button type="button" class="debt-as-of-clear-btn" id="debt-as-of-clear" hidden aria-label="${t("debt_balances_as_of_clear")}">${icons.close}</button>
        </div>
      </div>
      <div id="debt-sync-badge"></div>
      <div class="debt-total-card" id="debt-total-card" hidden>
        <span class="debt-total-label">${t("debt_balances_subtotal")}</span>
        <span class="debt-total-amount" id="debt-total-amount"></span>
      </div>
      ${
        canGroup
          ? `<div class="debt-filter-row">
               <div class="segmented" id="debt-mode-tabs">
                 <button type="button" class="chip chip-active" data-mode="flat">${t("debt_balances_flat")}</button>
                 <button type="button" class="chip" data-mode="by-manager">${t("debt_balances_by_manager")}</button>
               </div>
               <div class="filter-dropdown-wrap debt-manager-filter-wrap" id="debt-manager-filter-wrap" hidden>
                 <button type="button" class="filter-dropdown-btn" id="debt-manager-filter-btn" aria-haspopup="menu" aria-expanded="false">
                   <span id="debt-manager-filter-label">${t("all_managers")}</span>
                   <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
                 </button>
                 <div class="filter-dropdown-menu" id="debt-manager-filter-menu" role="menu" hidden></div>
               </div>
             </div>`
          : ""
      }
      <div class="debt-filter-row" id="debt-due-tabs">
        ${[["", "debt_filter_all"], ["overdue", "debt_filter_overdue"], ["not_due", "debt_filter_not_due"]].map(([v, k]) => `<button type="button" class="chip ${v === "" ? "chip-active" : ""}" data-due="${v}">${t(k)}</button>`).join("")}
      </div>
      <p class="form-error" id="debt-error" hidden></p>
      <div id="debt-list" class="card-list" style="margin-top:12px;"></div>
    </div>
  `;

  const container = root.querySelector(".detail-view");
  container.querySelector("#back-btn").addEventListener("click", () => navigate.goBack("#/dashboard"));
  const listEl = container.querySelector("#debt-list");
  const errorEl = container.querySelector("#debt-error");
  const totalCardEl = container.querySelector("#debt-total-card");
  const totalAmountEl = container.querySelector("#debt-total-amount");
  const syncBadgeEl = container.querySelector("#debt-sync-badge");
  const asOfInput = container.querySelector("#debt-as-of-input");
  const asOfValueEl = container.querySelector("#debt-as-of-value");
  const asOfClearBtn = container.querySelector("#debt-as-of-clear");

  asOfInput.addEventListener("change", () => {
    asOfDate = asOfInput.value || "";
    asOfValueEl.textContent = asOfDate ? formatAsOfCaption(asOfDate) : t("debt_balances_as_of_live");
    asOfClearBtn.hidden = !asOfDate;
    load();
  });
  asOfClearBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    asOfDate = "";
    asOfInput.value = "";
    asOfValueEl.textContent = t("debt_balances_as_of_live");
    asOfClearBtn.hidden = true;
    load();
  });

  let managerOptions = [];

  function renderManagerMenu() {
    const menu = container.querySelector("#debt-manager-filter-menu");
    if (!menu) return;
    menu.innerHTML = `
      <button type="button" role="menuitemradio" aria-checked="${!managerFilter}" class="${!managerFilter ? "filter-dropdown-selected" : ""}" data-value="">${t("all_managers")}</button>
      ${managerOptions
        .map(
          ([id, name]) =>
            `<button type="button" role="menuitemradio" aria-checked="${managerFilter === id}" class="${managerFilter === id ? "filter-dropdown-selected" : ""}" data-value="${id}">${escapeHtml(name || "")}</button>`
        )
        .join("")}
    `;
    menu.querySelectorAll("button").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        managerFilter = btn.dataset.value;
        const label = container.querySelector("#debt-manager-filter-label");
        if (label) label.textContent = btn.textContent;
        menu.hidden = true;
        container.querySelector("#debt-manager-filter-btn")?.setAttribute("aria-expanded", "false");
        render();
      });
    });
  }

  container.querySelectorAll("#debt-due-tabs [data-due]").forEach((btn) =>
    btn.addEventListener("click", () => {
      dueFilter = btn.dataset.due;
      container.querySelectorAll("#debt-due-tabs [data-due]").forEach((b) => b.classList.toggle("chip-active", b === btn));
      render();
    })
  );

  if (canGroup) {
    const tabsEl = container.querySelector("#debt-mode-tabs");
    const filterWrap = container.querySelector("#debt-manager-filter-wrap");
    tabsEl.querySelectorAll("[data-mode]").forEach((btn) => {
      btn.addEventListener("click", () => {
        mode = btn.dataset.mode;
        tabsEl.querySelectorAll("[data-mode]").forEach((b) => b.classList.toggle("chip-active", b.dataset.mode === mode));
        filterWrap.hidden = mode !== "by-manager";
        render();
      });
    });
    const managerBtn = container.querySelector("#debt-manager-filter-btn");
    const managerMenu = container.querySelector("#debt-manager-filter-menu");
    managerBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      managerMenu.hidden = !managerMenu.hidden;
      managerBtn.setAttribute("aria-expanded", String(!managerMenu.hidden));
    });
    container.addEventListener("click", () => {
      if (!managerMenu.hidden) {
        managerMenu.hidden = true;
        managerBtn.setAttribute("aria-expanded", "false");
      }
    });
  }

  // Three rows, in the order the balance is actually read: identify the
  // account and what it owes (ID + assigned manager left / amount right),
  // then whose it is, then the two dates that explain the balance -- when
  // they last paid and when a rep last stood in front of them. The manager
  // name only belongs on this first row in flat mode -- by-manager mode
  // already says whose customer it is via the group heading above, so
  // repeating it on every card would be redundant.
  function rowHtml(r) {
    const managerLabel = canGroup && mode === "flat" ? escapeHtml(r.assigned_manager_name || t("unassigned")) : "";
    return `
      <button type="button" class="card debt-balance-card ${Number(r.remaining_balance) > 0 && r.oldest_due_days != null ? (r.oldest_due_days > 0 ? "unpaid-row-overdue" : "unpaid-row-due") : ""}" data-customer-id="${r.internal_customer_id}">
        <div class="debt-balance-row">
          <span class="muted">${t("customer_id_label")}: ${escapeHtml(r.customer_id || "")}${managerLabel ? ` · ${managerLabel}` : ""}</span>
          <span class="text-amount debt-balance-amount">${formatAmd(Number(r.remaining_balance))}</span>
        </div>
        <div class="sales-order-name-row">
          <strong>${escapeHtml(r.customer_name || "")}</strong>
          ${Number(r.remaining_balance) > 0 ? dueChipHtml(r.oldest_due_days) : ""}
        </div>
        <div class="debt-balance-row debt-balance-row-dates muted">
          <span>${t("debt_balances_last_payment")}: ${formatDateOnly(r.last_payment_date)}</span>
          <span>${t("debt_balances_last_visit")}: ${formatDate(r.last_visit_at)}</span>
        </div>
      </button>`;
  }

  let rows = [];

  function render() {
    let visible = rows;
    if (dueFilter === "overdue") visible = visible.filter((r) => Number(r.remaining_balance) > 0 && r.oldest_due_days != null && r.oldest_due_days > 0);
    else if (dueFilter === "not_due") visible = visible.filter((r) => Number(r.remaining_balance) > 0 && r.oldest_due_days != null && r.oldest_due_days <= 0);
    if (canGroup && mode === "by-manager" && managerFilter) {
      visible = visible.filter((r) => String(r.assigned_manager_id || "") === managerFilter);
    }

    // Sum of exactly the rows on screen -- the manager filter (by-manager
    // mode) narrows this the same way it narrows the list below, so the
    // headline total always matches what's actually visible.
    const subtotal = visible.reduce((sum, r) => sum + Number(r.remaining_balance || 0), 0);
    totalCardEl.hidden = !visible.length;
    totalAmountEl.textContent = formatAmd(subtotal);

    if (!visible.length) {
      listEl.innerHTML = `<p class="empty-state">${t("debt_balances_empty")}</p>`;
      return;
    }
    if (canGroup && mode === "by-manager") {
      const groups = new Map();
      for (const r of visible) {
        const key = r.assigned_manager_id || "unassigned";
        const label = r.assigned_manager_name || t("unassigned");
        if (!groups.has(key)) groups.set(key, { label, rows: [] });
        groups.get(key).rows.push(r);
      }
      listEl.innerHTML = [...groups.values()]
        .map(
          (g) => `
        <div class="section-heading-row"><h2 class="section-title section-title-inline">${escapeHtml(g.label)}</h2></div>
        ${g.rows.map(rowHtml).join("")}
      `
        )
        .join("");
    } else {
      listEl.innerHTML = visible.map(rowHtml).join("");
    }
    listEl.querySelectorAll(".debt-balance-card").forEach((card) => {
      card.addEventListener("click", () => navigate(`#/customers/${card.dataset.customerId}`));
    });
  }

  function paintData(data) {
    rows = data.rows;
    syncBadgeEl.innerHTML = syncBadgeHtml(data.sync);
    if (canGroup) {
      // Preserve whatever the user already has selected -- loadWithCache
      // can repaint this a second time (stale cache, then the real fetch
      // landing), and resetting it back to "" mid-session would silently
      // drop their filter choice out from under them. String-keyed since
      // managerFilter is always a string (read off a DOM dataset) while
      // assigned_manager_id comes back as a number from the API.
      const managers = new Map();
      for (const r of rows) {
        if (r.assigned_manager_id) managers.set(String(r.assigned_manager_id), r.assigned_manager_name);
      }
      if (managerFilter && !managers.has(managerFilter)) managerFilter = "";
      managerOptions = [...managers.entries()];
      renderManagerMenu();
      const label = container.querySelector("#debt-manager-filter-label");
      if (label) label.textContent = managerFilter ? managers.get(managerFilter) || "" : t("all_managers");
    }
    render();
  }

  async function load() {
    let paintedOnce = false;
    try {
      await loadWithCache(
        // Scoped per as-of date, not one shared "debt-balances" key --
        // otherwise switching between live and a past date would show the
        // other mode's stale cached rows for an instant before the real
        // fetch landed.
        asOfDate ? `debt-balances:${asOfDate}` : "debt-balances",
        () => api.getDebtBalances(asOfDate ? { date: asOfDate } : {}),
        (data) => {
          paintData(data);
          paintedOnce = true;
        }
      );
    } catch (err) {
      if (!paintedOnce) {
        errorEl.textContent = err.message;
        errorEl.hidden = false;
        listEl.innerHTML = "";
      }
    }
  }

  listEl.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
  errorEl.hidden = true;
  load();
}
