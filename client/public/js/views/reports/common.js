// Shared pieces of the Reports screens: period tabs, selects, report header, date formats, channel options (moved out of reports.js
// with the refactor tool, docs/architecture-roadmap.md step 6).
import { api } from "../../api.js";
import { escapeHtml, formatDateTime as formatDateTimeShared, formatDayMonth, monthShort, openInfoPopup, parseDateOnly, syncNote } from "../../util.js";
import { t } from "../../i18n.js";
import { periodAria, periodLabel } from "../../periodButtons.js";

// "all" (not "") for the All-time option: every one of this array's three
// callers builds its request params with
// `Object.fromEntries([...data.entries()].filter(([, v]) => v))`, which
// drops falsy values -- an empty string here would vanish before it ever
// reached the server, indistinguishable from the field not existing at
// all, and periodBounds() would then fall through to its "month" default.
// That silently turned "All time" into "this month" in every report that
// uses this list.
export const PERIOD_OPTIONS = [
  { value: "today", base: "today" },
  { value: "week", base: "week" },
  { value: "month", base: "month" },
  { value: "quarter", base: "quarter" },
  { value: "year", base: "year" },
  { value: "all", labelKey: "rp_all" },
];

export const TIER_OPTIONS = ["potential", "bronze", "silver", "gold", "competitor"];

export const OUTCOME_OPTIONS = [
  "order_placed",
  "follow_up_required",
  "payment_collected",
  "assortment_check",
  "customer_unavailable",
  "other",
];

// For a real timestamp (checkins.timestamp, customers.created_at, a
// payment's created_at, ...) -- correctly converted to the viewer's
// local calendar date, since it names an actual instant.
export function formatDate(value) {
  return formatDayMonth(new Date(value), { year: true });
}

// For a plain calendar date with no time component (erp_daily_report's
// report_date/prev_report_date, and the day column from
// date_trunc('day', ...)::date in the payments-approved trend) --
// `new Date("2026-09-05")` parses that as UTC midnight, which
// toLocaleDateString() then renders as the PREVIOUS day in any timezone
// behind UTC (same bug fixed in debtBalances.js's formatDateOnly). Read
// the y/m/d digits straight out of the string and build a local Date
// from them instead, so it's never round-tripped through UTC.
export function formatDateOnly(value) {
  if (!value) return "—";
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
  if (!match) return formatDate(value);
  const [, yyyy, mm, dd] = match;
  return formatDayMonth(new Date(Number(yyyy), Number(mm) - 1, Number(dd)), { year: true });
}

// Period filter as Activity-style tabs (owner pattern: tabs/chips, not a
// native <select>). A hidden input keeps the value so every report's
// FormData/`form.addEventListener("change")` code works unchanged; one
// document-level click handler (below) flips it and fires "change".
export function periodTabsHtml(name, options, value) {
  return `<div class="activity-tabs report-period-tabs" role="tablist">
    <input type="hidden" name="${name}" value="${escapeHtml(value)}" />
    ${options
      .map((o) => {
        // A period with a "previous" (today / week / month / quarter / year) flips to it when the selected button is tapped again.
        const active = o.value === value;
        const flip = o.base ? ` data-base="${o.base}" aria-label="${escapeHtml(active ? periodAria(o.base, false) : periodLabel(o.base))}"` : "";
        return `<button type="button" role="tab" class="activity-tab${active ? " activity-tab-active" : ""}" aria-selected="${active}" data-period-value="${escapeHtml(o.value)}"${flip}>${escapeHtml(o.base ? periodLabel(o.base) : o.label)}</button>`;
      })
      .join("")}
  </div>`;
}

export function selectHtml(name, options, value) {
  return `<select name="${name}">${options
    .map((o) => `<option value="${escapeHtml(o.value)}" ${o.value === value ? "selected" : ""}>${escapeHtml(o.label)}</option>`)
    .join("")}</select>`;
}

// hint: a "!" button next to the title (the data-freshness note lives behind it).
export function reportHeaderHtml(titleKey, { hint = false } = {}) {
  return `
    <div class="detail-header report-header">
      <button class="icon-btn" id="back-btn" aria-label="${t("back")}">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
      </button>
      <div class="detail-header-title">${
        hint
          ? `<div class="sales-heading-with-hint"><h1>${t(titleKey)}</h1><button type="button" class="settings-hint-icon" id="report-sync-hint-btn" aria-label="${t("more_info")}" hidden>!</button></div>`
          : `<h1>${t(titleKey)}</h1>`
      }</div>
    </div>
  `;
}

export function formatDateTime(value) {
  if (!value) return "—";
  return formatDateTimeShared(value);
}

export function currentYearMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

// Local calendar-date components, not toISOString() -- see sales.js's own
// formatDateInput for why (UTC-conversion day-shift east of UTC). Used as
// the customer-debt as-of-date picker's `max`, so a user can't pick a
// future date the server has no order/cashflow history for yet.
export function currentYearMonthDay() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

// "15 Sep 2026" style, same short-date convention as sales.js's own
// formatSalesDateCaption -- parseDateOnly rather than `new Date(value)`
// since this is a date-only string.
export function formatReportAsOfCaption(dateOnly) {
  const d = parseDateOnly(dateOnly);
  if (!d) return String(dateOnly ?? "");
  const month = monthShort(d);
  return `${d.getDate()} ${month} ${d.getFullYear()}`;
}

export let cachedChannelOptions = null;

export async function channelOptions() {
  if (cachedChannelOptions) return cachedChannelOptions;
  const channels = await api.getPerfChannels();
  cachedChannelOptions = [{ value: "", label: t("all_channels") }, ...channels.map((c) => ({ value: c.code, label: c.name }))];
  return cachedChannelOptions;
}

// Shrinks the "AMD" unit first (down to 40%), then the whole figure, until a
// no-wrap amount fits its card -- so a very large total never gets clipped to "…".
export function fitReportStatValue(el) {
  if (!el) return;
  const unit = el.querySelector(".stat-unit");
  el.style.fontSize = "";
  if (unit) unit.style.fontSize = "";
  const overflows = () => el.scrollWidth > el.clientWidth + 1;
  if (!overflows()) return;
  if (unit) {
    for (let pct = 55; pct >= 40 && overflows(); pct -= 5) unit.style.fontSize = `${pct}%`;
  }
  let size = parseFloat(getComputedStyle(el).fontSize);
  while (overflows() && size > 11) {
    size -= 1;
    el.style.fontSize = `${size}px`;
  }
}

// Report pages whose header has the "!" hint button: returns paint(sync) -> the visible alert html
// (stale / never synced only) and keeps the full "Castrol data as of ..." line behind the icon.
export function wireSyncHint(container) {
  const btn = container.querySelector("#report-sync-hint-btn");
  let info = "";
  btn.addEventListener("click", () => openInfoPopup(info));
  return (sync) => {
    const note = syncNote(sync);
    info = note.info;
    btn.hidden = !note.info;
    return note.alert;
  };
}
