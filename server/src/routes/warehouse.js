// Warehouse Manager screens: an Aggregated Pick List (grouped by product,
// across every order currently sitting "confirmed" -- not scoped to one
// day, since orders arrive continuously), a Per-Order Staging List (one
// order per row, "Mark Packed" / "Flag stock issue"), and a read-only
// live-inventory reference panel. See
// migrations/051_warehouse_delivery_v3.sql for the 5-state status machine
// this operates on.
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
    `SELECT oi.product_id, oi.product_name, oi.brand, p.unit AS size,
            SUM(oi.quantity)::int AS total_quantity,
            COUNT(DISTINCT oi.order_id)::int AS order_count,
            p.stock_qty
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     LEFT JOIN products p ON p.id = oi.product_id
     WHERE o.status = 'confirmed'
     GROUP BY oi.product_id, oi.product_name, oi.brand, p.unit, p.stock_qty
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
     WHERE o.status = 'confirmed'
     ORDER BY o.created_at ASC`
  );
  const orderIds = rows.map((r) => r.id);
  const { rows: items } = orderIds.length
    ? await pool.query(
        "SELECT oi.*, p.unit AS size FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ANY($1) ORDER BY oi.id",
        [orderIds]
      )
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

async function markPacked(orderId) {
  const { rows } = await pool.query(
    `SELECT o.*, c.name AS customer_name FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = $1`,
    [orderId]
  );
  const order = rows[0];
  if (!order) return { error: "Order not found", status: 404 };
  if (order.status !== "confirmed") {
    return { error: `Cannot mark "${order.status}" as packed -- only a confirmed order can be packed`, status: 409 };
  }

  const { rows: updatedRows } = await pool.query(
    "UPDATE orders SET status = 'packed_stock_out', updated_at = now() WHERE id = $1 RETURNING *",
    [order.id]
  );

  (async () => {
    try {
      // Packed orders are picked up by the route planner, not pushed to one
      // driver directly -- notify delivery_manager/admin generally so
      // whoever plans routes knows there's fresh stock ready to route.
      const { rows: deliveryRows } = await pool.query("SELECT id FROM users WHERE role = ANY($1)", [WAREHOUSE_NOTIFY_ROLES]);
      for (const d of deliveryRows) {
        notifyUser(d.id, "order_packed", {
          title: "Order packed",
          body: `${order.customer_name}'s order is packed and ready to route.`,
          url: "/#/delivery",
        });
      }
    } catch (err) {
      console.error("Post-packed notification failed:", err);
    }
  })();

  return { order: updatedRows[0] };
}

warehouseRouter.post("/orders/:id/packed", async (req, res) => {
  const result = await markPacked(req.params.id);
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(result.order);
});

// C7: bulk mark-packed -- a WM staging a full batch shouldn't have to tap
// "Mark Packed" once per order. Best-effort per order (one bad id doesn't
// block the rest); the response lists which succeeded and which didn't.
warehouseRouter.post("/orders/bulk-packed", async (req, res) => {
  const { order_ids } = req.body ?? {};
  if (!Array.isArray(order_ids) || !order_ids.length) {
    return res.status(400).json({ error: "order_ids is required" });
  }
  const packed = [];
  const failed = [];
  for (const id of order_ids) {
    const result = await markPacked(id);
    if (result.error) failed.push({ id, error: result.error });
    else packed.push(result.order);
  }
  res.json({ packed, failed });
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
  if (order.status !== "confirmed") {
    return res.status(409).json({ error: `Cannot flag a stock issue on "${order.status}" -- only a confirmed order qualifies` });
  }

  const { rows: updatedRows } = await pool.query(
    "UPDATE orders SET status = 'draft', draft_reason = $1, updated_at = now() WHERE id = $2 RETURNING *",
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
