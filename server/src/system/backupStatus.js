// "Last good backup" for Settings > System health. deploy/backup.sh writes one backup_runs row per run (migration 231);
// a backup older than BACKUP_STALE_AFTER_HOURS -- nightly cron plus a half-day of slack -- is shown red.
import { pool } from "../db/pool.js";

export const BACKUP_STALE_AFTER_HOURS = 36;

// Pure rule, kept apart from the query so it is testable: stale when there is no good backup, or the newest is too old.
export function isBackupStale(lastOkAt, now = new Date()) {
  if (!lastOkAt) return true;
  return now.getTime() - new Date(lastOkAt).getTime() > BACKUP_STALE_AFTER_HOURS * 3600 * 1000;
}

export async function backupStatus(now = new Date()) {
  const { rows } = await pool.query(
    `SELECT (SELECT row_to_json(r) FROM (SELECT finished_at, db_bytes, uploads_bytes, offsite, detail
                                           FROM backup_runs WHERE ok ORDER BY finished_at DESC LIMIT 1) r) AS last_ok,
            (SELECT row_to_json(r) FROM (SELECT finished_at, detail
                                           FROM backup_runs WHERE NOT ok ORDER BY finished_at DESC LIMIT 1) r) AS last_failed`
  );
  const lastOk = rows[0].last_ok;
  // only a failure newer than the last good run matters to the reader
  const failed = rows[0].last_failed && (!lastOk || new Date(rows[0].last_failed.finished_at) > new Date(lastOk.finished_at)) ? rows[0].last_failed : null;
  return {
    stale_after_hours: BACKUP_STALE_AFTER_HOURS,
    last_ok_at: lastOk?.finished_at ?? null,
    offsite: lastOk?.offsite ?? null,
    db_bytes: lastOk?.db_bytes ?? null,
    uploads_bytes: lastOk?.uploads_bytes ?? null,
    warning: lastOk?.detail ?? null,
    last_failed_at: failed?.finished_at ?? null,
    last_failed_step: failed?.detail ?? null,
    stale: isBackupStale(lastOk?.finished_at, now),
  };
}
