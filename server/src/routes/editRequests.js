import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { EDITABLE_FIELDS } from "./customers.js";

export const editRequestsRouter = Router();

editRequestsRouter.use(requireAuth);

editRequestsRouter.post("/", async (req, res) => {
  const { customer_id, changes, note } = req.body ?? {};
  const customerId = Number(customer_id);

  if (!customerId || !changes || typeof changes !== "object" || Array.isArray(changes)) {
    return res.status(400).json({ error: "customer_id and changes are required" });
  }

  const filtered = {};
  for (const field of EDITABLE_FIELDS) {
    if (changes[field] !== undefined) filtered[field] = changes[field];
  }
  if (!Object.keys(filtered).length) {
    return res.status(400).json({ error: "No editable fields in changes" });
  }

  const { rows: customerRows } = await pool.query("SELECT id FROM customers WHERE id = $1", [
    customerId,
  ]);
  if (!customerRows[0]) return res.status(404).json({ error: "Customer not found" });

  const { rows } = await pool.query(
    `INSERT INTO customer_edit_requests (customer_id, requested_by, changes, note)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [customerId, req.user.id, JSON.stringify(filtered), note ?? null]
  );
  res.status(201).json(rows[0]);
});

editRequestsRouter.get("/", async (req, res) => {
  const { customer_id } = req.query;
  let { status } = req.query;

  // Non-admins can only look up requests for a specific customer (to show
  // a "pending edit" banner), and only the pending one — past approved/
  // rejected requests can reveal another user's proposed changes, so the
  // full review queue and history are admin-only.
  if (req.user.role !== "admin") {
    if (!customer_id) {
      return res.status(403).json({ error: "customer_id is required" });
    }
    status = "pending";
  }

  const conditions = [];
  const params = [];
  if (customer_id) {
    params.push(customer_id);
    conditions.push(`er.customer_id = $${params.length}`);
  }
  if (status) {
    params.push(status);
    conditions.push(`er.status = $${params.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const { rows } = await pool.query(
    `SELECT er.*, u.name AS requested_by_name, c.name AS customer_name
     FROM customer_edit_requests er
     JOIN users u ON u.id = er.requested_by
     JOIN customers c ON c.id = er.customer_id
     ${where}
     ORDER BY er.created_at DESC`,
    params
  );
  res.json(rows);
});

editRequestsRouter.patch("/:id", requireAdmin, async (req, res) => {
  const { action, note } = req.body ?? {};
  if (!["approve", "reject"].includes(action)) {
    return res.status(400).json({ error: "action must be 'approve' or 'reject'" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Lock the row inside the transaction so two concurrent approvals (or
    // a double-tapped button) can't both read status='pending' and both
    // apply — the loser blocks on the lock, then sees the now-reviewed row.
    const { rows } = await client.query(
      "SELECT * FROM customer_edit_requests WHERE id = $1 FOR UPDATE",
      [req.params.id]
    );
    const request = rows[0];
    if (!request) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Edit request not found" });
    }
    if (request.status !== "pending") {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "This request was already reviewed" });
    }

    if (action === "approve") {
      const updates = [];
      const params = [];
      for (const [field, value] of Object.entries(request.changes)) {
        if (!EDITABLE_FIELDS.includes(field)) continue;
        params.push(value);
        updates.push(`${field} = $${params.length}`);
      }
      if (updates.length) {
        params.push(request.customer_id);
        await client.query(
          `UPDATE customers SET ${updates.join(", ")} WHERE id = $${params.length}`,
          params
        );
      }
    }

    const { rows: updated } = await client.query(
      `UPDATE customer_edit_requests
       SET status = $1, reviewed_by = $2, reviewed_at = now(), note = COALESCE($3, note)
       WHERE id = $4
       RETURNING *`,
      [action === "approve" ? "approved" : "rejected", req.user.id, note ?? null, req.params.id]
    );

    await client.query("COMMIT");
    res.json(updated[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
});
