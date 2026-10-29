// Speed budget for the busiest endpoints (docs/architecture-roadmap.md step 12): a company-sized data set (4,000 customers, 60,000
// Excel order lines, 3,000 app orders with 9,000 lines, a debt row per customer) and the screens everyone opens all day. Each
// endpoint is timed as the admin (who sees everything: the largest answers) and must answer within its budget below.
//
// The budgets are about 4x what a fast computer measured, so a normal slow run passes and a real slowdown (a lost index, a query per row,
// a whole-table scan added to a list) fails. When a change makes an endpoint legitimately slower, raise its budget here AND in the
// roadmap table, with the reason; never raise one to get past a failure you did not explain.
//
// Isolated (test/isolated-tests.txt): it fills its own database and the data would change other files' counts.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../../src/db/pool.js";
import { startTestServer, stopTestServer, createUser, loginAs, apiRequest, cleanupAll } from "./helpers.js";

const CUSTOMERS = 4000;
const ERP_LINES_PER_CUSTOMER = 15; // 60,000 Excel order lines
const APP_ORDERS = 3000;
const TAG = `SPD${Date.now()}`;

// ms: median of 3 timed requests after one warm-up request. Measured on a fast computer (2026-10-29, step 12) in brackets; a budget is
// about 4x that, at least 500 ms (a CI runner is up to 2x slower).
export const BUDGETS = {
  "/api/customers": 500, // Customers list (112)
  "/api/orders": 500, // Orders list (13)
  "/api/debt-balances": 2000, // Debt balances (503)
  "/api/customers/debt-flags": 500, // debt chips on lists and the map (13)
  "/api/dashboard/summary": 500, // Home (6)
  "/api/dashboard/trends": 500, // Home charts (6)
  "/api/sales": 1200, // Sales page (294)
  "/api/biz-reports/unpaid-invoices": 1200, // Unpaid invoices (288)
  "/api/reports/customer-debt": 1200, // Customer debt report (304)
  "/api/ops/legacy-balances": 800, // Ops control, old balances (198)
};

let cookie;
const measured = {};

before(async () => {
  await startTestServer();
  const admin = await createUser("admin");
  const rep = await createUser("sales_manager");
  cookie = await loginAs(admin.email);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO customers (name, sales_channel, created_by, assigned_manager_id, lat, lng, erp_customer_id, region)
       SELECT $1 || ' Customer ' || g, (ARRAY['SM YVN','WS','KF','CAS'])[1 + g % 4], $2, $2,
              40.0 + (g % 400) * 0.002, 44.3 + (g / 400) * 0.02, $1 || '-' || g, 'Yerevan'
       FROM generate_series(1, $3::int) g`,
      [TAG, rep.id, CUSTOMERS]
    );
    await client.query(
      `INSERT INTO erp_customer_data (erp_customer_id, assigned_sales_rep, debt_amd, last_payment_date, days_since_payment, aging_bucket, customer_name)
       SELECT $1 || '-' || g, 'Rep ' || (g % 12), (g % 37) * 25000, CURRENT_DATE - (g % 120), g % 120,
              (ARRAY['0-30','31-60','61-90','90+'])[1 + g % 4], $1 || ' Customer ' || g
       FROM generate_series(1, $2::int) g`,
      [TAG, CUSTOMERS]
    );
    await client.query(
      `INSERT INTO erp_order_lines (erp_customer_id, order_id, order_date, product_id, brand, product_name, size_l, qty, unit_price_amd, revenue_amd, discount_amd, sales_rep)
       SELECT $1 || '-' || (1 + (g % $2::int)), $1 || '-O' || (g / 3), CURRENT_DATE - (g % 365), 'P' || (g % 300),
              (ARRAY['Castrol','Mobil','Shell','Liqui Moly'])[1 + g % 4], 'Product ' || (g % 300), (ARRAY['1','4','5','20'])[1 + g % 4],
              1 + g % 6, 3000 + (g % 50) * 100, (1 + g % 6) * (3000 + (g % 50) * 100), 0, 'Rep ' || (g % 12)
       FROM generate_series(1, $3::int) g`,
      [TAG, CUSTOMERS, CUSTOMERS * ERP_LINES_PER_CUSTOMER]
    );
    const { rows: orders } = await client.query(
      `INSERT INTO orders (customer_id, user_id, status, total_amd, created_at)
       SELECT c.id, $2, (ARRAY['submitted','confirmed','delivered','delivered'])[1 + g % 4], 30000 + (g % 90) * 1000, now() - ((g % 180) || ' days')::interval
       FROM generate_series(1, $3::int) g
       JOIN customers c ON c.erp_customer_id = $1 || '-' || (1 + g % 4000)
       RETURNING id`,
      [TAG, rep.id, APP_ORDERS]
    );
    await client.query(
      `INSERT INTO order_items (order_id, product_name, unit_price_amd, quantity, line_total_amd, brand)
       SELECT o.id, 'Product ' || k, 5000, k, 5000 * k, 'Castrol' FROM unnest($1::int[]) AS o(id), generate_series(1, 3) k`,
      [orders.map((o) => o.id)]
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  await pool.query("ANALYZE customers; ANALYZE erp_customer_data; ANALYZE erp_order_lines; ANALYZE orders; ANALYZE order_items");
});

after(async () => {
  console.log(`speed budget (ms, median of 3): ${JSON.stringify(measured)}`);
  await pool.query("DELETE FROM orders WHERE customer_id IN (SELECT id FROM customers WHERE erp_customer_id LIKE $1)", [`${TAG}-%`]);
  await pool.query("DELETE FROM erp_order_lines WHERE erp_customer_id LIKE $1", [`${TAG}-%`]);
  await pool.query("DELETE FROM erp_customer_data WHERE erp_customer_id LIKE $1", [`${TAG}-%`]);
  await pool.query("DELETE FROM customers WHERE erp_customer_id LIKE $1", [`${TAG}-%`]);
  await cleanupAll();
  await stopTestServer();
});

async function timed(path) {
  const started = performance.now();
  const res = await apiRequest(path, { cookie });
  const ms = performance.now() - started;
  assert.equal(res.status, 200, `${path} answered ${res.status}`);
  return ms;
}

for (const [path, budget] of Object.entries(BUDGETS)) {
  test(`${path} answers within ${budget} ms with a company-sized data set`, async () => {
    await timed(path); // warm-up: the first request also pays for caches and query plans
    const runs = [await timed(path), await timed(path), await timed(path)].sort((a, b) => a - b);
    measured[path] = Math.round(runs[1]);
    assert.ok(runs[1] <= budget, `${path}: ${Math.round(runs[1])} ms, budget ${budget} ms`);
  });
}
