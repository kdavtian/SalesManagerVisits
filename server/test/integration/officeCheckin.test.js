// The Castrol Office (customers.checkin_for_all) is visible and check-in-able for every rep, but it
// is attendance, not a sales visit: never overdue, no visit in the scorecard, no strawberry bonus.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, apiRequest, apiFormRequest, loginAs, trackCheckin } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { buildScorecard } from "../../src/scorecard.js";
import { ingestVisitContribution } from "../../src/bonusSourceIngest.js";

let director, rep, other, repCookie, office;

test.before(async () => {
  await startTestServer();
  director = await createUser("sales_director");
  rep = await createUser("sales_manager");
  other = await createUser("sales_manager");
  repCookie = await loginAs(rep.email);
  office = await createCustomer({ created_by: director.id, assigned_manager_id: other.id, name: `ITEST Castrol Office ${Date.now()}` });
  await pool.query("UPDATE customers SET checkin_for_all = true WHERE id = $1", [office.id]);
});
test.after(async () => {
  await cleanupAll();
  await stopTestServer();
});

test("every rep sees the office in the customers list even though it is assigned to someone else", async () => {
  const res = await apiRequest("/api/customers", { cookie: repCookie });
  assert.equal(res.status, 200);
  const row = res.data.find((c) => c.id === office.id);
  assert.ok(row, "office listed for a rep it is not assigned to");
  assert.equal(row.requires_visit, false);
  assert.equal(row.overdue, false);
});

test("checking in at the office works, is not a visit in the scorecard and earns no visit bonus", async () => {
  const form = new FormData();
  form.set("customer_id", String(office.id));
  form.set("lat", String(office.lat));
  form.set("lng", String(office.lng));
  const res = await apiFormRequest("/api/checkins", { cookie: repCookie, form });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  trackCheckin(res.data.id);

  const card = (await buildScorecard(new Date().toISOString().slice(0, 10))).reps.find((r) => r.id === rep.id) ?? { visits: 0 };
  assert.equal(card.visits, 0);
  assert.equal(card.customers_visited ?? 0, 0);

  const result = await ingestVisitContribution(res.data.id);
  assert.equal(result.contribution, null);
  assert.equal(result.ledger, null);
});

test("the office has no visit schedule", async () => {
  const res = await apiRequest(`/api/customers/${office.id}/visit-schedule`, { cookie: repCookie });
  assert.equal(res.status, 200);
  assert.equal(res.data.no_visit, true);
  assert.deepEqual(res.data.planned, []);
});
