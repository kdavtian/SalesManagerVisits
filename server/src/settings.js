import { pool } from "./db/pool.js";

const ENV_DEFAULT_RADIUS = Number(process.env.CHECKIN_RADIUS_METERS) || 200;

export async function getCheckinRadiusMeters() {
  const { rows } = await pool.query("SELECT checkin_radius_meters FROM app_settings WHERE id = 1");
  return rows[0]?.checkin_radius_meters ?? ENV_DEFAULT_RADIUS;
}

export async function setCheckinRadiusMeters(meters) {
  const { rows } = await pool.query(
    `INSERT INTO app_settings (id, checkin_radius_meters) VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE SET checkin_radius_meters = EXCLUDED.checkin_radius_meters
     RETURNING checkin_radius_meters`,
    [meters]
  );
  return rows[0].checkin_radius_meters;
}

export async function getDefaultVisitFrequencyDays() {
  const { rows } = await pool.query("SELECT default_visit_frequency_days FROM app_settings WHERE id = 1");
  return rows[0]?.default_visit_frequency_days ?? 14;
}

export async function setDefaultVisitFrequencyDays(days) {
  const { rows } = await pool.query(
    `INSERT INTO app_settings (id, default_visit_frequency_days) VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE SET default_visit_frequency_days = EXCLUDED.default_visit_frequency_days
     RETURNING default_visit_frequency_days`,
    [days]
  );
  return rows[0].default_visit_frequency_days;
}
