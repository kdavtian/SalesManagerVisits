// Map "debt coin": GET /api/customers/debt-flags lists who owes money, with the same RBAC as every other debt figure.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, loginAs, apiRequest } from "./helpers.js";
import { pool } from "../../src/db/pool.js";

const stamp = Date.now();
const erpIds = [];

test.before(startTestServer);
test.after(async () => {
  await pool.query("DELETE FROM erp_customer_data WHERE erp_customer_id = ANY($1)", [erpIds]);
  await cleanupAll();
  await stopTestServer();
});

async function debtor(manager, suffix, debt) {
  const erpId = `itest-df-${stamp}-${suffix}`;
  erpIds.push(erpId);
  const customer = await createCustomer({ created_by: manager.id, assigned_manager_id: manager.id, erp_customer_id: erpId });
  await pool.query("INSERT INTO erp_customer_data (erp_customer_id, customer_name, debt_amd, days_since_payment, synced_at) VALUES ($1, 'x', $2, 0, now())", [erpId, debt]);
  return customer;
}

test("debt-flags: only customers with debt above zero; a sales manager sees only their own", async () => {
  const mine = await createUser("sales_manager");
  const other = await createUser("sales_manager");
  const director = await createUser("sales_director");
  const owes = await debtor(mine, "owes", 120000);
  const paid = await debtor(mine, "paid", 0);
  const overpaid = await debtor(mine, "over", -500);
  const othersDebtor = await debtor(other, "other", 80000);

  const asMine = await apiRequest("/api/customers/debt-flags", { cookie: await loginAs(mine.email) });
  assert.equal(asMine.status, 200);
  const mineIds = asMine.data.map((r) => r.customer_id);
  assert.ok(mineIds.includes(owes.id));
  assert.ok(!mineIds.includes(paid.id));
  assert.ok(!mineIds.includes(overpaid.id));
  assert.ok(!mineIds.includes(othersDebtor.id), "another rep's debtor must not leak");
  assert.equal(asMine.data.find((r) => r.customer_id === owes.id).debt_amd, 120000);

  const asDirector = await apiRequest("/api/customers/debt-flags", { cookie: await loginAs(director.email) });
  const directorIds = asDirector.data.map((r) => r.customer_id);
  assert.ok(directorIds.includes(owes.id) && directorIds.includes(othersDebtor.id));
});
