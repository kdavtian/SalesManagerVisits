// KF/CAS/CVO/PCO/OEM customers are not visited in the field: the visit schedule must not report
// overdue days or planned visits for them (the customer card showed "visit delayed 42 days").
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, apiRequest, loginAs } from "./helpers.js";
import { pool } from "../../src/db/pool.js";

let admin, adminCookie;
test.before(async () => {
  await startTestServer();
  admin = await createUser("admin");
  adminCookie = await loginAs(admin.email);
});
test.after(async () => {
  await pool.query("DELETE FROM checkins WHERE user_id = $1", [admin.id]);
  await cleanupAll();
  await stopTestServer();
});

async function customerVisitedLongAgo(channel) {
  const c = await createCustomer({ created_by: admin.id, assigned_manager_id: admin.id, sales_channel: channel });
  await pool.query(
    "INSERT INTO checkins (customer_id, user_id, lat, lng, distance_meters, within_range, timestamp) VALUES ($1, $2, 40.18, 44.51, 5, true, now() - interval '42 days')",
    [c.id, admin.id]
  );
  return c;
}

test("visit schedule: CAS customers have no overdue days and no planned visits; field channels still do", async () => {
  const cas = await customerVisitedLongAgo("CAS");
  const field = await customerVisitedLongAgo("SM YVN");

  const noVisit = (await apiRequest(`/api/customers/${cas.id}/visit-schedule`, { cookie: adminCookie })).data;
  assert.equal(noVisit.no_visit, true);
  assert.equal(noVisit.cadence.overdue, false);
  assert.equal(noVisit.cadence.overdue_days, 0);
  assert.deepEqual(noVisit.planned, []);
  assert.equal(noVisit.planned_today, false);
  assert.ok(noVisit.cadence.last_visit_at, "the last visit is still reported");

  const visited = (await apiRequest(`/api/customers/${field.id}/visit-schedule`, { cookie: adminCookie })).data;
  assert.equal(visited.no_visit, undefined);
  assert.equal(visited.cadence.overdue, true);
  assert.ok(visited.cadence.overdue_days > 0);

  // The map pin batch follows the same rule.
  const batch = (await apiRequest(`/api/customers/map-facts?ids=${cas.id},${field.id}`, { cookie: adminCookie })).data;
  assert.equal(batch[cas.id].no_visit, true);
  assert.equal(batch[field.id].cadence.overdue, true);
});
