import { pool } from "./db/pool.js";

// How long an ERP sync can go stale before it's treated as broken rather
// than just "not brand new". Set above the "up to a few days between syncs
// is fine, the Excel extract still beats app data" tolerance the business
// actually runs on (see the debt-reconciliation comment in
// routes/reports.js) -- this is a "the pipeline looks broken" flag, not a
// "the number is old" one. Shared by the Reports API (to badge a report)
// and erpSyncMonitor.js (to alert admin/CEO) so the two never disagree on
// what "stale" means.
export const ERP_STALE_AFTER_HOURS = 72;

export async function erpSyncFreshness(table) {
  const { rows } = await pool.query(`SELECT MAX(synced_at) AS synced_at FROM ${table}`);
  const syncedAt = rows[0]?.synced_at ?? null;
  const hoursSinceSync = syncedAt ? (Date.now() - new Date(syncedAt).getTime()) / 3.6e6 : null;
  return {
    synced_at: syncedAt,
    stale: hoursSinceSync == null || hoursSinceSync > ERP_STALE_AFTER_HOURS,
    stale_after_hours: ERP_STALE_AFTER_HOURS,
  };
}
