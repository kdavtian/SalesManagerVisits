// Warehouse Manager screens: an Aggregated Pick List (grouped by product,
// across every order currently sitting in warehouse_review -- not scoped
// to one day, since orders arrive continuously), a Per-Order Staging List
// (one order per row, "Mark Packed" / "Flag stock issue"), and a read-only
// live-inventory reference panel. See migrations/050_warehouse_delivery.sql
// for the status machine this operates on.
import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { canManageWarehouse } from "../roles.js";
import { notifyUser } from "../notifications.js";
import { STOCK_ISSUE_NOTIFY_ROLES, WAREHOUSE_NOTIFY_ROLES } from "../notificationPreferences.js";

export const warehouseRouter = Router();
warehouseRouter.use(requireAuth);

function requireWarehouse(req, res, next) {
  if (!canManageWarehouse(req.user.role)) return res.status(403).json({ error: "Not allowed" });
  next();
}
warehouseRouter.use(requireWarehouse);

// Grouped by product, not date -- a Warehouse Manager physically walking
// the floor needs "how many of X do I need across every order waiting
// right now", not one order at a time.
warehouseRouter.get("/pick-list", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT oi.product_id, oi.product_name, oi.brand,
            SUM(oi.quantity)::int AS total_quantity,
            COUNT(DISTINCT oi.order_id)::int AS order_count,
            p.stock_qty
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     LEFT JOIN products p ON p.id = oi.product_id
     WHERE o.status = 'warehouse_review'
     GROUP BY oi.product_id, oi.product_name, oi.brand, p.stock_qty
     ORDER BY oi.brand NULLS LAST, oi.product_name`
  );
  res.json(rows);
});

// One row per order awaiting packing -- the screen a WM actually stages
// against, with "Mark Packed" / "Flag stock issue" per order.
warehouseRouter.get("/staging-list", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT o.id, o.order_code, o.total_amd, o.created_at, o.customer_id,
            c.name AS customer_name, c.erp_customer_id, c.address,
            u.name AS rep_name
     FROM orders o
     JOIN customers c ON c.id = o.customer_id
     JOIN users u ON u.id = o.user_id
     WHERE o.status = 'warehouse_review'
     ORDER BY o.created_at ASC`
  );
  const orderIds = rows.map((r) => r.id);
  const { rows: items } = orderIds.length
    ? await pool.query("SELECT * FROM order_items WHERE order_id = ANY($1) ORDER BY id", [orderIds])
    : { rows: [] };
  const itemsByOrder = new Map();
  for (const item of items) {
    if (!itemsByOrder.has(item.order_id)) itemsByOrder.set(item.order_id, []);
    itemsByOrder.get(item.order_id).push(item);
  }
  res.json(rows.map((o) => ({ ...o, items: itemsByOrder.get(o.id) || [] })));
});

// Read-only live-inventory reference -- out of scope to decrement stock in
// real time (per spec), this is just "what does the catalog currently say
// we have" so a WM can sanity-check before flagging a stock issue.
warehouseRouter.get("/inventory", async (req, res) => {
  const { q, brand } = req.query;
  const conditions = [];
  const params = [];
  if (q) {
    params.push(`%${q}%`);
    conditions.push(`(name ILIKE $${params.length} OR brand ILIKE $${params.length})`);
  }
  if (brand) {
    params.push(brand);
    conditions.push(`brand = $${params.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const { rows } = await pool.query(
    `SELECT id, name, brand, family, unit, stock_qty,
       NULLIF(regexp_replace(unit, 'L$', ''), '')::numeric AS liters
     FROM products
     ${where}
     -- Brand, then family/category, then size ascending (small to big) --
     -- a non-liter unit (no numeric size) sorts after sized ones within
     -- its own brand/family group, then alphabetically by name as a
     -- final tiebreaker.
     ORDER BY brand NULLS LAST, family NULLS LAST, liters NULLS LAST, name
     LIMIT 300`,
    params
  );
  res.json(rows);
});

// Distinct brand list for the inventory screen's brand filter -- kept
// separate from the paginated/searched inventory rows themselves so the
// filter's own option list doesn't shrink as a search narrows the results.
warehouseRouter.get("/inventory/brands", async (req, res) => {
  const { rows } = await pool.query(
    "SELECT DISTINCT brand FROM products WHERE brand IS NOT NULL ORDER BY brand"
  );
  res.json(rows.map((r) => r.brand));
});

warehouseRouter.post("/orders/:id/packed", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT o.*, c.name AS customer_name FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = $1`,
    [req.params.id]
  );
  const order = rows[0];
  if (!order) return res.status(404).json({ error: "Order not found" });
  if (order.status !== "warehouse_review") {
    return res.status(409).json({ error: `Cannot mark "${order.status}" as packed -- only a warehouse_review order can be packed` });
  }

  const { rows: updatedRows } = await pool.query(
    "UPDATE orders SET status = 'packed', updated_at = now() WHERE id = $1 RETURNING *",
    [order.id]
  );
  res.json(updatedRows[0]);

  (async () => {
    try {
      const { rows: driverRows } = await pool.query("SELECT id FROM users WHERE role = ANY($1)", [WAREHOUSE_NOTIFY_ROLES]);
      // Packed orders are picked up by the route planner, not pushed to one
      // driver directly -- notify delivery_manager/admin generally so
      // whoever plans routes knows there's fresh stock ready to route.
      const { rows: deliveryRows } = await pool.query("SELECT id FROM users WHERE role IN ('delivery_manager', 'admin')");
      for (const d of deliveryRows) {
        notifyUser(d.id, "order_packed", {
          title: "Order packed",
          body: `${order.customer_name}'s order is packed and ready to route.`,
          url: "/#/delivery",
        });
      }
      void driverRows;
    } catch (err) {
      console.error("Post-packed notification failed:", err);
    }
  })();
});

warehouseRouter.post("/orders/:id/stock-issue", async (req, res) => {
  const { note } = req.body ?? {};
  if (!note || !note.trim()) return res.status(400).json({ error: "A note is required to flag a stock issue" });

  const { rows } = await pool.query(
    `SELECT o.*, c.name AS customer_name FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = $1`,
    [req.params.id]
  );
  const order = rows[0];
  if (!order) return res.status(404).json({ error: "Order not found" });
  if (order.status !== "warehouse_review") {
    return res.status(409).json({ error: `Cannot flag a stock issue on "${order.status}" -- only a warehouse_review order qualifies` });
  }

  const { rows: updatedRows } = await pool.query(
    "UPDATE orders SET status = 'stock_issue', stock_issue_note = $1, updated_at = now() WHERE id = $2 RETURNING *",
    [note.trim(), order.id]
  );
  res.json(updatedRows[0]);

  (async () => {
    try {
      const { rows: recipients } = await pool.query("SELECT id FROM users WHERE role = ANY($1)", [STOCK_ISSUE_NOTIFY_ROLES]);
      for (const recipient of recipients) {
        notifyUser(recipient.id, "order_stock_issue", {
          title: "Stock issue flagged",
          body: `${order.customer_name}'s order: ${note.trim()}`,
          url: "/#/orders",
        });
      }
    } catch (err) {
      console.error("Post-stock-issue notification failed:", err);
    }
  })();
});
