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

// Trims and collapses internal whitespace runs ("Orlen  5w40" / a trailing
// or leading space / a tab) down to a single space. The ERP extract's own
// product name/brand/unit text has real spacing drift from one sync to the
// next for what's the same physical product -- routes/erpSync.js's
// claim-by-name step only ever lowercased before matching, so a
// whitespace-only difference silently failed to match an existing
// never-synced row and inserted a second one instead, reported live as
// e.g. "Orlen 5w40 4.5L" listed twice with two different stock counts.
// Applied before matching AND before storage, so the canonical text this
// app stores for a given erp_product_id stays stable sync to sync too.
export function normalizeErpText(value) {
  if (value == null) return value;
  return String(value).trim().replace(/\s+/g, " ");
}

// For comparing a *size/unit* token specifically ("4.5L", "4.5 L", "4.5  L"
// are the exact same size), not for prose: a unit string has no meaningful
// word-boundary space the way a product name does, so this strips
// whitespace entirely rather than collapsing it to one space -- the same
// distinction client/public/js/views/warehouse.js's size filter already
// makes (see its own `size` query param matching in routes/warehouse.js).
// Only ever used to build/compare an identity key; never applied to the
// text actually stored, which keeps whatever spacing the source used.
export function normalizeErpUnitKey(value) {
  if (value == null) return "";
  return String(value).trim().replace(/\s+/g, "").toLowerCase();
}

// Legal name / TIN / address from the workbook (Customers sheet). TIN must be
// the 8-digit Armenian format (Excel often stores it as a number, so accept
// that too); name and address are just trimmed. Returns null when the entry
// has no usable value, so callers only collect rows that can fill something.
function legalFieldsOf(entry) {
  const rawTin = entry.tin != null ? String(entry.tin).trim().replace(/\.0$/, "") : "";
  // Excel stores a numeric TIN without its leading zero (02256083 -> 2256083).
  const padded = /^\d{7}$/.test(rawTin) ? `0${rawTin}` : rawTin;
  const tin = /^\d{8}$/.test(padded) ? padded : null;
  const text = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const legalName = text(entry.legal_name);
  const legalAddress = text(entry.legal_address);
  return tin || legalName || legalAddress ? { tin, legalName, legalAddress } : null;
}

// Separate top-level `customer_legal` list: TIN / legal name / address for
// EVERY workbook customer (the customers[] extract is narrowed to current
// debt / recent orders, but invoicing needs the TIN of any customer). It only
// fills customers.* and never touches erp_customer_data.
export function transformErpCustomerLegal(rows) {
  const legalErpIds = [];
  const tins = [];
  const legalNames = [];
  const legalAddresses = [];
  for (const entry of isPlainArray(rows)) {
    if (!isPlainObject(entry) || !entry.erp_customer_id) continue;
    const legal = legalFieldsOf(entry);
    if (!legal) continue;
    legalErpIds.push(String(entry.erp_customer_id));
    tins.push(legal.tin);
    legalNames.push(legal.legalName);
    legalAddresses.push(legal.legalAddress);
  }
  return { legalErpIds, tins, legalNames, legalAddresses };
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
  const balance0s = [];
  const lastPayments = [];
  const daysSince = [];
  const agingBuckets = [];
  const recentOrders = [];
  const regionErpIds = [];
  const regions = [];
  const subregions = [];
  const tierErpIds = [];
  const tiers = [];
  const legalErpIds = [];
  const tins = [];
  const legalNames = [];
  const legalAddresses = [];

  for (const entry of isPlainArray(customers)) {
    if (!isPlainObject(entry) || !entry.erp_customer_id) continue;
    erpIds.push(String(entry.erp_customer_id));
    names.push(entry.customer_name != null ? String(entry.customer_name) : null);
    reps.push(entry.assigned_sales_rep != null ? String(entry.assigned_sales_rep) : null);
    debts.push(Number.isFinite(entry.debt_amd) ? entry.debt_amd : null);
    balance0s.push(Number.isFinite(entry.balance0_amd) ? entry.balance0_amd : null);
    lastPayments.push(entry.last_payment_date || null);
    daysSince.push(Number.isFinite(entry.days_since_payment) ? entry.days_since_payment : null);
    agingBuckets.push(entry.aging_bucket || null);
    recentOrders.push(JSON.stringify(Array.isArray(entry.recent_orders) ? entry.recent_orders.slice(0, 10) : []));
    // The workbook's Customers-sheet Tier is the source of truth for an
    // ERP-linked customer's tier; anything else (blank, junk) is ignored.
    const erpTier = typeof entry.erp_tier === "string" ? entry.erp_tier.trim().toLowerCase() : null;
    if (erpTier === "bronze" || erpTier === "silver" || erpTier === "gold") {
      tierErpIds.push(String(entry.erp_customer_id));
      tiers.push(erpTier);
    }
    const legal = legalFieldsOf(entry);
    if (legal) {
      legalErpIds.push(String(entry.erp_customer_id));
      tins.push(legal.tin);
      legalNames.push(legal.legalName);
      legalAddresses.push(legal.legalAddress);
    }
    if (entry.region || entry.subregion) {
      regionErpIds.push(String(entry.erp_customer_id));
      regions.push(entry.region != null ? String(entry.region) : null);
      subregions.push(entry.subregion != null ? String(entry.subregion) : null);
    }
  }

  return { erpIds, names, reps, debts, balance0s, lastPayments, daysSince, agingBuckets, recentOrders, regionErpIds, regions, subregions, tierErpIds, tiers, legalErpIds, tins, legalNames, legalAddresses };
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
  const lineDiscounts = [];

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
    // Optional -- the ERP Orders sheet's own per-product "Discount" column
    // (see docs/erp-sync-contract.md), omitted/null for a line with no
    // discount or price adjustment recorded against it.
    lineDiscounts.push(Number.isFinite(line.discount_amd) ? line.discount_amd : null);
  }

  return {
    lineErpIds,
    lineOrderIds,
    lineDates,
    lineProductIds,
    lineBrands,
    lineProductNames,
    lineSizes,
    lineQtys,
    lineUnitPrices,
    lineRevenues,
    lineDiscounts,
  };
}

// erp_customer_id and date are required -- an entry missing either is
// dropped (see docs/erp-sync-contract.md). amount_amd keeps whatever sign
// the ERP sends (positive = payment received, negative = refund paid back
// out): a debt-as-of-date calculation needs the signed total, not just
// real payments, so a refund correctly adds back into the running balance
// instead of disappearing from it.
export function transformErpCashflowLines(cashflowLines) {
  const cashErpIds = [];
  const cashDates = [];
  const cashAmounts = [];

  for (const line of isPlainArray(cashflowLines)) {
    if (!isPlainObject(line) || !line.erp_customer_id || !line.date) continue;
    cashErpIds.push(String(line.erp_customer_id));
    cashDates.push(line.date);
    cashAmounts.push(Number.isFinite(line.amount_amd) ? line.amount_amd : null);
  }

  return { cashErpIds, cashDates, cashAmounts };
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
// the extract doesn't have to send it twice; silver/gold/landing_cost/
// net_cost have no such fallback. net_cost_amd is optional and, unlike
// landing_cost_amd, admin-editable in the app (see migration 080) -- the
// sync only ever offers a value if the extract actually sends one
// (nothing currently does; the field exists so a future Excel/Sheet column
// can start populating it with no further app change), and
// routes/erpSync.js applies it the same gated way as every other editable
// field: skipped on a row an admin has corrected by hand since its last
// sync.
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
  const prodNetCosts = [];
  const prodHcCodes = [];
  const prodActives = [];

  for (const p of isPlainArray(products)) {
    if (!isPlainObject(p) || !p.erp_product_id || !p.name || !Number.isFinite(p.unit_price_amd)) continue;
    prodErpIds.push(String(p.erp_product_id));
    prodNames.push(normalizeErpText(p.name));
    prodBrands.push(p.brand != null ? normalizeErpText(p.brand) : null);
    prodUnits.push(p.unit != null ? normalizeErpText(p.unit) : null);
    prodPrices.push(p.unit_price_amd);
    prodFamilies.push(p.family != null ? normalizeErpText(p.family) : null);
    prodBronzePrices.push(Number.isFinite(p.bronze_price_amd) ? p.bronze_price_amd : p.unit_price_amd);
    prodSilverPrices.push(Number.isFinite(p.silver_price_amd) ? p.silver_price_amd : null);
    prodGoldPrices.push(Number.isFinite(p.gold_price_amd) ? p.gold_price_amd : null);
    prodStockQtys.push(Number.isFinite(p.stock_qty) ? Math.trunc(p.stock_qty) : null);
    prodLandingCosts.push(Number.isFinite(p.landing_cost_amd) ? p.landing_cost_amd : null);
    prodNetCosts.push(Number.isFinite(p.net_cost_amd) ? p.net_cost_amd : null);
    // HC (ՀԾ-Հաշվապահ) product code, text so "000010" keeps its zeros.
    const hc = p.hc_code != null ? String(p.hc_code).trim() : "";
    prodHcCodes.push(hc || null);
    // Workbook SKU Status: true = ACTIVE, false = not sold any more, null = not reported.
    prodActives.push(typeof p.active === "boolean" ? p.active : null);
  }

  return {
    prodErpIds,
    prodNames,
    prodBrands,
    prodUnits,
    prodPrices,
    prodFamilies,
    prodBronzePrices,
    prodSilverPrices,
    prodGoldPrices,
    prodStockQtys,
    prodLandingCosts,
    prodNetCosts,
    prodHcCodes,
    prodActives,
  };
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
