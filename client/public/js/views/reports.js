import { api } from "../api.js";
import { escapeHtml } from "../util.js";
import { t } from "../i18n.js";
import { icons } from "../icons.js";
import { REGION_LIST, YEREVAN_DISTRICTS, CATEGORY_LIST, formatAmd } from "../util.js";

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
  return renderReportsList(root, navigate);
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
                <span>${escapeHtml(c.sales_channel)}</span>
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
