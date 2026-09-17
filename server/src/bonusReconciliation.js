// Periodic reconciliation sweep for the Bonuses module -- same setInterval-
// in-the-one-process pattern as dailySummary.js/erpSyncMonitor.js (see
// those files' own header comments; no separate job runner for a
// single-instance deployment). This is the safety net behind whatever
// direct route-level hooks a later phase adds: every ingest*() function in
// bonusSourceIngest.js is idempotent, so re-sweeping a window that's mostly
// already processed is always a cheap no-op, never a duplicate award --
// which is what makes it safe to also be the *only* path (no route hooks
// wired yet in this phase) without risking double-crediting once route
// hooks are added later.
//
// Every query below is scoped to "rows in the lookback window that this
// module hasn't recorded a decision for yet" so a steady-state sweep only
// touches genuinely new activity, not the whole table.
import { pool } from "./db/pool.js";
import { getBonusesEnabled } from "./bonusSettings.js";
import { ingestVisitContribution, ingestCollectionContribution, ingestOrderDelivery, ingestOfficeAttendance } from "./bonusSourceIngest.js";

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // hourly

// Generous overlap with the sweep interval so a checkin/payment that syncs
// late from an offline device, or a payment approved well after it was
// created, is never missed by a boundary that only looked at "since the
// last sweep."
const DEFAULT_LOOKBACK_HOURS = 48;

export async function runReconciliationSweep({ lookbackHours = DEFAULT_LOOKBACK_HOURS } = {}) {
  if (!(await getBonusesEnabled())) return { checkinsVisits: 0, checkinsAttendance: 0, payments: 0, orders: 0 };

  const since = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);

  const { rows: visitCheckins } = await pool.query(
    `SELECT c.id FROM checkins c
     LEFT JOIN bonus_source_contributions sc ON sc.source_table = 'checkin' AND sc.source_id = c.id
     WHERE c.created_at >= $1 AND sc.id IS NULL`,
    [since]
  );
  for (const { id } of visitCheckins) await ingestVisitContribution(id);

  // Scoped to checkins at the configured office customer specifically --
  // ingestOfficeAttendance() never writes a bonus_attendance_records row
  // for a checkin at any other customer (there's no "arrival attempt" to
  // log), so an unscoped version of this query would find the exact same
  // non-office checkins "still unprocessed" on every sweep, forever.
  const { rows: attendanceCheckins } = await pool.query(
    `SELECT c.id FROM checkins c
     JOIN customers cu ON cu.id = c.customer_id
     LEFT JOIN bonus_attendance_records ar ON ar.checkin_id = c.id
     WHERE c.created_at >= $1 AND ar.id IS NULL
       AND cu.erp_customer_id = (SELECT bonus_office_erp_customer_id FROM app_settings WHERE id = 1)`,
    [since]
  );
  for (const { id } of attendanceCheckins) await ingestOfficeAttendance(id);

  const { rows: payments } = await pool.query(
    `SELECT p.id FROM payments p
     LEFT JOIN bonus_source_contributions sc ON sc.source_table = 'payment' AND sc.source_id = p.id
     WHERE p.status = 'approved' AND p.approved_at >= $1 AND sc.id IS NULL`,
    [since]
  );
  for (const { id } of payments) await ingestCollectionContribution(id);

  const { rows: orders } = await pool.query(
    `SELECT DISTINCT o.id FROM orders o
     JOIN order_status_history h ON h.order_id = o.id AND h.new_status = 'delivered'
     LEFT JOIN bonus_source_contributions sc ON sc.source_table = 'order' AND sc.source_id = o.id
     WHERE h.changed_at >= $1 AND sc.id IS NULL`,
    [since]
  );
  for (const { id } of orders) await ingestOrderDelivery(id);

  return {
    checkinsVisits: visitCheckins.length,
    checkinsAttendance: attendanceCheckins.length,
    payments: payments.length,
    orders: orders.length,
  };
}

let started = false;
export function startBonusReconciliation() {
  if (started) return;
  started = true;
  setInterval(() => {
    runReconciliationSweep().catch((err) => console.error("Bonus reconciliation sweep failed:", err.message));
  }, CHECK_INTERVAL_MS);
}
