import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";

export const notificationsRouter = Router();

notificationsRouter.use(requireAuth);

function isValidId(value) {
  return /^\d+$/.test(String(value ?? ""));
}

// Newest first, paginated with a plain offset -- this is a personal inbox
// capped at a few hundred rows per user in practice, not a table this app
// needs keyset pagination for.
notificationsRouter.get("/", async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const { rows } = await pool.query(
    `SELECT id, type, title, body, url, read_at, created_at
     FROM notifications WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [req.user.id, limit, offset]
  );
  res.json(rows);
});

// Polled by the top-bar bell badge -- kept separate from the list so
// checking it doesn't require pulling notification bodies over the wire.
notificationsRouter.get("/unread-count", async (req, res) => {
  const { rows } = await pool.query(
    "SELECT count(*)::int AS count FROM notifications WHERE user_id = $1 AND read_at IS NULL",
    [req.user.id]
  );
  res.json({ count: rows[0].count });
});

notificationsRouter.patch("/:id/read", async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: "Invalid notification id" });
  const { rows } = await pool.query(
    "UPDATE notifications SET read_at = now() WHERE id = $1 AND user_id = $2 AND read_at IS NULL RETURNING id",
    [req.params.id, req.user.id]
  );
  if (!rows.length) {
    const { rows: exists } = await pool.query("SELECT id FROM notifications WHERE id = $1 AND user_id = $2", [
      req.params.id,
      req.user.id,
    ]);
    if (!exists.length) return res.status(404).json({ error: "Notification not found" });
  }
  res.status(204).end();
});

notificationsRouter.patch("/read-all", async (req, res) => {
  await pool.query("UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL", [req.user.id]);
  res.status(204).end();
});
