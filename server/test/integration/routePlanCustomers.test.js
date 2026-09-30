// GET /api/visit-plans/rules/customers -- the Route Plans "View customers"
// sheet's data source: every customer assigned to a rep, tagged with which
// weekday(s) an active visit_plan_rule covers them on (explicit
// customer_ids, an area/region rule, or both), so the client can show a
// per-customer day badge or flag a customer that's on no day at all.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, apiRequest, loginAs } from "./helpers.js";
import { pool } from "../../src/db/pool.js";

let adminCookie;
let repCookie;
let admin;
let rep;
let otherManager;
let plannedCustomer; // explicit customer_ids on Thursday
let areaCustomer; // covered only via an area rule on Monday
let unplannedCustomer; // on no rule at all

test.before(async () => {
  await startTestServer();
  admin = await createUser("admin");
  adminCookie = await loginAs(admin.email);
  rep = await createUser("sales_manager");
  repCookie = await loginAs(rep.email);
  otherManager = await createUser("sales_manager");

  plannedCustomer = await createCustomer({ created_by: admin.id, assigned_manager_id: rep.id });
  areaCustomer = await createCustomer({ created_by: admin.id, assigned_manager_id: rep.id });
  unplannedCustomer = await createCustomer({ created_by: admin.id, assigned_manager_id: rep.id });
  await pool.query("UPDATE customers SET region = $1, subregion = $2 WHERE id = $3", [
    "Yerevan",
    "Kentron",
    areaCustomer.id,
  ]);

  // Thursday rule: explicit customer_ids only.
  await pool.query(
    `INSERT INTO visit_plan_rules (user_id, day_of_week, areas, customer_ids, created_by, active)
     VALUES ($1, 4, '[]', $2, $3, true)`,
    [rep.id, [plannedCustomer.id], admin.id]
  );
  // Monday rule: area-only, covers areaCustomer via its region/subregion.
  await pool.query(
    `INSERT INTO visit_plan_rules (user_id, day_of_week, areas, customer_ids, created_by, active)
     VALUES ($1, 1, $2, '{}', $3, true)`,
    [rep.id, JSON.stringify([{ region: "Yerevan", subregion: "Kentron" }]), admin.id]
  );
});
test.after(async () => {
  await pool.query("DELETE FROM visit_plan_rules WHERE user_id = $1", [rep.id]);
  await cleanupAll();
  await stopTestServer();
});

test("GET /visit-plans/rules/customers: tags each customer with its day(s), area rules included", async () => {
  const res = await apiRequest(`/api/visit-plans/rules/customers?user_id=${rep.id}`, { cookie: adminCookie });
  assert.equal(res.status, 200);
  const byId = new Map(res.data.customers.map((c) => [c.id, c]));
  assert.deepEqual(byId.get(plannedCustomer.id).days, [4]);
  assert.deepEqual(byId.get(areaCustomer.id).days, [1]);
  assert.deepEqual(byId.get(unplannedCustomer.id).days, []);
});

test("GET /visit-plans/rules/customers: a rep can read their own list without user_id", async () => {
  const res = await apiRequest("/api/visit-plans/rules/customers", { cookie: repCookie });
  assert.equal(res.status, 200);
  assert.equal(res.data.customers.length, 3);
});

test("GET /visit-plans/rules/customers: a sales_manager cannot read another rep's list", async () => {
  const otherCookie = await loginAs(otherManager.email);
  const res = await apiRequest(`/api/visit-plans/rules/customers?user_id=${rep.id}`, { cookie: otherCookie });
  assert.equal(res.status, 403);
});
