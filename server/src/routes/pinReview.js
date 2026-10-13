import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { canReassignCustomers } from "../roles.js";
import { buildPinReview } from "../pinReview.js";

export const pinReviewRouter = Router();
pinReviewRouter.use(requireAuth);
pinReviewRouter.use((req, res, next) => {
  if (!canReassignCustomers(req.user.role)) return res.status(403).json({ error: "Not allowed" });
  next();
});

pinReviewRouter.get("/", async (req, res) => {
  res.json(await buildPinReview());
});

// Move the pin to the suggested spot (recomputed now, never trusted from the client). The move is logged as
// an approved edit request, like any other pin correction.
pinReviewRouter.post("/:customerId/accept", async (req, res) => {
  const customerId = Number(req.params.customerId);
  if (!Number.isInteger(customerId)) return res.status(400).json({ error: "Invalid customer id" });
  const [suggestion] = await buildPinReview(customerId);
  if (!suggestion) return res.status(409).json({ error: "This pin is no longer flagged" });
  const client = await pool.connect();
  let releaseErr;
  try {
    await client.query("BEGIN");
    await client.query("UPDATE customers SET lat = $1, lng = $2 WHERE id = $3", [suggestion.suggested_lat, suggestion.suggested_lng, customerId]);
    await client.query(
      `INSERT INTO customer_edit_requests (customer_id, requested_by, changes, note, status, reviewed_by, reviewed_at)
       VALUES ($1, $2, $3, $4, 'approved', $2, now())`,
      [
        customerId,
        req.user.id,
        JSON.stringify({ lat: suggestion.suggested_lat, lng: suggestion.suggested_lng }),
        `Pin review: moved to the spot of ${suggestion.points} check-ins (${suggestion.shift_m} m)`,
      ]
    );
    await client.query("COMMIT");
  } catch (err) {
    releaseErr = err;
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release(releaseErr);
  }
  res.json({ ok: true, lat: suggestion.suggested_lat, lng: suggestion.suggested_lng });
});

// "This pin is fine": older evidence is ignored from now on; a new cluster of far check-ins can flag it again.
pinReviewRouter.post("/:customerId/dismiss", async (req, res) => {
  const customerId = Number(req.params.customerId);
  if (!Number.isInteger(customerId)) return res.status(400).json({ error: "Invalid customer id" });
  const { rowCount } = await pool.query("SELECT 1 FROM customers WHERE id = $1", [customerId]);
  if (!rowCount) return res.status(404).json({ error: "Customer not found" });
  await pool.query(
    `INSERT INTO pin_review_dismissals (customer_id, dismissed_by) VALUES ($1, $2)
     ON CONFLICT (customer_id) DO UPDATE SET dismissed_by = EXCLUDED.dismissed_by, dismissed_at = now()`,
    [customerId, req.user.id]
  );
  res.json({ ok: true });
});
