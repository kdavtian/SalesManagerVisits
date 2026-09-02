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
            ab.name AS approved_by_name, rb.name AS rejected_by_name
     FROM payments p
     JOIN users sm ON sm.id = p.sales_manager_id
     JOIN users cb ON cb.id = p.created_by
     LEFT JOIN users ab ON ab.id = p.approved_by
     LEFT JOIN users rb ON rb.id = p.rejected_by
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

  const salesChannel = manager.role === "sales_manager" ? manager.position || null : null;

  const { rows } = await pool.query(
    `INSERT INTO payments
       (customer_id, customer_name_snapshot, erp_customer_id_snapshot, amount_amd, payment_date,
        sales_manager_id, sales_manager_name_snapshot, sales_channel, note, status, created_by, client_ref)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10, $11)
     RETURNING id`,
    [
      customer.id,
      customer.name,
      customer.erp_customer_id || null,
      amount,
      paymentDateObj.toISOString(),
      salesManagerId,
      manager.name,
      salesChannel,
      note || null,
      req.user.id,
      client_ref || null,
    ]
  );
  const paymentId = rows[0].id;

  await pool.query(
    `INSERT INTO payment_status_history (payment_id, old_status, new_status, reason, changed_by)
     VALUES ($1, NULL, 'pending', 'Submitted', $2)`,
    [paymentId, req.user.id]
  );

  const payment = await loadPaymentRow(paymentId);
  res.status(201).json(payment);

  (async () => {
    try {
      const { rows: recipients } = await pool.query("SELECT id FROM users WHERE role = ANY($1)", [PAYMENT_NOTIFY_ROLES]);
      for (const recipient of recipients) {
        notifyUser(recipient.id, "payment_submitted", {
          title: "Նոր վճարում",
          body: `${customer.name}${customer.erp_customer_id ? ` · ID ${customer.erp_customer_id}` : ""}\n${Number(amount).toLocaleString()} AMD\n${manager.name}${salesChannel ? ` · ${salesChannel}` : ""}`,
          url: `/#/payments/${paymentId}`,
        });
      }
    } catch (err) {
      console.error("Payment notification failed:", err);
    }
  })();
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
    conditions.push(`p.payment_date <= $${params.length}`);
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
    `SELECT p.*
     FROM payments p
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

paymentsRouter.post("/:id/approve", async (req, res) => {
  if (!canReviewPayments(req.user.role)) return res.status(403).json({ error: "Not allowed to approve payments" });
  const payment = await loadPaymentRow(req.params.id);
  if (!payment) return res.status(404).json({ error: "Payment not found" });
  if (payment.status !== "pending") {
    return res.status(409).json({ error: "Only a pending payment can be approved" });
  }

  await pool.query(
    `UPDATE payments SET status = 'approved', approved_by = $1, approved_at = now(),
            rejected_by = NULL, rejected_at = NULL, rejection_reason = NULL
     WHERE id = $2`,
    [req.user.id, req.params.id]
  );
  await pool.query(
    `INSERT INTO payment_status_history (payment_id, old_status, new_status, reason, changed_by)
     VALUES ($1, 'pending', 'approved', 'Approved', $2)`,
    [req.params.id, req.user.id]
  );
  res.json(await loadPaymentRow(req.params.id));
});

paymentsRouter.post("/:id/reject", async (req, res) => {
  if (!canReviewPayments(req.user.role)) return res.status(403).json({ error: "Not allowed to reject payments" });
  const { reason } = req.body ?? {};
  if (!reason || !reason.trim()) return res.status(400).json({ error: "A rejection reason is required" });

  const payment = await loadPaymentRow(req.params.id);
  if (!payment) return res.status(404).json({ error: "Payment not found" });
  if (payment.status !== "pending") {
    return res.status(409).json({ error: "Only a pending payment can be rejected" });
  }

  await pool.query(
    `UPDATE payments SET status = 'rejected', rejected_by = $1, rejected_at = now(), rejection_reason = $2
     WHERE id = $3`,
    [req.user.id, reason.trim(), req.params.id]
  );
  await pool.query(
    `INSERT INTO payment_status_history (payment_id, old_status, new_status, reason, changed_by)
     VALUES ($1, 'pending', 'rejected', $2, $3)`,
    [req.params.id, reason.trim(), req.user.id]
  );
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

  const payment = await loadPaymentRow(req.params.id);
  if (!payment) return res.status(404).json({ error: "Payment not found" });
  if (payment.status === "pending") {
    return res.status(409).json({ error: "Payment is already pending" });
  }

  const oldStatus = payment.status;
  await pool.query(
    `UPDATE payments SET status = 'pending', approved_by = NULL, approved_at = NULL,
            rejected_by = NULL, rejected_at = NULL, rejection_reason = NULL
     WHERE id = $1`,
    [req.params.id]
  );
  await pool.query(
    `INSERT INTO payment_status_history (payment_id, old_status, new_status, reason, changed_by)
     VALUES ($1, $2, 'pending', $3, $4)`,
    [req.params.id, oldStatus, reason.trim(), req.user.id]
  );
  res.json(await loadPaymentRow(req.params.id));
});
