// Pure validate/normalize transforms from the ERP sync bot's JSON payload
// (see docs/erp-sync-contract.md) into the parallel-array shape
// routes/erpSync.js's unnest()-based bulk inserts expect. Split out from
// the route handler so this -- what counts as a valid row, what gets
// coerced/defaulted, what gets silently dropped -- is unit-testable
// without a database.

export function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isFiniteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

export function isPlainArray(value) {
  return Array.isArray(value) ? value : [];
}

// customers is the only required top-level field (see the contract) --
// an entry is skipped entirely without erp_customer_id, since that's the
// join key everything else in the app keys off. region/subregion are only
// collected for entries that actually set one, since the caller applies
// them as a COALESCE-only backfill (never overwrites an existing value).
export function transformErpCustomers(customers) {
  const erpIds = [];
  const names = [];
  const reps = [];
  const debts = [];
  const lastPayments = [];
  const daysSince = [];
  const agingBuckets = [];
  const recentOrders = [];
  const regionErpIds = [];
  const regions = [];
  const subregions = [];

  for (const entry of isPlainArray(customers)) {
    if (!isPlainObject(entry) || !entry.erp_customer_id) continue;
    erpIds.push(String(entry.erp_customer_id));
    names.push(entry.customer_name != null ? String(entry.customer_name) : null);
    reps.push(entry.assigned_sales_rep != null ? String(entry.assigned_sales_rep) : null);
    debts.push(Number.isFinite(entry.debt_amd) ? entry.debt_amd : null);
    lastPayments.push(entry.last_payment_date || null);
    daysSince.push(Number.isFinite(entry.days_since_payment) ? entry.days_since_payment : null);
    agingBuckets.push(entry.aging_bucket || null);
    recentOrders.push(JSON.stringify(Array.isArray(entry.recent_orders) ? entry.recent_orders.slice(0, 10) : []));
    if (entry.region || entry.subregion) {
      regionErpIds.push(String(entry.erp_customer_id));
      regions.push(entry.region != null ? String(entry.region) : null);
      subregions.push(entry.subregion != null ? String(entry.subregion) : null);
    }
  }

  return { erpIds, names, reps, debts, lastPayments, daysSince, agingBuckets, recentOrders, regionErpIds, regions, subregions };
}

// erp_customer_id, order_id, and date are all required -- an entry missing
// any of the three is dropped (see docs/erp-sync-contract.md).
export function transformErpOrderLines(orderLines) {
  const lineErpIds = [];
  const lineOrderIds = [];
  const lineDates = [];
  const lineProductIds = [];
  const lineBrands = [];
  const lineProductNames = [];
  const lineSizes = [];
  const lineQtys = [];
  const lineUnitPrices = [];
  const lineRevenues = [];

  for (const line of isPlainArray(orderLines)) {
    if (!isPlainObject(line) || !line.erp_customer_id || !line.order_id || !line.date) continue;
    lineErpIds.push(String(line.erp_customer_id));
    lineOrderIds.push(String(line.order_id));
    lineDates.push(line.date);
    lineProductIds.push(line.product_id != null ? String(line.product_id) : null);
    lineBrands.push(line.brand != null ? String(line.brand) : null);
    lineProductNames.push(line.product != null ? String(line.product) : null);
    lineSizes.push(line.size_l != null ? String(line.size_l) : null);
    lineQtys.push(Number.isFinite(line.qty) ? line.qty : null);
    lineUnitPrices.push(Number.isFinite(line.unit_price_amd) ? line.unit_price_amd : null);
    lineRevenues.push(Number.isFinite(line.revenue_amd) ? line.revenue_amd : null);
  }

  return { lineErpIds, lineOrderIds, lineDates, lineProductIds, lineBrands, lineProductNames, lineSizes, lineQtys, lineUnitPrices, lineRevenues };
}

// rep_name (matching sales_channels.code) and a monthly array are required;
// each monthly entry needs its own `month`, or it's skipped individually
// without dropping the rest of that rep's months.
export function transformErpSalesPerformance(salesPerformance) {
  const perfRepNames = [];
  const perfMonths = [];
  const perfSales = [];
  const perfCollected = [];
  const perfBudget = [];

  for (const rep of isPlainArray(salesPerformance)) {
    if (!isPlainObject(rep) || !rep.rep_name || !Array.isArray(rep.monthly)) continue;
    for (const m of rep.monthly) {
      if (!isPlainObject(m) || !m.month) continue;
      perfRepNames.push(String(rep.rep_name));
      perfMonths.push(m.month);
      perfSales.push(Number.isFinite(m.sales_amd) ? m.sales_amd : 0);
      perfCollected.push(Number.isFinite(m.collected_amd) ? m.collected_amd : 0);
      perfBudget.push(Number.isFinite(m.budget_amd) ? m.budget_amd : 0);
    }
  }

  return { perfRepNames, perfMonths, perfSales, perfCollected, perfBudget };
}

// erp_product_id, name, and a finite unit_price_amd are required. bronze
// defaults to unit_price_amd (same source, "Price T1") when omitted, so
// the extract doesn't have to send it twice; silver/gold/landing_cost have
// no such fallback.
export function transformErpProducts(products) {
  const prodErpIds = [];
  const prodNames = [];
  const prodBrands = [];
  const prodUnits = [];
  const prodPrices = [];
  const prodFamilies = [];
  const prodBronzePrices = [];
  const prodSilverPrices = [];
  const prodGoldPrices = [];
  const prodStockQtys = [];
  const prodLandingCosts = [];

  for (const p of isPlainArray(products)) {
    if (!isPlainObject(p) || !p.erp_product_id || !p.name || !Number.isFinite(p.unit_price_amd)) continue;
    prodErpIds.push(String(p.erp_product_id));
    prodNames.push(String(p.name));
    prodBrands.push(p.brand != null ? String(p.brand) : null);
    prodUnits.push(p.unit != null ? String(p.unit) : null);
    prodPrices.push(p.unit_price_amd);
    prodFamilies.push(p.family != null ? String(p.family) : null);
    prodBronzePrices.push(Number.isFinite(p.bronze_price_amd) ? p.bronze_price_amd : p.unit_price_amd);
    prodSilverPrices.push(Number.isFinite(p.silver_price_amd) ? p.silver_price_amd : null);
    prodGoldPrices.push(Number.isFinite(p.gold_price_amd) ? p.gold_price_amd : null);
    prodStockQtys.push(Number.isFinite(p.stock_qty) ? Math.trunc(p.stock_qty) : null);
    prodLandingCosts.push(Number.isFinite(p.landing_cost_amd) ? p.landing_cost_amd : null);
  }

  return { prodErpIds, prodNames, prodBrands, prodUnits, prodPrices, prodFamilies, prodBronzePrices, prodSilverPrices, prodGoldPrices, prodStockQtys, prodLandingCosts };
}

// channel_code, month, and brand are all required.
export function transformErpBrandVolume(brandVolume) {
  const volChannelCodes = [];
  const volMonths = [];
  const volBrands = [];
  const volLiters = [];

  for (const v of isPlainArray(brandVolume)) {
    if (!isPlainObject(v) || !v.channel_code || !v.month || !v.brand) continue;
    volChannelCodes.push(String(v.channel_code));
    volMonths.push(v.month);
    volBrands.push(String(v.brand));
    volLiters.push(Number.isFinite(v.liters) ? v.liters : 0);
  }

  return { volChannelCodes, volMonths, volBrands, volLiters };
}
