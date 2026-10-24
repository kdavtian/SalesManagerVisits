// Payments page, owner 2026-10-24: every payment says whether the Excel shows it (same customer, same amount, within 3 days),
// the list can show only the ones the Excel still misses, and an admin can delete a payment (archived, never lost).
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, apiRequest, loginAs, trackPayment } from "./helpers.js";
import { pool } from "../../src/db/pool.js";

const ERP_ID = `itest-pay-xl-${Date.now()}`;
let admin, rep, customer, adminCookie, repCookie;

async function seed(amount, daysAgo, status = "approved") {
  const { rows } = await pool.query(
    `INSERT INTO payments (customer_id, customer_name_snapshot, erp_customer_id_snapshot, amount_amd, payment_date, sales_manager_id, sales_manager_name_snapshot, status, created_by, current_holder_id)
     VALUES ($1, $2, $3, $4, now() - ($5 || ' days')::interval, $6, 'Fixture Rep', $7, $6, $6) RETURNING id`,
    [customer.id, customer.name, ERP_ID, amount, String(daysAgo), rep.id, status]
  );
  trackPayment(rows[0].id);
  return rows[0].id;
}

test.before(async () => {
  await startTestServer();
  admin = await createUser("admin");
  rep = await createUser("sales_manager");
  adminCookie = await loginAs(admin.email);
  repCookie = await loginAs(rep.email);
  customer = await createCustomer({ created_by: admin.id, erp_customer_id: ERP_ID });
});
test.after(async () => {
  await pool.query("DELETE FROM erp_cashflow_lines WHERE erp_customer_id = $1", [ERP_ID]);
  await pool.query("DELETE FROM deleted_payments WHERE payment->>'erp_customer_id_snapshot' = $1", [ERP_ID]);
  await cleanupAll();
  await stopTestServer();
});

test("the list says which payments the Excel shows, and excel=missing keeps only the old ones it does not", async () => {
  const inExcel = await seed(12345, 10);
  const missing = await seed(22222, 10, "pending");
  const fresh = await seed(33333, 0);
  await pool.query("INSERT INTO erp_cashflow_lines (erp_customer_id, cashflow_date, amount_amd) VALUES ($1, current_date - 9, 12345)", [ERP_ID]);

  const all = await apiRequest(`/api/payments?customer_id=${customer.id}`, { cookie: adminCookie });
  const byId = new Map(all.data.rows.map((p) => [p.id, p]));
  assert.equal(byId.get(inExcel).in_excel, true);
  assert.equal(byId.get(missing).in_excel, false);
  assert.equal(byId.get(fresh).in_excel, false);
  assert.ok(byId.get(missing).days_old >= 10);

  const only = await apiRequest(`/api/payments?customer_id=${customer.id}&excel=missing`, { cookie: adminCookie });
  assert.deepEqual(only.data.rows.map((p) => p.id), [missing]); // the fresh one is still inside the 3 days of grace

  const detail = await apiRequest(`/api/payments/${missing}`, { cookie: adminCookie });
  assert.equal(detail.data.in_excel, false);
});

test("only an admin can delete a payment; it is archived with its history and the reason", async () => {
  const id = await seed(44444, 2, "pending");
  await pool.query("INSERT INTO payment_status_history (payment_id, old_status, new_status, reason, changed_by) VALUES ($1, NULL, 'pending', 'Created', $2)", [id, rep.id]);

  const denied = await apiRequest(`/api/payments/${id}`, { method: "DELETE", cookie: repCookie, body: { reason: "x" } });
  assert.equal(denied.status, 403);

  const ok = await apiRequest(`/api/payments/${id}`, { method: "DELETE", cookie: adminCookie, body: { reason: "entered twice" } });
  assert.equal(ok.status, 200);
  const { rows } = await pool.query("SELECT 1 FROM payments WHERE id = $1", [id]);
  assert.equal(rows.length, 0);
  const archived = await pool.query("SELECT * FROM deleted_payments WHERE payment_id = $1", [id]);
  assert.equal(archived.rows.length, 1);
  assert.equal(archived.rows[0].reason, "entered twice");
  assert.equal(archived.rows[0].deleted_by, admin.id);
  assert.equal(archived.rows[0].history.length, 1);

  const list = await apiRequest("/api/payments/deleted/list", { cookie: adminCookie });
  assert.ok(list.data.some((r) => r.payment_id === id && Number(r.amount_amd) === 44444));
  assert.equal((await apiRequest("/api/payments/deleted/list", { cookie: repCookie })).status, 403);
  assert.equal((await apiRequest(`/api/payments/${id}`, { method: "DELETE", cookie: adminCookie })).status, 404);
});
