import { recordOrder } from "../orders/orderRecord.js";
import { EXCEL_MATCH_DAYS } from "../money/paymentExcelMatch.js";
import { pool } from "../db/pool.js";
// After every ERP sync: anything the workbook already shows is settled in KAD
// too (owner's rule).
//  - A confirmed / packed order that matches an ERP order (same ERP customer,
//    date within 1 day, same total) is moved to Delivered, marked "from ERP",
//    and taken out of the warehouse and delivery queues.
//  - A pending cash payment that matches an ERP payment (same ERP customer,
//    same amount, date within EXCEL_MATCH_DAYS -- the same window as the "In Excel" chip) is approved, marked "from ERP".
// Orders act only on a UNIQUE match. Payments: closest date first within 3 days, a unique pairing only at 4-5 days; never twice on the
// same ERP row, and never again on a payment a person sent back to Pending.

// Yerevan calendar date of a timestamptz.
const YEREVAN_DAY = "((%s AT TIME ZONE 'Asia/Yerevan')::date)";

export async function autoDeliverOrdersFromErp(client) {
  // ERP orders (one per order id): customer, date, total.
  const { rows } = await client.query(
    `WITH erp AS (
       SELECT erp_customer_id, order_id, MIN(order_date) AS d, ROUND(SUM(revenue_amd)) AS total
       FROM erp_order_lines
       WHERE NOT EXISTS (SELECT 1 FROM orders x WHERE x.erp_matched_order_id = erp_order_lines.order_id)
       GROUP BY erp_customer_id, order_id
     ), cand AS (
       SELECT o.id, c.erp_customer_id, ${YEREVAN_DAY.replace("%s", "o.created_at")} AS d, ROUND(o.total_amd) AS total
       FROM orders o JOIN customers c ON c.id = o.customer_id
       WHERE o.status IN ('confirmed', 'packed_stock_out') AND c.erp_customer_id IS NOT NULL
     ), pairs AS (
       SELECT cand.id AS order_id, erp.order_id AS erp_order_id, cand.d AS cand_d, erp.d AS erp_d
       FROM cand JOIN erp ON erp.erp_customer_id = cand.erp_customer_id
        AND ABS(erp.total - cand.total) <= 1
        AND erp.d BETWEEN cand.d - 1 AND cand.d + 1
     )
     SELECT p.order_id, p.erp_order_id, p.cand_d, p.erp_d
     FROM pairs p
     WHERE (SELECT COUNT(*) FROM pairs q WHERE q.order_id = p.order_id) = 1
       AND (SELECT COUNT(*) FROM pairs q WHERE q.erp_order_id = p.erp_order_id) = 1`
  );
  const delivered = [];
  for (const m of rows) {
    const { rows: before } = await client.query("SELECT status FROM orders WHERE id = $1 FOR UPDATE", [m.order_id]);
    const old = before[0]?.status;
    if (old !== "confirmed" && old !== "packed_stock_out") continue;
    // Out of the delivery queue: close any route stop the order was on.
    await client.query("UPDATE route_stops SET completed_at = now() WHERE order_id = $1 AND completed_at IS NULL", [m.order_id]);
    await client.query(
      "UPDATE orders SET status = 'delivered', delivered_from_erp = true, erp_matched_order_id = $2, updated_at = now() WHERE id = $1",
      [m.order_id, m.erp_order_id]
    );
    await client.query(
      `INSERT INTO order_status_history (order_id, old_status, new_status, reason, changed_by)
       VALUES ($1, $2, 'delivered', $3, NULL)`,
      [m.order_id, old, `From ERP (order ${m.erp_order_id} in the workbook)`]
    );
    // the Excel proves it: delivered AND recorded (owner, 2026-11-11)
    await recordOrder(client, m.order_id, { reason: `Recorded: found in the Excel (order ${m.erp_order_id})` });
    delivered.push(m.order_id);
  }
  return delivered;
}

// Owner, 2026-11-14: "if a payment is already in the Excel, approve it automatically, like the orders". Two gaps left payments pending
// with the green "In Excel" chip: (1) a payment inside a handover waiting to be confirmed was skipped, and in the same sync
// markAppRowsInExcel linked it to its Excel row -- so every later sync saw that row as used (by the payment itself) and never approved it;
// (2) this matched within 3 days, the chip within EXCEL_MATCH_DAYS. Now: the chip's window, payments in a handover too (approving does not
// move the cash: it is still in hand until a person receives it -- cashCustody.js CASH_IN_HAND_SQL, and the handover's confirm records who
// received it), and a pending payment already linked to its row is approved with that row.
// Never automatic again (review 2026-11-14): a payment a person sent back from Approved to Pending (it was matched to the wrong Excel row), so
// the sync cannot undo the reversal; and, while it is inside a handover, a payment from before the cash cut-over (approving it would take
// it out of the cash-in-hand tracking while the notes are still travelling, cashCustody.js).
const AUTO_APPROVE_OK_SQL = `p.status = 'pending'
  AND NOT EXISTS (SELECT 1 FROM payment_status_history r WHERE r.payment_id = p.id AND r.old_status = 'approved' AND r.new_status = 'pending')
  AND NOT (p.pending_handoff_id IS NOT NULL AND p.payment_date < (SELECT payments_cutover FROM app_settings WHERE id = 1))`;
const CF_KEY_SQL = "cf.erp_customer_id || '|' || cf.cashflow_date::text || '|' || ROUND(cf.amount_amd)::text";

export async function autoApprovePaymentsFromErp(client) {
  const approved = [];
  async function approve(paymentId, key) {
    const { rowCount } = await client.query(
      `UPDATE payments SET status = 'approved', approved_at = now(), approved_by = NULL, approved_from_erp = true, erp_match_key = $2,
              rejected_by = NULL, rejected_at = NULL, rejection_reason = NULL
       WHERE id = $1 AND status = 'pending'`,
      [paymentId, key]
    );
    if (!rowCount) return false;
    await client.query(
      `INSERT INTO payment_status_history (payment_id, old_status, new_status, reason, changed_by)
       VALUES ($1, 'pending', 'approved', 'From ERP (payment found in the workbook)', NULL)`,
      [paymentId]
    );
    approved.push(paymentId);
    return true;
  }

  // (a) pending payments an earlier sync already linked to an Excel row. A link whose row is gone from the workbook (edited or deleted) is
  // dropped, so (b) can match the payment again. A row still there approves at most as many payments as it has copies left (two copies
  // linked two payments, one copy deleted: only one is approved).
  await client.query(
    `UPDATE payments p SET erp_match_key = NULL
     WHERE ${AUTO_APPROVE_OK_SQL} AND p.erp_match_key IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM erp_cashflow_lines cf WHERE cf.amount_amd > 0 AND ${CF_KEY_SQL} = p.erp_match_key)`
  );
  const { rows: linked } = await client.query(
    `WITH cand AS (
       SELECT p.id, p.erp_match_key, ROW_NUMBER() OVER (PARTITION BY p.erp_match_key ORDER BY p.payment_date, p.id) AS rn
       FROM payments p WHERE ${AUTO_APPROVE_OK_SQL} AND p.erp_match_key IS NOT NULL
     )
     SELECT cand.id, cand.erp_match_key FROM cand
     WHERE cand.rn + (SELECT COUNT(*) FROM payments u WHERE u.erp_match_key = cand.erp_match_key AND u.status = 'approved')
           <= (SELECT COUNT(*) FROM erp_cashflow_lines cf WHERE cf.amount_amd > 0 AND ${CF_KEY_SQL} = cand.erp_match_key)
     ORDER BY cand.id`
  );
  for (const r of linked) await approve(r.id, r.erp_match_key);

  // (b) ERP payment rows still unused: how many rows per key, minus those already used by a payment matched to them earlier.
  const { rows } = await client.query(
    `WITH erp AS (
       SELECT erp_customer_id, cashflow_date AS d, ROUND(amount_amd) AS amount,
              erp_customer_id || '|' || cashflow_date::text || '|' || ROUND(amount_amd)::text AS key, COUNT(*)::int AS n
       FROM erp_cashflow_lines WHERE amount_amd > 0
       GROUP BY erp_customer_id, cashflow_date, ROUND(amount_amd)
     ), free AS (
       SELECT erp.*, erp.n - (SELECT COUNT(*) FROM payments u WHERE u.erp_match_key = erp.key)::int AS left_n FROM erp
     )
     SELECT p.id AS payment_id, f.key, ABS(f.d - ${YEREVAN_DAY.replace("%s", "p.payment_date")}) AS gap, f.left_n
     FROM payments p
     JOIN free f ON f.erp_customer_id = p.erp_customer_id_snapshot
      AND f.amount = ROUND(p.amount_amd)
      AND f.d BETWEEN ${YEREVAN_DAY.replace("%s", "p.payment_date")} - ${EXCEL_MATCH_DAYS} AND ${YEREVAN_DAY.replace("%s", "p.payment_date")} + ${EXCEL_MATCH_DAYS}
     WHERE ${AUTO_APPROVE_OK_SQL} AND p.erp_match_key IS NULL AND f.left_n > 0
     ORDER BY gap, p.id`
  );
  // Within 3 days: closest dates first, each ERP row (key) approves only as many payments as it has rows left (as before). 4-5 days apart
  // only when the pairing is unique -- that payment has no other Excel row and that Excel row no other payment -- so a second payment of the
  // same amount a few days later is never taken for this one.
  const perPayment = new Map();
  const perKey = new Map();
  for (const m of rows) {
    perPayment.set(m.payment_id, (perPayment.get(m.payment_id) ?? 0) + 1);
    perKey.set(m.key, (perKey.get(m.key) ?? 0) + 1);
  }
  const left = new Map();
  const done = new Set();
  for (const m of rows) {
    if (done.has(m.payment_id)) continue;
    if (m.gap > 3 && (perPayment.get(m.payment_id) > 1 || perKey.get(m.key) > 1)) continue;
    const remaining = left.has(m.key) ? left.get(m.key) : m.left_n;
    if (remaining <= 0) continue;
    if (!(await approve(m.payment_id, m.key))) continue;
    left.set(m.key, remaining - 1);
    done.add(m.payment_id);
  }
  return approved;
}

// Owner, 2026-11-14 ("not solved yet"): the approval waited for the next Excel upload, so a payment the Excel already showed could sit
// pending for a day. The same matching now also runs every few minutes from the job scheduler (jobs/index.js) against the Excel rows the
// app already has -- a payment entered after the upload is approved as soon as its row is there, and a deploy takes effect within minutes.
export async function runAutoApprovePayments(db = pool) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const approved = await autoApprovePaymentsFromErp(client);
    await client.query("COMMIT");
    return { approved: approved.length };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Which app rows Excel already holds (owner, 2026-10-27: "Excel includes only ALREADY DELIVERED orders ... if the order is included,
// included, if no - no. Same for collected payments"). The two functions above only look at orders still on their way and payments still
// pending; an order the app itself marked delivered, or a payment the accountant already approved, was never checked against Excel. This
// marks those too -- only the "found in Excel" link, never the status -- with the same unique-match rule, so the previous debt on a blank
// (signedActs.balanceBeforeVisit) adds exactly the app rows Excel does not have yet.
export async function markAppRowsInExcel(client) {
  const { rows: orders } = await client.query(
    `WITH erp AS (
       SELECT erp_customer_id, order_id, MIN(order_date) AS d, ROUND(SUM(revenue_amd)) AS total
       FROM erp_order_lines
       WHERE NOT EXISTS (SELECT 1 FROM orders x WHERE x.erp_matched_order_id = erp_order_lines.order_id)
       GROUP BY erp_customer_id, order_id
     ), cand AS (
       SELECT o.id, c.erp_customer_id, ROUND(o.total_amd) AS total, ${YEREVAN_DAY.replace("%s", "o.created_at")} AS created_d,
              ${YEREVAN_DAY.replace("%s", `COALESCE((SELECT MAX(h.changed_at) FROM order_status_history h WHERE h.order_id = o.id AND h.new_status = 'delivered' AND h.old_status IS DISTINCT FROM 'recorded'), o.updated_at)`)} AS delivered_d
       FROM orders o JOIN customers c ON c.id = o.customer_id
       WHERE o.status IN ('delivered', 'recorded') AND o.erp_matched_order_id IS NULL AND c.erp_customer_id IS NOT NULL
     ), pairs AS (
       SELECT cand.id AS order_id, erp.order_id AS erp_order_id
       FROM cand JOIN erp ON erp.erp_customer_id = cand.erp_customer_id
        AND ABS(erp.total - cand.total) <= 1
        AND erp.d BETWEEN cand.created_d - 1 AND cand.delivered_d + 14
     )
     SELECT p.order_id, p.erp_order_id FROM pairs p
     WHERE (SELECT COUNT(*) FROM pairs q WHERE q.order_id = p.order_id) = 1
       AND (SELECT COUNT(*) FROM pairs q WHERE q.erp_order_id = p.erp_order_id) = 1`
  );
  for (const m of orders) {
    const { rowCount } = await client.query("UPDATE orders SET erp_matched_order_id = $2 WHERE id = $1 AND erp_matched_order_id IS NULL", [m.order_id, m.erp_order_id]);
    // found in the Excel: a delivered order becomes Recorded by itself (one already recorded by the accountant stays as it is)
    if (rowCount) await recordOrder(client, m.order_id, { reason: `Recorded: found in the Excel (order ${m.erp_order_id})` });
  }

  const { rows: pays } = await client.query(
    `WITH erp AS (
       SELECT erp_customer_id, cashflow_date AS d, ROUND(amount_amd) AS amount,
              erp_customer_id || '|' || cashflow_date::text || '|' || ROUND(amount_amd)::text AS key, COUNT(*)::int AS n
       FROM erp_cashflow_lines WHERE amount_amd > 0
       GROUP BY erp_customer_id, cashflow_date, ROUND(amount_amd)
     ), free AS (
       SELECT erp.*, erp.n - (SELECT COUNT(*) FROM payments u WHERE u.erp_match_key = erp.key)::int AS left_n FROM erp
     )
     SELECT p.id AS payment_id, f.key, ABS(f.d - ${YEREVAN_DAY.replace("%s", "p.payment_date")}) AS gap, f.left_n
     FROM payments p
     JOIN free f ON f.erp_customer_id = p.erp_customer_id_snapshot
      AND f.amount = ROUND(p.amount_amd)
      AND f.d BETWEEN ${YEREVAN_DAY.replace("%s", "p.payment_date")} - ${EXCEL_MATCH_DAYS} AND ${YEREVAN_DAY.replace("%s", "p.payment_date")} + ${EXCEL_MATCH_DAYS}
     -- approved ones only: a pending payment is matched (and approved) by autoApprovePaymentsFromErp with its own rules (2026-11-14)
     WHERE p.status = 'approved' AND p.erp_match_key IS NULL AND f.left_n > 0
     ORDER BY gap, p.id`
  );
  const left = new Map();
  const done = new Set();
  let paymentsMarked = 0;
  for (const m of pays) {
    if (done.has(m.payment_id)) continue;
    const remaining = left.has(m.key) ? left.get(m.key) : m.left_n;
    if (remaining <= 0) continue;
    const { rowCount } = await client.query("UPDATE payments SET erp_match_key = $2 WHERE id = $1 AND erp_match_key IS NULL", [m.payment_id, m.key]);
    if (!rowCount) continue;
    left.set(m.key, remaining - 1);
    done.add(m.payment_id);
    paymentsMarked += 1;
  }
  return { orders: orders.length, payments: paymentsMarked };
}
