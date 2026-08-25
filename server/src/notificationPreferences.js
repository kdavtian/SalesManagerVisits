import { pool } from "./db/pool.js";

// The fixed set of push notification events this app can send. Kept as a
// plain list (not derived from anywhere else) so the admin matrix and the
// self-service preferences UI both have one place to enumerate them from.
export const NOTIFICATION_TYPES = ["plan_submitted", "plan_reviewed", "order_status_changed", "visit_reminder"];

// Roles that can review a route plan -- the only roles plan_submitted is
// ever relevant to (see canPlanForOthers in roles.js).
export const APPROVER_ROLES = ["admin", "sales_director", "ceo"];

// A user-scoped row always wins over a role-scoped row for the same type;
// with neither, the notification is enabled by default (opt-out, not
// opt-in, so a fresh install doesn't silently go quiet).
export async function isNotificationEnabled(userId, type) {
  const { rows } = await pool.query(
    `SELECT ns.enabled
     FROM notification_settings ns
     JOIN users u ON u.id = $1
     WHERE ns.notification_type = $2
       AND ((ns.scope_type = 'user' AND ns.scope_value = $1::text)
         OR (ns.scope_type = 'role' AND ns.scope_value = u.role))
     ORDER BY (ns.scope_type = 'user') DESC
     LIMIT 1`,
    [userId, type]
  );
  return rows.length ? rows[0].enabled : true;
}
