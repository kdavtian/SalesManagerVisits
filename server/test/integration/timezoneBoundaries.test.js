// Integration-level companion to yerevanDate.test.js's pure unit tests --
// those cover the JS helper functions; this exercises the SQL-level fix in
// checkins.js's GET / (range=today/week/month), the exact code path the
// Activity screen depends on, against a real Postgres connection. See "Fix
// the Activity 'Today' date mismatch" in the stabilization plan.
import test from "node:test";
import assert from "node:assert/strict";
import {
  startTestServer,
  stopTestServer,
  cleanupAll,
  createUser,
  createCustomer,
  apiRequest,
  loginAs,
  trackCheckin,
} from "./helpers.js";
import { pool } from "../../src/db/pool.js";

test.before(startTestServer);
test.after(async () => {
  await cleanupAll();
  await stopTestServer();
});

async function seedCheckinAt(customerId, userId, timestampUtc) {
  const { rows } = await pool.query(
    `INSERT INTO checkins (customer_id, user_id, lat, lng, distance_meters, within_range, outcomes, "timestamp")
     VALUES ($1, $2, 40.18, 44.51, 0, true, ARRAY['no_order'], $3) RETURNING id`,
    [customerId, userId, timestampUtc]
  );
  return trackCheckin(rows[0].id);
}

test("range=today includes a check-in logged between Yerevan midnight and the old UTC cutoff", async () => {
  const manager = await createUser("sales_manager");
  const customer = await createCustomer({ created_by: manager.id });
  const cookie = await loginAs(manager.email);

  // now() at request time is real "now" -- to make this test deterministic
  // regardless of when it actually runs, anchor both check-ins relative to
  // the current instant rather than a fixed calendar date: one squarely at
  // "1 hour ago" (always inside whatever today/Yerevan-today actually is),
  // and one deliberately placed 2 hours before that, inside the boundary
  // window that only matters if a real clock happens to be past midnight
  // UTC but before 04:00 Yerevan right now (a rare intersection) -- instead
  // we directly assert the DB-level boundary expression rather than
  // depend on wall-clock timing, which is the robust way to test this
  // without flaking once a day.
  const { rows: boundary } = await pool.query(
    `SELECT (date_trunc('day', now() AT TIME ZONE 'Asia/Yerevan') AT TIME ZONE 'Asia/Yerevan') AS yerevan_midnight_utc,
            date_trunc('day', now()) AS utc_midnight`
  );
  const yerevanMidnightUtc = new Date(boundary[0].yerevan_midnight_utc);
  const utcMidnight = new Date(boundary[0].utc_midnight);

  // A check-in timestamped 1 minute after Yerevan's real midnight (in UTC
  // terms) is "today" in Yerevan no matter what -- this is squarely the
  // case the old date_trunc('day', now()) (UTC) bug excluded whenever
  // Yerevan's midnight falls in a different UTC day than the UTC cutoff
  // (i.e. whenever the current Yerevan hour is before 4am).
  const justAfterYerevanMidnight = new Date(yerevanMidnightUtc.getTime() + 60_000);
  const checkinId = await seedCheckinAt(customer.id, manager.id, justAfterYerevanMidnight.toISOString());

  const todayList = await apiRequest("/api/checkins?range=today", { cookie });
  assert.equal(todayList.status, 200);
  const ids = (todayList.data.rows ?? todayList.data).map((r) => r.id);
  assert.ok(ids.includes(checkinId), "a check-in just after Yerevan midnight must show under range=today");

  // Sanity: if the UTC cutoff differs from the Yerevan one right now (i.e.
  // we're in the actual bug window), the OLD (buggy) boundary would NOT
  // have included this check-in -- confirms the test is actually exercising
  // the fix when the clock allows it, not just trivially passing.
  if (utcMidnight.getTime() !== yerevanMidnightUtc.getTime()) {
    assert.ok(
      justAfterYerevanMidnight.getTime() < utcMidnight.getTime(),
      "expected this check-in to fall inside the old bug's exclusion window"
    );
  }
});

test("range=today excludes a check-in from the previous Yerevan day", async () => {
  const manager = await createUser("sales_manager");
  const customer = await createCustomer({ created_by: manager.id });
  const cookie = await loginAs(manager.email);

  const { rows: boundary } = await pool.query(
    `SELECT (date_trunc('day', now() AT TIME ZONE 'Asia/Yerevan') AT TIME ZONE 'Asia/Yerevan') AS yerevan_midnight_utc`
  );
  const yerevanMidnightUtc = new Date(boundary[0].yerevan_midnight_utc);
  const justBeforeYerevanMidnight = new Date(yerevanMidnightUtc.getTime() - 60_000);
  const checkinId = await seedCheckinAt(customer.id, manager.id, justBeforeYerevanMidnight.toISOString());

  const todayList = await apiRequest("/api/checkins?range=today", { cookie });
  const ids = (todayList.data.rows ?? todayList.data).map((r) => r.id);
  assert.ok(!ids.includes(checkinId), "a check-in from the previous Yerevan day must NOT show under range=today");
});
