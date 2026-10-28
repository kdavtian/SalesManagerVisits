// Per-customer ordering rhythm (migration 110): how many days a customer usually leaves between orders.
// Rebuilt inside every ERP sync (erpSync.js) right after the order lines are replaced; read by the customer
// list / map facts (reorder chip) and by customerReorder.js (reorder profile).
import { pool } from "../db/pool.js";

// The customer counts as due for a reorder once the days since the last order reach the usual gap, and as
// late once they pass 1.5x the gap and a week more (the same limit that creates the automatic follow-up task).
export function reorderState(daysSince, gapDays) {
  if (!(gapDays >= 7 && gapDays <= 90) || daysSince == null || daysSince > 365) return null;
  if (daysSince > Math.max(gapDays * 1.5, gapDays + 7)) return "late";
  if (daysSince >= gapDays) return "due";
  return null;
}

export async function refreshOrderRhythm(db = pool) {
  await db.query("DELETE FROM customer_order_rhythm");
  await db.query(
    `WITH days AS (
       SELECT erp_customer_id, order_date FROM erp_order_lines
       WHERE order_date >= (now() AT TIME ZONE 'Asia/Yerevan')::date - 400 AND erp_customer_id <> '10000' AND COALESCE(revenue_amd, 0) > 0
       GROUP BY erp_customer_id, order_date
     ), gaps AS (
       SELECT erp_customer_id, order_date, order_date - LAG(order_date) OVER (PARTITION BY erp_customer_id ORDER BY order_date) AS gap FROM days
     )
     INSERT INTO customer_order_rhythm (erp_customer_id, last_order_date, order_days, median_gap_days)
     SELECT erp_customer_id, MAX(order_date), COUNT(*)::int,
            CASE WHEN COUNT(gap) >= 3 THEN ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY gap))::int END
     FROM gaps GROUP BY erp_customer_id`
  );
}

// SQL expressions for a query that joins `customer_order_rhythm rr ON rr.erp_customer_id = c.erp_customer_id`
// (alias c = customers): days since the last order (an app order newer than the synced history counts too)
// and the usual gap. NULL when there is no usable rhythm.
export const REORDER_DAYS_SINCE_SQL = `(CASE WHEN rr.median_gap_days IS NOT NULL THEN
    (now() AT TIME ZONE 'Asia/Yerevan')::date - GREATEST(rr.last_order_date,
      COALESCE((SELECT max((o.created_at AT TIME ZONE 'Asia/Yerevan')::date) FROM orders o WHERE o.customer_id = c.id AND o.status <> 'draft'), rr.last_order_date))
  END)`;
export const REORDER_COLUMNS = `rr.median_gap_days AS reorder_gap_days, ${REORDER_DAYS_SINCE_SQL} AS reorder_days_since`;
export const REORDER_JOIN = "LEFT JOIN customer_order_rhythm rr ON rr.erp_customer_id = c.erp_customer_id";

// Adds `reorder_state` ("due" | "late" | null) to rows selected with REORDER_COLUMNS and drops nothing.
export function withReorderState(row) {
  const days = row.reorder_days_since == null ? null : Number(row.reorder_days_since);
  const gap = row.reorder_gap_days == null ? null : Number(row.reorder_gap_days);
  row.reorder_state = row.checkin_for_all ? null : reorderState(days, gap);
  return row;
}
