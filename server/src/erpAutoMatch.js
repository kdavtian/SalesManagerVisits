// After every ERP sync: anything the workbook already shows is settled in KAD
// too (owner's rule).
//  - A confirmed / packed order that matches an ERP order (same ERP customer,
//    date within 1 day, same total) is moved to Delivered, marked "from ERP",
//    and taken out of the warehouse and delivery queues.
//  - A pending cash payment that matches an ERP payment (same ERP customer,
//    same amount, date within 3 days) is approved, marked "from ERP".
// Both only act on a UNIQUE match, never on a guess, and never twice on the
// same ERP row.

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
    delivered.push(m.order_id);
  }
  return delivered;
}

export async function autoApprovePaymentsFromErp(client) {
  // ERP payment rows still unused: how many rows per key, minus those already
  // used by a payment that was approved from them earlier.
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
      AND f.d BETWEEN ${YEREVAN_DAY.replace("%s", "p.payment_date")} - 3 AND ${YEREVAN_DAY.replace("%s", "p.payment_date")} + 3
     WHERE p.status = 'pending' AND p.pending_handoff_id IS NULL AND f.left_n > 0
     ORDER BY gap, p.id`
  );
  // Closest dates first; each ERP row (key) can approve only as many payments as it has rows left.
  const left = new Map();
  const done = new Set();
  const approved = [];
  for (const m of rows) {
    if (done.has(m.payment_id)) continue;
    const remaining = left.has(m.key) ? left.get(m.key) : m.left_n;
    if (remaining <= 0) continue;
    const { rowCount } = await client.query(
      `UPDATE payments SET status = 'approved', approved_at = now(), approved_by = NULL, approved_from_erp = true, erp_match_key = $2,
              rejected_by = NULL, rejected_at = NULL, rejection_reason = NULL
       WHERE id = $1 AND status = 'pending' AND pending_handoff_id IS NULL`,
      [m.payment_id, m.key]
    );
    if (!rowCount) continue;
    await client.query(
      `INSERT INTO payment_status_history (payment_id, old_status, new_status, reason, changed_by)
       VALUES ($1, 'pending', 'approved', 'From ERP (payment found in the workbook)', NULL)`,
      [m.payment_id]
    );
    left.set(m.key, remaining - 1);
    done.add(m.payment_id);
    approved.push(m.payment_id);
  }
  return approved;
}
