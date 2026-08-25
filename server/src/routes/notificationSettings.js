import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { NOTIFICATION_TYPES } from "../notificationPreferences.js";
import { ROLES } from "../roles.js";

export const notificationSettingsRouter = Router();

notificationSettingsRouter.use(requireAuth);

function isValidType(value) {
  return NOTIFICATION_TYPES.includes(value);
}

// Admin-configured defaults per role -- the matrix in Settings > admin
// section. Returns every role/type combination explicitly (defaulting to
// enabled: true where no row exists yet), so the frontend never has to
// guess at the fallback itself.
notificationSettingsRouter.get("/", requireAdmin, async (req, res) => {
  const { rows } = await pool.query(
    "SELECT scope_value AS role, notification_type, enabled FROM notification_settings WHERE scope_type = 'role'"
  );
  const overrides = new Map(rows.map((r) => [`${r.role}:${r.notification_type}`, r.enabled]));
  const matrix = [];
  for (const role of ROLES) {
    for (const type of NOTIFICATION_TYPES) {
      matrix.push({
        role,
        notification_type: type,
        enabled: overrides.get(`${role}:${type}`) ?? true,
      });
    }
  }
  res.json(matrix);
});

notificationSettingsRouter.put("/", requireAdmin, async (req, res) => {
  const { role, notification_type, enabled } = req.body ?? {};
  if (!ROLES.includes(role) || !isValidType(notification_type) || typeof enabled !== "boolean") {
    return res.status(400).json({ error: "role, notification_type, and a boolean enabled are required" });
  }
  await pool.query(
    `INSERT INTO notification_settings (scope_type, scope_value, notification_type, enabled)
     VALUES ('role', $1, $2, $3)
     ON CONFLICT (scope_type, scope_value, notification_type) DO UPDATE SET enabled = $3, updated_at = now()`,
    [role, notification_type, enabled]
  );
  res.status(204).end();
});

// The logged-in user's own effective preferences (their personal override
// if they have one, otherwise the role default), for the notification
// preferences section every user sees in Settings.
notificationSettingsRouter.get("/mine", async (req, res) => {
  const { rows: roleRows } = await pool.query(
    "SELECT notification_type, enabled FROM notification_settings WHERE scope_type = 'role' AND scope_value = $1",
    [req.user.role]
  );
  const { rows: userRows } = await pool.query(
    "SELECT notification_type, enabled FROM notification_settings WHERE scope_type = 'user' AND scope_value = $1",
    [String(req.user.id)]
  );
  const roleDefaults = new Map(roleRows.map((r) => [r.notification_type, r.enabled]));
  const userOverrides = new Map(userRows.map((r) => [r.notification_type, r.enabled]));
  const preferences = NOTIFICATION_TYPES.map((type) => ({
    notification_type: type,
    enabled: userOverrides.get(type) ?? roleDefaults.get(type) ?? true,
    is_override: userOverrides.has(type),
  }));
  res.json(preferences);
});

notificationSettingsRouter.put("/mine", async (req, res) => {
  const { notification_type, enabled } = req.body ?? {};
  if (!isValidType(notification_type) || typeof enabled !== "boolean") {
    return res.status(400).json({ error: "notification_type and a boolean enabled are required" });
  }
  await pool.query(
    `INSERT INTO notification_settings (scope_type, scope_value, notification_type, enabled)
     VALUES ('user', $1, $2, $3)
     ON CONFLICT (scope_type, scope_value, notification_type) DO UPDATE SET enabled = $3, updated_at = now()`,
    [String(req.user.id), notification_type, enabled]
  );
  res.status(204).end();
});

// Clears a personal override so this notification type falls back to
// following the role default again.
notificationSettingsRouter.delete("/mine/:type", async (req, res) => {
  if (!isValidType(req.params.type)) return res.status(400).json({ error: "Unknown notification_type" });
  await pool.query(
    "DELETE FROM notification_settings WHERE scope_type = 'user' AND scope_value = $1 AND notification_type = $2",
    [String(req.user.id), req.params.type]
  );
  res.status(204).end();
});
