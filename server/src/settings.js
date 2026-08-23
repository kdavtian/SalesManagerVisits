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
