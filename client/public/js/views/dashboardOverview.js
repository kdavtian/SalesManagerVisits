import { api } from "../api.js";
import { escapeHtml, formatAmd } from "../util.js";
import { t } from "../i18n.js";

// A dependency-free CSS bar chart, same technique as dashboard.js's
// trendChartHtml -- this app has no charting library, so a handful of
// bars is rendered as plain divs sized by percentage height rather than
// pulling one in. Not imported from dashboard.js because that helper
// isn't exported; the pattern is simple enough to keep local.
function barChartHtml(items, { labelKey, valueKey, unit = "", ariaLabel = "" } = {}) {
  const max = Math.max(1, ...items.map((i) => Number(i[valueKey]) || 0));
  const bars = items
    .map((i) => {
      const value = Number(i[valueKey]) || 0;
      const heightPct = Math.round((value / max) * 100);
      return `<div class="trend-bar" style="height:${Math.max(heightPct, value > 0 ? 4 : 0)}%" title="${escapeHtml(String(i[labelKey]))}: ${Math.round(value).toLocaleString()}${unit}"></div>`;
    })
    .join("");
  return `<div class="trend-chart" role="img" aria-label="${escapeHtml(ariaLabel)}">${bars}</div>`;
}

function comparisonBarHtml(label, actual, target) {
  const pct = target > 0 ? Math.min(100, Math.round((actual / target) * 100)) : 0;
  return `
    <div class="perf-kpi-block">
      <div class="perf-kpi-head"><span class="perf-kpi-label">${escapeHtml(label)}</span></div>
      <div class="perf-kpi-main">
        <span class="perf-kpi-actual">${formatAmd(Math.round(actual))}</span>
        <span class="perf-kpi-target muted">/ ${formatAmd(Math.round(target))}${target ? ` (${pct}%)` : ""}</span>
      </div>
      ${target ? `<div class="progress-bar perf-kpi-bar"><div class="progress-bar-fill" style="width:${pct}%"></div></div>` : ""}
    </div>
  `;
}

// Budget is only ever tracked per calendar month (sales_performance.month),
// so only these two periods can show an actual-vs-budget comparison; the
// other two read from the daily-management report's own day/wtd actuals
// instead (see loadSalesSection below), with no budget figure at all.
const BUDGET_PERIODS = new Set(["mtd", "ytd"]);
const PERIODS = ["today", "wtd", "mtd", "ytd"];
const DEFAULT_PERIOD = "mtd";

export async function renderDashboardOverview(root, navigate) {
  root.innerHTML = `
    <div class="detail-view">
      <div class="detail-header">
        <button class="icon-btn" id="back-btn" aria-label="${t("back")}">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
        </button>
        <div class="detail-header-title"><h1>${t("company_dashboard_title")}</h1></div>
      </div>
      <div class="company-dashboard-period-row">
        <label class="visually-hidden" for="company-dashboard-period">${t("company_dashboard_period_label")}</label>
        <select class="period-select" id="company-dashboard-period">
          ${PERIODS.map((p) => `<option value="${p}" ${p === DEFAULT_PERIOD ? "selected" : ""}>${t(`company_dashboard_period_${p}`)}</option>`).join("")}
        </select>
      </div>
      <div id="company-dashboard-sales"><p class="loading-state" role="status">${t("loading")}</p></div>
      <div id="company-dashboard-rest"><p class="loading-state" role="status">${t("loading")}</p></div>
    </div>
  `;
  const container = root.querySelector(".detail-view");
  container.querySelector("#back-btn").addEventListener("click", () => navigate("#/dashboard"));

  const salesEl = container.querySelector("#company-dashboard-sales");
  const restEl = container.querySelector("#company-dashboard-rest");
  const periodSelect = container.querySelector("#company-dashboard-period");

  // Inventory and brand-volume are point-in-time/its-own-trend-chart
  // sections, not period-scoped -- fetched once, untouched by the period
  // switch below, instead of refetching on every period change.
  try {
    const [products, brandActuals] = await Promise.all([api.listProducts(), api.getPerfBrandActualsSummary()]);
    restEl.innerHTML = `${renderInventorySection(products)}${renderBrandVolumeSection(brandActuals)}`;
  } catch (err) {
    restEl.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
  }

  async function loadSales(period) {
    salesEl.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
    try {
      if (BUDGET_PERIODS.has(period)) {
        const leaderboard = await api.getSalesPerformanceLeaderboard(period);
        salesEl.innerHTML = renderBudgetSalesSection(leaderboard);
      } else {
        const { report } = await api.getDailyManagementReport({ period: "daily" });
        salesEl.innerHTML = renderActualsOnlySalesSection(report, period);
      }
    } catch (err) {
      salesEl.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    }
  }
  periodSelect.addEventListener("change", () => loadSales(periodSelect.value));
  await loadSales(DEFAULT_PERIOD);
}

// MTD/YTD: actual-vs-budget, company total + per-rep breakdown -- exactly
// what this section always showed, just period-scoped by the caller now
// instead of hardcoded to YTD.
function renderBudgetSalesSection(leaderboard) {
  if (!leaderboard?.length) {
    return `
      <h2 class="section-title">${t("company_dashboard_sales")}</h2>
      <p class="empty-state">${t("company_dashboard_no_data")}</p>
    `;
  }
  const totals = leaderboard.reduce(
    (sum, r) => ({
      sales_amd: sum.sales_amd + Number(r.sales_amd),
      collected_amd: sum.collected_amd + Number(r.collected_amd),
      budget_amd: sum.budget_amd + Number(r.budget_amd),
    }),
    { sales_amd: 0, collected_amd: 0, budget_amd: 0 }
  );

  return `
    <h2 class="section-title">${t("company_dashboard_sales")}</h2>
    ${comparisonBarHtml(t("company_dashboard_sales_label"), totals.sales_amd, totals.budget_amd)}
    <div class="stat-grid">
      <div class="stat-card">
        <span class="stat-value">${formatAmd(Math.round(totals.collected_amd))}</span>
        <span class="stat-label">${t("company_dashboard_collected_label")}</span>
      </div>
      <div class="stat-card">
        <span class="stat-value">${formatAmd(Math.round(totals.budget_amd))}</span>
        <span class="stat-label">${t("company_dashboard_budget_label")}</span>
      </div>
    </div>
    <h3 class="section-title section-title-inline" style="margin-top:14px;">${t("company_dashboard_by_rep")}</h3>
    <div class="card-list">
      ${leaderboard
        .map(
          (r) => `
        <div class="card">
          <strong>${escapeHtml(r.rep_name)}</strong>
          ${comparisonBarHtml(t("company_dashboard_sales_label"), Number(r.sales_amd), Number(r.budget_amd))}
          <div class="muted">${t("company_dashboard_collected_label")}: ${formatAmd(Math.round(Number(r.collected_amd)))}</div>
        </div>
      `
        )
        .join("")}
    </div>
  `;
}

// Today/WTD: total sales + total collected only, read straight off the
// daily-management report's own day_amd/wtd_amd columns (see
// server/src/routes/reports.js -- the same erp_daily_report row already
// carries every period's totals). No per-rep breakdown and no budget bar
// here: budget is a monthly figure (see BUDGET_PERIODS above), and a
// per-rep split isn't part of this report's shape, so faking either would
// be misleading rather than just absent.
function renderActualsOnlySalesSection(report, period) {
  if (!report) {
    return `
      <h2 class="section-title">${t("company_dashboard_sales")}</h2>
      <p class="empty-state">${t("company_dashboard_no_data")}</p>
    `;
  }
  const salesAmd = period === "today" ? report.sales_day_amd : report.sales_wtd_amd;
  const collectedAmd = period === "today" ? report.payments_day_amd : report.payments_wtd_amd;

  return `
    <h2 class="section-title">${t("company_dashboard_sales")}</h2>
    <div class="stat-grid">
      <div class="stat-card">
        <span class="stat-value">${formatAmd(Math.round(Number(salesAmd) || 0))}</span>
        <span class="stat-label">${t("company_dashboard_sales_label")}</span>
      </div>
      <div class="stat-card">
        <span class="stat-value">${formatAmd(Math.round(Number(collectedAmd) || 0))}</span>
        <span class="stat-label">${t("company_dashboard_collected_label")}</span>
      </div>
    </div>
    <p class="muted" style="margin: 10px 4px 0;">${t("company_dashboard_no_budget_note")}</p>
  `;
}

// "1L" -> 1, "208L" -> 208; null for a unit that isn't a plain liter size
// (filters, non-oil items) -- same pattern as orderCreate.js's sizeLiters,
// not imported since that helper isn't exported.
function sizeLiters(unit) {
  const m = /^([\d.]+)\s*L$/i.exec((unit || "").trim());
  return m ? parseFloat(m[1]) : null;
}

function formatLiters(value) {
  const n = Number(value) || 0;
  return Number.isInteger(n) ? `${n.toLocaleString()} L` : `${n.toFixed(1)} L`;
}

// Section 3: inventory balance, by liters and AMD value rather than a raw
// unit count -- a unit count on its own can't be compared across products
// (a "1" for a 208L drum and a "1" for a 1L bottle mean very different
// amounts of oil). GET /products already returns stock_qty per active
// product (see server/src/routes/products.js) -- brand grouping is a
// client-side reduce rather than a new server aggregation, since the flat
// list is small enough to fold in JS.
function renderInventorySection(products) {
  if (!products?.length) {
    return `
      <h2 class="section-title">${t("company_dashboard_inventory")}</h2>
      <p class="empty-state">${t("company_dashboard_no_data")}</p>
    `;
  }
  let totalLiters = 0;
  let totalAmd = 0;
  const byBrand = new Map();
  for (const p of products) {
    const qty = Number(p.stock_qty) || 0;
    const liters = sizeLiters(p.unit);
    const lineLiters = liters !== null ? qty * liters : 0;
    const lineAmd = qty * (Number(p.unit_price_amd) || 0);
    totalLiters += lineLiters;
    totalAmd += lineAmd;
    const brand = p.brand || "—";
    const prev = byBrand.get(brand) || { liters: 0, amd: 0 };
    byBrand.set(brand, { liters: prev.liters + lineLiters, amd: prev.amd + lineAmd });
  }
  const brandRows = [...byBrand.entries()].sort((a, b) => b[1].amd - a[1].amd);

  return `
    <h2 class="section-title">${t("company_dashboard_inventory")}</h2>
    <div class="stat-grid">
      <div class="stat-card">
        <span class="stat-value">${formatLiters(totalLiters)}</span>
        <span class="stat-label">${t("company_dashboard_total_stock")}</span>
      </div>
      <div class="stat-card">
        <span class="stat-value">${formatAmd(Math.round(totalAmd))}</span>
        <span class="stat-label">${t("company_dashboard_total_stock_value")}</span>
      </div>
    </div>
    <h3 class="section-title section-title-inline" style="margin-top:14px;">${t("company_dashboard_by_brand")}</h3>
    <div class="card-list">
      ${brandRows
        .map(
          ([brand, totals]) => `
        <div class="card list-row">
          <span>${escapeHtml(brand)}</span>
          <span class="card-trailing muted">${formatLiters(totals.liters)} · ${formatAmd(Math.round(totals.amd))}</span>
        </div>
      `
        )
        .join("")}
    </div>
  `;
}

// Section 4: brand-volume actuals. New minimal endpoint (see
// teamPerformance.js's /brand-actuals-summary) since nothing existing
// aggregates perf_actuals_brand_monthly past a single channel.
function renderBrandVolumeSection(brandActuals) {
  if (!brandActuals?.length) {
    return `
      <h2 class="section-title">${t("company_dashboard_brand_volume")}</h2>
      <p class="empty-state">${t("company_dashboard_no_data")}</p>
    `;
  }
  const byBrand = new Map();
  for (const row of brandActuals) {
    byBrand.set(row.brand, (byBrand.get(row.brand) || 0) + Number(row.liters));
  }
  const brandRows = [...byBrand.entries()].sort((a, b) => b[1] - a[1]);

  const byMonth = new Map();
  for (const row of brandActuals) {
    const key = String(row.month).slice(0, 10);
    byMonth.set(key, (byMonth.get(key) || 0) + Number(row.liters));
  }
  const monthly = [...byMonth.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, liters]) => ({ month, liters }));

  return `
    <h2 class="section-title">${t("company_dashboard_brand_volume")}</h2>
    <div class="card trend-chart-card">
      ${barChartHtml(monthly, { labelKey: "month", valueKey: "liters", unit: "L", ariaLabel: t("company_dashboard_brand_volume") })}
    </div>
    <div class="card-list">
      ${brandRows
        .map(
          ([brand, liters]) => `
        <div class="card list-row">
          <span>${escapeHtml(brand)}</span>
          <span class="card-trailing muted">${Math.round(liters).toLocaleString()} L</span>
        </div>
      `
        )
        .join("")}
    </div>
  `;
}
