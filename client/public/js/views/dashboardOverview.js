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

export async function renderDashboardOverview(root, navigate) {
  root.innerHTML = `
    <div class="detail-view">
      <div class="detail-header">
        <button class="icon-btn" id="back-btn" aria-label="${t("back")}">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
        </button>
        <div class="detail-header-title"><h1>${t("company_dashboard_title")}</h1></div>
      </div>
      <div id="company-dashboard-body" style="margin-top:12px;"><p class="loading-state" role="status">${t("loading")}</p></div>
    </div>
  `;
  const container = root.querySelector(".detail-view");
  container.querySelector("#back-btn").addEventListener("click", () => navigate("#/dashboard"));

  const bodyEl = container.querySelector("#company-dashboard-body");
  let leaderboard, products, brandActuals;
  try {
    [leaderboard, products, brandActuals] = await Promise.all([
      api.getSalesPerformanceLeaderboard(),
      api.listProducts(),
      api.getPerfBrandActualsSummary(),
    ]);
  } catch (err) {
    bodyEl.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    return;
  }

  bodyEl.innerHTML = `
    ${renderSalesSection(leaderboard)}
    ${renderInventorySection(products)}
    ${renderBrandVolumeSection(brandActuals)}
  `;
}

// Sections 1 and 2 (sales performance and money collected) both come from
// the same YTD-per-rep rows -- collected_amd is already part of the same
// query that gives sales/budget, so there's no separate fetch for it.
function renderSalesSection(leaderboard) {
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
    ${comparisonBarHtml(t("company_dashboard_ytd_sales"), totals.sales_amd, totals.budget_amd)}
    <div class="stat-grid">
      <div class="stat-card">
        <span class="stat-value">${formatAmd(Math.round(totals.collected_amd))}</span>
        <span class="stat-label">${t("company_dashboard_collected")}</span>
      </div>
      <div class="stat-card">
        <span class="stat-value">${formatAmd(Math.round(totals.budget_amd))}</span>
        <span class="stat-label">${t("company_dashboard_ytd_budget")}</span>
      </div>
    </div>
    <h3 class="section-title section-title-inline" style="margin-top:14px;">${t("company_dashboard_by_rep")}</h3>
    <div class="card-list">
      ${leaderboard
        .map(
          (r) => `
        <div class="card">
          <strong>${escapeHtml(r.rep_name)}</strong>
          ${comparisonBarHtml(t("company_dashboard_ytd_sales"), Number(r.sales_amd), Number(r.budget_amd))}
          <div class="muted">${t("company_dashboard_ytd_collected")}: ${formatAmd(Math.round(Number(r.collected_amd)))}</div>
        </div>
      `
        )
        .join("")}
    </div>
  `;
}

// Section 3: inventory balance. GET /products already returns stock_qty
// per active product (see server/src/routes/products.js) -- brand
// grouping is a client-side reduce rather than a new server aggregation,
// since the flat list is small enough to fold in JS.
function renderInventorySection(products) {
  if (!products?.length) {
    return `
      <h2 class="section-title">${t("company_dashboard_inventory")}</h2>
      <p class="empty-state">${t("company_dashboard_no_data")}</p>
    `;
  }
  const totalStock = products.reduce((sum, p) => sum + (Number(p.stock_qty) || 0), 0);
  const byBrand = new Map();
  for (const p of products) {
    const brand = p.brand || "—";
    byBrand.set(brand, (byBrand.get(brand) || 0) + (Number(p.stock_qty) || 0));
  }
  const brandRows = [...byBrand.entries()].sort((a, b) => b[1] - a[1]);

  return `
    <h2 class="section-title">${t("company_dashboard_inventory")}</h2>
    <div class="card">
      <span class="progress-label">${t("company_dashboard_total_stock")}</span>
      <span class="stat-value">${totalStock.toLocaleString()}</span>
    </div>
    <h3 class="section-title section-title-inline" style="margin-top:14px;">${t("company_dashboard_by_brand")}</h3>
    <div class="card-list">
      ${brandRows
        .map(
          ([brand, qty]) => `
        <div class="card list-row">
          <span>${escapeHtml(brand)}</span>
          <span class="card-trailing muted">${qty.toLocaleString()}</span>
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
