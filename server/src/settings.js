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

export async function getIncentiveMessage() {
  const { rows } = await pool.query("SELECT incentive_message FROM app_settings WHERE id = 1");
  return rows[0]?.incentive_message ?? null;
}

export async function setIncentiveMessage(message) {
  const { rows } = await pool.query(
    `INSERT INTO app_settings (id, incentive_message) VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE SET incentive_message = EXCLUDED.incentive_message
     RETURNING incentive_message`,
    [message]
  );
  return rows[0].incentive_message;
}

// Per-role allow-list of Home quick-action tile ids, e.g.
// { "sales_manager": ["qa_check_in", ...] }. NULL means "nobody has ever
// customized this", and a role missing from the object means "that role
// still uses the built-in default" -- the client owns the default list
// (it's the same list it renders the tiles from), so this layer stays a
// dumb passthrough and can never disagree with it.
export async function getQuickActionVisibility() {
  const { rows } = await pool.query("SELECT quick_action_visibility FROM app_settings WHERE id = 1");
  return rows[0]?.quick_action_visibility ?? null;
}

export async function setQuickActionVisibility(value) {
  const { rows } = await pool.query(
    `INSERT INTO app_settings (id, quick_action_visibility) VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE SET quick_action_visibility = EXCLUDED.quick_action_visibility
     RETURNING quick_action_visibility`,
    [value === null ? null : JSON.stringify(value)]
  );
  return rows[0].quick_action_visibility;
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
