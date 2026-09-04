import { pool } from "./db/pool.js";

// The fixed set of push notification events this app can send. Kept as a
// plain list (not derived from anywhere else) so the admin matrix and the
// self-service preferences UI both have one place to enumerate them from.
export const NOTIFICATION_TYPES = [
  "plan_submitted",
  "plan_reviewed",
  "order_status_changed",
  "order_placed",
  "visit_reminder",
  "perf_plan_submitted",
  "perf_plan_reviewed",
  "payment_submitted",
  "order_warehouse_review",
  "order_stock_issue",
  "order_packed",
  "order_delivered",
  "order_returned",
  "order_stale_packed",
  "payment_due_soon",
];

// Warehouse Manager: an order just entered their queue.
export const WAREHOUSE_NOTIFY_ROLES = ["warehouse_manager", "admin"];

// A stock issue needs the Sales Director (and CEO/admin) to sort out --
// same reviewers who confirmed the order in the first place.
export const STOCK_ISSUE_NOTIFY_ROLES = ["sales_director", "ceo", "admin"];

// A driver only needs to know once an order is packed and ready to route.
export const DRIVER_NOTIFY_ROLES = ["delivery_manager", "admin"];

// Delivered/returned events are visible to management and the warehouse,
// per the spec's notification-events table.
export const DELIVERY_OUTCOME_NOTIFY_ROLES = ["sales_director", "admin", "warehouse_manager"];

// Roles that can review a route plan -- the only roles plan_submitted is
// ever relevant to (see canPlanForOthers in roles.js).
export const APPROVER_ROLES = ["admin", "sales_director", "ceo"];

// Roles that can review a Team Performance plan -- CEO/admin review
// everything, Accountant reviews Sales Director submissions only (see
// canReviewPlan in roles.js). Kept separate from APPROVER_ROLES since these
// are two unrelated approval workflows (route plans vs performance plans).
export const PERF_APPROVER_ROLES = ["admin", "ceo", "accountant"];

// Roles that need to know a new order landed -- the director (or CEO) who
// may need to review or approve a discount, and the accountant who
// consolidates orders. Each recipient can still turn this off for
// themselves in Settings (see isNotificationEnabled) -- being on this list
// only sets the default to "on", not "forced".
export const ORDER_NOTIFY_ROLES = ["sales_director", "accountant", "ceo"];

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
