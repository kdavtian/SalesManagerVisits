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

// Coerces a server-sourced amount to a real number, never NaN -- a stale
// cached client build talking to an already-updated server (or vice
// versa) across a deploy can mean a field the client expects is simply
// missing from the response (undefined, not null/0), and Number(undefined)
// is NaN, which then propagates through every sum/formatAmd downstream and
// renders literally as "NaN դր." Falls back to 0, the same as a field that
// legitimately came back empty, so a version-skewed response degrades to
// "no data yet" instead of visibly broken text.
function safeAmd(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// collected is optional -- when given (and there's a target to place it
// against), a "|" tick mark is overlaid on the bar at the collected
// amount's own percent-of-target position, so actual sales and actual
// cash collected can be compared on the same bar instead of only seeing
// collected as a separate number below it.
function comparisonBarHtml(label, actual, target, collected) {
  const pct = target > 0 ? Math.min(100, Math.round((actual / target) * 100)) : 0;
  const collectedPct = target > 0 && collected != null ? Math.min(100, Math.round((collected / target) * 100)) : null;
  const mark =
    collectedPct !== null
      ? `<div class="perf-kpi-bar-mark" style="left:${collectedPct}%" title="${escapeHtml(t("company_dashboard_collected_label"))}: ${escapeHtml(formatAmd(Math.round(collected)))}"></div>`
      : "";
  return `
    <div class="perf-kpi-block">
      <div class="perf-kpi-head"><span class="perf-kpi-label">${escapeHtml(label)}</span></div>
      <div class="perf-kpi-main">
        <span class="perf-kpi-actual">${formatAmd(Math.round(actual))}</span>
        <span class="perf-kpi-target muted">/ ${formatAmd(Math.round(target))}${target ? ` (${pct}%)` : ""}</span>
      </div>
      ${target ? `<div class="progress-bar perf-kpi-bar"><div class="progress-bar-fill" style="width:${pct}%"></div>${mark}</div>` : ""}
    </div>
  `;
}

// The plan figure is only ever tracked per calendar month
// (sales_performance.month), so only these two periods can show an
// actual-vs-plan comparison; the other two read from the daily-management
// report's own day/wtd actuals instead (see loadSalesSection below), with
// no plan figure at all.
const PLAN_PERIODS = new Set(["mtd", "ytd"]);
const PERIODS = ["today", "wtd", "mtd", "ytd"];
const DEFAULT_PERIOD = "mtd";

export async function renderDashboardOverview(root, navigate) {
  let period = DEFAULT_PERIOD;

  root.innerHTML = `
    <div class="detail-view company-dashboard-view">
      <div class="detail-header">
        <button class="icon-btn" id="back-btn" aria-label="${t("back")}">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
        </button>
        <div class="detail-header-title"><h1>${t("company_dashboard_title")}</h1></div>
      </div>
      <div class="activity-tabs company-dashboard-period-tabs" role="tablist" aria-label="${t("company_dashboard_period_label")}">
        ${PERIODS.map(
          (p) =>
            `<button type="button" role="tab" aria-selected="${p === period}" class="activity-tab ${p === period ? "activity-tab-active" : ""}" data-period="${p}">${t(`company_dashboard_period_${p}`)}</button>`
        ).join("")}
      </div>
      <div id="company-dashboard-sales"><p class="loading-state" role="status">${t("loading")}</p></div>
      <div id="company-dashboard-rest"><p class="loading-state" role="status">${t("loading")}</p></div>
    </div>
  `;
  const container = root.querySelector(".detail-view");
  container.querySelector("#back-btn").addEventListener("click", () => navigate("#/dashboard"));

  const salesEl = container.querySelector("#company-dashboard-sales");
  const restEl = container.querySelector("#company-dashboard-rest");
  const periodTabs = container.querySelectorAll(".company-dashboard-period-tabs .activity-tab");

  // Inventory and brand-volume are point-in-time/its-own-trend-chart
  // sections, not period-scoped -- fetched once, untouched by the period
  // switch below, instead of refetching on every period change.
  try {
    const [products, brandActuals] = await Promise.all([api.listProducts(), api.getPerfBrandActualsSummary()]);
    restEl.innerHTML = `${renderInventorySection(products)}${renderBrandVolumeSection(brandActuals)}`;
  } catch (err) {
    restEl.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
  }

  async function loadSales() {
    salesEl.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
    try {
      if (PLAN_PERIODS.has(period)) {
        const leaderboard = await api.getSalesPerformanceLeaderboard(period);
        salesEl.innerHTML = renderPlanSalesSection(leaderboard);
      } else {
        const { report } = await api.getDailyManagementReport({ period: "daily" });
        salesEl.innerHTML = renderActualsOnlySalesSection(report, period);
      }
    } catch (err) {
      salesEl.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    }
  }
  periodTabs.forEach((btn) => {
    btn.addEventListener("click", () => {
      period = btn.dataset.period;
      periodTabs.forEach((b) => {
        const active = b === btn;
        b.classList.toggle("activity-tab-active", active);
        b.setAttribute("aria-selected", String(active));
      });
      loadSales();
    });
  });
  await loadSales();
}

// MTD/YTD: actual-vs-plan, company total + per-rep breakdown. The plan
// figure now comes from Team Performance's own approved Sales targets
// (perf_plan_targets.sales_target_amd, summed per channel/rep) instead of
// sales_performance's Excel-synced budget_amd column -- that column
// carried stale/unreliable values unrelated to the real approved plan
// (see server/src/routes/salesPerformance.js's GET / for the full story),
// so the server now does that join itself and returns the field already
// named plan_amd.
function renderPlanSalesSection(leaderboard) {
  if (!leaderboard?.length) {
    return `
      <h2 class="section-title">${t("company_dashboard_sales")}</h2>
      <p class="empty-state">${t("company_dashboard_no_data")}</p>
    `;
  }
  const totals = leaderboard.reduce(
    (sum, r) => ({
      sales_amd: sum.sales_amd + safeAmd(r.sales_amd),
      collected_amd: sum.collected_amd + safeAmd(r.collected_amd),
      plan_amd: sum.plan_amd + safeAmd(r.plan_amd),
    }),
    { sales_amd: 0, collected_amd: 0, plan_amd: 0 }
  );

  return `
    <h2 class="section-title">${t("company_dashboard_sales")}</h2>
    ${comparisonBarHtml(t("company_dashboard_sales_label"), totals.sales_amd, totals.plan_amd, totals.collected_amd)}
    <div class="stat-grid">
      <div class="stat-card">
        <span class="stat-value">${formatAmd(Math.round(totals.collected_amd))}</span>
        <span class="stat-label">${t("company_dashboard_collected_label")}</span>
      </div>
      <div class="stat-card">
        <span class="stat-value">${formatAmd(Math.round(totals.plan_amd))}</span>
        <span class="stat-label">${t("company_dashboard_plan_label")}</span>
      </div>
    </div>
    <h3 class="section-title section-title-inline" style="margin-top:14px;">${t("company_dashboard_by_rep")}</h3>
    <div class="card-list">
      ${leaderboard
        .map(
          (r) => `
        <div class="card">
          <strong>${escapeHtml(r.rep_name)}</strong>
          ${comparisonBarHtml(t("company_dashboard_sales_label"), safeAmd(r.sales_amd), safeAmd(r.plan_amd), safeAmd(r.collected_amd))}
          <div class="muted">${t("company_dashboard_collected_label")}: ${formatAmd(Math.round(safeAmd(r.collected_amd)))}</div>
        </div>
      `
        )
        .join("")}
    </div>
  `;
}

// Today/WTD: total sales + total collected read straight off the
// daily-management report's own day_amd/wtd_amd columns (see
// server/src/routes/reports.js -- the same erp_daily_report row already
// carries every period's totals). No plan bar here: the plan figure is a
// monthly one (see PLAN_PERIODS above), and there's no daily/weekly target
// to compare against, so faking one would be misleading rather than just
// absent.
//
// A per-rep breakdown IS shown, but numbers-only (no bar, for the same
// no-target reason): sales_by_channel/payments_by_channel on the report
// row are real ERP figures for report_date, pushed by the same sync PC
// that already supplies the totals above (see erpSync.js's POST
// /daily-report and migration 061). The *_wtd counterparts (migration 067)
// aren't sent by that pipeline yet -- until it's updated to compute a
// weekly-by-channel breakdown from the same Cash/Sales sheet, those come
// back as "[]" and renderByChannelNumbers below simply renders nothing for
// This Week, same as before those columns existed.
function renderByChannelNumbers(salesByChannel, paymentsByChannel) {
  const salesMap = new Map((salesByChannel || []).filter((c) => c?.channel_code).map((c) => [c.channel_code, safeAmd(c.amd)]));
  const paymentsMap = new Map((paymentsByChannel || []).filter((c) => c?.channel_code).map((c) => [c.channel_code, safeAmd(c.amd)]));
  const channels = [...new Set([...salesMap.keys(), ...paymentsMap.keys()])];
  if (!channels.length) return "";
  return `
    <h3 class="section-title section-title-inline" style="margin-top:14px;">${t("company_dashboard_by_rep")}</h3>
    <div class="card-list">
      ${channels
        .map(
          (code) => `
        <div class="card">
          <strong>${escapeHtml(code)}</strong>
          <div class="muted">${t("company_dashboard_sales_label")}: ${formatAmd(Math.round(salesMap.get(code) || 0))}</div>
          <div class="muted">${t("company_dashboard_collected_label")}: ${formatAmd(Math.round(paymentsMap.get(code) || 0))}</div>
        </div>
      `
        )
        .join("")}
    </div>
  `;
}

function renderActualsOnlySalesSection(report, period) {
  if (!report) {
    return `
      <h2 class="section-title">${t("company_dashboard_sales")}</h2>
      <p class="empty-state">${t("company_dashboard_no_data")}</p>
    `;
  }
  const salesAmd = period === "today" ? report.sales_day_amd : report.sales_wtd_amd;
  const collectedAmd = period === "today" ? report.payments_day_amd : report.payments_wtd_amd;
  const salesByChannel = period === "today" ? report.sales_by_channel : report.sales_by_channel_wtd;
  const paymentsByChannel = period === "today" ? report.payments_by_channel : report.payments_by_channel_wtd;

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
    <p class="muted" style="margin: 10px 4px 0;">${t("company_dashboard_no_plan_note")}</p>
    ${renderByChannelNumbers(salesByChannel, paymentsByChannel)}
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
