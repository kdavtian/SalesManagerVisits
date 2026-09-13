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

// The app-disguise unlock code's hash. NULL means "never customized" --
// callers compare against the built-in default hash themselves (see
// calculatorLock.js) rather than this module hardcoding that fallback, so
// the default lives in exactly one place.
export async function getCalculatorPinHash() {
  const { rows } = await pool.query("SELECT calculator_pin_hash FROM app_settings WHERE id = 1");
  return rows[0]?.calculator_pin_hash ?? null;
}

export async function setCalculatorPinHash(hash) {
  await pool.query(
    `INSERT INTO app_settings (id, calculator_pin_hash) VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE SET calculator_pin_hash = EXCLUDED.calculator_pin_hash`,
    [hash]
  );
}

// Global emergency kill-switch (see middleware/lockdown.js). lockdown_by/at
// record who triggered it and when -- shown next to the toggle so admins
// know it wasn't left on by accident.
export async function getLockdownState() {
  const { rows } = await pool.query(
    `SELECT lockdown_enabled, lockdown_by, lockdown_at, u.name AS lockdown_by_name
     FROM app_settings
     LEFT JOIN users u ON u.id = app_settings.lockdown_by
     WHERE app_settings.id = 1`
  );
  const row = rows[0];
  return {
    enabled: row?.lockdown_enabled ?? false,
    by: row?.lockdown_by ?? null,
    byName: row?.lockdown_by_name ?? null,
    at: row?.lockdown_at ?? null,
  };
}

export async function setLockdown(enabled, byUserId) {
  await pool.query(
    `INSERT INTO app_settings (id, lockdown_enabled, lockdown_by, lockdown_at)
     VALUES (1, $1, $2, CASE WHEN $1 THEN now() ELSE NULL END)
     ON CONFLICT (id) DO UPDATE SET
       lockdown_enabled = EXCLUDED.lockdown_enabled,
       lockdown_by = EXCLUDED.lockdown_by,
       lockdown_at = EXCLUDED.lockdown_at`,
    [enabled, enabled ? byUserId : null]
  );
}

// Admin on/off switch for the calculator disguise (see bootGate.js). Read
// server-side while rendering index.html, not fetched by the client, so
// the disguise's "never touches the network before unlock" property holds
// regardless of whether the feature is on or off.
export async function getCalculatorModeEnabled() {
  const { rows } = await pool.query("SELECT calculator_mode_enabled FROM app_settings WHERE id = 1");
  return rows[0]?.calculator_mode_enabled ?? false;
}

export async function setCalculatorModeEnabled(enabled) {
  const { rows } = await pool.query(
    `INSERT INTO app_settings (id, calculator_mode_enabled) VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE SET calculator_mode_enabled = EXCLUDED.calculator_mode_enabled
     RETURNING calculator_mode_enabled`,
    [enabled]
  );
  return rows[0].calculator_mode_enabled;
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
