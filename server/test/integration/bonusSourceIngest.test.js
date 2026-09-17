// Real-Postgres coverage for the Phase 3 source-integration modules:
// bonusSourceIngest.js's four ingest*() functions, bonusLedger.js's
// idempotency/reversal, and bonusEarningUnits.js's daily cap. No HTTP route
// exists yet (added in a later phase), so this drives the functions
// directly, the same way test/integration/bonusRules.test.js does.
//
// bonus_point_ledger's three provenance FKs are ON DELETE RESTRICT (see
// migrations/078_bonus_ledger_restrict_fks.sql) -- a customer/user fixture
// this file creates cannot be deleted by helpers.js's cleanupAll() while a
// ledger row still points (even indirectly, through a contribution or
// attendance row) at it. cleanupBonusRows() below tears down everything
// this file's own tests wrote, in dependency order, before cleanupAll()
// runs.
import "dotenv/config";
import test from "node:test";
import assert from "node:assert/strict";
import { pool } from "../../src/db/pool.js";
import {
  ingestVisitContribution,
  ingestCollectionContribution,
  ingestOrderDelivery,
  ingestOfficeAttendance,
  reverseSourceContribution,
} from "../../src/bonusSourceIngest.js";
import { reverseLedgerEntry } from "../../src/bonusLedger.js";
import { setBonusSettings } from "../../src/bonusSettings.js";
import { createUser, createCustomer, trackCheckin, trackPayment, trackOrder, cleanupAll } from "./helpers.js";

const userIds = [];

async function cleanupBonusRows() {
  if (!userIds.length) return;
  const { rows: evidenceFromContributions } = await pool.query(
    `SELECT DISTINCT sc.gps_evidence_id AS id FROM bonus_source_contributions sc
     JOIN bonus_earning_units eu ON eu.id = sc.earning_unit_id
     WHERE eu.user_id = ANY($1) AND sc.gps_evidence_id IS NOT NULL`,
    [userIds]
  );
  const { rows: evidenceFromAttendance } = await pool.query(
    `SELECT DISTINCT gps_evidence_id AS id FROM bonus_attendance_records WHERE user_id = ANY($1) AND gps_evidence_id IS NOT NULL`,
    [userIds]
  );
  const evidenceIds = [...evidenceFromContributions, ...evidenceFromAttendance].map((r) => r.id);

  await pool.query("DELETE FROM bonus_point_ledger WHERE user_id = ANY($1)", [userIds]);
  await pool.query(
    `DELETE FROM bonus_source_contributions sc USING bonus_earning_units eu
     WHERE sc.earning_unit_id = eu.id AND eu.user_id = ANY($1)`,
    [userIds]
  );
  await pool.query("DELETE FROM bonus_attendance_records WHERE user_id = ANY($1)", [userIds]);
  await pool.query("DELETE FROM bonus_earning_units WHERE user_id = ANY($1)", [userIds]);
  if (evidenceIds.length) {
    await pool.query("DELETE FROM bonus_gps_evidence WHERE id = ANY($1)", [evidenceIds]);
  }
}

test.after(async () => {
  await cleanupBonusRows();
  await cleanupAll();
});

async function seedCheckin({ customerId, userId, withinRange = true, timestamp = new Date() }) {
  const { rows } = await pool.query(
    `INSERT INTO checkins (customer_id, user_id, lat, lng, distance_meters, within_range, outcomes, "timestamp")
     VALUES ($1, $2, 40.18, 44.51, $3, $4, ARRAY['no_order'], $5) RETURNING *`,
    [customerId, userId, withinRange ? 10 : 5000, withinRange, timestamp]
  );
  trackCheckin(rows[0].id);
  return rows[0];
}

async function seedApprovedPayment({ customerId, salesManagerId, paymentDate = new Date() }) {
  const { rows } = await pool.query(
    `INSERT INTO payments (
       customer_id, customer_name_snapshot, amount_amd, payment_date, sales_manager_id,
       sales_manager_name_snapshot, status, created_by, approved_by, approved_at
     ) VALUES ($1, 'Fixture Customer', 5000, $2, $3, 'Fixture Rep', 'approved', $3, $3, now())
     RETURNING *`,
    [customerId, paymentDate, salesManagerId]
  );
  trackPayment(rows[0].id);
  return rows[0];
}

async function seedDeliveredOrder({ customerId, userId, deliveredAt = new Date() }) {
  const { rows } = await pool.query(
    `INSERT INTO orders (customer_id, user_id, status, total_amd, discount_pct, discount_amd, approval_status, order_code, payment_method)
     VALUES ($1, $2, 'delivered', 1000, 0, 0, 'not_required', $3, 'cash') RETURNING *`,
    [customerId, userId, `ITEST-BONUS-${Date.now()}-${Math.random().toString(36).slice(2)}`]
  );
  trackOrder(rows[0].id);
  await pool.query(
    `INSERT INTO order_status_history (order_id, old_status, new_status, changed_at) VALUES ($1, 'confirmed', 'delivered', $2)`,
    [rows[0].id, deliveredAt]
  );
  return rows[0];
}

// --- Strawberry: visits -----------------------------------------------------------

test("ingestVisitContribution: a GPS-verified checkin earns a strawberry and posts a ledger entry", async () => {
  const manager = await createUser("sales_manager");
  userIds.push(manager.id);
  const customer = await createCustomer({ created_by: manager.id });
  const checkin = await seedCheckin({ customerId: customer.id, userId: manager.id, withinRange: true });

  const { contribution, ledger } = await ingestVisitContribution(checkin.id);
  assert.equal(contribution.status, "confirmed");
  assert.equal(contribution.contributes_scaled, 2); // 1 whole strawberry, scale-2 terms
  assert.equal(contribution.gps_verified, true);
  assert.ok(ledger);
  assert.equal(ledger.activity, "strawberry");
  assert.equal(ledger.collectible_delta_scaled, 2);
  assert.equal(ledger.points_delta_scaled, 2); // 1 strawberry * 1 point/unit (seeded default) * scale 2
});

test("ingestVisitContribution: a checkin outside GPS range earns nothing but is still recorded", async () => {
  const manager = await createUser("sales_manager");
  userIds.push(manager.id);
  const customer = await createCustomer({ created_by: manager.id });
  const checkin = await seedCheckin({ customerId: customer.id, userId: manager.id, withinRange: false });

  const { contribution, ledger } = await ingestVisitContribution(checkin.id);
  assert.equal(contribution.status, "rejected");
  assert.equal(contribution.contributes_scaled, 0);
  assert.equal(ledger, null);
});

test("ingestVisitContribution: a second visit to the same customer the same day earns no additional strawberry (daily cap)", async () => {
  const manager = await createUser("sales_manager");
  userIds.push(manager.id);
  const customer = await createCustomer({ created_by: manager.id });
  const now = new Date();
  const first = await seedCheckin({ customerId: customer.id, userId: manager.id, withinRange: true, timestamp: now });
  const second = await seedCheckin({
    customerId: customer.id,
    userId: manager.id,
    withinRange: true,
    timestamp: new Date(now.getTime() + 60 * 60 * 1000),
  });

  const firstResult = await ingestVisitContribution(first.id);
  assert.ok(firstResult.ledger);
  const secondResult = await ingestVisitContribution(second.id);
  assert.equal(secondResult.contribution.status, "confirmed"); // a real, GPS-valid visit...
  assert.equal(secondResult.contribution.contributes_scaled, 0); // ...but the day's unit is already full
  assert.equal(secondResult.ledger, null);
});

test("ingestVisitContribution: re-processing the same checkin is idempotent -- no duplicate ledger row", async () => {
  const manager = await createUser("sales_manager");
  userIds.push(manager.id);
  const customer = await createCustomer({ created_by: manager.id });
  const checkin = await seedCheckin({ customerId: customer.id, userId: manager.id, withinRange: true });

  const first = await ingestVisitContribution(checkin.id);
  const second = await ingestVisitContribution(checkin.id);
  assert.equal(second.contribution.id, first.contribution.id);
  assert.equal(second.ledger, null); // nothing new posted the second time

  const { rows } = await pool.query("SELECT * FROM bonus_point_ledger WHERE operation_key = $1", [`checkin:${checkin.id}:strawberry`]);
  assert.equal(rows.length, 1);
});

// --- Carrot: collections -----------------------------------------------------------

test("ingestCollectionContribution: an approved payment with a fresh nearby checkin earns a full carrot", async () => {
  const manager = await createUser("sales_manager");
  userIds.push(manager.id);
  const customer = await createCustomer({ created_by: manager.id });
  const now = new Date();
  await seedCheckin({ customerId: customer.id, userId: manager.id, withinRange: true, timestamp: now });
  const payment = await seedApprovedPayment({
    customerId: customer.id,
    salesManagerId: manager.id,
    paymentDate: new Date(now.getTime() + 30 * 60 * 1000),
  });

  const { contribution, ledger } = await ingestCollectionContribution(payment.id);
  assert.equal(contribution.gps_verified, true);
  assert.equal(contribution.contributes_scaled, 2); // full carrot
  assert.ok(ledger);
  assert.equal(ledger.activity, "carrot");
  assert.equal(ledger.points_delta_scaled, 10); // 1 carrot * 5 points/unit (seeded default) * scale 2
});

test("ingestCollectionContribution: an approved payment with no nearby checkin earns half a carrot", async () => {
  const manager = await createUser("sales_manager");
  userIds.push(manager.id);
  const customer = await createCustomer({ created_by: manager.id });
  const payment = await seedApprovedPayment({ customerId: customer.id, salesManagerId: manager.id });

  const { contribution, ledger } = await ingestCollectionContribution(payment.id);
  assert.equal(contribution.gps_verified, false);
  assert.equal(contribution.contributes_scaled, 1); // half carrot
  assert.ok(ledger);
  assert.equal(ledger.points_delta_scaled, 5); // 0.5 carrot * 5 points/unit * scale 2
});

test("ingestCollectionContribution: a checkin outside the freshness window does not count as evidence", async () => {
  const manager = await createUser("sales_manager");
  userIds.push(manager.id);
  const customer = await createCustomer({ created_by: manager.id });
  await setBonusSettings({ collectionGpsFreshnessHours: 1 });
  const now = new Date();
  await seedCheckin({ customerId: customer.id, userId: manager.id, withinRange: true, timestamp: new Date(now.getTime() - 3 * 60 * 60 * 1000) });
  const payment = await seedApprovedPayment({ customerId: customer.id, salesManagerId: manager.id, paymentDate: now });

  const { contribution } = await ingestCollectionContribution(payment.id);
  assert.equal(contribution.gps_verified, false);
  assert.equal(contribution.contributes_scaled, 1); // falls back to half credit

  await setBonusSettings({ collectionGpsFreshnessHours: 4 }); // restore the default for later tests
});

test("ingestCollectionContribution: a pending (not yet approved) payment earns nothing", async () => {
  const manager = await createUser("sales_manager");
  userIds.push(manager.id);
  const customer = await createCustomer({ created_by: manager.id });
  const { rows } = await pool.query(
    `INSERT INTO payments (customer_id, customer_name_snapshot, amount_amd, payment_date, sales_manager_id, sales_manager_name_snapshot, status, created_by)
     VALUES ($1, 'Fixture Customer', 5000, now(), $2, 'Fixture Rep', 'pending', $2) RETURNING id`,
    [customer.id, manager.id]
  );
  trackPayment(rows[0].id);

  const result = await ingestCollectionContribution(rows[0].id);
  assert.equal(result.reason, "payment_not_approved");
  assert.equal(result.contribution, null);
});

// --- Apple: delivered orders --------------------------------------------------------

test("ingestOrderDelivery: an order with a recorded 'delivered' transition earns an apple", async () => {
  const manager = await createUser("sales_manager");
  userIds.push(manager.id);
  const customer = await createCustomer({ created_by: manager.id });
  const order = await seedDeliveredOrder({ customerId: customer.id, userId: manager.id });

  const { contribution, ledger } = await ingestOrderDelivery(order.id);
  assert.equal(contribution.contributes_scaled, 2);
  assert.ok(ledger);
  assert.equal(ledger.activity, "apple");
  assert.equal(ledger.points_delta_scaled, 10); // 1 apple * 5 points/unit (seeded default) * scale 2
});

test("ingestOrderDelivery: an order never marked delivered earns nothing", async () => {
  const manager = await createUser("sales_manager");
  userIds.push(manager.id);
  const customer = await createCustomer({ created_by: manager.id });
  const { rows } = await pool.query(
    `INSERT INTO orders (customer_id, user_id, status, total_amd, discount_pct, discount_amd, approval_status, order_code, payment_method)
     VALUES ($1, $2, 'confirmed', 1000, 0, 0, 'not_required', $3, 'cash') RETURNING id`,
    [customer.id, manager.id, `ITEST-BONUS-ND-${Date.now()}`]
  );
  trackOrder(rows[0].id);

  const result = await ingestOrderDelivery(rows[0].id);
  assert.equal(result.reason, "order_not_delivered");
  assert.equal(result.contribution, null);
});

// --- Cherry: office attendance -------------------------------------------------------
//
// office_erp_customer_id has its own unique index on customers, so every
// office-attendance test below shares one office customer fixture rather
// than each creating its own row with the same erp id. Cutoff comparisons
// use "now" plus a cutoff time set relative to the *current* Yerevan time
// (via yerevanTimeOfDay) rather than a hardcoded calendar date, so the
// bonus_earning_rule_versions rows seeded at migration time (effective_at =
// whenever the migration actually ran) are always already in force for a
// checkin timestamped "now" -- a hardcoded past-looking date can silently
// predate the seed and read back a null rule instead.
let officeCustomer;
async function getOfficeCustomer() {
  if (!officeCustomer) {
    const creator = await createUser("admin");
    officeCustomer = await createCustomer({ created_by: creator.id, erp_customer_id: "10000" });
  }
  return officeCustomer;
}

test("ingestOfficeAttendance: a GPS-verified arrival at the office before the cutoff earns a cherry", async () => {
  const manager = await createUser("sales_manager");
  userIds.push(manager.id);
  const office = await getOfficeCustomer();
  // "23:59:59" is always after the current Yerevan time of day.
  await setBonusSettings({ officeErpCustomerId: "10000", officeCutoffTime: "23:59:59", officeEarliestTime: null, officeWorkdays: null });
  const checkin = await seedCheckin({ customerId: office.id, userId: manager.id, withinRange: true, timestamp: new Date() });

  const { attendance, ledger } = await ingestOfficeAttendance(checkin.id);
  assert.equal(attendance.qualifies, true);
  assert.ok(ledger);
  assert.equal(ledger.activity, "cherry");
  assert.equal(ledger.points_delta_scaled, 6); // 1 cherry * 3 points/unit (seeded default) * scale 2
});

test("ingestOfficeAttendance: an arrival at or after the cutoff is recorded but does not qualify", async () => {
  const manager = await createUser("sales_manager");
  userIds.push(manager.id);
  const office = await getOfficeCustomer();
  // "00:00:00" is never strictly after the current Yerevan time of day, so
  // beforeCutoff is always false -- deterministic regardless of wall clock.
  await setBonusSettings({ officeErpCustomerId: "10000", officeCutoffTime: "00:00:00", officeEarliestTime: null, officeWorkdays: null });
  const checkin = await seedCheckin({ customerId: office.id, userId: manager.id, withinRange: true, timestamp: new Date() });

  const { attendance, ledger } = await ingestOfficeAttendance(checkin.id);
  assert.equal(attendance.qualifies, false);
  assert.equal(ledger, null);
});

test("ingestOfficeAttendance: a checkin at a non-office customer is not attendance at all", async () => {
  const manager = await createUser("sales_manager");
  userIds.push(manager.id);
  const customer = await createCustomer({ created_by: manager.id, erp_customer_id: "99999" });
  await setBonusSettings({ officeErpCustomerId: "10000" });
  const checkin = await seedCheckin({ customerId: customer.id, userId: manager.id, withinRange: true });

  const result = await ingestOfficeAttendance(checkin.id);
  assert.equal(result.reason, "not_office_customer");
  assert.equal(result.attendance, null);
});

test("ingestOfficeAttendance: only the first qualifying arrival per day earns a cherry", async () => {
  const manager = await createUser("sales_manager");
  userIds.push(manager.id);
  const office = await getOfficeCustomer();
  await setBonusSettings({ officeErpCustomerId: "10000", officeCutoffTime: "23:59:59", officeEarliestTime: null, officeWorkdays: null });
  const now = new Date();
  const first = await seedCheckin({ customerId: office.id, userId: manager.id, withinRange: true, timestamp: now });
  const second = await seedCheckin({ customerId: office.id, userId: manager.id, withinRange: true, timestamp: new Date(now.getTime() + 15 * 60 * 1000) });

  const firstResult = await ingestOfficeAttendance(first.id);
  assert.ok(firstResult.ledger);
  const secondResult = await ingestOfficeAttendance(second.id);
  assert.equal(secondResult.attendance.qualifies, true); // genuinely qualifying...
  // ...but the deterministic per-user/per-day operation_key means the second
  // call's ledger post lands on the *same* row as the first (postLedgerEntry
  // returns the existing row on an operation_key conflict, never null) --
  // the real invariant is "no second row," not "no ledger returned."
  assert.equal(secondResult.ledger.id, firstResult.ledger.id);
  const { rows } = await pool.query("SELECT id FROM bonus_point_ledger WHERE user_id = $1 AND activity = 'cherry'", [manager.id]);
  assert.equal(rows.length, 1);
});

// --- Reversal ------------------------------------------------------------------------

test("reverseSourceContribution: reverses the ledger entry and gives back the earning-unit capacity", async () => {
  const manager = await createUser("sales_manager");
  userIds.push(manager.id);
  const customer = await createCustomer({ created_by: manager.id });
  const checkin = await seedCheckin({ customerId: customer.id, userId: manager.id, withinRange: true });
  const { ledger: original } = await ingestVisitContribution(checkin.id);

  const { contribution, ledger: reversal, alreadyReversed } = await reverseSourceContribution("checkin", checkin.id, {
    reason: "test reversal",
  });
  assert.equal(alreadyReversed, false);
  assert.equal(contribution.status, "reversed");
  assert.equal(reversal.collectible_delta_scaled, -2);
  assert.equal(reversal.points_delta_scaled, -2);
  assert.equal(reversal.reversal_of_id, original.id);

  const { rows } = await pool.query("SELECT confirmed_scaled FROM bonus_earning_units WHERE id = $1", [contribution.earning_unit_id]);
  assert.equal(rows[0].confirmed_scaled, 0); // capacity given back -- a later visit that day could earn again

  // Reversing again is a no-op, not a second negative entry.
  const second = await reverseSourceContribution("checkin", checkin.id, { reason: "test reversal" });
  assert.equal(second.alreadyReversed, true);
});

test("reverseLedgerEntry: reversing the same ledger row twice posts only one reversal", async () => {
  const manager = await createUser("sales_manager");
  userIds.push(manager.id);
  const customer = await createCustomer({ created_by: manager.id });
  const order = await seedDeliveredOrder({ customerId: customer.id, userId: manager.id });
  const { ledger } = await ingestOrderDelivery(order.id);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const first = await reverseLedgerEntry(client, ledger.id, { reason: "test" });
    const second = await reverseLedgerEntry(client, ledger.id, { reason: "test" });
    assert.equal(first.alreadyPosted, false);
    assert.equal(second.alreadyPosted, true);
    assert.equal(first.row.id, second.row.id);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
});
