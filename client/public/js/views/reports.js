import { api } from "../api.js";
import { escapeHtml, firstUseHintHtml, activateFirstUseHints, activateDialog, downloadFromUrl, saveBlob } from "../util.js";
import { buildRegionSubregionTree, openTriStateTreeSheet, NO_GROUP_KEY } from "../regionTree.js";
import { t, getLang } from "../i18n.js";
import { icons } from "../icons.js";
import { dueChipHtml } from "../debtChip.js";
import { REGION_LIST, YEREVAN_DISTRICTS, regionLabelHy, CATEGORY_LIST, formatAmd, amdWithUnitHtml, channelDisplayLabel, syncBadgeHtml, formatDateDMY, parseDateOnly } from "../util.js";

// "all" (not "") for the All-time option: every one of this array's three
// callers builds its request params with
// `Object.fromEntries([...data.entries()].filter(([, v]) => v))`, which
// drops falsy values -- an empty string here would vanish before it ever
// reached the server, indistinguishable from the field not existing at
// all, and periodBounds() would then fall through to its "month" default.
// That silently turned "All time" into "this month" in every report that
// uses this list.
const PERIOD_OPTIONS = [
  { value: "all", labelKey: "period_all_time" },
  { value: "today", labelKey: "tab_today" },
  { value: "week", labelKey: "tab_week" },
  { value: "month", labelKey: "tab_month" },
  { value: "year", labelKey: "period_year" },
];

const TIER_OPTIONS = ["potential", "bronze", "silver", "gold", "competitor"];

const OUTCOME_OPTIONS = [
  "order_placed",
  "no_order",
  "payment_collected",
  "follow_up_required",
  "assortment_check",
  "customer_unavailable",
  "complaint",
  "other",
];

// For a real timestamp (checkins.timestamp, customers.created_at, a
// payment's created_at, ...) -- correctly converted to the viewer's
// local calendar date, since it names an actual instant.
function formatDate(value) {
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

// For a plain calendar date with no time component (erp_daily_report's
// report_date/prev_report_date, and the day column from
// date_trunc('day', ...)::date in the payments-approved trend) --
// `new Date("2026-09-05")` parses that as UTC midnight, which
// toLocaleDateString() then renders as the PREVIOUS day in any timezone
// behind UTC (same bug fixed in debtBalances.js's formatDateOnly). Read
// the y/m/d digits straight out of the string and build a local Date
// from them instead, so it's never round-tripped through UTC.
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

function selectHtml(name, options, value) {
  return `<select name="${name}">${options
    .map((o) => `<option value="${escapeHtml(o.value)}" ${o.value === value ? "selected" : ""}>${escapeHtml(o.label)}</option>`)
    .join("")}</select>`;
}

// Reports is its own mini-router within one hash (#/reports) -- a list
// page when no report is selected, or one of the three report views when
// `r` is set in the query string. Kept in one file since the views share
// the same header/back-button chrome and filter-building conventions.
export async function renderReports(root, navigate, reportKey) {
  if (reportKey === "new_customers") return renderNewCustomersReport(root, navigate);
  if (reportKey === "checkins") return renderCheckinsReport(root, navigate);
  if (reportKey === "weekly_scorecard") return (await import("./bizReports.js")).renderWeeklyScorecard(root, navigate);
  if (reportKey === "delivery_speed") return (await import("./bizReports.js")).renderDeliverySpeed(root, navigate);
  if (reportKey === "customer_pipeline") return (await import("./bizReports.js")).renderCustomerPipeline(root, navigate);
  if (reportKey === "unpaid_invoices") return (await import("./bizReports.js")).renderUnpaidInvoices(root, navigate);
  if (reportKey === "fuel_allowance") return (await import("./fuelReport.js")).renderFuelReport(root, navigate);
  if (reportKey === "orders_pipeline") return renderOrdersPipelineReport(root, navigate);
  if (reportKey === "brand_availability") return renderBrandAvailabilityReport(root, navigate);
  if (reportKey === "payments") return renderPaymentsReport(root, navigate);
  // Payments (Excel) now lives on the Sales page as its Payments tab.
  if (reportKey === "erp_payments") return navigate("#/sales?tab=payments");
  if (reportKey === "cash_custody") return renderCashCustodyReport(root, navigate);
  if (reportKey === "cash_reconciliation") return renderCashReconciliationReport(root, navigate);
  if (reportKey === "customer_debt") return renderCustomerDebtReport(root, navigate);
  if (reportKey === "sales_budget") return renderSalesBudgetReport(root, navigate);
  if (reportKey === "brand_volume") return renderBrandVolumeReport(root, navigate);
  if (reportKey === "daily_management") return renderDailyManagementReport(root, navigate);
  if (reportKey === "documents") return renderDocumentsReport(root, navigate);
  return renderReportsList(root, navigate);
}

const GENERATED_REPORT_TYPE_LABEL_KEY = {
  sales_director: "report_documents_type_sales_director",
  debt_receivables: "report_documents_type_debt_receivables",
  ceo_management: "report_documents_type_ceo_management",
};

async function renderDocumentsReport(root, navigate) {
  root.innerHTML = `
    <div class="detail-view">
      ${reportHeaderHtml("report_documents_name")}
      <div id="documents-list" class="card-list"><p class="loading-state" role="status">${t("loading")}</p></div>
    </div>
  `;
  const container = root.querySelector(".detail-view");
  container.querySelector("#back-btn").addEventListener("click", () => navigate("#/reports"));
  const listEl = container.querySelector("#documents-list");

  try {
    const docs = await api.listGeneratedReports();
    if (!docs.length) {
      listEl.innerHTML = `<p class="empty-state">${t("report_documents_empty")}</p>`;
      return;
    }
    // Grouped by report_date (already the API's primary sort) instead of one
    // flat list -- the bot typically pushes all 3 report types for the same
    // date together, so a flat list repeats that date on every single row
    // and only gets harder to scan as more days pile up. The heading carries
    // the date instead, once per group.
    let lastDate = null;
    listEl.innerHTML = docs
      .map((d) => {
        const dateHeading = d.report_date !== lastDate ? `<p class="list-group-heading">${formatDateOnly(d.report_date)}</p>` : "";
        lastDate = d.report_date;
        return `
      ${dateHeading}
      <a class="card report-row" href="/api/reports/documents/${d.id}/download" data-download="report-${d.id}">
        <strong>${t(GENERATED_REPORT_TYPE_LABEL_KEY[d.report_type] || d.report_type)}</strong>
        <span>${icons.download}</span>
      </a>`;
      })
      .join("");
    // Saved in place (share sheet / download), never by navigating the app
    // window to the file -- an installed PWA would have no way back.
    listEl.addEventListener("click", async (e) => {
      const link = e.target.closest("a[data-download]");
      if (!link) return;
      e.preventDefault();
      try {
        await downloadFromUrl(link.getAttribute("href"), link.dataset.download);
      } catch (err) {
        alert(err.message);
      }
    });
  } catch (err) {
    listEl.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
  }
}

async function renderReportsList(root, navigate) {
  root.innerHTML = `
    <div class="detail-view">
      <div class="detail-header">
        <button class="icon-btn" id="back-btn" aria-label="${t("back")}">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
        </button>
        <div class="detail-header-title"><h1>${t("reports")}</h1></div>
      </div>
      ${firstUseHintHtml("reports_index", t("hint_reports_index"))}
      <div id="reports-list" class="card-list"><p class="loading-state" role="status">${t("loading")}</p></div>
    </div>
  `;
  const container = root.querySelector(".detail-view");
  container.querySelector("#back-btn").addEventListener("click", () => navigate("#/dashboard"));
  activateFirstUseHints(container);
  const listEl = container.querySelector("#reports-list");

  try {
    const reports = (await api.listReports()).filter((r) => r.key !== "erp_payments");
    if (!reports.length) {
      listEl.innerHTML = `<p class="empty-state">${t("no_reports_available")}</p>`;
      return;
    }
    listEl.innerHTML = reports
      .map(
        (r) => `
      <button type="button" class="card report-list-card" data-key="${r.key}">
        <span class="report-list-icon">${REPORT_ICONS[r.key] || icons.chart}</span>
        <div class="report-list-text">
          <strong>${t(r.nameKey)}</strong>
          <span class="muted">${t(r.descriptionKey)}</span>
        </div>
      </button>`
      )
      .join("");
    listEl.querySelectorAll(".report-list-card").forEach((el) => {
      el.addEventListener("click", () => navigate(`#/reports?r=${el.dataset.key}`));
    });
  } catch (err) {
    listEl.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
  }
}

const REPORT_ICONS = {
  new_customers: icons.mapPinPlus,
  checkins: icons.mapPinCheck,
  fuel_allowance: icons.route,
  weekly_scorecard: icons.clipboardCheck,
  customer_pipeline: icons.mapPinPlus,
  delivery_speed: icons.route,
  orders_pipeline: icons.cart,
  brand_availability: icons.store,
  payments: icons.payment,
  erp_payments: icons.wallet,
  cash_custody: icons.wallet,
  cash_reconciliation: icons.clipboardCheck,
  customer_debt: icons.warning,
  unpaid_invoices: icons.clipboardCheck,
  sales_budget: icons.target,
  brand_volume: icons.box,
  daily_management: icons.dashboard,
  documents: icons.note,
};

function reportHeaderHtml(titleKey) {
  return `
    <div class="detail-header report-header">
      <button class="icon-btn" id="back-btn" aria-label="${t("back")}">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
      </button>
      <div class="detail-header-title"><h1>${t(titleKey)}</h1></div>
    </div>
  `;
}

function formatDateTime(value) {
  if (!value) return "—";
  return new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// syncBadgeHtml now lives in util.js, shared with sales.js and
// debtBalances.js (see its own comment there for why).

function subregionOptions(region) {
  if (region === "Yerevan") return YEREVAN_DISTRICTS;
  return [];
}

async function renderNewCustomersReport(root, navigate) {
  root.innerHTML = `
    <div class="detail-view">
      ${reportHeaderHtml("report_new_customers_name")}
      <form id="report-filters" class="report-filter-form">
        ${selectHtml(
          "period",
          PERIOD_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) })),
          "month"
        )}
        ${selectHtml("region", [{ value: "", label: t("all_regions") }, ...REGION_LIST.map((r) => ({ value: r, label: regionLabelHy(r) }))], "")}
        ${selectHtml(
          "customer_tier",
          [{ value: "", label: t("all_tiers") }, ...TIER_OPTIONS.map((v) => ({ value: v, label: t(`tier_${v}`) }))],
          ""
        )}
      </form>
      <div id="report-body"><p class="loading-state" role="status">${t("loading")}</p></div>
    </div>
  `;
  const container = root.querySelector(".detail-view");
  container.querySelector("#back-btn").addEventListener("click", () => navigate("#/reports"));
  const form = container.querySelector("#report-filters");
  const body = container.querySelector("#report-body");

  async function load() {
    body.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
    const data = new FormData(form);
    const params = Object.fromEntries([...data.entries()].filter(([, v]) => v));
    try {
      const { customers, by_manager } = await api.getNewCustomersReport(params);
      body.innerHTML = `
        <h2 class="section-title">${t("by_manager")}</h2>
        <div class="card-list">
          ${
            by_manager.length
              ? by_manager
                  .map(
                    (m) => `
              <div class="card report-row">
                <span>${escapeHtml(m.user_name)}</span>
                <strong>${m.new_customers}</strong>
              </div>`
                  )
                  .join("")
              : `<p class="empty-state">${t("no_data")}</p>`
          }
        </div>
        <h2 class="section-title">${t("customers")} (${customers.length})</h2>
        <div class="card-list">
          ${
            customers.length
              ? customers
                  .map(
                    (c) => `
              <div class="card report-row-multiline">
                <div class="report-debt-customer-top">
                  <strong class="report-debt-customer-name">${escapeHtml(c.name)}</strong>
                  <span class="muted report-created-date">${formatDate(c.created_at)}</span>
                </div>
                <span class="muted">${escapeHtml(c.region || "")}${c.subregion ? `, ${escapeHtml(c.subregion)}` : ""} · ${escapeHtml(c.created_by_name)}</span>
              </div>`
                  )
                  .join("")
              : `<p class="empty-state">${t("no_data")}</p>`
          }
        </div>
      `;
    } catch (err) {
      body.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    }
  }

  form.addEventListener("change", load);
  await load();
}

async function renderCheckinsReport(root, navigate) {
  root.innerHTML = `
    <div class="detail-view">
      ${reportHeaderHtml("report_checkins_name")}
      <form id="report-filters" class="report-filter-form">
        ${selectHtml(
          "period",
          PERIOD_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) })),
          "month"
        )}
        ${selectHtml("region", [{ value: "", label: t("all_regions") }, ...REGION_LIST.map((r) => ({ value: r, label: regionLabelHy(r) }))], "")}
        ${selectHtml(
          "category",
          [{ value: "", label: t("all_categories") }, ...CATEGORY_LIST.map((c) => ({ value: c.value, label: c.value }))],
          ""
        )}
        ${selectHtml(
          "customer_tier",
          [{ value: "", label: t("all_tiers") }, ...TIER_OPTIONS.map((v) => ({ value: v, label: t(`tier_${v}`) }))],
          ""
        )}
        ${selectHtml(
          "outcome",
          [{ value: "", label: t("all_outcomes") }, ...OUTCOME_OPTIONS.map((v) => ({ value: v, label: t(`outcome_${v}`) }))],
          ""
        )}
      </form>
      <div id="report-body"><p class="loading-state" role="status">${t("loading")}</p></div>
    </div>
  `;
  const container = root.querySelector(".detail-view");
  container.querySelector("#back-btn").addEventListener("click", () => navigate("#/reports"));
  const form = container.querySelector("#report-filters");
  const body = container.querySelector("#report-body");

  async function load() {
    body.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
    const data = new FormData(form);
    const params = Object.fromEntries([...data.entries()].filter(([, v]) => v));
    try {
      const { checkins, total } = await api.getCheckinsReport(params);
      body.innerHTML = `
        <h2 class="section-title">${t("checkins")} (${total})</h2>
        <div class="card-list">
          ${
            checkins.length
              ? checkins
                  .map(
                    (c) => `
              <div class="card report-row-multiline">
                <strong>${escapeHtml(c.customer_name)}</strong>
                <span class="muted">${escapeHtml(c.user_name)} · ${formatDate(c.timestamp)}${c.region ? ` · ${escapeHtml(c.region)}` : ""}</span>
                <span class="muted">${(c.outcomes || []).map((o) => t(`outcome_${o}`)).join(", ")}</span>
              </div>`
                  )
                  .join("")
              : `<p class="empty-state">${t("no_data")}</p>`
          }
        </div>
      `;
    } catch (err) {
      body.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    }
  }

  form.addEventListener("change", load);
  await load();
}

const ORDER_PIPELINE_STATUS_KEYS = {
  draft: "order_status_draft",
  submitted: "order_status_submitted",
  confirmed: "order_status_confirmed",
  packed_stock_out: "order_status_packed_stock_out",
  delivered: "order_status_delivered",
};

async function renderOrdersPipelineReport(root, navigate) {
  root.innerHTML = `
    <div class="detail-view">
      ${reportHeaderHtml("report_orders_pipeline_name")}
      <form id="report-filters" class="report-filter-form">
        ${selectHtml(
          "period",
          PERIOD_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) })),
          "month"
        )}
      </form>
      <div id="report-body"><p class="loading-state" role="status">${t("loading")}</p></div>
    </div>
  `;
  const container = root.querySelector(".detail-view");
  container.querySelector("#back-btn").addEventListener("click", () => navigate("#/reports"));
  const form = container.querySelector("#report-filters");
  const body = container.querySelector("#report-body");

  async function load() {
    body.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
    const data = new FormData(form);
    const params = Object.fromEntries([...data.entries()].filter(([, v]) => v));
    try {
      const { by_status, active, delivered, discount } = await api.getOrdersPipelineReport(params);
      const statusLabel = (s) => (ORDER_PIPELINE_STATUS_KEYS[s] ? t(ORDER_PIPELINE_STATUS_KEYS[s]) : s);

      body.innerHTML = `
        <h2 class="section-title">${t("report_orders_pipeline_by_status")}</h2>
        <div class="card-list">
          ${
            by_status.length
              ? by_status
                  .map(
                    (r) => `
              <div class="card report-row">
                <span>${escapeHtml(statusLabel(r.status))}</span>
                <strong>${r.count} · ${formatAmd(Number(r.total_amd))}</strong>
              </div>`
                  )
                  .join("")
              : `<p class="empty-state">${t("no_data")}</p>`
          }
        </div>

        <h2 class="section-title">${t("report_orders_pipeline_active_title")}</h2>
        <div class="card-list">
          ${
            active.length
              ? active
                  .map(
                    (r) => `
              <div class="card report-row-multiline">
                <strong>${escapeHtml(statusLabel(r.status))} · ${r.count}</strong>
                <span class="muted">${t("report_orders_pipeline_oldest_since").replace("{date}", formatDateTime(r.oldest_updated_at))}${
                      Number(r.stuck_over_48h) > 0
                        ? ` · <span class="sync-badge-stale">${t("report_orders_pipeline_stuck_over_48h").replace("{n}", r.stuck_over_48h)}</span>`
                        : ""
                    }</span>
              </div>`
                  )
                  .join("")
              : `<p class="empty-state">${t("no_data")}</p>`
          }
        </div>

        <h2 class="section-title">${t("report_orders_pipeline_delivered_title")}</h2>
        <div class="stat-grid">
          <div class="stat-card">
            <span class="stat-value">${delivered.avg_cycle_hours != null ? `${Number(delivered.avg_cycle_hours).toFixed(1)}h` : "—"}</span>
            <span class="stat-label">${t("report_orders_pipeline_delivered_cycle")}</span>
          </div>
          <div class="stat-card">
            <span class="stat-value">${delivered.delivered_count}</span>
            <span class="stat-label">${t("report_orders_pipeline_delivered_count")}</span>
          </div>
        </div>

        <h2 class="section-title">${t("report_orders_pipeline_discount_title")}</h2>
        <div class="card-list">
          <div class="card report-row">
            <span>${t("report_orders_pipeline_discount_pending")}</span>
            <strong>${discount.pending_count}${
              discount.oldest_pending_at ? ` · ${t("report_orders_pipeline_oldest_since").replace("{date}", formatDateTime(discount.oldest_pending_at))}` : ""
            }</strong>
          </div>
          <div class="card report-row">
            <span>${t("report_orders_pipeline_discount_approved")}</span>
            <strong>${discount.approved_count}</strong>
          </div>
          <div class="card report-row">
            <span>${t("report_orders_pipeline_discount_rejected")}</span>
            <strong>${discount.rejected_count}</strong>
          </div>
        </div>
      `;
    } catch (err) {
      body.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    }
  }

  form.addEventListener("change", load);
  await load();
}

const PAYMENT_STATUS_OPTIONS = ["pending", "approved", "rejected"];

function formatAvgInterval(pgInterval) {
  if (!pgInterval) return "—";
  // node-postgres returns an INTERVAL as {hours, minutes, days, ...} -- keep
  // this to the coarsest unit that's actually informative for an approval
  // turnaround (hours is the practical unit here, not days/weeks).
  const totalHours = (pgInterval.days || 0) * 24 + (pgInterval.hours || 0) + (pgInterval.minutes || 0) / 60;
  return `${totalHours.toFixed(1)}h`;
}

async function renderPaymentsReport(root, navigate) {
  root.innerHTML = `
    <div class="detail-view">
      ${reportHeaderHtml("report_payments_name")}
      <form id="report-filters" class="report-filter-form">
        ${selectHtml(
          "period",
          PERIOD_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) })),
          "month"
        )}
        ${selectHtml(
          "status",
          [{ value: "", label: t("all_payment_statuses") }, ...PAYMENT_STATUS_OPTIONS.map((v) => ({ value: v, label: t(`payment_status_${v}`) }))],
          ""
        )}
      </form>
      <div id="report-body"><p class="loading-state" role="status">${t("loading")}</p></div>
    </div>
  `;
  const container = root.querySelector(".detail-view");
  container.querySelector("#back-btn").addEventListener("click", () => navigate("#/reports"));
  const form = container.querySelector("#report-filters");
  const body = container.querySelector("#report-body");

  async function load() {
    body.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
    const data = new FormData(form);
    const params = Object.fromEntries([...data.entries()].filter(([, v]) => v));
    let result;
    try {
      result = await api.getPaymentsReport(params);
    } catch (err) {
      body.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
      return;
    }
    const { kpis, by_channel, by_manager, daily_trend, operations } = result;

    function drillLink(extraParams) {
      const qs = new URLSearchParams({ ...params, ...extraParams }).toString();
      return `#/payments${qs ? `?${qs}` : ""}`;
    }

    const maxDaily = Math.max(1, ...daily_trend.map((d) => Number(d.approved_amd)));

    body.innerHTML = `
      <div class="stat-grid">
        <button type="button" class="stat-card report-drill-card" data-href="${drillLink({})}">
          <span class="stat-value">${kpis.submitted_count}</span>
          <span class="stat-label">${t("report_payments_submitted")}</span>
          <span class="stat-sublabel">${formatAmd(Number(kpis.submitted_amd))}</span>
        </button>
        <button type="button" class="stat-card report-drill-card" data-href="${drillLink({ status: "approved" })}">
          <span class="stat-value">${kpis.approved_count}</span>
          <span class="stat-label">${t("report_payments_approved")}</span>
          <span class="stat-sublabel">${formatAmd(Number(kpis.approved_amd))}</span>
        </button>
        <button type="button" class="stat-card report-drill-card" data-href="${drillLink({ status: "pending" })}">
          <span class="stat-value">${kpis.pending_count}</span>
          <span class="stat-label">${t("payment_status_pending")}</span>
          <span class="stat-sublabel">${formatAmd(Number(kpis.pending_amd))}</span>
        </button>
        <button type="button" class="stat-card report-drill-card" data-href="${drillLink({ status: "rejected" })}">
          <span class="stat-value">${kpis.rejected_count}</span>
          <span class="stat-label">${t("payment_status_rejected")}</span>
          <span class="stat-sublabel">${formatAmd(Number(kpis.rejected_amd))}</span>
        </button>
      </div>

      <h2 class="section-title">${t("report_payments_operations")}</h2>
      <div class="card-list">
        <div class="card report-row"><span>${t("report_payments_pending_now")}</span><strong>${operations.pending_count}</strong></div>
        <div class="card report-row"><span>${t("report_payments_pending_over_24h")}</span><strong>${operations.pending_over_24h}</strong></div>
        <div class="card report-row"><span>${t("report_payments_oldest_pending")}</span><strong>${operations.oldest_pending_at ? formatDate(operations.oldest_pending_at) : "—"}</strong></div>
        <div class="card report-row"><span>${t("report_payments_avg_approval_time")}</span><strong>${formatAvgInterval(operations.avg_approval_interval)}</strong></div>
        <div class="card report-row"><span>${t("payment_status_rejected")}</span><strong>${operations.rejected_count}</strong></div>
      </div>

      ${
        daily_trend.length
          ? `<h2 class="section-title">${t("report_payments_daily_trend")}</h2>
        <div class="card trend-chart-card">
          <div class="trend-chart" role="img" aria-label="${t("report_payments_daily_trend")}">
            ${daily_trend
              .map((d) => {
                const heightPct = Math.round((Number(d.approved_amd) / maxDaily) * 100);
                return `<div class="trend-bar" style="height:${Math.max(heightPct, Number(d.approved_amd) > 0 ? 4 : 0)}%" title="${formatDateOnly(d.day)}: ${formatAmd(Number(d.approved_amd))}"></div>`;
              })
              .join("")}
          </div>
        </div>`
          : ""
      }

      <h2 class="section-title">${t("by_channel")}</h2>
      <div class="card-list">
        ${
          by_channel.length
            ? by_channel
                .map(
                  (c) => `
              <button type="button" class="card report-row report-drill-card" data-href="${drillLink({ sales_channel: c.sales_channel === "—" ? "" : c.sales_channel })}">
                <span>${escapeHtml(channelDisplayLabel(c.sales_channel))}</span>
                <strong>${formatAmd(Number(c.approved_amd))}</strong>
              </button>`
                )
                .join("")
            : `<p class="empty-state">${t("no_data")}</p>`
        }
      </div>

      <h2 class="section-title">${t("by_manager")}</h2>
      <div class="card-list">
        ${
          by_manager.length
            ? by_manager
                .map(
                  (m) => `
              <button type="button" class="card report-row report-drill-card" data-href="${drillLink({ sales_manager_id: m.sales_manager_id })}">
                <span>${escapeHtml(m.sales_manager_name)}</span>
                <strong>${formatAmd(Number(m.approved_amd))}</strong>
              </button>`
                )
                .join("")
            : `<p class="empty-state">${t("no_data")}</p>`
        }
      </div>
    `;

    body.querySelectorAll(".report-drill-card").forEach((el) => {
      el.addEventListener("click", () => navigate(el.dataset.href));
    });
  }

  form.addEventListener("change", load);
  await load();
}

// No period filter -- unlike every other report here, this is a snapshot
// of custody right now (who's physically holding unreconciled cash this
// second), not a historical query, so "this month" would be meaningless.
async function renderCashCustodyReport(root, navigate) {
  root.innerHTML = `
    <div class="detail-view">
      ${reportHeaderHtml("report_cash_custody_name")}
      <div id="report-body"><p class="loading-state" role="status">${t("loading")}</p></div>
    </div>
  `;
  const container = root.querySelector(".detail-view");
  container.querySelector("#back-btn").addEventListener("click", () => navigate("#/reports"));
  const body = container.querySelector("#report-body");

  try {
    const { by_holder, totals, handoffs, operations } = await api.getCashCustodyReport();
    body.innerHTML = `
      <div class="stat-grid">
        <div class="stat-card">
          <span class="stat-value stat-value-amd">${amdWithUnitHtml(Number(totals.total_unreconciled_amd))}</span>
          <span class="stat-label">${t("report_cash_custody_total_unreconciled")}</span>
        </div>
        <div class="stat-card">
          <span class="stat-value stat-value-amd">${amdWithUnitHtml(Number(totals.in_transit_amd))}</span>
          <span class="stat-label">${t("report_cash_custody_in_transit")}</span>
        </div>
      </div>

      <h2 class="section-title">${t("report_cash_custody_by_holder")}</h2>
      <div class="card-list">
        ${
          by_holder.length
            ? by_holder
                .map(
                  (h) => `
            <div class="card report-row-multiline">
              <strong>${escapeHtml(h.holder_name)}</strong>
              <span class="muted">${t(`role_${h.holder_role}`)} · ${h.payment_count}${
                    Number(h.in_transit_count) > 0
                      ? ` · <span class="sync-badge-stale">${t("report_cash_custody_holder_in_transit").replace("{n}", h.in_transit_count)}</span>`
                      : ""
                  }</span>
              <span class="muted">${formatAmd(Number(h.amount_amd))}</span>
            </div>`
                )
                .join("")
            : `<p class="empty-state">${t("no_data")}</p>`
        }
      </div>

      <h2 class="section-title">${t("report_cash_custody_handoffs_title")}</h2>
      ${
        Number(operations.pending_over_24h) > 0
          ? `<p class="sync-badge sync-badge-stale">${t("report_cash_custody_handoffs_overdue").replace("{n}", operations.pending_over_24h)}</p>`
          : ""
      }
      <div class="card-list">
        ${
          handoffs.length
            ? handoffs
                .map(
                  (h) => `
            <div class="card report-row-multiline">
              <strong>${escapeHtml(h.from_name)} → ${escapeHtml(h.to_name)}</strong>
              <span class="muted">${formatAmd(Number(h.amount_amd))} · ${t("report_cash_custody_since").replace("{date}", formatDateTime(h.submitted_at))}</span>
            </div>`
                )
                .join("")
            : `<p class="empty-state">${t("report_cash_custody_no_handoffs")}</p>`
        }
      </div>
    `;
  } catch (err) {
    body.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
  }
}

// Day-by-day history, unlike cash_custody's live snapshot above -- flags
// any day where field-collected cash and same-day payment submissions
// diverge by more than the server's own alert threshold (see
// CASH_RECONCILIATION_ALERT_AMD in routes/reports.js), which is a real
// signal something didn't make it from "collected" to "submitted" (or
// vice versa), not just a rep's collection landing a day later than usual.
async function renderCashReconciliationReport(root, navigate) {
  root.innerHTML = `
    <div class="detail-view">
      ${reportHeaderHtml("report_cash_reconciliation_name")}
      <div id="report-body"><p class="loading-state" role="status">${t("loading")}</p></div>
    </div>
  `;
  const container = root.querySelector(".detail-view");
  container.querySelector("#back-btn").addEventListener("click", () => navigate("#/reports"));
  const body = container.querySelector("#report-body");

  try {
    const { rows, alert_threshold_amd } = await api.getCashReconciliationReport();
    const alertCount = rows.filter((r) => r.alert).length;
    body.innerHTML = `
      ${
        alertCount
          ? `<p class="sync-badge sync-badge-stale">${t("report_cash_reconciliation_alert_summary").replace("{n}", alertCount).replace("{amount}", formatAmd(alert_threshold_amd))}</p>`
          : `<p class="muted">${t("report_cash_reconciliation_no_alerts")}</p>`
      }
      <div class="card-list">
        ${rows
          .map((r) => {
            const diff = Number(r.difference_amd);
            return `
            <div class="card cash-recon-card${diff !== 0 ? " cash-recon-card-diff" : ""}">
              <div class="cash-recon-top">
                <strong>${formatDateDMY(r.day)}</strong>
                <span class="${diff !== 0 ? "cash-recon-diff-amount" : "muted"}">${t("report_cash_reconciliation_difference")}: ${diff > 0 ? "+" : ""}${formatAmd(diff)}</span>
              </div>
              <span class="muted">${t("report_cash_reconciliation_collected")}: ${formatAmd(Number(r.collected_amd))} · ${t("report_cash_reconciliation_submitted")}: ${formatAmd(Number(r.submitted_amd))}</span>
            </div>`;
          })
          .join("")}
      </div>
    `;
  } catch (err) {
    body.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
  }
}

function currentYearMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

// Local calendar-date components, not toISOString() -- see sales.js's own
// formatDateInput for why (UTC-conversion day-shift east of UTC). Used as
// the customer-debt as-of-date picker's `max`, so a user can't pick a
// future date the server has no order/cashflow history for yet.
function currentYearMonthDay() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

// "15 Sep 2026" style, same short-date convention as sales.js's own
// formatSalesDateCaption -- parseDateOnly rather than `new Date(value)`
// since this is a date-only string.
function formatReportAsOfCaption(dateOnly) {
  const d = parseDateOnly(dateOnly);
  if (!d) return String(dateOnly ?? "");
  const month = d.toLocaleDateString(getLang() === "hy" ? "hy" : "en", { month: "short" });
  return `${d.getDate()} ${month} ${d.getFullYear()}`;
}

let cachedChannelOptions = null;
async function channelOptions() {
  if (cachedChannelOptions) return cachedChannelOptions;
  const channels = await api.getPerfChannels();
  cachedChannelOptions = [{ value: "", label: t("all_channels") }, ...channels.map((c) => ({ value: c.code, label: c.name }))];
  return cachedChannelOptions;
}

// Shrinks the "AMD" unit first (down to 40%), then the whole figure, until a
// no-wrap amount fits its card -- so a very large total never gets clipped to "…".
function fitReportStatValue(el) {
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

async function renderCustomerDebtReport(root, navigate) {
  root.innerHTML = `
    <div class="detail-view">
      ${reportHeaderHtml("report_customer_debt_name")}
      <form id="report-filters" class="report-filter-form report-debt-filters">
        <div class="pill-date-filter-row">
          <div class="pill-date-filter-wrap">
            <button type="button" class="pill-date-filter-btn" tabindex="-1" aria-hidden="true">
              <span class="pill-date-filter-caption">${t("debt_balances_as_of_date")}</span>
              <span class="pill-date-filter-value" id="report-debt-as-of-value">${t("debt_balances_as_of_live")}</span>
            </button>
            <input type="date" class="pill-date-picker-input" id="report-debt-as-of-input" name="date" value="" max="${currentYearMonthDay()}" aria-label="${t("debt_balances_as_of_date")}" />
          </div>
          <button type="button" class="pill-date-clear-btn" id="report-debt-as-of-clear" hidden aria-label="${t("debt_balances_as_of_clear")}" title="${t("debt_balances_as_of_clear")}">${icons.close}</button>
        </div>
        <button type="button" class="map-filter-chip report-channel-btn" id="report-debt-channels-btn" aria-haspopup="dialog">${t("all_channels")}</button>
        ${selectHtml(
          "debt_only",
          [
            { value: "1", label: t("report_customer_debt_with_debt_only") },
            { value: "", label: t("report_customer_debt_all") },
          ],
          "1"
        )}
      </form>
      <div id="report-body"><p class="loading-state" role="status">${t("loading")}</p></div>
    </div>
  `;
  const container = root.querySelector(".detail-view");
  container.querySelector("#back-btn").addEventListener("click", () => navigate("#/reports"));
  const form = container.querySelector("#report-filters");
  const body = container.querySelector("#report-body");
  const asOfInput = container.querySelector("#report-debt-as-of-input");
  const asOfValueEl = container.querySelector("#report-debt-as-of-value");
  const asOfClearBtn = container.querySelector("#report-debt-as-of-clear");

  // Just paints the pill's own caption -- reloading is already handled by
  // the form-level "change" listener below (this input lives inside
  // #report-filters, so its native change event bubbles there too).
  asOfInput.addEventListener("change", () => {
    asOfValueEl.textContent = asOfInput.value ? formatReportAsOfCaption(asOfInput.value) : t("debt_balances_as_of_live");
    asOfClearBtn.hidden = !asOfInput.value;
  });
  // The clear button sets the input's value programmatically, which does
  // NOT fire a native "change" event on its own -- so this one does need
  // to trigger the reload itself, unlike the listener above.
  asOfClearBtn.addEventListener("click", () => {
    asOfInput.value = "";
    asOfValueEl.textContent = t("debt_balances_as_of_live");
    asOfClearBtn.hidden = true;
    load();
  });

  // Channel filter: multi-select (sheet of checkboxes). Empty set = all channels.
  const selectedChannels = new Set();
  const selectedBuckets = new Set();
  let channelList = [];
  const channelBtn = container.querySelector("#report-debt-channels-btn");
  function paintChannelBtn() {
    if (!selectedChannels.size) channelBtn.textContent = t("all_channels");
    else if (selectedChannels.size === 1) channelBtn.textContent = channelList.find((c) => c.value === [...selectedChannels][0])?.label ?? [...selectedChannels][0];
    else channelBtn.textContent = `${selectedChannels.size} ${t("channels_selected")}`;
    channelBtn.classList.toggle("chip-active", selectedChannels.size > 0);
  }
  try {
    channelList = (await channelOptions()).filter((o) => o.value);
  } catch {
    // Channel list is a filter convenience only -- if it fails to load, the
    // report itself (unfiltered) still works fine below.
  }
  channelBtn.addEventListener("click", () => {
    const picked = new Set(selectedChannels);
    const overlay = document.createElement("div");
    overlay.className = "sheet-overlay";
    overlay.innerHTML = `
      <div class="sheet pd-edit-sheet">
        <h2>${t("all_channels")}</h2>
        <div class="pd-edit-scroll">
          <div class="filter-sheet-chips">
            ${channelList.map((c) => `<button type="button" class="filter-sheet-chip ${picked.has(c.value) ? "filter-sheet-chip-selected" : ""}" data-value="${escapeHtml(c.value)}" aria-pressed="${picked.has(c.value)}">${escapeHtml(c.label)}</button>`).join("")}
          </div>
        </div>
        <div class="sheet-actions">
          <button type="button" class="btn" id="ch-clear">${t("clear")}</button>
          <button type="button" class="btn btn-primary" id="ch-show">${t("show_results")}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    activateDialog(overlay);
    overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());
    const sync = (chip) => {
      chip.classList.toggle("filter-sheet-chip-selected", picked.has(chip.dataset.value));
      chip.setAttribute("aria-pressed", String(picked.has(chip.dataset.value)));
    };
    overlay.querySelector(".filter-sheet-chips").addEventListener("click", (e) => {
      const chip = e.target.closest("[data-value]");
      if (!chip) return;
      if (picked.has(chip.dataset.value)) picked.delete(chip.dataset.value);
      else picked.add(chip.dataset.value);
      sync(chip);
    });
    overlay.querySelector("#ch-clear").addEventListener("click", () => {
      picked.clear();
      overlay.querySelectorAll("[data-value]").forEach(sync);
    });
    overlay.querySelector("#ch-show").addEventListener("click", () => {
      selectedChannels.clear();
      for (const v of picked) selectedChannels.add(v);
      selectedBuckets.clear(); // a different channel set has different buckets
      overlay.remove();
      paintChannelBtn();
      load();
    });
  });

  // The page frame (stat cards, bucket list, customer list) is built once;
  // changing a filter only swaps the numbers and the two lists inside it, so
  // nothing blinks or collapses to a spinner and the scroll position stays.
  let scaffolded = false;
  let loadSeq = 0;
  function scaffold() {
    body.innerHTML = `
      <div id="debt-sync-badge"></div>
      <div class="stat-grid">
        <div class="stat-card">
          <span class="stat-value report-debt-total-value" id="report-debt-total-value"></span>
          <span class="stat-label">${t("report_customer_debt_total_debt")}</span>
        </div>
        <div class="stat-card">
          <span class="stat-value report-debt-total-value" id="report-debt-customers-value"></span>
          <span class="stat-label">${t("report_customer_debt_customers_with_debt")}</span>
        </div>
      </div>
      <div id="debt-adjusted-note"></div>
      <h2 class="section-title">${t("report_customer_debt_by_bucket")}</h2>
      <div class="card-list" id="debt-bucket-list"></div>
      <h2 class="section-title" id="debt-customers-title"></h2>
      <div class="card-list" id="debt-customer-list"></div>
    `;
    // Delegated once: the bucket rows are re-rendered on every load.
    // Tapping an aging row filters the customer list (and totals) to that
    // bucket; tap again to clear. Several buckets can be combined.
    body.querySelector("#debt-bucket-list").addEventListener("click", (e) => {
      const btn = e.target.closest(".report-bucket-btn");
      if (!btn) return;
      const bucket = btn.dataset.bucket;
      if (selectedBuckets.has(bucket)) selectedBuckets.delete(bucket);
      else selectedBuckets.add(bucket);
      // Instant feedback on the row itself, before the numbers arrive.
      btn.classList.toggle("report-bucket-active", selectedBuckets.has(bucket));
      btn.setAttribute("aria-pressed", String(selectedBuckets.has(bucket)));
      load();
    });
    scaffolded = true;
  }

  function paintDebt({ customers, by_bucket, totals, sync }) {
    body.querySelector("#debt-sync-badge").innerHTML = syncBadgeHtml(sync);
    body.querySelector("#report-debt-total-value").innerHTML = amdWithUnitHtml(Number(totals.total_debt_amd));
    body.querySelector("#report-debt-customers-value").textContent = totals.customers_with_debt;
    // Only meaningful in live mode -- totals.total_debt_amd_erp is always the
    // raw live erp.debt_amd sum, which as-of-date mode has no reason to match
    // (it's comparing two different things, not "collections since sync"),
    // so this note would be misleading rather than explanatory there.
    body.querySelector("#debt-adjusted-note").innerHTML =
      !asOfInput.value && Number(totals.total_debt_amd_erp) !== Number(totals.total_debt_amd)
        ? `<p class="muted" style="margin: 0 4px 12px;">${t("report_customer_debt_adjusted_note")
            .replace("{erp}", formatAmd(Number(totals.total_debt_amd_erp)))
            .replace("{adjusted}", formatAmd(Number(totals.total_debt_amd)))}</p>`
        : "";
    body.querySelector("#debt-bucket-list").innerHTML = by_bucket.length
      ? by_bucket
          .map(
            (b) => `
        <button type="button" class="card report-row report-bucket-btn ${selectedBuckets.has(b.aging_bucket) ? "report-bucket-active" : ""}" data-bucket="${escapeHtml(b.aging_bucket)}" aria-pressed="${selectedBuckets.has(b.aging_bucket)}">
          <span>${escapeHtml(t(`debt_bucket_${b.aging_bucket}`))}</span>
          <strong class="report-row-amount">${formatAmd(Number(b.total_debt_amd))} <span class="muted">(${b.customer_count})</span></strong>
        </button>`
          )
          .join("")
      : `<p class="empty-state">${t("no_data")}</p>`;
    body.querySelector("#debt-customers-title").textContent = `${t("customers")} (${customers.length})`;
    body.querySelector("#debt-customer-list").innerHTML = customers.length
      ? customers
          .map((c) => {
            const collected = Number(c.collected_since_sync_amd);
            return `
        <div class="card report-row-multiline ${Number(c.estimated_debt_amd) > 0 && c.oldest_due_days != null ? (c.oldest_due_days > 0 ? "unpaid-row-overdue" : "unpaid-row-due") : ""}">
          <div class="report-debt-customer-top">
            <strong class="report-debt-customer-name">${escapeHtml(c.customer_name)}</strong>
            <strong class="report-row-amount">${formatAmd(Number(c.estimated_debt_amd))}</strong>
          </div>
          ${c.oldest_due_days != null && Number(c.estimated_debt_amd) > 0 ? `<div class="debt-chip-line">${Number(c.overdue_amd) > 0 ? `<span class="muted">${t("debt_overdue_label")}: ${formatAmd(Number(c.overdue_amd))}</span>` : ""}${dueChipHtml(c.oldest_due_days)}</div>` : ""}
          <span class="muted">${t("customer_id_label")}: ${escapeHtml(c.erp_customer_id || "—")} · ${escapeHtml(channelDisplayLabel(c.assigned_sales_rep))}</span>
          <span class="muted">${t("debt_balances_last_payment")}: ${c.last_payment_date ? escapeHtml(formatDateDMY(c.last_payment_date)) : t("report_customer_debt_no_payment")}</span>${
              collected > 0
                ? `
          <span class="muted sync-adjusted-note">${formatAmd(Number(c.debt_amd))} ${t("report_customer_debt_per_sync")} − ${formatAmd(collected)} ${t("report_customer_debt_collected_since")}</span>`
                : ""
            }
        </div>`;
          })
          .join("")
      : `<p class="empty-state">${t("no_data")}</p>`;
    fitReportStatValue(body.querySelector("#report-debt-total-value"));
  }

  async function load() {
    const seq = ++loadSeq;
    if (scaffolded) body.classList.add("report-body-refreshing");
    else body.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
    const data = new FormData(form);
    const params = Object.fromEntries([...data.entries()].filter(([, v]) => v));
    if (selectedChannels.size) params.sales_channel = [...selectedChannels].join(",");
    if (selectedBuckets.size) params.aging = [...selectedBuckets].join(",");
    try {
      const result = await api.getCustomerDebtReport(params);
      if (seq !== loadSeq) return; // a newer filter change is already in flight
      if (!scaffolded) scaffold();
      body.querySelector(":scope > .form-error")?.remove();
      paintDebt(result);
      body.classList.remove("report-body-refreshing");
    } catch (err) {
      if (seq !== loadSeq) return;
      body.classList.remove("report-body-refreshing");
      if (scaffolded) {
        // Keep the page; show the error above it.
        body.querySelector(".form-error")?.remove();
        body.insertAdjacentHTML("afterbegin", `<p class="form-error">${escapeHtml(err.message)}</p>`);
      } else {
        body.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
      }
    }
  }

  form.addEventListener("change", load);
  await load();
}

async function renderSalesBudgetReport(root, navigate) {
  root.innerHTML = `
    <div class="detail-view">
      ${reportHeaderHtml("report_sales_budget_name")}
      <form id="report-filters" class="report-filter-form">
        <input type="month" name="month" value="${currentYearMonth()}" />
      </form>
      <div id="report-body"><p class="loading-state" role="status">${t("loading")}</p></div>
    </div>
  `;
  const container = root.querySelector(".detail-view");
  container.querySelector("#back-btn").addEventListener("click", () => navigate("#/reports"));
  const form = container.querySelector("#report-filters");
  const body = container.querySelector("#report-body");

  function achievedPct(sales, budget) {
    if (!budget) return "—";
    return `${Math.round((sales / budget) * 100)}%`;
  }

  async function load() {
    body.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
    const data = new FormData(form);
    const params = Object.fromEntries([...data.entries()].filter(([, v]) => v));
    try {
      const { rows, totals, sync } = await api.getSalesBudgetReport(params);
      body.innerHTML = `
        ${syncBadgeHtml(sync)}
        <div class="stat-grid">
          <div class="stat-card">
            <span class="stat-value stat-value-amd">${amdWithUnitHtml(totals.sales_amd)}</span>
            <span class="stat-label">${t("report_sales_budget_sales")}</span>
          </div>
          <div class="stat-card">
            <span class="stat-value stat-value-amd">${amdWithUnitHtml(totals.budget_amd)}</span>
            <span class="stat-label">${t("report_sales_budget_budget")}</span>
          </div>
          <div class="stat-card">
            <span class="stat-value">${achievedPct(totals.sales_amd, totals.budget_amd)}</span>
            <span class="stat-label">${t("report_sales_budget_achieved")}</span>
          </div>
          <div class="stat-card">
            <span class="stat-value stat-value-amd">${amdWithUnitHtml(totals.collected_amd)}</span>
            <span class="stat-label">${t("report_sales_budget_collected")}</span>
          </div>
        </div>

        <h2 class="section-title">${t("by_channel")}</h2>
        <div class="card-list">
          ${
            rows.length
              ? rows
                  .map(
                    (r) => `
              <div class="card report-row-multiline">
                <strong>${escapeHtml(r.channel_name || channelDisplayLabel(r.rep_name))}</strong>
                <span class="muted">${formatAmd(Number(r.sales_amd))} / ${formatAmd(Number(r.budget_amd))} (${achievedPct(Number(r.sales_amd), Number(r.budget_amd))}) · ${t("report_sales_budget_collected")}: ${formatAmd(Number(r.collected_amd))}</span>
              </div>`
                  )
                  .join("")
              : `<p class="empty-state">${t("no_data")}</p>`
          }
        </div>
      `;
    } catch (err) {
      body.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    }
  }

  form.addEventListener("change", load);
  await load();
}

function brandLabel(key) {
  return BRAND_LABELS[key] || key;
}

async function renderBrandVolumeReport(root, navigate) {
  root.innerHTML = `
    <div class="detail-view">
      ${reportHeaderHtml("report_brand_volume_name")}
      <form id="report-filters" class="report-filter-form">
        <input type="month" name="month" value="${currentYearMonth()}" />
        <select name="sales_channel"><option value="">${t("all_channels")}</option></select>
      </form>
      <div id="report-body"><p class="loading-state" role="status">${t("loading")}</p></div>
    </div>
  `;
  const container = root.querySelector(".detail-view");
  container.querySelector("#back-btn").addEventListener("click", () => navigate("#/reports"));
  const form = container.querySelector("#report-filters");
  const body = container.querySelector("#report-body");

  try {
    const options = await channelOptions();
    form.querySelector('select[name="sales_channel"]').outerHTML = selectHtml("sales_channel", options, "");
  } catch {
    // Filter convenience only, same as the debt report above.
  }

  async function load() {
    body.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
    const data = new FormData(form);
    const params = Object.fromEntries([...data.entries()].filter(([, v]) => v));
    try {
      const { rows, by_brand, sync } = await api.getBrandVolumeReport(params);
      body.innerHTML = `
        ${syncBadgeHtml(sync)}
        <h2 class="section-title">${t("report_brand_volume_total")}</h2>
        <div class="card-list">
          ${
            by_brand.length
              ? by_brand
                  .map(
                    (b) => `
              <div class="card report-row">
                <span>${escapeHtml(brandLabel(b.brand))}</span>
                <strong>${Number(b.total_liters).toLocaleString()} L</strong>
              </div>`
                  )
                  .join("")
              : `<p class="empty-state">${t("no_data")}</p>`
          }
        </div>

        <h2 class="section-title">${t("by_channel")}</h2>
        <div class="card-list">
          ${
            rows.length
              ? rows
                  .map(
                    (r) => `
              <div class="card report-row">
                <span>${escapeHtml(r.channel_name || channelDisplayLabel(r.channel_code))} · ${escapeHtml(brandLabel(r.brand))}</span>
                <strong>${Number(r.liters).toLocaleString()} L</strong>
              </div>`
                  )
                  .join("")
              : `<p class="empty-state">${t("no_data")}</p>`
          }
        </div>
      `;
    } catch (err) {
      body.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    }
  }

  form.addEventListener("change", load);
  await load();
}

function formatUsd(value) {
  if (value == null) return "";
  return `${Number(value).toLocaleString()} ${t("usd")}`;
}

function signedAmd(value) {
  if (value == null) return t("no_data");
  const n = Number(value);
  return `${n > 0 ? "+" : ""}${formatAmd(n)}`;
}

const REPORT_PERIODS = ["daily", "weekly", "monthly", "quarterly", "annual"];

async function renderDailyManagementReport(root, navigate) {
  root.innerHTML = `
    <div class="detail-view">
      ${reportHeaderHtml("report_daily_management_name")}
      <form id="report-filters" class="report-filter-form">
        <select name="period">
          ${REPORT_PERIODS.map((p) => `<option value="${p}">${t(`report_daily_management_period_tab_${p}`)}</option>`).join("")}
        </select>
        <select name="date"></select>
      </form>
      <div id="report-body"><p class="loading-state" role="status">${t("loading")}</p></div>
    </div>
  `;
  const container = root.querySelector(".detail-view");
  container.querySelector("#back-btn").addEventListener("click", () => navigate("#/reports"));
  const form = container.querySelector("#report-filters");
  const periodSelect = form.querySelector('select[name="period"]');
  const dateSelect = form.querySelector('select[name="date"]');
  const body = container.querySelector("#report-body");

  async function load(explicitDate) {
    body.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
    try {
      const period = periodSelect.value;
      const result = await api.getDailyManagementReport(explicitDate ? { date: explicitDate, period } : { period });
      if (!result?.report) {
        dateSelect.innerHTML = "";
        body.innerHTML = `<p class="empty-state">${t("no_data")}</p>`;
        return;
      }
      const { report: r, available_dates } = result;

      if (!explicitDate) {
        dateSelect.innerHTML = available_dates.map((d) => `<option value="${d}" ${d === r.report_date ? "selected" : ""}>${formatDateOnly(d)}</option>`).join("");
      }

      const salesRows = [
        [t("report_daily_management_period_ytd"), r.sales_ytd_amd, r.sales_ytd_liters, r.sales_ytd_orders],
        [t("report_daily_management_period_mtd"), r.sales_mtd_amd, r.sales_mtd_liters, r.sales_mtd_orders],
        [t("report_daily_management_period_wtd"), r.sales_wtd_amd, r.sales_wtd_liters, r.sales_wtd_orders],
        [t("report_daily_management_period_day"), r.sales_day_amd, r.sales_day_liters, r.sales_day_orders],
      ];
      const paymentsRows = [
        [t("report_daily_management_period_ytd"), r.payments_ytd_amd, r.payments_ytd_customers],
        [t("report_daily_management_period_mtd"), r.payments_mtd_amd, r.payments_mtd_customers],
        [t("report_daily_management_period_wtd"), r.payments_wtd_amd, r.payments_wtd_customers],
        [t("report_daily_management_period_day"), r.payments_day_amd, r.payments_day_customers],
      ];

      body.innerHTML = `
        <h2 class="section-title">${t("report_daily_management_sales")}</h2>
        <div class="stat-grid stat-grid-4">
          ${salesRows
            .map(
              ([label, amd, liters, orders]) => `
            <div class="stat-card">
              <span class="stat-value stat-value-amd">${amdWithUnitHtml(amd)}</span>
              <span class="stat-label">${label}</span>
              <span class="muted">${liters != null ? `${Number(liters).toLocaleString()} L` : "—"} · ${orders != null ? orders : "—"}</span>
            </div>`
            )
            .join("")}
        </div>
        <p class="muted" style="margin: 0 4px 8px;">${t("report_daily_management_change_prev")}: ${signedAmd(r.sales_change_amd)}${r.sales_change_liters != null ? ` · ${r.sales_change_liters > 0 ? "+" : ""}${Number(r.sales_change_liters).toLocaleString()} L` : ""}</p>
        <p class="muted" style="margin: 0 4px 8px;">${t("report_daily_management_margin")}: ${formatAmd(r.sales_margin_amd)}${r.sales_margin_pct != null ? ` (${Number(r.sales_margin_pct).toFixed(1)}%)` : ""}</p>

        <h2 class="section-title">${t("report_daily_management_sales")} · ${t("by_channel")} (${formatDateOnly(r.report_date)})</h2>
        <div class="card-list">
          ${
            r.sales_by_channel.length
              ? r.sales_by_channel
                  .map(
                    (c) => `
              <div class="card report-row">
                <span>${escapeHtml(channelDisplayLabel(c.channel_code))}</span>
                <strong>${formatAmd(c.amd)} · ${c.liters != null ? `${Number(c.liters).toLocaleString()} L` : "—"} · ${c.orders != null ? c.orders : "—"}</strong>
              </div>`
                  )
                  .join("")
              : `<p class="empty-state">${t("no_data")}</p>`
          }
        </div>

        <h2 class="section-title">${t("report_daily_management_payments")}</h2>
        <div class="stat-grid stat-grid-4">
          ${paymentsRows
            .map(
              ([label, amd, customers]) => `
            <div class="stat-card">
              <span class="stat-value stat-value-amd">${amdWithUnitHtml(amd)}</span>
              <span class="stat-label">${label}</span>
              <span class="muted">${customers != null ? customers : "—"}</span>
            </div>`
            )
            .join("")}
        </div>

        <h2 class="section-title">${t("report_daily_management_payments")} · ${t("by_channel")} (${formatDateOnly(r.report_date)})</h2>
        <div class="card-list">
          ${
            r.payments_by_channel.length
              ? r.payments_by_channel
                  .map(
                    (c) => `
              <div class="card report-row">
                <span>${escapeHtml(channelDisplayLabel(c.channel_code))}</span>
                <strong>${formatAmd(c.amd)} · ${c.customers != null ? c.customers : "—"}</strong>
              </div>`
                  )
                  .join("")
              : `<p class="empty-state">${t("no_data")}</p>`
          }
        </div>

        <h2 class="section-title">${t("report_daily_management_balance")}</h2>
        <div class="card-list">
          <p class="list-group-heading">${t("report_daily_management_group_cash")}</p>
          <div class="card report-row"><span>${t("report_daily_management_balance")}</span><strong>${formatAmd(r.balance_amd)}${r.balance_usd != null ? ` (${formatUsd(r.balance_usd)})` : ""}</strong></div>
          <div class="card report-row"><span>${t("report_daily_management_total")}</span><strong>${formatAmd(r.balance_total_amd)}${r.balance_total_usd != null ? ` (${formatUsd(r.balance_total_usd)})` : ""}</strong></div>
          <div class="card report-row"><span>${t("report_daily_management_cash")}</span><strong>${formatAmd(r.balance_cash_amd)}${r.balance_cash_usd != null ? ` (${formatUsd(r.balance_cash_usd)})` : ""}</strong></div>
          <div class="card report-row"><span>${t("report_daily_management_noncash")}</span><strong>${formatAmd(r.balance_noncash_amd)}${r.balance_noncash_usd != null ? ` (${formatUsd(r.balance_noncash_usd)})` : ""}</strong></div>

          <p class="list-group-heading">${t("report_daily_management_with_managers")}</p>
          <div class="card report-row"><span>${t("report_daily_management_total")}</span><strong>${formatAmd(r.balance_with_managers_amd)}</strong></div>
          ${r.balance_with_managers_by_manager
            .map(
              (m) => `
          <div class="card report-row"><span style="padding-left:12px;">${escapeHtml(m.manager_name)}</span><strong>${formatAmd(m.amd)}</strong></div>`
            )
            .join("")}

          <p class="list-group-heading">${t("report_daily_management_group_other")}</p>
          <div class="card report-row"><span>${t("report_daily_management_credit_line")}</span><strong>${formatUsd(r.credit_line_usd)}</strong></div>
          <div class="card report-row"><span>${t("report_daily_management_receivables")}</span><strong>${formatAmd(r.receivables_total_amd)} (${t("report_daily_management_receivables_net")}: ${formatAmd(r.receivables_net_amd)})</strong></div>
          <div class="card report-row"><span>${t("report_daily_management_warehouse")}</span><strong>${formatAmd(r.warehouse_value_amd)} · ${r.warehouse_liters != null ? `${Number(r.warehouse_liters).toLocaleString()} L` : "—"}</strong></div>
        </div>
        ${
          r.prev_report_date
            ? `<p class="muted" style="margin: 8px 4px;">${t("report_daily_management_change_since")} ${formatDateOnly(r.prev_report_date)}: ${t("report_daily_management_total")} ${signedAmd(r.change_total_amd)}, ${t("report_daily_management_overdue")} ${signedAmd(r.change_overdue_amd)}</p>`
            : ""
        }
      `;
    } catch (err) {
      body.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    }
  }

  dateSelect.addEventListener("change", () => load(dateSelect.value));
  periodSelect.addEventListener("change", () => load());
  await load();
}

// Deliberately not run through t() -- these are trademarked brand names,
// not translatable UI copy, and read the same in Armenian as in English.
const BRAND_LABELS = {
  castrol: "Castrol",
  lotos: "Lotos",
  royal: "Royal",
  mobil: "Mobil",
  motul: "Motul",
  shell: "Shell",
  liquimoly: "Liqui Moly",
  bardahl: "Bardahl",
  aral: "Aral",
  oscar: "Oscar",
  zic: "ZIC",
  russian_oil: "Russian oil",
};

function summarizeBrandStatus(brandStatus) {
  const present = [];
  for (const brand of ["castrol", "lotos", "royal"]) {
    if ((brandStatus[brand] || []).length) present.push(BRAND_LABELS[brand]);
  }
  for (const key of brandStatus.competitors || []) {
    if (BRAND_LABELS[key]) present.push(BRAND_LABELS[key]);
  }
  return present;
}

async function renderBrandAvailabilityReport(root, navigate) {
  root.innerHTML = `
    <div class="detail-view">
      ${reportHeaderHtml("report_brand_availability_name")}
      <form id="report-filters" class="report-filter-form">
        ${selectHtml("region", [{ value: "", label: t("all_regions") }, ...REGION_LIST.map((r) => ({ value: r, label: regionLabelHy(r) }))], "")}
      </form>
      <p class="muted" style="margin: 0 4px 8px;">${t("brand_availability_map_hint")}</p>
      <div id="report-body"><p class="loading-state" role="status">${t("loading")}</p></div>
    </div>
  `;
  const container = root.querySelector(".detail-view");
  container.querySelector("#back-btn").addEventListener("click", () => navigate("#/reports"));
  const form = container.querySelector("#report-filters");
  const body = container.querySelector("#report-body");

  async function load() {
    body.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
    const data = new FormData(form);
    const params = Object.fromEntries([...data.entries()].filter(([, v]) => v));
    try {
      const rows = await api.getBrandAvailabilityReport(params);
      body.innerHTML = `
        <h2 class="section-title">${t("customers")} (${rows.length})</h2>
        <div class="card-list">
          ${
            rows.length
              ? rows
                  .map((r) => {
                    const brands = summarizeBrandStatus(r.brand_status || {});
                    return `
              <div class="card report-row-multiline">
                <strong>${escapeHtml(r.name)}</strong>
                <span class="muted">${escapeHtml(r.region || "")}${r.subregion ? `, ${escapeHtml(r.subregion)}` : ""} · ${formatDate(r.as_of)}</span>
                <span class="muted">${brands.length ? brands.map(escapeHtml).join(", ") : t("no_data")}</span>
              </div>`;
                  })
                  .join("")
              : `<p class="empty-state">${t("no_data")}</p>`
          }
        </div>
      `;
    } catch (err) {
      body.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    }
  }

  form.addEventListener("change", load);
  await load();
}
