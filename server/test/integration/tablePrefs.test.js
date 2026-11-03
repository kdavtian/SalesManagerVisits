// Desktop tables (owner, 2026-11-03): a person's columns saved on the server (only their own), and the Customers list's opt-in
// last-payment lookup + "only our customers" (ERP ID) filter.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, apiRequest, loginAs } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { cleanConfig } from "../../src/system/routes/tablePrefs.js";

const ERP = `TP${process.pid}`;
let admin, rep, other, adminCookie, repCookie, ours, theirs, notErp;

test.before(async () => {
  await startTestServer();
  admin = await createUser("admin");
  rep = await createUser("sales_manager");
  other = await createUser("sales_manager");
  adminCookie = await loginAs(admin.email);
  repCookie = await loginAs(rep.email);
  ours = await createCustomer({ created_by: admin.id, assigned_manager_id: rep.id, erp_customer_id: ERP, name: `TP ours ${process.pid}` });
  theirs = await createCustomer({ created_by: admin.id, assigned_manager_id: other.id, erp_customer_id: `${ERP}B`, name: `TP theirs ${process.pid}` });
  notErp = await createCustomer({ created_by: admin.id, assigned_manager_id: rep.id, name: `TP potential ${process.pid}` });
  await pool.query("INSERT INTO erp_cashflow_lines (erp_customer_id, cashflow_date, amount_amd) VALUES ($1, '2026-10-01', 40000), ($1, '2026-10-20', 85000), ($2, '2026-10-22', 70000)", [ERP, `${ERP}B`]);
  await pool.query("INSERT INTO erp_customer_data (erp_customer_id, debt_amd) VALUES ($1, 0), ($2, 0) ON CONFLICT DO NOTHING", [ERP, `${ERP}B`]);
});
test.after(async () => {
  await pool.query("DELETE FROM erp_cashflow_lines WHERE erp_customer_id IN ($1, $2)", [ERP, `${ERP}B`]);
  await pool.query("DELETE FROM erp_customer_data WHERE erp_customer_id IN ($1, $2)", [ERP, `${ERP}B`]);
  await cleanupAll();
  await stopTestServer();
});

test("table settings: saved per person, only their own, cleaned, deleted", async () => {
  const config = { order: ["rep", "debt", "address"], on: ["rep", "address"], fit: false, junk: "x" };
  assert.equal((await apiRequest("/api/table-prefs/customers", { method: "PUT", cookie: repCookie, body: { config } })).status, 200);
  const mine = await apiRequest("/api/table-prefs", { cookie: repCookie });
  assert.deepEqual({ order: mine.data.prefs.customers.order, on: mine.data.prefs.customers.on, fit: mine.data.prefs.customers.fit }, { order: ["rep", "debt", "address"], on: ["rep", "address"], fit: false });
  assert.equal(mine.data.prefs.customers.junk, undefined);
  // another person sees none of it
  assert.deepEqual((await apiRequest("/api/table-prefs", { cookie: adminCookie })).data.prefs, {});
  // changing it again replaces it
  await apiRequest("/api/table-prefs/customers", { method: "PUT", cookie: repCookie, body: { config: { order: ["debt"], on: ["debt"], fit: true } } });
  assert.deepEqual((await apiRequest("/api/table-prefs", { cookie: repCookie })).data.prefs.customers.on, ["debt"]);
  // bad input
  assert.equal((await apiRequest("/api/table-prefs/bad%20key!", { method: "PUT", cookie: repCookie, body: { config } })).status, 400);
  assert.equal((await apiRequest("/api/table-prefs/customers", { method: "PUT", cookie: repCookie, body: { config: "no" } })).status, 400);
  assert.equal((await apiRequest("/api/table-prefs/customers", { method: "DELETE", cookie: repCookie })).status, 200);
  assert.deepEqual((await apiRequest("/api/table-prefs", { cookie: repCookie })).data.prefs, {});
  assert.equal((await apiRequest("/api/table-prefs")).status, 401);
  assert.deepEqual(cleanConfig({ order: ["a", "a", 5, "b c"], on: "x" }), { order: ["a"], on: [], fit: true });
});

test("customers list: last payment is opt-in and a rep only gets it for their own customers; only_erp keeps the ERP customers", async () => {
  const plain = await apiRequest("/api/customers", { cookie: adminCookie });
  const row = (list, id) => list.find((c) => c.id === id);
  assert.equal(row(plain.data, ours.id).last_payment_date, undefined, "not asked for: not sent");
  const withPay = await apiRequest("/api/customers?include_payment=1", { cookie: adminCookie });
  assert.equal(row(withPay.data, ours.id).last_payment_date, "2026-10-20");
  assert.equal(row(withPay.data, ours.id).last_payment_amd, 85000);
  assert.equal(row(withPay.data, notErp.id).last_payment_date, null);
  // a rep: own customer yes; the other rep's customer is listed (the book is shared) but without the money
  const mineList = await apiRequest("/api/customers?include_payment=1", { cookie: repCookie });
  assert.equal(row(mineList.data, ours.id).last_payment_amd, 85000);
  assert.equal(row(mineList.data, theirs.id)?.last_payment_amd ?? null, null);
  // only our customers
  const only = await apiRequest("/api/customers?only_erp=1", { cookie: adminCookie });
  assert.ok(row(only.data, ours.id));
  assert.equal(row(only.data, notErp.id), undefined);
});
