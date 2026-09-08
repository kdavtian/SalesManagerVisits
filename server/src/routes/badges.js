// One combined poll for every Home-tab/nav badge count, backing app.js's
// every-60s refresh. Each of these counts already has its own dedicated
// endpoint (orders/payments/warehouse/delivery/unrecorded/notifications/
// visit-plans), which stay exactly as they are -- this file duplicates
// none of their query logic beyond copy-pasting the same WHERE clauses,
// it just runs all of them together in one request instead of seven
// separate ones every minute. Event-driven refreshes (right after a rep
// submits/approves/packs/delivers something) still hit the single-purpose
// endpoint for just that one badge -- this route is for the periodic
// poll only, where combining is worth it.
import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import {
  canConfirmOrders,
  seesAllPayments,
  seesUnrecordedBadge,
  canManageWarehouse,
  canPlanRoutes,
  canDeliverOrders,
  canPlanForOthers,
} from "../roles.js";

export const badgesRouter = Router();
badgesRouter.use(requireAuth);

badgesRouter.get("/", async (req, res) => {
  const role = req.user.role;
  const userId = req.user.id;

  const [orders, payments, unrecorded, warehouse, delivery, notifications, planApprovals] = await Promise.all([
    canConfirmOrders(role)
      ? pool.query("SELECT COUNT(*)::int AS count FROM orders WHERE status = 'submitted'")
      : Promise.resolve({ rows: [{ count: 0 }] }),

    seesAllPayments(role)
      ? pool.query("SELECT count(*)::int AS count FROM payments WHERE status = 'pending'")
      : pool.query("SELECT count(*)::int AS count FROM payments WHERE status = 'pending' AND sales_manager_id = $1", [userId]),

    seesUnrecordedBadge(role)
      ? pool.query("SELECT COUNT(*)::int AS count FROM orders WHERE status = 'delivered' AND recorded = false")
      : Promise.resolve({ rows: [{ count: 0 }] }),

    canManageWarehouse(role)
      ? pool.query("SELECT COUNT(*)::int AS count FROM orders WHERE status = 'confirmed'")
      : Promise.resolve({ rows: [{ count: 0 }] }),

    canPlanRoutes(role) || canDeliverOrders(role)
      ? pool.query(
          `SELECT
             (SELECT COUNT(*)::int FROM orders o WHERE o.status = 'packed_stock_out'
                AND NOT EXISTS (SELECT 1 FROM route_stops rs WHERE rs.order_id = o.id))
             + (SELECT COUNT(*)::int FROM route_stops WHERE completed_at IS NULL)
             AS count`
        )
      : Promise.resolve({ rows: [{ count: 0 }] }),

    pool.query("SELECT count(*)::int AS count FROM notifications WHERE user_id = $1 AND read_at IS NULL", [userId]),

    canPlanForOthers(role)
      ? pool.query("SELECT count(*)::int AS count FROM visit_plans WHERE status = 'pending'")
      : Promise.resolve({ rows: [{ count: 0 }] }),
  ]);

  res.json({
    orders: orders.rows[0].count,
    payments: payments.rows[0].count,
    unrecorded: unrecorded.rows[0].count,
    warehouse: warehouse.rows[0].count,
    delivery: delivery.rows[0].count,
    notifications: notifications.rows[0].count,
    planApprovals: planApprovals.rows[0].count,
  });
});
