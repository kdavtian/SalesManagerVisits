// Payments Collection & Approval workflow. See migrations/046_payments.sql
// for the business definition: a Sales Manager submits an immutable record
// of money received; an Accountant (or CEO/admin) reviews it against the
// accounting books they maintain separately and APPROVEs (confirms
// receipt/reconciliation) or REJECTs it with a reason. APPROVED is the
// only status that represents confirmed, reconciled collection -- reports
// and Team Performance must never treat PENDING as collected.
import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { canReviewPayments, canSubmitPaymentsForOthers, seesAllPayments, PAYMENT_NOTIFY_ROLES } from "../roles.js";
import { notifyUser } from "../notifications.js";

export const paymentsRouter = Router();
paymentsRouter.use(requireAuth);

const PAGE_SIZE = 30;
const MAX_AMOUNT = 100000000000; // matches the DB CHECK constraint

// The Add Payment form's manager picker (for roles that can submit on
// someone else's behalf) needs the list of sales managers, but GET
// /api/users is admin-only -- a Director/Accountant/CEO submitting for
// another manager still isn't an admin, so this is scoped narrowly to
// exactly the fields the picker needs, gated by the same permission as
// submitting itself.
paymentsRouter.get("/eligible-managers", async (req, res) => {
  if (!canSubmitPaymentsForOthers(req.user.role)) return res.status(403).json({ error: "Not allowed" });
  const { rows } = await pool.query(
    "SELECT id, name, position FROM users WHERE role = 'sales_manager' ORDER BY name"
  );
  res.json(rows);
});

async function loadPaymentRow(id) {
  const { rows } = await pool.query(
    `SELECT p.*, sm.name AS current_sales_manager_name, cb.name AS created_by_name,
            ab.name AS approved_by_name, rb.name AS rejected_by_name,
            COALESCE(c.name, p.customer_name_snapshot) AS customer_name_snapshot
     FROM payments p
     JOIN users sm ON sm.id = p.sales_manager_id
     JOIN users cb ON cb.id = p.created_by
     LEFT JOIN users ab ON ab.id = p.approved_by
     LEFT JOIN users rb ON rb.id = p.rejected_by
     LEFT JOIN customers c ON c.id = p.customer_id
     WHERE p.id = $1`,
    [id]
  );
  return rows[0];
}

function canSeePayment(user, payment) {
  if (seesAllPayments(user.role)) return true;
  return payment.sales_manager_id === user.id;
}

// Amount/customer/manager/day duplicate check -- a same-shape submission
// within a short window is flagged, not blocked (see task spec: "warn, do
// not automatically reject"). The client re-submits with confirm_duplicate
// to push it through anyway.
async function findLikelyDuplicate({ customerId, amount, salesManagerId, paymentDate }) {
  const { rows } = await pool.query(
    `SELECT id, amount_amd, payment_date, status
     FROM payments
     WHERE customer_id = $1
       AND sales_manager_id = $2
       AND amount_amd = $3
       AND status != 'rejected'
       AND payment_date BETWEEN $4::timestamptz - interval '20 hours' AND $4::timestamptz + interval '20 hours'
     ORDER BY created_at DESC
     LIMIT 1`,
    [customerId, salesManagerId, amount, paymentDate]
  );
  return rows[0] ?? null;
}

// Shared by the manual "Add Payment" submission below and by the checkin
// flow's "payment collected" outcome (see routes/checkins.js) -- both end
// up as an ordinary pending payment an accountant reviews the same way,
// so there's exactly one insert+history+notify path regardless of source.
// client_ref is what makes this idempotent: checkins.js passes a
// deterministic `checkin-<id>` ref, so a retried/duplicate checkin submit
// can never create a second payment for the same collection.
// `db` defaults to the shared pool but accepts a checked-out transaction
// client instead -- callers that need this insert plus a follow-up write
// (e.g. delivery.js's create-payment-from-pod, which also updates
// pod_records.payment_id) can pass their own BEGIN/COMMIT client so the two
// writes commit or roll back together.
// current_holder_id starts as salesManagerId (the $6 reused in the INSERT
// below): whoever the money came from/through is the first custodian in the
// cash chain (migrations/059), including a director who logged a collection
// themselves. Everything after that is moved only by routes/cashHandoffs.js.
export async function insertPayment({ customer, amount, paymentDate, salesManagerId, manager, note, createdBy, clientRef, db = pool }) {
  const salesChannel = manager.role === "sales_manager" ? manager.position || null : null;

  // NOTE: payments has no order_id column -- migrations/050 added one, then
  // 051 (v3 rebuild) explicitly dropped it (delivery-time collection is
  // informational-only on pod_records, never linked into this approval
  // table via a payments.order_id column -- see 051's section 9 and
  // migrations/056, which links the other direction instead: pod_records.
  // payment_id -> payments.id). This INSERT used to still reference the
  // dropped column and 500'd on every call; fixed here.
  const { rows } = await db.query(
    `INSERT INTO payments
       (customer_id, customer_name_snapshot, erp_customer_id_snapshot, amount_amd, payment_date,
        sales_manager_id, sales_manager_name_snapshot, sales_channel, note, status, created_by, client_ref,
        current_holder_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10, $11, $6)
     ON CONFLICT (created_by, client_ref) WHERE client_ref IS NOT NULL DO NOTHING
     RETURNING id`,
    [
      customer.id,
      customer.name,
      customer.erp_customer_id || null,
      amount,
      paymentDate,
      salesManagerId,
      manager.name,
      salesChannel,
      note || null,
      createdBy,
      clientRef || null,
    ]
  );

  let paymentId = rows[0]?.id;
  if (!paymentId) {
    // ON CONFLICT DO NOTHING means this exact client_ref already exists
    // (an idempotent retry) -- return the existing payment's id, no new
    // history row or notification.
    const existing = await db.query("SELECT id FROM payments WHERE created_by = $1 AND client_ref = $2", [createdBy, clientRef]);
    return existing.rows[0]?.id ?? null;
  }

  await db.query(
    `INSERT INTO payment_status_history (payment_id, old_status, new_status, reason, changed_by)
     VALUES ($1, NULL, 'pending', 'Submitted', $2)`,
    [paymentId, createdBy]
  );

  (async () => {
    try {
      const { rows: recipients } = await pool.query("SELECT id FROM users WHERE role = ANY($1)", [PAYMENT_NOTIFY_ROLES]);
      for (const recipient of recipients) {
        notifyUser(recipient.id, "payment_submitted", {
          title: "New payment",
          body: `${customer.name}${customer.erp_customer_id ? ` · ID ${customer.erp_customer_id}` : ""}\n${Number(amount).toLocaleString()} AMD\n${manager.name}${salesChannel ? ` · ${salesChannel}` : ""}`,
          url: `/#/payments/${paymentId}`,
        });
      }
    } catch (err) {
      console.error("Payment notification failed:", err);
    }
  })();

  return paymentId;
}

paymentsRouter.post("/", async (req, res) => {
  const { customer_id, amount_amd, payment_date, note, sales_manager_id, client_ref, confirm_duplicate } = req.body ?? {};

  const amount = Number(amount_amd);
  if (!customer_id || !Number.isFinite(amount) || amount <= 0 || amount >= MAX_AMOUNT) {
    return res.status(400).json({ error: "A valid customer and a positive amount are required" });
  }
  const paymentDateObj = payment_date ? new Date(payment_date) : new Date();
  if (Number.isNaN(paymentDateObj.getTime())) {
    return res.status(400).json({ error: "Invalid payment date" });
  }

  let salesManagerId = req.user.id;
  if (req.user.role === "sales_manager") {
    // Never allow impersonating another manager, even if the client sends one.
    salesManagerId = req.user.id;
  } else if (sales_manager_id) {
    if (!canSubmitPaymentsForOthers(req.user.role)) {
      return res.status(403).json({ error: "Not allowed to submit a payment for another sales manager" });
    }
    salesManagerId = Number(sales_manager_id);
  } else if (!canSubmitPaymentsForOthers(req.user.role)) {
    return res.status(403).json({ error: "Not allowed to submit payments" });
  }

  const { rows: managerRows } = await pool.query("SELECT id, name, position, role FROM users WHERE id = $1", [salesManagerId]);
  const manager = managerRows[0];
  if (!manager) return res.status(400).json({ error: "Sales manager not found" });

  const { rows: customerRows } = await pool.query(
    "SELECT id, name, erp_customer_id FROM customers WHERE id = $1",
    [customer_id]
  );
  const customer = customerRows[0];
  if (!customer) return res.status(400).json({ error: "Customer not found" });

  if (client_ref) {
    const { rows: existing } = await pool.query(
      "SELECT id FROM payments WHERE created_by = $1 AND client_ref = $2",
      [req.user.id, client_ref]
    );
    if (existing[0]) {
      // Same client retried (e.g. after a flaky connection) -- return the
      // already-created payment instead of creating a second one.
      return res.status(201).json(await loadPaymentRow(existing[0].id));
    }
  }

  if (!confirm_duplicate) {
    const duplicate = await findLikelyDuplicate({
      customerId: customer.id,
      amount,
      salesManagerId,
      paymentDate: paymentDateObj.toISOString(),
    });
    if (duplicate) {
      return res.status(409).json({
        error: "duplicate_warning",
        message: "Possible duplicate payment",
        similar_payment: duplicate,
      });
    }
  }

  const paymentId = await insertPayment({
    customer,
    amount,
    paymentDate: paymentDateObj.toISOString(),
    salesManagerId,
    manager,
    note,
    createdBy: req.user.id,
    clientRef: client_ref,
  });

  const payment = await loadPaymentRow(paymentId);
  res.status(201).json(payment);
});

paymentsRouter.get("/pending-count", async (req, res) => {
  if (seesAllPayments(req.user.role)) {
    const { rows } = await pool.query("SELECT count(*)::int AS count FROM payments WHERE status = 'pending'");
    return res.json({ count: rows[0].count });
  }
  const { rows } = await pool.query(
    "SELECT count(*)::int AS count FROM payments WHERE status = 'pending' AND sales_manager_id = $1",
    [req.user.id]
  );
  res.json({ count: rows[0].count });
});

paymentsRouter.get("/", async (req, res) => {
  const { status, sales_channel, sales_manager_id, customer_id, month, from, to, q, sort, offset } = req.query;

  const conditions = [];
  const params = [];

  if (!seesAllPayments(req.user.role)) {
    params.push(req.user.id);
    conditions.push(`p.sales_manager_id = $${params.length}`);
  } else if (sales_manager_id) {
    params.push(sales_manager_id);
    conditions.push(`p.sales_manager_id = $${params.length}`);
  }

  if (status) {
    params.push(status);
    conditions.push(`p.status = $${params.length}`);
  }
  if (sales_channel) {
    params.push(sales_channel);
    conditions.push(`p.sales_channel = $${params.length}`);
  }
  if (customer_id) {
    params.push(customer_id);
    conditions.push(`p.customer_id = $${params.length}`);
  }
  if (month && /^\d{4}-\d{2}$/.test(month)) {
    params.push(`${month}-01`);
    conditions.push(`date_trunc('month', p.payment_date) = $${params.length}::date`);
  }
  if (from) {
    params.push(from);
    conditions.push(`p.payment_date >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    // Not "<=" -- payment_date is a timestamptz, and $N is a bare date
    // (e.g. "2026-09-12"), so "<=" casts to that day's midnight and
    // excludes every payment from later the same day -- i.e. the "Today"
    // quick filter (from=to=today) matched nothing made after 00:00. Same
    // exclusive-upper-bound pattern already used for date ranges in
    // checkins.js/exports.js.
    conditions.push(`p.payment_date < ($${params.length}::date + interval '1 day')`);
  }
  if (q) {
    params.push(`%${q}%`);
    const qi = params.length;
    params.push(String(q));
    const qi2 = params.length;
    conditions.push(
      `(p.customer_name_snapshot ILIKE $${qi} OR p.erp_customer_id_snapshot ILIKE $${qi} OR p.sales_manager_name_snapshot ILIKE $${qi} OR p.note ILIKE $${qi} OR p.id::text = $${qi2})`
    );
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  // Default: Sales Channel then newest-first within each channel (per spec).
  // A manager only ever sees their own single channel, so channel grouping
  // is a no-op for them -- date-only sort reads identically either way.
  const orderBy = sort === "date" ? "p.payment_date DESC" : "p.sales_channel NULLS LAST, p.payment_date DESC";
  const offsetNum = Math.max(0, Number(offset) || 0);

  params.push(PAGE_SIZE + 1, offsetNum);
  const { rows } = await pool.query(
    `SELECT p.*, COALESCE(c.name, p.customer_name_snapshot) AS customer_name_snapshot
     FROM payments p
     LEFT JOIN customers c ON c.id = p.customer_id
     ${where}
     ORDER BY ${orderBy}
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  res.json({ rows: rows.slice(0, PAGE_SIZE), has_more: rows.length > PAGE_SIZE });
});

paymentsRouter.get("/:id", async (req, res) => {
  const payment = await loadPaymentRow(req.params.id);
  if (!payment) return res.status(404).json({ error: "Payment not found" });
  if (!canSeePayment(req.user, payment)) return res.status(403).json({ error: "Not allowed to view this payment" });

  const { rows: history } = await pool.query(
    `SELECT h.*, u.name AS changed_by_name
     FROM payment_status_history h
     LEFT JOIN users u ON u.id = h.changed_by
     WHERE h.payment_id = $1
     ORDER BY h.changed_at ASC`,
    [req.params.id]
  );
  res.json({ ...payment, history });
});

// --- Reconciling the old single-stage review with the cash custody chain ---
// Before migrations/059 these three endpoints were the ONLY way a payment
// changed status, and any accountant/CEO/admin could approve any pending
// payment. Now the terminal accountant confirmation in
// routes/cashHandoffs.js also flips payments to 'approved'. Two independent
// paths to the same transition is exactly how money gets double-processed,
// so they are reconciled here rather than left side by side:
//
//   1. A payment that is inside an in-flight handoff is frozen for
//      EVERYONE, admin included -- the receiver's confirm/reject is the
//      decision in flight, and approving underneath it would strand the
//      handoff pointing at already-approved cash.
//   2. Approving directly requires the cash to have actually reached an
//      accountant's custody, i.e. the chain already ran. In practice the
//      handoff confirmation does this for you, so this endpoint becomes a
//      correction tool (e.g. re-approving after a return-to-pending)
//      rather than a parallel workflow.
//   3. admin keeps a manual override on rule 2 only. That follows this
//      codebase's standing convention (see roles.js: "admin is treated as
//      a CEO-equivalent superset throughout ... so a technical admin
//      account can always unblock a stuck workflow") -- if cash is
//      physically reconciled but the chain was never recorded in the app,
//      someone has to be able to close it out.
async function custodyBlocksReview(payment, user) {
  if (payment.pending_handoff_id) {
    return "This payment is part of a cash handoff awaiting confirmation -- resolve that handoff first";
  }
  if (user.role === "admin") return null;
  if (!payment.current_holder_id) return "This payment has no recorded cash holder";
  const { rows } = await pool.query("SELECT role FROM users WHERE id = $1", [payment.current_holder_id]);
  if (rows[0]?.role !== "accountant") {
    return "This payment's cash has not reached an accountant yet -- confirm it through the cash handoff chain first";
  }
  return null;
}

paymentsRouter.post("/:id/approve", async (req, res) => {
  if (!canReviewPayments(req.user.role)) return res.status(403).json({ error: "Not allowed to approve payments" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // FOR UPDATE closes the race with a concurrent approve/reject/
    // return-to-pending on the same row: the loser blocks here, then finds
    // status already changed by the winner and bails out cleanly instead of
    // overwriting it (see the approve+reject race that corrupted payment
    // status and duplicated payment_status_history rows).
    const { rows } = await client.query("SELECT * FROM payments WHERE id = $1 FOR UPDATE", [req.params.id]);
    const payment = rows[0];
    if (!payment) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Payment not found" });
    }
    if (payment.status !== "pending") {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Only a pending payment can be approved" });
    }
    const blocked = await custodyBlocksReview(payment, req.user);
    if (blocked) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: blocked });
    }

    await client.query(
      `UPDATE payments SET status = 'approved', approved_by = $1, approved_at = now(),
              rejected_by = NULL, rejected_at = NULL, rejection_reason = NULL
       WHERE id = $2`,
      [req.user.id, req.params.id]
    );
    await client.query(
      `INSERT INTO payment_status_history (payment_id, old_status, new_status, reason, changed_by)
       VALUES ($1, 'pending', 'approved', 'Approved', $2)`,
      [req.params.id, req.user.id]
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  res.json(await loadPaymentRow(req.params.id));
});

paymentsRouter.post("/:id/reject", async (req, res) => {
  if (!canReviewPayments(req.user.role)) return res.status(403).json({ error: "Not allowed to reject payments" });
  const { reason } = req.body ?? {};
  if (!reason || !reason.trim()) return res.status(400).json({ error: "A rejection reason is required" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query("SELECT * FROM payments WHERE id = $1 FOR UPDATE", [req.params.id]);
    const payment = rows[0];
    if (!payment) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Payment not found" });
    }
    if (payment.status !== "pending") {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Only a pending payment can be rejected" });
    }
    // Only the in-flight freeze applies here, not the "must have reached an
    // accountant" rule: rejecting a payment means "this collection record is
    // wrong", which a reviewer may need to do while the cash is still
    // travelling. Rejecting also takes it out of the chain -- it stops being
    // available to hand off, since only 'pending' rows are.
    if (payment.pending_handoff_id) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "This payment is part of a cash handoff awaiting confirmation -- resolve that handoff first" });
    }

    await client.query(
      `UPDATE payments SET status = 'rejected', rejected_by = $1, rejected_at = now(), rejection_reason = $2
       WHERE id = $3`,
      [req.user.id, reason.trim(), req.params.id]
    );
    await client.query(
      `INSERT INTO payment_status_history (payment_id, old_status, new_status, reason, changed_by)
       VALUES ($1, 'pending', 'rejected', $2, $3)`,
      [req.params.id, reason.trim(), req.user.id]
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  res.json(await loadPaymentRow(req.params.id));
});

// Reversal is deliberately not reachable from the list row -- see task
// spec item 26/41: an already-resolved payment can only be reopened from
// its own detail view, with a mandatory reason, so it's never a one-tap
// accident.
paymentsRouter.post("/:id/return-to-pending", async (req, res) => {
  if (!canReviewPayments(req.user.role)) return res.status(403).json({ error: "Not allowed to reverse payment status" });
  const { reason } = req.body ?? {};
  if (!reason || !reason.trim()) return res.status(400).json({ error: "A reason is required" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query("SELECT * FROM payments WHERE id = $1 FOR UPDATE", [req.params.id]);
    const payment = rows[0];
    if (!payment) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Payment not found" });
    }
    if (payment.status === "pending") {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Payment is already pending" });
    }
    // Custody is deliberately left alone -- whoever physically holds the cash
    // still holds it; only the reconciliation status is reopened. If the
    // holder is the accountant, re-approving afterwards passes the gate above.

    const oldStatus = payment.status;
    await client.query(
      `UPDATE payments SET status = 'pending', approved_by = NULL, approved_at = NULL,
              rejected_by = NULL, rejected_at = NULL, rejection_reason = NULL
       WHERE id = $1`,
      [req.params.id]
    );
    await client.query(
      `INSERT INTO payment_status_history (payment_id, old_status, new_status, reason, changed_by)
       VALUES ($1, $2, 'pending', $3, $4)`,
      [req.params.id, oldStatus, reason.trim(), req.user.id]
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  res.json(await loadPaymentRow(req.params.id));
});
