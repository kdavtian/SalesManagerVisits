// What the app knows about the Excel -> app sync: the last successful run (with the date of the Excel file the bot used), the last failure, and the
// admin's "Sync now" requests, which the bot (it holds the Excel file) picks up by polling. Everything here is best effort around the sync itself:
// a problem recording a run never fails the sync.
import { pool } from "./db/pool.js";
import { ERP_STALE_AFTER_HOURS } from "./erpSyncFreshness.js";

export const REQUEST_OPEN_MINUTES = 10;

function validDate(value) {
  if (value == null || value === "") return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

// meta (optional, from the bot): { workbook_modified_at, workbook_name, request_id }
export async function recordSyncRun({ counts = {}, warnings = [], meta = null }) {
  try {
    const m = meta && typeof meta === "object" && !Array.isArray(meta) ? meta : {};
    const requestId = Number.isInteger(m.request_id) ? m.request_id : null;
    await pool.query("INSERT INTO erp_sync_runs (counts, warnings, workbook_modified_at, workbook_name, request_id) VALUES ($1, $2, $3, $4, $5)", [
      JSON.stringify(counts),
      warnings,
      validDate(m.workbook_modified_at),
      typeof m.workbook_name === "string" ? m.workbook_name.slice(0, 200) : null,
      requestId,
    ]);
    await pool.query("DELETE FROM erp_sync_runs WHERE at < now() - interval '60 days'");
  } catch (err) {
    console.error("recordSyncRun failed:", err.message);
  }
}

export async function getSyncStatus() {
  const [{ rows: runs }, { rows: failures }, { rows: requests }] = await Promise.all([
    pool.query("SELECT at, counts, warnings, workbook_modified_at, workbook_name FROM erp_sync_runs ORDER BY at DESC LIMIT 1"),
    pool.query("SELECT at, endpoint, error FROM erp_sync_attempts WHERE ok = false ORDER BY at DESC LIMIT 1"),
    pool.query(
      `SELECT r.id, r.requested_at, r.picked_at, r.finished_at, r.ok, r.message, u.name AS requested_by_name
         FROM erp_sync_requests r LEFT JOIN users u ON u.id = r.requested_by ORDER BY r.id DESC LIMIT 1`
    ),
  ]);
  const last = runs[0] ?? null;
  const hours = (d) => (d ? (Date.now() - new Date(d).getTime()) / 3.6e6 : null);
  const syncAge = hours(last?.at);
  const fileAge = hours(last?.workbook_modified_at);
  const failure = failures[0] ?? null;
  const request = requests[0] ?? null;
  return {
    last_success: last,
    last_failure: failure && (!last || new Date(failure.at) > new Date(last.at)) ? failure : null,
    sync_age_hours: syncAge,
    workbook_age_hours: fileAge,
    stale_after_hours: ERP_STALE_AFTER_HOURS,
    sync_stale: syncAge == null || syncAge > ERP_STALE_AFTER_HOURS,
    workbook_stale: fileAge != null && fileAge > ERP_STALE_AFTER_HOURS,
    request: request ? { ...request, open: !request.finished_at && new Date(request.requested_at).getTime() > Date.now() - REQUEST_OPEN_MINUTES * 60000 } : null,
  };
}

// One open request at a time: a second tap while the first waits returns the same one.
export async function createSyncRequest(userId) {
  const { rows } = await pool.query(
    `SELECT id FROM erp_sync_requests WHERE finished_at IS NULL AND requested_at > now() - make_interval(mins => $1) ORDER BY id DESC LIMIT 1`,
    [REQUEST_OPEN_MINUTES]
  );
  if (rows[0]) return { id: rows[0].id, existing: true };
  const ins = await pool.query("INSERT INTO erp_sync_requests (requested_by) VALUES ($1) RETURNING id", [userId]);
  await pool.query("DELETE FROM erp_sync_requests WHERE requested_at < now() - interval '30 days'");
  return { id: ins.rows[0].id, existing: false };
}

// The bot asks: is anyone waiting for a sync? Marks the oldest open request as picked up (once).
export async function pickPendingRequest() {
  const { rows } = await pool.query(
    `UPDATE erp_sync_requests SET picked_at = now()
      WHERE id = (SELECT id FROM erp_sync_requests
                   WHERE finished_at IS NULL AND picked_at IS NULL AND requested_at > now() - make_interval(mins => $1)
                   ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING id`,
    [REQUEST_OPEN_MINUTES]
  );
  return rows[0]?.id ?? null;
}

export async function finishRequest(id, ok, message) {
  const { rowCount } = await pool.query("UPDATE erp_sync_requests SET finished_at = now(), ok = $2, message = $3 WHERE id = $1 AND finished_at IS NULL", [
    id,
    Boolean(ok),
    message ? String(message).slice(0, 500) : null,
  ]);
  return rowCount > 0;
}
