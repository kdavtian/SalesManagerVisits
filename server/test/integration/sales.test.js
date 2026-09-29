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
