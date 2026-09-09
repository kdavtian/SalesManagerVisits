import { api } from "../api.js";
import { escapeHtml } from "../util.js";
import { t } from "../i18n.js";
import { icons } from "../icons.js";
import { REGION_LIST, YEREVAN_DISTRICTS, CATEGORY_LIST, formatAmd, channelDisplayLabel } from "../util.js";

const PERIOD_OPTIONS = [
  { value: "", labelKey: "period_all_time" },
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

function formatDate(value) {
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
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
  if (reportKey === "brand_availability") return renderBrandAvailabilityReport(root, navigate);
  if (reportKey === "payments") return renderPaymentsReport(root, navigate);
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
    listEl.innerHTML = docs
      .map(
        (d) => `
      <a class="card report-row" href="/api/reports/documents/${d.id}/download">
        <span>
          <strong>${t(GENERATED_REPORT_TYPE_LABEL_KEY[d.report_type] || d.report_type)}</strong>
          <span class="muted"> · ${formatDate(d.report_date)}</span>
        </span>
        <span>${icons.download}</span>
      </a>`
      )
      .join("");
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
      <div id="reports-list" class="card-list"><p class="loading-state" role="status">${t("loading")}</p></div>
    </div>
  `;
  const container = root.querySelector(".detail-view");
  container.querySelector("#back-btn").addEventListener("click", () => navigate("#/dashboard"));
  const listEl = container.querySelector("#reports-list");

  try {
    const reports = await api.listReports();
    if (!reports.length) {
      listEl.innerHTML = `<p class="empty-state">${t("no_reports_available")}</p>`;
      return;
    }
    listEl.innerHTML = reports
      .map(
        (r) => `
      <button type="button" class="card report-list-card" data-key="${r.key}">
        <span class="report-list-icon">${icons.chart}</span>
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

function reportHeaderHtml(titleKey) {
  return `
    <div class="detail-header">
      <button class="icon-btn" id="back-btn" aria-label="${t("back")}">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
      </button>
      <div class="detail-header-title"><h1>${t(titleKey)}</h1></div>
    </div>
  `;
}

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
        ${selectHtml("region", [{ value: "", label: t("all_regions") }, ...REGION_LIST.map((r) => ({ value: r, label: r }))], "")}
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
                <strong>${escapeHtml(c.name)}</strong>
                <span class="muted">${escapeHtml(c.region || "")}${c.subregion ? `, ${escapeHtml(c.subregion)}` : ""} · ${escapeHtml(c.created_by_name)} · ${formatDate(c.created_at)}</span>
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
        ${selectHtml("region", [{ value: "", label: t("all_regions") }, ...REGION_LIST.map((r) => ({ value: r, label: r }))], "")}
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
                return `<div class="trend-bar" style="height:${Math.max(heightPct, Number(d.approved_amd) > 0 ? 4 : 0)}%" title="${formatDate(d.day)}: ${formatAmd(Number(d.approved_amd))}"></div>`;
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

function currentYearMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

let cachedChannelOptions = null;
async function channelOptions() {
  if (cachedChannelOptions) return cachedChannelOptions;
  const channels = await api.getPerfChannels();
  cachedChannelOptions = [{ value: "", label: t("all_channels") }, ...channels.map((c) => ({ value: c.code, label: c.name }))];
  return cachedChannelOptions;
}

async function renderCustomerDebtReport(root, navigate) {
  root.innerHTML = `
    <div class="detail-view">
      ${reportHeaderHtml("report_customer_debt_name")}
      <form id="report-filters" class="report-filter-form">
        <select name="sales_channel"><option value="">${t("all_channels")}</option></select>
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

  try {
    const options = await channelOptions();
    form.querySelector('select[name="sales_channel"]').outerHTML = selectHtml("sales_channel", options, "");
  } catch {
    // Channel list is a filter convenience only -- if it fails to load, the
    // report itself (unfiltered) still works fine below.
  }

  async function load() {
    body.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
    const data = new FormData(form);
    const params = Object.fromEntries([...data.entries()].filter(([, v]) => v));
    try {
      const { customers, by_bucket, totals } = await api.getCustomerDebtReport(params);
      body.innerHTML = `
        <div class="stat-grid">
          <div class="stat-card">
            <span class="stat-value">${formatAmd(Number(totals.total_debt_amd))}</span>
            <span class="stat-label">${t("report_customer_debt_total_debt")}</span>
          </div>
          <div class="stat-card">
            <span class="stat-value">${totals.customers_with_debt}</span>
            <span class="stat-label">${t("report_customer_debt_customers_with_debt")}</span>
          </div>
        </div>

        <h2 class="section-title">${t("report_customer_debt_by_bucket")}</h2>
        <div class="card-list">
          ${
            by_bucket.length
              ? by_bucket
                  .map(
                    (b) => `
              <div class="card report-row">
                <span>${escapeHtml(b.aging_bucket)}</span>
                <strong>${formatAmd(Number(b.total_debt_amd))} (${b.customer_count})</strong>
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
                <strong>${escapeHtml(c.customer_name)}</strong>
                <span class="muted">${escapeHtml(channelDisplayLabel(c.assigned_sales_rep))} · ${c.aging_bucket ? escapeHtml(c.aging_bucket) : "—"}${c.days_since_payment != null ? ` · ${c.days_since_payment}d` : ""}</span>
                <span class="muted">${formatAmd(Number(c.debt_amd))}</span>
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
      const { rows, totals } = await api.getSalesBudgetReport(params);
      body.innerHTML = `
        <div class="stat-grid">
          <div class="stat-card">
            <span class="stat-value">${formatAmd(totals.sales_amd)}</span>
            <span class="stat-label">${t("report_sales_budget_sales")}</span>
          </div>
          <div class="stat-card">
            <span class="stat-value">${formatAmd(totals.budget_amd)}</span>
            <span class="stat-label">${t("report_sales_budget_budget")}</span>
          </div>
          <div class="stat-card">
            <span class="stat-value">${achievedPct(totals.sales_amd, totals.budget_amd)}</span>
            <span class="stat-label">${t("report_sales_budget_achieved")}</span>
          </div>
          <div class="stat-card">
            <span class="stat-value">${formatAmd(totals.collected_amd)}</span>
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
      const { rows, by_brand } = await api.getBrandVolumeReport(params);
      body.innerHTML = `
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
        dateSelect.innerHTML = available_dates.map((d) => `<option value="${d}" ${d === r.report_date ? "selected" : ""}>${formatDate(d)}</option>`).join("");
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
        <div class="card-list">
          ${salesRows
            .map(
              ([label, amd, liters, orders]) => `
            <div class="card report-row-multiline">
              <strong>${label}</strong>
              <span class="muted">${formatAmd(amd)} · ${liters != null ? `${Number(liters).toLocaleString()} L` : "—"} · ${orders != null ? orders : "—"}</span>
            </div>`
            )
            .join("")}
        </div>
        <p class="muted" style="margin: 0 4px 8px;">${t("report_daily_management_change_prev")}: ${signedAmd(r.sales_change_amd)}${r.sales_change_liters != null ? ` · ${r.sales_change_liters > 0 ? "+" : ""}${Number(r.sales_change_liters).toLocaleString()} L` : ""}</p>
        <p class="muted" style="margin: 0 4px 8px;">${t("report_daily_management_margin")}: ${formatAmd(r.sales_margin_amd)}${r.sales_margin_pct != null ? ` (${Number(r.sales_margin_pct).toFixed(1)}%)` : ""}</p>

        <h2 class="section-title">${t("by_channel")} (${formatDate(r.report_date)})</h2>
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
        <div class="card-list">
          ${paymentsRows
            .map(
              ([label, amd, customers]) => `
            <div class="card report-row-multiline">
              <strong>${label}</strong>
              <span class="muted">${formatAmd(amd)} · ${customers != null ? customers : "—"}</span>
            </div>`
            )
            .join("")}
        </div>

        <h2 class="section-title">${t("by_channel")} (${formatDate(r.report_date)})</h2>
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
          <div class="card report-row"><span>${t("report_daily_management_balance")}</span><strong>${formatAmd(r.balance_amd)}${r.balance_usd != null ? ` (${formatUsd(r.balance_usd)})` : ""}</strong></div>
          <div class="card report-row"><span>${t("report_daily_management_total")}</span><strong>${formatAmd(r.balance_total_amd)}${r.balance_total_usd != null ? ` (${formatUsd(r.balance_total_usd)})` : ""}</strong></div>
          <div class="card report-row"><span>${t("report_daily_management_cash")}</span><strong>${formatAmd(r.balance_cash_amd)}${r.balance_cash_usd != null ? ` (${formatUsd(r.balance_cash_usd)})` : ""}</strong></div>
          <div class="card report-row"><span>${t("report_daily_management_noncash")}</span><strong>${formatAmd(r.balance_noncash_amd)}${r.balance_noncash_usd != null ? ` (${formatUsd(r.balance_noncash_usd)})` : ""}</strong></div>
          <div class="card report-row"><span>${t("report_daily_management_with_managers")}</span><strong>${formatAmd(r.balance_with_managers_amd)}</strong></div>
          ${r.balance_with_managers_by_manager
            .map(
              (m) => `
          <div class="card report-row"><span style="padding-left:12px;">${escapeHtml(m.manager_name)}</span><strong>${formatAmd(m.amd)}</strong></div>`
            )
            .join("")}
          <div class="card report-row"><span>${t("report_daily_management_credit_line")}</span><strong>${formatUsd(r.credit_line_usd)}</strong></div>
          <div class="card report-row"><span>${t("report_daily_management_receivables")}</span><strong>${formatAmd(r.receivables_total_amd)} (${t("report_daily_management_receivables_net")}: ${formatAmd(r.receivables_net_amd)})</strong></div>
          <div class="card report-row"><span>${t("report_daily_management_warehouse")}</span><strong>${formatAmd(r.warehouse_value_amd)} · ${r.warehouse_liters != null ? `${Number(r.warehouse_liters).toLocaleString()} L` : "—"}</strong></div>
        </div>
        ${
          r.prev_report_date
            ? `<p class="muted" style="margin: 8px 4px;">${t("report_daily_management_change_since")} ${formatDate(r.prev_report_date)}: ${t("report_daily_management_total")} ${signedAmd(r.change_total_amd)}, ${t("report_daily_management_overdue")} ${signedAmd(r.change_overdue_amd)}</p>`
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
        ${selectHtml("region", [{ value: "", label: t("all_regions") }, ...REGION_LIST.map((r) => ({ value: r, label: r }))], "")}
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
