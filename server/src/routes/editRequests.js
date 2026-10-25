import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { EDITABLE_FIELDS, isWithinArmenia } from "./customers.js";
import { haversineMeters } from "../utils/geo.js";
import { normalizePhoneForStorage } from "../phoneFormat.js";
import { normalizeIncomingPlaces, recordPlaceReviews } from "../placeReviews.js";

export const editRequestsRouter = Router();

editRequestsRouter.use(requireAuth);

// Same staleness problem as a direct PATCH /customers/:id (see the comment there): another still-pending
// request for this same customer might propose one of the fields just applied, with a now-outdated value
// snapshotted at its own submission time. Left alone, approving *that* one later would silently revert this
// change right back. Strip the stale fields from it, or auto-reject it if that empties it out.
async function supersedePending(client, customerId, exceptRequestId, changedFields, reviewerId) {
  const { rows: otherPending } = await client.query(
    "SELECT id, changes FROM customer_edit_requests WHERE customer_id = $1 AND status = 'pending' AND id != $2 FOR UPDATE",
    [customerId, exceptRequestId]
  );
  for (const pr of otherPending) {
    const remaining = { ...pr.changes };
    let stale = false;
    for (const field of changedFields) {
      if (remaining[field] !== undefined) {
        delete remaining[field];
        stale = true;
      }
    }
    if (!stale) continue;
    if (Object.keys(remaining).length) {
      await client.query("UPDATE customer_edit_requests SET changes = $1 WHERE id = $2", [JSON.stringify(remaining), pr.id]);
    } else {
      await client.query(
        `UPDATE customer_edit_requests
         SET status = 'rejected', reviewed_by = $1, reviewed_at = now(),
             note = COALESCE(note || ' — ', '') || 'Auto-rejected: superseded by another approved request'
         WHERE id = $2`,
        [reviewerId, pr.id]
      );
    }
  }
}

// Pin corrections (lat + lng only) are applied at once -- nobody should have to wait for approval to fix
// a wrong pin, and with the check-in allowance a wrong pin blocks a rep from checking in. A sales manager
// may correct the pin of their OWN customers (assigned to them or created by them); management roles any
// customer. Everything else (and a rep's request for someone else's customer) still waits for review.
const PIN_AUTO_APPROVE_MANAGEMENT = new Set(["ceo", "operations_director", "sales_director"]);
function canAutoApprovePin(user, customer, filtered) {
  const keys = Object.keys(filtered);
  if (keys.length !== 2 || filtered.lat === undefined || filtered.lng === undefined) return false;
  if (typeof filtered.lat !== "number" || typeof filtered.lng !== "number" || !isWithinArmenia(filtered.lat, filtered.lng)) return false;
  if (customer.checkin_for_all) return false; // the office pin is not a rep's to move
  if (PIN_AUTO_APPROVE_MANAGEMENT.has(user.role)) return true;
  return user.role === "sales_manager" && (customer.assigned_manager_id === user.id || customer.created_by === user.id);
}

editRequestsRouter.post("/", async (req, res) => {
  const { customer_id, changes, note } = req.body ?? {};
  const customerId = Number(customer_id);

  if (!customerId || !changes || typeof changes !== "object" || Array.isArray(changes)) {
    return res.status(400).json({ error: "customer_id and changes are required" });
  }

  const filtered = {};
  for (const field of EDITABLE_FIELDS) {
    if (changes[field] !== undefined) filtered[field] = field === "phone" ? normalizePhoneForStorage(changes[field]) : changes[field];
  }
  if (!Object.keys(filtered).length) {
    return res.status(400).json({ error: "No editable fields in changes" });
  }

  const { rows: customerRows } = await pool.query(
    "SELECT id, lat, lng, created_by, assigned_manager_id, checkin_for_all FROM customers WHERE id = $1",
    [customerId]
  );
  if (!customerRows[0]) return res.status(404).json({ error: "Customer not found" });

  if (canAutoApprovePin(req.user, customerRows[0], filtered)) {
    const client = await pool.connect();
    let releaseErr;
    try {
      await client.query("BEGIN");
      await client.query("UPDATE customers SET lat = $1, lng = $2 WHERE id = $3", [filtered.lat, filtered.lng, customerId]);
      const moved = Math.round(haversineMeters(customerRows[0].lat, customerRows[0].lng, filtered.lat, filtered.lng));
      const { rows } = await client.query(
        `INSERT INTO customer_edit_requests (customer_id, requested_by, changes, note, status, reviewed_at)
         VALUES ($1, $2, $3, $4, 'approved', now())
         RETURNING *`,
        [customerId, req.user.id, JSON.stringify(filtered), `${note ? `${note} — ` : ""}Auto-approved pin correction (moved ${moved} m)`]
      );
      await supersedePending(client, customerId, rows[0].id, ["lat", "lng"], req.user.id);
      await client.query("COMMIT");
      return res.status(201).json(rows[0]);
    } catch (err) {
      releaseErr = err;
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release(releaseErr);
    }
  }

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
  let releaseErr;
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
      const changedFields = [];
      // a proposed region / subregion is matched against the Armenian places like a direct edit (places.js)
      const { rows: currentPlaces } = await client.query("SELECT region, subregion FROM customers WHERE id = $1", [request.customer_id]);
      const placeOutcome = normalizeIncomingPlaces({ region: request.changes.region, subregion: request.changes.subregion }, currentPlaces[0] ?? {});
      for (const [field, value] of Object.entries(request.changes)) {
        if (!EDITABLE_FIELDS.includes(field)) continue;
        const next = field in placeOutcome.values ? placeOutcome.values[field] : value;
        params.push(field === "phone" ? normalizePhoneForStorage(next) : next);
        updates.push(`${field} = $${params.length}`);
        changedFields.push(field);
      }
      if (updates.length) {
        params.push(request.customer_id);
        await client.query(
          `UPDATE customers SET ${updates.join(", ")} WHERE id = $${params.length}`,
          params
        );

        await recordPlaceReviews(client, request.customer_id, req.user.id, placeOutcome);
        await supersedePending(client, request.customer_id, request.id, changedFields, req.user.id);
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
    releaseErr = err;
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release(releaseErr);
  }
});
