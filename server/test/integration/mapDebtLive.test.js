// Owner, 2026-11-07: the Map popup said 251,400 where the customer card said 211,400 (a 40,000 payment recorded in the app, not in the
// Excel yet). Every screen that shows a customer's debt reads the LIVE debt: the card, the Map popup (one and many), the Map debt coins
// and the Customers list.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, apiRequest, loginAs, trackPayment } from "./helpers.js";
import { pool } from "../../src/db/pool.js";

const stamp = Date.now().toString(36);
const erpId = `MDL-${stamp}`;
let admin, rep, other, cookie, repCookie, otherCookie, customer;

test.before(async () => {
  await startTestServer();
  admin = await createUser("admin");
  rep = await createUser("sales_manager");
  other = await createUser("sales_manager");
  cookie = await loginAs(admin.email);
  repCookie = await loginAs(rep.email);
  otherCookie = await loginAs(other.email);
  customer = await createCustomer({ created_by: admin.id, assigned_manager_id: rep.id, erp_customer_id: erpId });
  await pool.query("INSERT INTO erp_customer_data (erp_customer_id, customer_name, debt_amd, synced_at) VALUES ($1, 'x', 251400, now())", [erpId]);
  trackPayment(
    (await pool.query(
      `INSERT INTO payments (customer_id, customer_name_snapshot, amount_amd, payment_date, sales_manager_id, sales_manager_name_snapshot, status, created_by, current_holder_id)
       VALUES ($1, 'x', 40000, now(), $2, 'Rep', 'pending', $2, $2) RETURNING id`,
      [customer.id, rep.id]
    )).rows[0].id
  );
});
test.after(async () => {
  await pool.query("DELETE FROM erp_customer_data WHERE erp_customer_id = $1", [erpId]);
  await cleanupAll();
  await stopTestServer();
});

test("the customer card, the Map popup (one and many), the debt coins and the list all say 211,400", async () => {
  const card = await apiRequest(`/api/customers/${customer.id}`, { cookie });
  assert.equal(card.data.live_debt.debt_amd, 211400, "the card");
  const one = await apiRequest(`/api/customers/${customer.id}/map-facts`, { cookie });
  assert.equal(one.data.erp_debt_amd, 211400, "popup, one pin");
  const many = await apiRequest(`/api/customers/map-facts?ids=${customer.id}`, { cookie });
  assert.equal(many.data[customer.id].erp_debt_amd, 211400, "popup, warmed in a batch");
  const flags = await apiRequest("/api/customers/debt-flags", { cookie });
  assert.equal(flags.data.find((f) => f.customer_id === customer.id)?.debt_amd, 211400, "debt coins");
  const list = await apiRequest("/api/customers?include_debt=1&search=" + erpId, { cookie });
  assert.equal(list.data.find((c) => c.id === customer.id)?.debt_amd, 211400, "the Customers list");
});

test("a rep sees the live debt of their own customer only; another rep gets nothing", async () => {
  const own = await apiRequest(`/api/customers/${customer.id}/map-facts`, { cookie: repCookie });
  assert.equal(own.data.erp_debt_amd, 211400);
  const foreign = await apiRequest(`/api/customers/${customer.id}/map-facts`, { cookie: otherCookie });
  assert.equal(foreign.data.erp_debt_amd ?? null, null);
  const flags = await apiRequest("/api/customers/debt-flags", { cookie: otherCookie });
  assert.ok(!flags.data.some((f) => f.customer_id === customer.id));
});
