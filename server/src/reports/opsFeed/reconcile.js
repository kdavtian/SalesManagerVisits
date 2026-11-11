// GET /api/ops/v1/reconcile: what the app knows differs from the Excel, for the daily Reconciler agent (owner, 2026-11-07: "message
// only when something differs"). Every rule is the one the app's own screens already use, imported from where it lives, so the agent
// can never disagree with the app:
//   cash_payments   app payments (old module) still not in the Excel cashflow after the anti-fraud grace days (paymentExcelMatch.js)
//   bank_payments   bank / card payments (Bank & cash desks) whose books are still open (the board's "not in Excel", liveDebt.js)
//   orders          app deliveries the sync has not found in the Excel order lines (erp_matched_order_id empty: appStock.js / liveDebt.js)
//   returns         goods returned to the warehouse that the Excel does not have yet (order_returns.recorded_at empty: appStock.js)
//   field_expenses  field cash expenses with no Excel expense row after 5 days (expenseWatch.js)
//   erp_sync        last successful sync and workbook age (erpSyncStatus.js), failed attempts since then (last 24 h)
// PRIVACY (owner, 2026-11-07): customers appear only as their ERP customer ID; no names, phones, TINs, addresses, notes, staff or error text.
import { pool } from "../../db/pool.js";
import { IN_EXCEL_SQL, DAYS_OLD_SQL } from "../../money/paymentExcelMatch.js";
import { APP_EXPENSE_IN_EXCEL_SQL, APP_EXPENSE_DAYS_OLD_SQL, MATCH_DAYS as EXPENSE_MATCH_DAYS, EXPENSE_LOOKBACK_DAYS } from "../../money/expenseWatch.js";
import { getFraudSettings, NOT_IN_EXCEL_LOOKBACK_DAYS } from "../../money/antiFraud.js";
import { getCutover } from "../../money/payments2/service.js";
import { UNRECORDED_DAYS } from "../../money/liveDebt.js";
import { getSyncStatus } from "../../erp/erpSyncStatus.js";

export const RECONCILE_GRACE_DAYS = 3; // an app row younger than this is not called missing yet (the accountant's normal lag)
export const MAX_ITEMS = 50;
// How far back each module looks: the window of the screen whose rule it uses (cash payments and field expenses: the anti-fraud /
// expense watch 120 days; bank payments: the live debt's 60 days, from the payments cut-over). Deliveries and returns use the live
// debt's 60 days too: an unmatched delivery older than that (a customer with no ERP id, a total typed differently) is a known data gap
// on Data quality, not a new difference to message about every morning.
const LIVE_WINDOW_DAYS = UNRECORDED_DAYS;
const YEREVAN_DAY = (col) => `((${col} AT TIME ZONE 'Asia/Yerevan')::date)`;
const TODAY = "((now() AT TIME ZONE 'Asia/Yerevan')::date)";
const amd = (v) => Math.round(Number(v) || 0);

// every module query returns rows of { customer_erp_id, amount_amd, age_days }, oldest first
function moduleOf(kind, rows) {
  return {
    count: rows.length,
    amount_amd: rows.reduce((s, r) => s + amd(r.amount_amd), 0),
    oldest_age_days: rows.length ? Math.max(...rows.map((r) => Number(r.age_days))) : null,
    items: rows.slice(0, MAX_ITEMS).map((r) => ({ customer_erp_id: r.customer_erp_id ?? null, kind, amount_amd: amd(r.amount_amd), age_days: Number(r.age_days) })),
    truncated: rows.length > MAX_ITEMS,
  };
}

export async function reconcile(db = pool) {
  const [fraud, cutover] = await Promise.all([getFraudSettings(db), getCutover(db)]);
  // the anti-fraud "not in Excel after N days" setting (default 3), so the agent and the Fraud alerts page call the same rows missing
  const graceDays = Number(fraud.unmatchedDays) || RECONCILE_GRACE_DAYS;
  const [cash, bank, orders, returns, expenses, sync, failed] = await Promise.all([
    db.query(
      `SELECT p.erp_customer_id_snapshot AS customer_erp_id, p.amount_amd, ${DAYS_OLD_SQL}::int AS age_days
         FROM payments p
        WHERE p.status IN ('pending', 'approved') AND p.erp_customer_id_snapshot IS NOT NULL
          AND ${DAYS_OLD_SQL} >= $1 AND p.payment_date > now() - make_interval(days => ${NOT_IN_EXCEL_LOOKBACK_DAYS}) AND NOT ${IN_EXCEL_SQL}
        ORDER BY age_days DESC, p.id`,
      [graceDays]
    ),
    db.query(
      `SELECT c.erp_customer_id AS customer_erp_id, cp.amount_amd, (${TODAY} - cp.pay_day)::int AS age_days
         FROM customer_payments cp JOIN customers c ON c.id = cp.customer_id
        WHERE cp.legacy_payment_id IS NULL AND cp.voided_at IS NULL AND cp.method IN ('bank', 'card') AND cp.books_state = 'open'
          AND cp.pay_day >= GREATEST($1::date, ${TODAY} - ${LIVE_WINDOW_DAYS}) AND cp.pay_day <= ${TODAY} - $2::int
        ORDER BY age_days DESC, cp.id`,
      [cutover, graceDays]
    ),
    db.query(
      `WITH d AS (
         SELECT o.id, o.customer_id, o.total_amd,
                ${YEREVAN_DAY("COALESCE((SELECT max(h.changed_at) FROM order_status_history h WHERE h.order_id = o.id AND h.new_status = 'delivered' AND h.old_status IS DISTINCT FROM 'recorded'), o.updated_at)")} AS delivered_day
           FROM orders o
          WHERE o.status IN ('delivered', 'recorded') AND o.cancelled_at IS NULL AND o.erp_matched_order_id IS NULL AND NOT o.delivered_from_erp
            AND o.updated_at > now() - make_interval(days => ${LIVE_WINDOW_DAYS + 30}))
       SELECT c.erp_customer_id AS customer_erp_id, d.total_amd AS amount_amd, (${TODAY} - d.delivered_day)::int AS age_days
         FROM d JOIN customers c ON c.id = d.customer_id
        WHERE d.delivered_day <= ${TODAY} - $1::int AND d.delivered_day > ${TODAY} - ${LIVE_WINDOW_DAYS}
        ORDER BY age_days DESC, d.id`,
      [graceDays]
    ),
    db.query(
      `SELECT c.erp_customer_id AS customer_erp_id, r.credit_amd AS amount_amd, (${TODAY} - ${YEREVAN_DAY("COALESCE(r.received_at, r.decided_at, r.requested_at)")})::int AS age_days
         FROM order_returns r JOIN customers c ON c.id = r.customer_id
        WHERE r.kind = 'return' AND r.status = 'done' AND r.recorded_at IS NULL
          AND COALESCE(r.received_at, r.decided_at, r.requested_at) <= now() - make_interval(days => $1::int)
          AND COALESCE(r.received_at, r.decided_at, r.requested_at) > now() - make_interval(days => ${LIVE_WINDOW_DAYS})
        ORDER BY age_days DESC, r.id`,
      [graceDays]
    ),
    db.query(
      `SELECT NULL AS customer_erp_id, ce.amount_amd, ${APP_EXPENSE_DAYS_OLD_SQL}::int AS age_days
         FROM cash_expenses ce
        WHERE ${APP_EXPENSE_DAYS_OLD_SQL} >= ${EXPENSE_MATCH_DAYS} AND ce.created_at > now() - make_interval(days => ${EXPENSE_LOOKBACK_DAYS}) AND NOT ${APP_EXPENSE_IN_EXCEL_SQL}
        ORDER BY age_days DESC, ce.id`
    ),
    getSyncStatus(),
    // failures of the last 24 h that no later successful sync has fixed (a 03:00 failure retried fine at 03:30 is not a difference)
    db.query(
      `SELECT count(*)::int AS n, COALESCE(array_agg(DISTINCT endpoint) FILTER (WHERE endpoint IS NOT NULL), '{}') AS endpoints
         FROM erp_sync_attempts
        WHERE ok = false AND at > now() - interval '24 hours' AND at > COALESCE((SELECT max(at) FROM erp_sync_runs), '-infinity')`
    ),
  ]);
  const modules = {
    cash_payments: moduleOf("cash_payment_not_in_excel", cash.rows),
    bank_payments: moduleOf("bank_payment_not_in_excel", bank.rows),
    orders: moduleOf("order_not_in_excel", orders.rows),
    returns: moduleOf("return_not_in_excel", returns.rows),
    field_expenses: moduleOf("field_expense_not_in_excel", expenses.rows),
  };
  // the same status the Settings > Excel sync card shows (erp/erpSyncStatus.js): sync and workbook file age
  const round1 = (h) => (h == null ? null : Math.round(h * 10) / 10);
  const lastOk = sync.last_success?.at ?? null;
  const erpSync = {
    last_success_at: lastOk ? new Date(lastOk).toISOString() : null,
    hours_since_success: round1(sync.sync_age_hours),
    workbook_age_hours: round1(sync.workbook_age_hours),
    stale: sync.sync_stale,
    workbook_stale: sync.workbook_stale,
    stale_after_hours: sync.stale_after_hours,
    failed_attempts_24h: failed.rows[0].n,
    failed_endpoints_24h: failed.rows[0].endpoints,
  };
  const ok = Object.values(modules).every((m) => m.count === 0) && erpSync.failed_attempts_24h === 0 && !erpSync.stale && !erpSync.workbook_stale;
  return { ok, generated_at: new Date().toISOString(), grace_days: graceDays, modules, erp_sync: erpSync };
}
