// Release 3c (owner, 2026-11-02: "everywhere, show the gap"): the customer card, the app orders and Debt balances show the live debt
// (Excel + the app's delivered orders - the app's payments the Excel does not have yet) with the Excel figure and the gap.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, apiRequest, loginAs, trackOrder, trackPayment } from "./helpers.js";
import { pool } from "../../src/db/pool.js";

const ERP = `ILD${Date.now().toString(36)}`;
let admin, rep, cookie, customer, orderId;

test.before(async () => {
  await startTestServer();
  admin = await createUser("admin");
  rep = await createUser("sales_manager");
  cookie = await loginAs(admin.email);
  customer = await createCustomer({ created_by: rep.id, erp_customer_id: ERP });
  await pool.query("INSERT INTO erp_customer_data (erp_customer_id, customer_name, debt_amd, synced_at) VALUES ($1, 'x', 100000, now())", [ERP]);
  orderId = trackOrder((await pool.query("INSERT INTO orders (customer_id, user_id, status, total_amd, order_code) VALUES ($1, $2, 'delivered', 30000, $3) RETURNING id", [customer.id, rep.id, `LD-${ERP}`])).rows[0].id);
  trackPayment(
    (await pool.query(
      `INSERT INTO payments (customer_id, customer_name_snapshot, amount_amd, payment_date, sales_manager_id, sales_manager_name_snapshot, status, created_by, current_holder_id)
       VALUES ($1, 'x', 20000, now(), $2, 'Rep', 'pending', $2, $2) RETURNING id`,
      [customer.id, rep.id]
    )).rows[0].id
  );
});
test.after(async () => {
  await pool.query("DELETE FROM erp_customer_data WHERE erp_customer_id = $1", [ERP]);
  await cleanupAll();
  await stopTestServer();
});

test("the customer card: live debt 110,000 = Excel 100,000 + order 30,000 - payment 20,000", async () => {
  const r = await apiRequest(`/api/customers/${customer.id}`, { cookie });
  assert.equal(r.status, 200);
  assert.deepEqual(
    { d: r.data.live_debt.debt_amd, e: r.data.live_debt.excel_amd, o: r.data.live_debt.orders_not_in_excel_amd, p: r.data.live_debt.payments_not_in_excel_amd, a: r.data.live_debt.advance_amd },
    { d: 110000, e: 100000, o: 30000, p: 20000, a: 0 }
  );
});

test("the app order is the newest, so it is unpaid; Debt balances shows the live number with the Excel figure", async () => {
  const paid = await apiRequest(`/api/customers/${customer.id}/app-orders-paid`, { cookie });
  assert.equal(paid.data.orders[orderId].unpaid_amd, 30000);
  const list = await apiRequest("/api/debt-balances", { cookie });
  const row = list.data.rows.find((x) => x.internal_customer_id === customer.id);
  assert.ok(row, "listed");
  assert.equal(Number(row.remaining_balance), 110000);
  assert.equal(Number(row.excel_balance), 100000);
  assert.equal(row.not_in_excel_orders_amd, 30000);
  assert.equal(row.unrecorded_amd, 20000);
});
