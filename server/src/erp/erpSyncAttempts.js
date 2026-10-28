// Remembers failed Excel / ERP sync calls (and successful ones that skipped an optional step) so a rejected sync is no longer silent: admin / CEO /
// operations director get a notification, and GET /api/erp-sync/attempts lists the latest ones with the real error text.
import { pool } from "../db/pool.js";
import { notifyUser } from "../shared/notifications.js";

const ALERT_ROLES = ["admin", "ceo", "operations_director"];
const alerted = new Map(); // error text -> last alert time; one alert per distinct error per 6 hours
const ALERT_EVERY_MS = 6 * 3600 * 1000;

// Best effort: never throws, never delays the sync's own answer by more than the insert.
export async function recordSyncAttempt({ endpoint, ok, error = null, warnings = [] }) {
  try {
    if (ok && !warnings.length) return;
    await pool.query("INSERT INTO erp_sync_attempts (endpoint, ok, error, warnings) VALUES ($1, $2, $3, $4)", [endpoint, ok, error ? String(error).slice(0, 2000) : null, warnings]);
    await pool.query("DELETE FROM erp_sync_attempts WHERE at < now() - interval '30 days'");
    const text = error ?? warnings.join(" | ");
    const last = alerted.get(text) ?? 0;
    if (Date.now() - last < ALERT_EVERY_MS) return;
    alerted.set(text, Date.now());
    const { rows } = await pool.query("SELECT id FROM users WHERE role = ANY($1)", [ALERT_ROLES]);
    const body = ok ? `• Excel-ի տվյալները թարմացվել են, բայց մի քայլ բաց է թողնվել՝ ${text}` : `• Excel-ի համաժամացումը մերժվեց (${endpoint})՝ ${text}\n• Տվյալները չեն թարմացվել։`;
    for (const u of rows) await notifyUser(u.id, "erp_sync_stale", { title: ok ? "Excel համաժամացում՝ նախազգուշացում" : "Excel համաժամացումը ձախողվեց", body, url: "/#/reports" });
  } catch (err) {
    console.error("recordSyncAttempt failed:", err.message);
  }
}

export async function latestSyncAttempts(limit = 30) {
  const { rows } = await pool.query("SELECT id, endpoint, ok, error, warnings, at FROM erp_sync_attempts ORDER BY at DESC LIMIT $1", [limit]);
  return rows;
}
