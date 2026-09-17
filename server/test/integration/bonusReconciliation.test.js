// Real-Postgres coverage for bonusReconciliation.js's sweep: it's disabled
// while app_settings.bonuses_enabled is off, it finds and ingests genuinely
// new activity, a second sweep over the same window is a no-op, and --
// critically -- a checkin at a non-office customer is never re-queued for
// attendance processing on every sweep forever (see this file's regression
// test below; the bug it guards against was caught by hand while manually
// verifying the sweep during development: an unscoped "no attendance row
// yet" query matches every non-office checkin on every run, since
// ingestOfficeAttendance() never writes one for a checkin that isn't at the
// office customer in the first place).
import "dotenv/config";
import test from "node:test";
import assert from "node:assert/strict";
import { pool } from "../../src/db/pool.js";
import { runReconciliationSweep } from "../../src/bonusReconciliation.js";
import { setBonusesEnabled, getBonusesEnabled, setBonusSettings } from "../../src/bonusSettings.js";
import { createUser, createCustomer, trackCheckin, cleanupAll } from "./helpers.js";

const userIds = [];

async function cleanupBonusRows() {
  if (!userIds.length) return;
  await pool.query("DELETE FROM bonus_point_ledger WHERE user_id = ANY($1)", [userIds]);
  await pool.query(
    `DELETE FROM bonus_source_contributions sc USING bonus_earning_units eu
     WHERE sc.earning_unit_id = eu.id AND eu.user_id = ANY($1)`,
    [userIds]
  );
  await pool.query("DELETE FROM bonus_attendance_records WHERE user_id = ANY($1)", [userIds]);
  await pool.query("DELETE FROM bonus_earning_units WHERE user_id = ANY($1)", [userIds]);
}

test.after(async () => {
  await setBonusesEnabled(false); // restore the production default for every other test file
  await cleanupBonusRows();
  await cleanupAll();
});

test("runReconciliationSweep: does nothing while bonuses_enabled is off", async () => {
  await setBonusesEnabled(false);
  const manager = await createUser("sales_manager");
  userIds.push(manager.id);
  const customer = await createCustomer({ created_by: manager.id });
  const { rows } = await pool.query(
    `INSERT INTO checkins (customer_id, user_id, lat, lng, distance_meters, within_range, outcomes, "timestamp")
     VALUES ($1, $2, 40.18, 44.51, 10, true, ARRAY['no_order'], now()) RETURNING id`,
    [customer.id, manager.id]
  );
  trackCheckin(rows[0].id);

  // Not asserting the sweep's aggregate return value here -- app_settings.
  // bonuses_enabled is a real shared singleton, and several other bonus
  // test files toggle it concurrently (Node's test runner runs files in
  // parallel); one of them flipping it back to true between this line and
  // the sweep call below is a real, observed race (caught in CI), not a
  // hypothetical. What this test actually owns -- "my checkin doesn't get
  // processed while I've asked for it to be off" -- is checked directly
  // against this checkin's own row instead.
  await runReconciliationSweep();
  const { rows: contributionRows } = await pool.query(
    "SELECT id FROM bonus_source_contributions WHERE source_table = 'checkin' AND source_id = $1",
    [rows[0].id]
  );
  if (await getBonusesEnabled()) return; // another file turned it on mid-test -- this run can't assert "off" behavior
  assert.equal(contributionRows.length, 0);
  const { rows: ledgerRows } = await pool.query("SELECT id FROM bonus_point_ledger WHERE user_id = $1", [manager.id]);
  assert.equal(ledgerRows.length, 0);
});

test("runReconciliationSweep: ingests a new GPS-verified visit once enabled, then no-ops on the next sweep", async () => {
  await setBonusesEnabled(true);
  const manager = await createUser("sales_manager");
  userIds.push(manager.id);
  const customer = await createCustomer({ created_by: manager.id });
  const { rows } = await pool.query(
    `INSERT INTO checkins (customer_id, user_id, lat, lng, distance_meters, within_range, outcomes, "timestamp")
     VALUES ($1, $2, 40.18, 44.51, 10, true, ARRAY['no_order'], now()) RETURNING id`,
    [customer.id, manager.id]
  );
  trackCheckin(rows[0].id);

  // Not asserting an exact checkinsVisits count here -- another test file's
  // checkin created earlier in the shared 48h lookback window (e.g. the
  // previous test above, run while bonuses_enabled was off) is legitimately
  // still unprocessed and correctly swept up too. What this test owns is
  // "this checkin specifically got a contribution and a ledger entry."
  await runReconciliationSweep();
  const { rows: contributionRows } = await pool.query(
    "SELECT id FROM bonus_source_contributions WHERE source_table = 'checkin' AND source_id = $1",
    [rows[0].id]
  );
  assert.equal(contributionRows.length, 1);
  const { rows: ledgerRows } = await pool.query("SELECT activity FROM bonus_point_ledger WHERE user_id = $1", [manager.id]);
  assert.equal(ledgerRows.length, 1);
  assert.equal(ledgerRows[0].activity, "strawberry");

  await runReconciliationSweep();
  const { rows: stillOne } = await pool.query("SELECT id FROM bonus_point_ledger WHERE user_id = $1", [manager.id]);
  assert.equal(stillOne.length, 1); // a second sweep didn't duplicate this user's ledger entry
});

test("runReconciliationSweep: a checkin at a non-office customer is never re-queued for attendance on repeated sweeps", async () => {
  await setBonusesEnabled(true);
  await setBonusSettings({ officeErpCustomerId: "10000" });
  const manager = await createUser("sales_manager");
  userIds.push(manager.id);
  const customer = await createCustomer({ created_by: manager.id, erp_customer_id: "not-the-office" });
  const { rows } = await pool.query(
    `INSERT INTO checkins (customer_id, user_id, lat, lng, distance_meters, within_range, outcomes, "timestamp")
     VALUES ($1, $2, 40.18, 44.51, 10, true, ARRAY['no_order'], now()) RETURNING id`,
    [customer.id, manager.id]
  );
  trackCheckin(rows[0].id);

  const first = await runReconciliationSweep();
  assert.equal(first.checkinsAttendance, 0); // not a candidate at all -- scoped out by the office-customer join

  const second = await runReconciliationSweep();
  assert.equal(second.checkinsAttendance, 0); // still zero, not "found again"

  const { rows: attendanceRows } = await pool.query("SELECT id FROM bonus_attendance_records WHERE checkin_id = $1", [rows[0].id]);
  assert.equal(attendanceRows.length, 0); // correctly never treated as an attendance attempt
});
