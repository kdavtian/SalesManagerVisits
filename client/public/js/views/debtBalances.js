// Read-only Debt Balances viewer (item 4). Pulls from the ERP-synced
// erp_customer_data.debt_amd (see server/src/routes/debtBalances.js) --
// no write-back, no new ledger/aging workflow. A sales_manager gets a flat
// list already scoped to their own book server-side; director/admin/ceo/
// accountant additionally get a Flat/By-manager toggle and a manager
// filter, grouping the same payload client-side.
import { api } from "../api.js";
import { escapeHtml, formatAmd, syncNote, openInfoPopup, parseDateOnly, monthShort, formatDayMonth, labelColon, channelDisplayLabel } from "../util.js";
import { buildDirectionManagerTree, openTriStateTreeSheet, NO_GROUP_KEY } from "../regionTree.js";
import { state } from "../state.js";
import { t, getLang } from "../i18n.js";
import { loadWithCache } from "../listCache.js";
import { icons } from "../icons.js";

// For last_visit_at, a real timestamp (checkins.timestamp) -- correctly
// converted to the viewer's local calendar date, since it names an
// actual instant.
function formatDate(value) {
  if (!value) return "—";
  return formatDayMonth(new Date(value), { year: true });
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
  return formatDayMonth(new Date(Number(yyyy), Number(mm) - 1, Number(dd)), { year: true });
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
  const month = monthShort(d);
  return `${d.getDate()} ${month} ${d.getFullYear()}`;
}

export async function renderDebtBalances(root, navigate) {
  const canGroup = state.user.role !== "sales_manager";
  let mode = "flat";
  // Set of "channel::managerId" keys (regionTree.js buildDirectionManagerTree leaf ids): sales channels with their reps inside,
  // the same filter as the Customers page. Empty = no filter.
  let assignmentKeys = new Set();
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
      <div class="detail-header debt-header">
        <button class="icon-btn" id="back-btn" aria-label="${t("back")}">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
        </button>
        <div class="detail-header-title"><div class="sales-heading-with-hint"><h1>${t("debt_balances_title")}</h1><button type="button" class="settings-hint-icon" id="debt-sync-hint-btn" aria-label="${t("more_info")}" hidden>!</button></div></div>
        <div class="debt-as-of-filter-wrap" id="debt-as-of-filter-wrap">
          <button type="button" class="debt-as-of-filter-btn" tabindex="-1" aria-hidden="true">
            ${icons.calendar}
            <span class="debt-as-of-filter-value" id="debt-as-of-value">${t("debt_balances_as_of_live")}</span>
          </button>
          <input type="date" class="debt-as-of-picker-input" id="debt-as-of-input" value="" max="${formatDateInput(new Date())}" aria-label="${t("debt_balances_as_of_date")}" />
          <button type="button" class="debt-as-of-clear-btn" id="debt-as-of-clear" hidden aria-label="${t("debt_balances_as_of_clear")}">${icons.close}</button>
        </div>
      </div>
      <div id="debt-sync-badge"></div>
      <div class="debt-total-card" id="debt-total-card" hidden>
        <div class="debt-total-line">
          <span class="debt-total-label">${t("debt_balances_total_debt")}</span>
          <span class="debt-total-amount" id="debt-total-amount"></span>
        </div>
        <div class="debt-total-line debt-total-line-overdue" id="debt-overdue-line">
          <span class="debt-total-label">${t("debt_balances_overdue_total")}</span>
          <span class="debt-total-amount" id="debt-overdue-amount"></span>
        </div>
        <div class="debt-total-line debt-total-line-unrecorded" id="debt-unrecorded-line" hidden>
          <span class="debt-total-label">${t("debt_balances_unrecorded_total")}<button type="button" class="settings-hint-icon" id="debt-unrecorded-hint-btn" aria-label="${t("more_info")}">!</button></span>
          <span class="debt-total-amount" id="debt-unrecorded-amount"></span>
        </div>
      </div>
      ${
        canGroup
          ? `<div class="debt-filter-row debt-filter-row-split">
               <div class="segmented" id="debt-mode-tabs">
                 <button type="button" class="chip chip-active" data-mode="flat">${t("debt_balances_flat")}</button>
                 <button type="button" class="chip" data-mode="by-manager">${t("debt_balances_by_manager")}</button>
               </div>
               <span id="debt-assign-filter-slot"></span>
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
  const overdueAmountEl = container.querySelector("#debt-overdue-amount");
  const unrecordedLineEl = container.querySelector("#debt-unrecorded-line");
  const unrecordedAmountEl = container.querySelector("#debt-unrecorded-amount");
  container.querySelector("#debt-unrecorded-hint-btn").addEventListener("click", () => openInfoPopup(`<p>${t("debt_balances_unrecorded_hint")}</p>`));
  const syncBadgeEl = container.querySelector("#debt-sync-badge");
  const syncHintBtn = container.querySelector("#debt-sync-hint-btn");
  let syncInfoHtml = "";
  syncHintBtn.addEventListener("click", () => openInfoPopup(syncInfoHtml));
  const asOfInput = container.querySelector("#debt-as-of-input");
  const asOfValueEl = container.querySelector("#debt-as-of-value");
  const asOfClearBtn = container.querySelector("#debt-as-of-clear");
  const asOfWrapEl = container.querySelector("#debt-as-of-filter-wrap");

  asOfInput.addEventListener("change", () => {
    asOfDate = asOfInput.value || "";
    asOfValueEl.textContent = asOfDate ? formatAsOfCaption(asOfDate) : t("debt_balances_as_of_live");
    asOfClearBtn.hidden = !asOfDate;
    asOfWrapEl.classList.toggle("has-date", Boolean(asOfDate));
    load();
  });
  asOfClearBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    asOfDate = "";
    asOfInput.value = "";
    asOfValueEl.textContent = t("debt_balances_as_of_live");
    asOfClearBtn.hidden = true;
    asOfWrapEl.classList.remove("has-date");
    load();
  });

  // Channel -> rep filter button (management only: a sales_manager's list is already just their own book).
  function renderAssignFilter() {
    const slot = container.querySelector("#debt-assign-filter-slot");
    if (!slot) return;
    const count = assignmentKeys.size;
    const label = t("filter_direction_manager_title");
    slot.innerHTML = `<button type="button" class="filter-icon-btn ${count ? "filter-icon-btn-active" : ""}" id="debt-assign-filter-btn" aria-label="${escapeHtml(count > 1 ? `${label} (${count})` : label)}" title="${escapeHtml(label)}">
      ${icons.person}
      ${count > 1 ? `<span class="filter-icon-count" aria-hidden="true">${count}</span>` : count ? `<span class="filter-icon-dot" aria-hidden="true"></span>` : ""}
    </button>`;
    slot.querySelector("button").addEventListener("click", () =>
      openTriStateTreeSheet(label, {
        tree: buildDirectionManagerTree(rows, { channelLabel: channelDisplayLabel, noDirectionLabel: t("no_direction"), unassignedLabel: t("unassigned") }),
        initialSelectedIds: assignmentKeys,
        countUnitLabel: t("perf_dq_customers_unit"),
        onApply: (selectedIds) => {
          assignmentKeys = selectedIds;
          renderAssignFilter();
          render();
        },
      })
    );
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
    tabsEl.querySelectorAll("[data-mode]").forEach((btn) => {
      btn.addEventListener("click", () => {
        mode = btn.dataset.mode;
        tabsEl.querySelectorAll("[data-mode]").forEach((b) => b.classList.toggle("chip-active", b.dataset.mode === mode));
        render();
      });
    });
  }

  // Card (compact): first line "ID: 10123 • customer name" (the name never repeats the ID, wraps, never cut) with the
  // total on the right; under it, on the left who owns it, last visit and last payment, on the right (aligned with the
  // total) either "Of which [14d] overdue: 300,000" (red chip + red bold amount) or a green "left: 7d" chip.
  const dayChip = (days, cls, text) => `<span class="due-chip ${cls}">${text ?? `${days}${t("debt_days_short")}`}</span>`;
  // The ERP name usually starts with the customer's own ID ("10123 Shirak Garage"); the card already shows the ID.
  function nameWithoutId(name, id) {
    const raw = String(name || "").trim();
    const key = String(id || "").trim();
    if (!key) return raw;
    const escaped = key.replace(/[^\w]/g, "\\$&");
    const stripped = raw.replace(new RegExp(`^(?:ID\\s*)?#?${escaped}(?!\\w)\\s*[-–—•:.)]*\\s*`, "i"), "");
    return stripped || raw;
  }
  const dateLine = (label, value) => `<div class="debt-date-line"><span class="muted">${label}${labelColon()}</span><span class="debt-date-value">${value}</span></div>`;
  function rowHtml(r) {
    const owner = canGroup
      ? [mode === "flat" ? escapeHtml(r.assigned_manager_name || t("unassigned")) : "", r.sales_channel ? escapeHtml(channelDisplayLabel(r.sales_channel)) : ""].filter(Boolean).join(" · ")
      : "";
    const owes = Number(r.remaining_balance) > 0;
    const overdueAmount = Number(r.overdue_amd) || 0;
    const days = r.oldest_due_days;
    let dueHtml = "";
    if (owes && days != null) {
      if (days > 0) {
        dueHtml = `<div class="debt-due-line"><span class="debt-due-head"><span class="debt-due-small">${t("debt_of_which")}</span>${dayChip(days, "due-chip-overdue")}${
          overdueAmount > 0 ? `<span class="debt-due-small">${t("debt_overdue_word")}</span>` : ""
        }</span>${overdueAmount > 0 ? `<strong class="debt-due-amount">${formatAmd(overdueAmount)}</strong>` : ""}</div>`;
      } else {
        dueHtml = `<div class="debt-due-line">${days === 0 ? dayChip(0, "due-chip-soon", t("debt_due_today")) : dayChip(-days, "due-chip-ok", `${t("debt_left_word")}${-days}${t("debt_days_short")}`)}</div>`;
      }
    }
    const unrecorded = Number(r.unrecorded_amd) || 0;
    return `
      <button type="button" class="card debt-balance-card ${owes && days != null ? (days > 0 ? "unpaid-row-overdue" : "unpaid-row-due") : ""}" data-customer-id="${r.internal_customer_id}">
        <div class="debt-top"><div class="debt-name-line"><span class="debt-id">ID: ${escapeHtml(r.customer_id || "")}</span> <span class="debt-dot">•</span> <strong class="debt-name">${escapeHtml(nameWithoutId(r.customer_name, r.customer_id))}</strong></div>
        <span class="text-amount debt-balance-amount">${formatAmd(Number(r.remaining_balance))}</span></div>
        <div class="debt-bottom"><div class="debt-card-left">
          ${owner ? `<div class="muted debt-owner-line">${owner}</div>` : ""}
          ${dateLine(t("debt_balances_last_visit"), formatDate(r.last_visit_at))}
          ${dateLine(t("debt_balances_last_payment"), formatDateOnly(r.last_payment_date))}
        </div>
        <div class="debt-card-right">
          ${dueHtml}
          ${owes && unrecorded > 0 ? `<div class="debt-unrecorded-line"><span class="muted">${t("debt_balances_unrecorded_row")}</span> <strong>${formatAmd(unrecorded)}</strong></div>` : ""}
        </div></div>
      </button>`;
  }

  let rows = [];

  function render() {
    let visible = rows;
    if (dueFilter === "overdue") visible = visible.filter((r) => Number(r.remaining_balance) > 0 && r.oldest_due_days != null && r.oldest_due_days > 0);
    else if (dueFilter === "not_due") visible = visible.filter((r) => Number(r.remaining_balance) > 0 && r.oldest_due_days != null && r.oldest_due_days <= 0);
    if (canGroup && assignmentKeys.size) {
      visible = visible.filter((r) => assignmentKeys.has(`${r.sales_channel || NO_GROUP_KEY}::${r.assigned_manager_id ?? NO_GROUP_KEY}`));
    }

    // Sum of exactly the rows on screen -- the channel/rep filter narrows this the same way it narrows the list
    // below, so the headline total always matches what's actually visible.
    const subtotal = visible.reduce((sum, r) => sum + Number(r.remaining_balance || 0), 0);
    // How much of that is already past its due date, and what the reps collected that the Excel does not hold yet.
    const overdue = visible.reduce((sum, r) => sum + Math.max(0, Number(r.overdue_amd || 0)), 0);
    const unrecorded = visible.reduce((sum, r) => sum + Number(r.unrecorded_amd || 0), 0);
    totalCardEl.hidden = !visible.length;
    totalAmountEl.textContent = formatAmd(subtotal);
    overdueAmountEl.textContent = formatAmd(overdue);
    overdueAmountEl.classList.toggle("debt-amount-overdue", overdue > 0);
    unrecordedLineEl.hidden = !(unrecorded > 0);
    unrecordedAmountEl.textContent = formatAmd(unrecorded);

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
    // "Castrol data as of ..." sits behind the "!" next to the heading; only a stale/never-synced
    // feed stays visible (see syncNote in util.js).
    const note = syncNote(data.sync);
    syncBadgeEl.innerHTML = note.alert;
    syncInfoHtml = note.info;
    syncHintBtn.hidden = !note.info;
    if (canGroup) {
      // loadWithCache can repaint this a second time (stale cache, then the real fetch landing): keep the user's
      // selection, but drop keys that no longer exist in the fresh rows.
      const present = new Set(rows.map((r) => `${r.sales_channel || NO_GROUP_KEY}::${r.assigned_manager_id ?? NO_GROUP_KEY}`));
      assignmentKeys = new Set([...assignmentKeys].filter((k) => present.has(k)));
      renderAssignFilter();
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
