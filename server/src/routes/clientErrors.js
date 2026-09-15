import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";

export const clientErrorsRouter = Router();

clientErrorsRouter.use(requireAuth);

const KINDS = new Set(["error", "unhandledrejection", "slow_load"]);
// Generous but bounded -- a stack trace or a long URL shouldn't be able to
// bloat this table row by row.
const MAX_TEXT_LEN = 4000;

function clip(value) {
  if (typeof value !== "string") return null;
  return value.slice(0, MAX_TEXT_LEN);
}

// Fire-and-forget from the client (see client/public/js/errorMonitoring.js)
// -- best-effort telemetry, not something a broken page should ever block
// on, so this only ever needs to accept and store, never round-trip data
// back.
clientErrorsRouter.post("/", async (req, res) => {
  const { kind, message, stack, url, duration_ms, user_agent } = req.body || {};
  if (!KINDS.has(kind) || !message) return res.status(400).json({ error: "Invalid client error report" });

  await pool.query(
    `INSERT INTO client_error_log (user_id, kind, message, stack, url, duration_ms, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [req.user.id, kind, clip(message), clip(stack), clip(url), Number.isFinite(duration_ms) ? Math.round(duration_ms) : null, clip(user_agent)]
  );
  res.status(204).end();
});

clientErrorsRouter.get("/", requireAdmin, async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
  const { rows } = await pool.query(
    `SELECT cel.id, cel.user_id, u.name AS user_name, cel.kind, cel.message, cel.stack, cel.url,
            cel.duration_ms, cel.user_agent, cel.created_at
     FROM client_error_log cel
     LEFT JOIN users u ON u.id = cel.user_id
     ORDER BY cel.created_at DESC
     LIMIT $1`,
    [limit]
  );
  res.json(rows);
});
