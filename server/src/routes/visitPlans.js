import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";

export const visitPlansRouter = Router();

visitPlansRouter.use(requireAuth);

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

function isValidDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

// The authenticated rep's own plan for a date (defaults to today) -- used
// to drive the map's "Planned" filter and to prefill the plan-day sheet.
visitPlansRouter.get("/mine", async (req, res) => {
  const date = isValidDate(req.query.date) ? req.query.date : todayDate();
  const { rows } = await pool.query(
    "SELECT * FROM visit_plans WHERE user_id = $1 AND plan_date = $2",
    [req.user.id, date]
  );
  res.json(rows[0] ?? null);
});

// Create or replace the caller's plan for a date. Admin-authored plans are
// auto-approved; anyone else's plan (re-)submission goes back to pending,
// since the content changed and needs review again.
visitPlansRouter.post("/", async (req, res) => {
  const date = isValidDate(req.body?.date) ? req.body.date : todayDate();
  const customerIds = Array.isArray(req.body?.customer_ids)
    ? [...new Set(req.body.customer_ids.map(Number).filter(Number.isInteger))]
    : [];

  const isAdmin = req.user.role === "admin";
  const status = isAdmin ? "approved" : "pending";
  const reviewedBy = isAdmin ? req.user.id : null;
  const reviewedAt = isAdmin ? new Date() : null;

  const { rows } = await pool.query(
    `INSERT INTO visit_plans (user_id, plan_date, customer_ids, status, created_by, reviewed_by, reviewed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (user_id, plan_date) DO UPDATE
       SET customer_ids = EXCLUDED.customer_ids,
           status = EXCLUDED.status,
           reviewed_by = EXCLUDED.reviewed_by,
           reviewed_at = EXCLUDED.reviewed_at,
           updated_at = now()
     RETURNING *`,
    [req.user.id, date, customerIds, status, req.user.id, reviewedBy, reviewedAt]
  );
  res.status(201).json(rows[0]);
});

// Review queue -- admin only.
visitPlansRouter.get("/pending", requireAdmin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT vp.*, u.name AS user_name
     FROM visit_plans vp
     JOIN users u ON u.id = vp.user_id
     WHERE vp.status = 'pending'
     ORDER BY vp.plan_date ASC, vp.created_at ASC`
  );
  if (!rows.length) return res.json([]);

  const allCustomerIds = [...new Set(rows.flatMap((r) => r.customer_ids))];
  const { rows: customers } = allCustomerIds.length
    ? await pool.query("SELECT id, name FROM customers WHERE id = ANY($1)", [allCustomerIds])
    : { rows: [] };
  const nameById = new Map(customers.map((c) => [c.id, c.name]));

  res.json(
    rows.map((r) => ({
      ...r,
      customer_names: r.customer_ids.map((id) => nameById.get(id)).filter(Boolean),
    }))
  );
});

// Approve/reject a pending plan, or (admin only) directly edit and
// auto-approve an existing one -- "admin can change it later".
visitPlansRouter.patch("/:id", requireAdmin, async (req, res) => {
  const { action, customer_ids } = req.body ?? {};
  if (action === undefined && customer_ids === undefined) {
    return res.status(400).json({ error: "action or customer_ids is required" });
  }

  const client = await pool.connect();
  let releaseErr;
  try {
    await client.query("BEGIN");

    const { rows } = await client.query("SELECT * FROM visit_plans WHERE id = $1 FOR UPDATE", [
      req.params.id,
    ]);
    const plan = rows[0];
    if (!plan) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Plan not found" });
    }

    if (action !== undefined) {
      if (!["approve", "reject"].includes(action)) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "action must be 'approve' or 'reject'" });
      }
      if (plan.status !== "pending") {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "This plan was already reviewed" });
      }
    }

    const nextCustomerIds = Array.isArray(customer_ids)
      ? [...new Set(customer_ids.map(Number).filter(Number.isInteger))]
      : plan.customer_ids;
    const nextStatus = action === "reject" ? "rejected" : "approved";

    const { rows: updated } = await client.query(
      `UPDATE visit_plans
       SET customer_ids = $1, status = $2, reviewed_by = $3, reviewed_at = now(), updated_at = now()
       WHERE id = $4
       RETURNING *`,
      [nextCustomerIds, nextStatus, req.user.id, req.params.id]
    );

    await client.query("COMMIT");
    res.json(updated[0]);
  } catch (err) {
    releaseErr = err;
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release(releaseErr);
  }
});
