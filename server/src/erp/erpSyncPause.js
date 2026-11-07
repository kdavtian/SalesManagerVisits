// The Excel sync pause (owner, 2026-11-07): an admin switch in Settings > Integrations. While it is on, POST /api/erp-sync and
// /api/erp-sync/cashflow-ledger answer 423 "Excel sync is paused" and change nothing; the bot keeps its file and the next sync after the
// switch is turned off carries the whole workbook again, so nothing is lost. A refused sync is not counted as a failed one (no alarm).
import { pool } from "../db/pool.js";

export async function getSyncPause(db = pool) {
  const { rows } = await db.query(
    `SELECT s.erp_sync_paused AS paused, s.erp_sync_paused_at AS paused_at, u.name AS paused_by_name
       FROM app_settings s LEFT JOIN users u ON u.id = s.erp_sync_paused_by WHERE s.id = 1`
  );
  return { paused: rows[0]?.paused === true, paused_at: rows[0]?.paused_at ?? null, paused_by_name: rows[0]?.paused_by_name ?? null };
}

export async function setSyncPause(paused, userId, db = pool) {
  await db.query(
    `INSERT INTO app_settings (id, erp_sync_paused, erp_sync_paused_at, erp_sync_paused_by) VALUES (1, $1, CASE WHEN $1 THEN now() END, CASE WHEN $1 THEN $2::int END)
     ON CONFLICT (id) DO UPDATE SET erp_sync_paused = EXCLUDED.erp_sync_paused, erp_sync_paused_at = EXCLUDED.erp_sync_paused_at, erp_sync_paused_by = EXCLUDED.erp_sync_paused_by`,
    [paused, userId ?? null]
  );
  return getSyncPause(db);
}

// Express middleware for the routes that write Excel data into the app.
export async function refuseWhilePaused(_req, res, next) {
  try {
    const { paused } = await getSyncPause();
    if (paused) return res.status(423).json({ error: "Excel sync is paused in the app (Settings > Integrations)", code: "sync_paused" });
  } catch (err) {
    return next(err);
  }
  next();
}
