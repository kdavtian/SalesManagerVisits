// Getters/setters for the 8 bonus_* app_settings columns added by
// migrations/076_bonuses_schema.sql -- same no-caching, direct-query,
// UPSERT-on-write shape as every other app_settings column in settings.js
// (getCheckinRadiusMeters/setCheckinRadiusMeters etc.); kept in its own
// module rather than added to settings.js so the Bonuses module's settings
// surface stays easy to find as one unit while it's still being built out
// across several phases.
import { pool } from "./db/pool.js";

export async function getBonusesEnabled() {
  const { rows } = await pool.query("SELECT bonuses_enabled FROM app_settings WHERE id = 1");
  return rows[0]?.bonuses_enabled ?? false;
}

export async function setBonusesEnabled(enabled) {
  const { rows } = await pool.query(
    `INSERT INTO app_settings (id, bonuses_enabled) VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE SET bonuses_enabled = EXCLUDED.bonuses_enabled
     RETURNING bonuses_enabled`,
    [enabled]
  );
  return rows[0].bonuses_enabled;
}

// All 7 remaining bonus_* settings in one round trip -- what the ingestion
// functions in bonusSourceIngest.js need per call, and what an admin
// settings screen will read/write as one group in a later phase.
export async function getBonusSettings() {
  const { rows } = await pool.query(
    `SELECT bonus_office_erp_customer_id, bonus_office_cutoff_time, bonus_office_earliest_time,
            bonus_office_workdays, bonus_cherry_points, bonus_collection_gps_freshness_hours,
            bonus_default_grace_days
     FROM app_settings WHERE id = 1`
  );
  const row = rows[0] ?? {};
  return {
    officeErpCustomerId: row.bonus_office_erp_customer_id ?? null,
    officeCutoffTime: row.bonus_office_cutoff_time ?? "10:00:00",
    officeEarliestTime: row.bonus_office_earliest_time ?? null,
    officeWorkdays: row.bonus_office_workdays ?? null,
    cherryPoints: row.bonus_cherry_points ?? 3,
    collectionGpsFreshnessHours: row.bonus_collection_gps_freshness_hours ?? 4,
    defaultGraceDays: row.bonus_default_grace_days ?? 7,
  };
}

export async function setBonusSettings({
  officeErpCustomerId,
  officeCutoffTime,
  officeEarliestTime,
  officeWorkdays,
  cherryPoints,
  collectionGpsFreshnessHours,
  defaultGraceDays,
} = {}) {
  const current = await getBonusSettings();
  const { rows } = await pool.query(
    `INSERT INTO app_settings (
       id, bonus_office_erp_customer_id, bonus_office_cutoff_time, bonus_office_earliest_time,
       bonus_office_workdays, bonus_cherry_points, bonus_collection_gps_freshness_hours, bonus_default_grace_days
     ) VALUES (1, $1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO UPDATE SET
       bonus_office_erp_customer_id = EXCLUDED.bonus_office_erp_customer_id,
       bonus_office_cutoff_time = EXCLUDED.bonus_office_cutoff_time,
       bonus_office_earliest_time = EXCLUDED.bonus_office_earliest_time,
       bonus_office_workdays = EXCLUDED.bonus_office_workdays,
       bonus_cherry_points = EXCLUDED.bonus_cherry_points,
       bonus_collection_gps_freshness_hours = EXCLUDED.bonus_collection_gps_freshness_hours,
       bonus_default_grace_days = EXCLUDED.bonus_default_grace_days
     RETURNING bonus_office_erp_customer_id, bonus_office_cutoff_time, bonus_office_earliest_time,
               bonus_office_workdays, bonus_cherry_points, bonus_collection_gps_freshness_hours,
               bonus_default_grace_days`,
    [
      officeErpCustomerId !== undefined ? officeErpCustomerId : current.officeErpCustomerId,
      officeCutoffTime ?? current.officeCutoffTime,
      officeEarliestTime !== undefined ? officeEarliestTime : current.officeEarliestTime,
      officeWorkdays !== undefined ? officeWorkdays : current.officeWorkdays,
      cherryPoints ?? current.cherryPoints,
      collectionGpsFreshnessHours ?? current.collectionGpsFreshnessHours,
      defaultGraceDays ?? current.defaultGraceDays,
    ]
  );
  const row = rows[0];
  return {
    officeErpCustomerId: row.bonus_office_erp_customer_id,
    officeCutoffTime: row.bonus_office_cutoff_time,
    officeEarliestTime: row.bonus_office_earliest_time,
    officeWorkdays: row.bonus_office_workdays,
    cherryPoints: row.bonus_cherry_points,
    collectionGpsFreshnessHours: row.bonus_collection_gps_freshness_hours,
    defaultGraceDays: row.bonus_default_grace_days,
  };
}
