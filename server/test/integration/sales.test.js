// API coverage for the read-only Sales viewer (server/src/routes/sales.js)
// -- specifically GET /api/sales/order's per-line discount_amd (migration
// 081), the ERP Orders sheet's own per-product "Discount" column that used
// to be captured nowhere in this app at all (see docs/erp-sync-contract.md).
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, apiRequest, loginAs } from "./helpers.js";
import { pool } from "../../src/db/pool.js";

const ERP_CUSTOMER_ID = `itest-sales-${Date.now()}`;
const ORDER_ID = "ORD-ITEST-1";
const OLD_ORDER_ID = "ORD-ITEST-OLD";

let adminCookie;

test.before(async () => {
  await startTestServer();
  const admin = await createUser("admin");
  adminCookie = await loginAs(admin.email);
  await pool.query(
    `INSERT INTO erp_order_lines (erp_customer_id, order_id, order_date, product_id, brand, product_name, size_l, qty, unit_price_amd, revenue_amd, discount_amd)
     VALUES
       ($1, $2, CURRENT_DATE, 'P1', 'Castrol', 'Itest Discounted Oil', '4', 4, 12000, 46000, 2000),
       ($1, $2, CURRENT_DATE, 'P2', 'Castrol', 'Itest Plain Oil', '1', 2, 6000, 12000, NULL)`,
    [ERP_CUSTOMER_ID, ORDER_ID]
  );
  // An old order, far outside the default "this month" range -- only a
  // search (which ignores dates) should ever surface it.
  await pool.query(
    `INSERT INTO erp_order_lines (erp_customer_id, order_id, order_date, product_id, brand, product_name, size_l, qty, unit_price_amd, revenue_amd)
     VALUES ($1, $2, '2020-01-15', 'P3', 'Castrol', 'Itest Edge 0W-20 C5', '4', 1, 77777, 77777)`,
    [ERP_CUSTOMER_ID, OLD_ORDER_ID]
  );
});
test.after(async () => {
  await pool.query("DELETE FROM erp_order_lines WHERE erp_customer_id = $1", [ERP_CUSTOMER_ID]);
  await cleanupAll();
  await stopTestServer();
});

test("GET /api/sales/order: returns each line's discount_amd, null for a line with none", async () => {
  const res = await apiRequest(`/api/sales/order?erp_customer_id=${ERP_CUSTOMER_ID}&order_id=${ORDER_ID}`, {
    cookie: adminCookie,
  });
  assert.equal(res.status, 200);
  const discounted = res.data.lines.find((l) => l.product_name === "Itest Discounted Oil");
  const plain = res.data.lines.find((l) => l.product_name === "Itest Plain Oil");
  assert.equal(Number(discounted.discount_amd), 2000);
  assert.equal(plain.discount_amd, null);
  // discount_amd is purely informational -- the order total still comes
  // straight from revenue_amd, never re-derived from it.
  assert.equal(Number(res.data.total_amd), 58000);
});

test("GET /api/sales: a search keeps the date range; widening the range finds the old order", async () => {
  const plain = await apiRequest("/api/sales", { cookie: adminCookie });
  assert.ok(!plain.data.rows.some((r) => r.order_id === OLD_ORDER_ID));

  // Default (this month) range: the old order stays out even when searched.
  const narrow = await apiRequest(`/api/sales?q=${OLD_ORDER_ID}`, { cookie: adminCookie });
  assert.equal(narrow.status, 200);
  assert.equal(narrow.data.searching, true);
  assert.deepEqual(narrow.data.rows, []);

  const wide = "from=2019-01-01&to=2030-01-01";
  const byOrderId = await apiRequest(`/api/sales?q=${OLD_ORDER_ID}&${wide}`, { cookie: adminCookie });
  assert.deepEqual(byOrderId.data.rows.map((r) => r.order_id), [OLD_ORDER_ID]);

  const byErpId = await apiRequest(`/api/sales?q=${ERP_CUSTOMER_ID}&${wide}`, { cookie: adminCookie });
  assert.deepEqual(byErpId.data.rows.map((r) => r.order_id).sort(), [OLD_ORDER_ID, ORDER_ID].sort());
});

test("GET /api/sales: product text search is order-level and tolerant of dashes/spacing", async () => {
  const res = await apiRequest(`/api/sales?from=2019-01-01&to=2030-01-01&q=${encodeURIComponent("edge 0w20 c5 4l")}`, { cookie: adminCookie });
  assert.equal(res.status, 200);
  assert.deepEqual(res.data.rows.filter((r) => r.erp_customer_id === ERP_CUSTOMER_ID).map((r) => r.order_id), [OLD_ORDER_ID]);

  const miss = await apiRequest(`/api/sales?from=2019-01-01&to=2030-01-01&q=${encodeURIComponent(`${ERP_CUSTOMER_ID} 5w30`)}`, { cookie: adminCookie });
  assert.equal(miss.data.rows.length, 0);
});

test("GET /api/sales: amount terms compare against the order total", async () => {
  const big = await apiRequest(`/api/sales?from=2019-01-01&to=2030-01-01&q=${encodeURIComponent(`${ERP_CUSTOMER_ID} >60000`)}`, { cookie: adminCookie });
  assert.deepEqual(big.data.rows.map((r) => r.order_id), [OLD_ORDER_ID]);
  const small = await apiRequest(`/api/sales?from=2019-01-01&to=2030-01-01&q=${encodeURIComponent(`${ERP_CUSTOMER_ID} <=60000`)}`, { cookie: adminCookie });
  assert.deepEqual(small.data.rows.map((r) => r.order_id), [ORDER_ID]);
});
