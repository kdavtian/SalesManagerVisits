// ERP sync payload transforms (server/src/erpTransform.js) -- what the
// bot's JSON push gets validated/normalized into before the bulk insert.
// See docs/erp-sync-contract.md for the wire format these mirror.
import test from "node:test";
import assert from "node:assert/strict";
import {
  isPlainObject,
  isFiniteOrNull,
  isPlainArray,
  transformErpCustomers,
  transformErpOrderLines,
  transformErpSalesPerformance,
  transformErpProducts,
  transformErpBrandVolume,
} from "../src/erpTransform.js";

// --- helpers ---------------------------------------------------------------

test("isPlainObject: true for plain objects, false for arrays/null/primitives", () => {
  assert.equal(isPlainObject({}), true);
  assert.equal(isPlainObject([]), false);
  assert.equal(isPlainObject(null), false);
  assert.equal(isPlainObject("x"), false);
  assert.equal(isPlainObject(5), false);
});

test("isFiniteOrNull: passes through finite numbers, nulls everything else", () => {
  assert.equal(isFiniteOrNull(5), 5);
  assert.equal(isFiniteOrNull(0), 0);
  assert.equal(isFiniteOrNull(NaN), null);
  assert.equal(isFiniteOrNull(Infinity), null);
  assert.equal(isFiniteOrNull(undefined), null);
  assert.equal(isFiniteOrNull("5"), null, "a numeric string is not itself finite-typed");
});

test("isPlainArray: passes arrays through, defaults anything else to []", () => {
  assert.deepEqual(isPlainArray([1, 2]), [1, 2]);
  assert.deepEqual(isPlainArray(undefined), []);
  assert.deepEqual(isPlainArray(null), []);
  assert.deepEqual(isPlainArray({}), []);
});

// --- transformErpCustomers ---------------------------------------------------

test("transformErpCustomers: a well-formed entry maps every field", () => {
  const result = transformErpCustomers([
    {
      erp_customer_id: 12345,
      customer_name: "Acme Garage",
      assigned_sales_rep: "SM YVN",
      debt_amd: 150000,
      last_payment_date: "2026-08-20",
      days_since_payment: 12,
      aging_bucket: "0-30",
      recent_orders: [{ id: 1 }],
    },
  ]);
  assert.deepEqual(result.erpIds, ["12345"], "erp_customer_id is coerced to string");
  assert.deepEqual(result.names, ["Acme Garage"]);
  assert.deepEqual(result.reps, ["SM YVN"]);
  assert.deepEqual(result.debts, [150000]);
  assert.deepEqual(result.lastPayments, ["2026-08-20"]);
  assert.deepEqual(result.daysSince, [12]);
  assert.deepEqual(result.agingBuckets, ["0-30"]);
  assert.deepEqual(result.recentOrders, [JSON.stringify([{ id: 1 }])]);
});

test("transformErpCustomers: an entry without erp_customer_id is dropped entirely", () => {
  const result = transformErpCustomers([{ customer_name: "No ID" }, { erp_customer_id: "1", customer_name: "Has ID" }]);
  assert.equal(result.erpIds.length, 1);
  assert.equal(result.names[0], "Has ID");
});

test("transformErpCustomers: recent_orders is capped at 10 entries", () => {
  const orders = Array.from({ length: 15 }, (_, i) => ({ id: i }));
  const result = transformErpCustomers([{ erp_customer_id: "1", recent_orders: orders }]);
  assert.equal(JSON.parse(result.recentOrders[0]).length, 10);
});

test("transformErpCustomers: region/subregion are only collected when at least one is set", () => {
  const result = transformErpCustomers([
    { erp_customer_id: "1", region: "Yerevan" },
    { erp_customer_id: "2" },
    { erp_customer_id: "3", subregion: "Kentron" },
  ]);
  assert.deepEqual(result.regionErpIds, ["1", "3"]);
  assert.deepEqual(result.regions, ["Yerevan", null]);
  assert.deepEqual(result.subregions, [null, "Kentron"]);
});

test("transformErpCustomers: missing optional fields become null, not undefined/omitted", () => {
  const result = transformErpCustomers([{ erp_customer_id: "1" }]);
  assert.equal(result.names[0], null);
  assert.equal(result.reps[0], null);
  assert.equal(result.debts[0], null);
  assert.equal(result.lastPayments[0], null);
  assert.equal(result.daysSince[0], null);
  assert.equal(result.agingBuckets[0], null);
  assert.deepEqual(JSON.parse(result.recentOrders[0]), []);
});

test("transformErpCustomers: a non-array input produces empty output rather than throwing", () => {
  const result = transformErpCustomers(undefined);
  assert.deepEqual(result.erpIds, []);
});

// --- transformErpOrderLines --------------------------------------------------

test("transformErpOrderLines: all three required fields present maps the line", () => {
  const result = transformErpOrderLines([
    { erp_customer_id: "1", order_id: "ORD-1", date: "2026-09-01", product_id: "P1", brand: "Castrol", product: "Edge 5W30", size_l: "4", qty: 4, unit_price_amd: 12000, revenue_amd: 48000 },
  ]);
  assert.deepEqual(result.lineErpIds, ["1"]);
  assert.deepEqual(result.lineOrderIds, ["ORD-1"]);
  assert.deepEqual(result.lineQtys, [4]);
  assert.deepEqual(result.lineRevenues, [48000]);
});

test("transformErpOrderLines: missing erp_customer_id, order_id, or date each drop the line", () => {
  const result = transformErpOrderLines([
    { order_id: "ORD-1", date: "2026-09-01" },
    { erp_customer_id: "1", date: "2026-09-01" },
    { erp_customer_id: "1", order_id: "ORD-1" },
    { erp_customer_id: "1", order_id: "ORD-1", date: "2026-09-01" },
  ]);
  assert.equal(result.lineErpIds.length, 1, "only the fully-populated line survives");
});

// --- transformErpSalesPerformance --------------------------------------------

test("transformErpSalesPerformance: flattens each rep's monthly array into parallel rows", () => {
  const result = transformErpSalesPerformance([
    {
      rep_name: "SM YVN",
      monthly: [
        { month: "2026-08-01", sales_amd: 4000000, collected_amd: 3800000, budget_amd: 5000000 },
        { month: "2026-09-01", sales_amd: 5000000, collected_amd: 4800000, budget_amd: 6000000 },
      ],
    },
  ]);
  assert.deepEqual(result.perfRepNames, ["SM YVN", "SM YVN"]);
  assert.deepEqual(result.perfMonths, ["2026-08-01", "2026-09-01"]);
  assert.deepEqual(result.perfSales, [4000000, 5000000]);
});

test("transformErpSalesPerformance: a rep with no rep_name or no monthly array is dropped entirely", () => {
  const result = transformErpSalesPerformance([{ monthly: [{ month: "2026-09-01" }] }, { rep_name: "SM YVN" }]);
  assert.deepEqual(result.perfRepNames, []);
});

test("transformErpSalesPerformance: one bad month entry is skipped without dropping the rep's other months", () => {
  const result = transformErpSalesPerformance([
    { rep_name: "SM YVN", monthly: [{ sales_amd: 1 }, { month: "2026-09-01", sales_amd: 5000000 }] },
  ]);
  assert.deepEqual(result.perfMonths, ["2026-09-01"]);
});

test("transformErpSalesPerformance: missing numeric fields default to 0, not null", () => {
  const result = transformErpSalesPerformance([{ rep_name: "SM YVN", monthly: [{ month: "2026-09-01" }] }]);
  assert.deepEqual([result.perfSales[0], result.perfCollected[0], result.perfBudget[0]], [0, 0, 0]);
});

// --- transformErpProducts -----------------------------------------------------

test("transformErpProducts: bronze defaults to unit_price_amd when omitted", () => {
  const result = transformErpProducts([{ erp_product_id: "P1", name: "Edge 5W30", unit_price_amd: 12000 }]);
  assert.equal(result.prodBronzePrices[0], 12000);
  assert.equal(result.prodSilverPrices[0], null, "silver has no such fallback");
  assert.equal(result.prodGoldPrices[0], null);
  assert.equal(result.prodLandingCosts[0], null, "landing cost has no fallback either");
});

test("transformErpProducts: an explicit bronze price is kept as-is, not overridden", () => {
  const result = transformErpProducts([{ erp_product_id: "P1", name: "Edge 5W30", unit_price_amd: 12000, bronze_price_amd: 11500 }]);
  assert.equal(result.prodBronzePrices[0], 11500);
});

test("transformErpProducts: stock_qty is truncated to an integer", () => {
  const result = transformErpProducts([{ erp_product_id: "P1", name: "X", unit_price_amd: 100, stock_qty: 7.9 }]);
  assert.equal(result.prodStockQtys[0], 7);
});

test("transformErpProducts: erp_product_id, name, or a non-finite unit_price_amd each drop the row", () => {
  const result = transformErpProducts([
    { name: "No ID", unit_price_amd: 100 },
    { erp_product_id: "P1", unit_price_amd: 100 },
    { erp_product_id: "P1", name: "No price" },
    { erp_product_id: "P1", name: "Good", unit_price_amd: 100 },
  ]);
  assert.equal(result.prodErpIds.length, 1);
  assert.equal(result.prodNames[0], "Good");
});

// --- transformErpBrandVolume --------------------------------------------------

test("transformErpBrandVolume: a well-formed row maps through, liters defaults to 0", () => {
  const result = transformErpBrandVolume([{ channel_code: "SM YVN", month: "2026-09-01", brand: "Castrol" }]);
  assert.deepEqual(result.volChannelCodes, ["SM YVN"]);
  assert.equal(result.volLiters[0], 0);
});

test("transformErpBrandVolume: missing channel_code, month, or brand drops the row", () => {
  const result = transformErpBrandVolume([
    { month: "2026-09-01", brand: "Castrol" },
    { channel_code: "SM YVN", brand: "Castrol" },
    { channel_code: "SM YVN", month: "2026-09-01" },
  ]);
  assert.deepEqual(result.volChannelCodes, []);
});
