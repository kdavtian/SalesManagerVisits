import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { seesAllActivity } from "../roles.js";
import { notifyTelegram, escapeHtml } from "../telegram.js";
import { notifyUser } from "../push.js";
import { isNotificationEnabled } from "../notificationPreferences.js";

export const ordersRouter = Router();

ordersRouter.use(requireAuth);

// Warehouse/delivery staff (plus admin) are the ones who actually move an
// order through fulfillment; a plain rep or director can request a
// cancellation but can't claim to have packed or delivered something.
const FULFILLMENT_ROLES = new Set(["warehouse_manager", "delivery_manager", "admin"]);

// What each status may legally become next. "cancelled" is reachable from
// anywhere in-flight; once delivered or cancelled, an order is final.
const NEXT_STATUS = {
  submitted: ["confirmed", "cancelled"],
  confirmed: ["packed", "cancelled"],
  packed: ["delivered", "cancelled"],
  delivered: [],
  cancelled: [],
};

// Snapshots each line's product name/price at build time -- shared by
// create and edit so an edited order prices its new lines exactly the same
// way a fresh order would.
async function buildOrderLines(items) {
  const productIds = items.map((i) => Number(i.product_id)).filter(Number.isInteger);
  const { rows: products } = productIds.length
    ? await pool.query("SELECT * FROM products WHERE id = ANY($1)", [productIds])
    : { rows: [] };
  const productById = new Map(products.map((p) => [p.id, p]));

  const lines = [];
  for (const item of items) {
    const quantity = Number(item.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new OrderValidationError("Every item needs a positive quantity");
    }
    const product = Number.isInteger(Number(item.product_id)) ? productById.get(Number(item.product_id)) : null;
    const productName = product ? product.name : item.product_name;
    const unitPrice = product ? Number(product.unit_price_amd) : Number(item.unit_price_amd);
    if (!productName || !Number.isFinite(unitPrice) || unitPrice < 0) {
      throw new OrderValidationError("Each item needs a valid product and a non-negative price");
    }
    lines.push({
      product_id: product?.id ?? null,
      product_name: productName,
      unit_price_amd: unitPrice,
      quantity,
      line_total_amd: unitPrice * quantity,
    });
  }
  return lines;
}

class OrderValidationError extends Error {}

// Create an order: an items array of {product_id, quantity} (or a free-text
// {product_name, unit_price_amd, quantity} line for something not yet in
// the catalog). Prices are snapshotted from the catalog at save time, not
// looked up live later -- an order is what was actually agreed, and must
// stay correct even if the catalog price changes afterward.
ordersRouter.post("/", async (req, res) => {
  const { customer_id, checkin_id, note, items } = req.body ?? {};
  const customerId = Number(customer_id);
  if (!customerId || !Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: "customer_id and at least one item are required" });
  }

  const { rows: customerRows } = await pool.query("SELECT id, name FROM customers WHERE id = $1", [customerId]);
  const customer = customerRows[0];
  if (!customer) return res.status(404).json({ error: "Customer not found" });

  // A client-supplied checkin_id is otherwise unverified -- without this,
  // any rep could link their order to someone else's checkin (or one for a
  // different customer entirely), which would misattribute the order in
  // the customer's visit history.
  if (checkin_id) {
    const { rows: checkinRows } = await pool.query(
      "SELECT id FROM checkins WHERE id = $1 AND user_id = $2 AND customer_id = $3",
      [checkin_id, req.user.id, customerId]
    );
    if (!checkinRows[0]) {
      return res.status(400).json({ error: "checkin_id does not match this customer and your own check-ins" });
    }
  }

  let lines;
  try {
    lines = await buildOrderLines(items);
  } catch (err) {
    if (err instanceof OrderValidationError) return res.status(400).json({ error: err.message });
    throw err;
  }

  const totalAmd = lines.reduce((sum, l) => sum + l.line_total_amd, 0);

  const client = await pool.connect();
  let order;
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO orders (customer_id, user_id, checkin_id, total_amd, note)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [customerId, req.user.id, checkin_id || null, totalAmd, note || null]
    );
    order = rows[0];
    for (const line of lines) {
      await client.query(
        `INSERT INTO order_items (order_id, product_id, product_name, unit_price_amd, quantity, line_total_amd)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [order.id, line.product_id, line.product_name, line.unit_price_amd, line.quantity, line.line_total_amd]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  res.status(201).json({ ...order, items: lines });

  // Fire after responding -- the rep shouldn't wait on a Telegram round
  // trip for their order confirmation.
  const { rows: repRows } = await pool.query("SELECT name FROM users WHERE id = $1", [req.user.id]);
  notifyTelegram(
    `🛒 <b>New order</b>\n${escapeHtml(repRows[0]?.name || "Someone")} — ${escapeHtml(customer.name)}\n${lines.length} item${lines.length === 1 ? "" : "s"}, ${Number(totalAmd).toLocaleString()} AMD`
  );
});

const PAGE_SIZE = 100;

ordersRouter.get("/", async (req, res) => {
  let { customer_id, user_id, status, offset } = req.query;
  if (!seesAllActivity(req.user.role)) {
    user_id = req.user.id;
  }

  const conditions = [];
  const params = [];
  if (customer_id) {
    params.push(customer_id);
    conditions.push(`o.customer_id = $${params.length}`);
  }
  if (user_id) {
    params.push(user_id);
    conditions.push(`o.user_id = $${params.length}`);
  }
  if (status) {
    params.push(status);
    conditions.push(`o.status = $${params.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const offsetNum = Math.max(0, Number(offset) || 0);

  // Fetch one extra row to know whether there's a next page, without a
  // separate COUNT(*) query -- trimmed back to PAGE_SIZE before sending.
  params.push(PAGE_SIZE + 1, offsetNum);
  const { rows } = await pool.query(
    `SELECT o.*, u.name AS user_name, c.name AS customer_name
     FROM orders o
     JOIN users u ON u.id = o.user_id
     JOIN customers c ON c.id = o.customer_id
     ${where}
     ORDER BY o.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  res.json({ rows: rows.slice(0, PAGE_SIZE), has_more: rows.length > PAGE_SIZE });
});

ordersRouter.get("/:id", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT o.*, u.name AS user_name, c.name AS customer_name
     FROM orders o
     JOIN users u ON u.id = o.user_id
     JOIN customers c ON c.id = o.customer_id
     WHERE o.id = $1`,
    [req.params.id]
  );
  const order = rows[0];
  if (!order) return res.status(404).json({ error: "Order not found" });
  if (!seesAllActivity(req.user.role) && order.user_id !== req.user.id) {
    return res.status(403).json({ error: "Not allowed" });
  }

  const { rows: items } = await pool.query(
    "SELECT * FROM order_items WHERE order_id = $1 ORDER BY id",
    [order.id]
  );
  res.json({ ...order, items });
});

// Edit line items (only while still "submitted", by the rep who placed it
// or an admin) and/or move the order's fulfillment status forward or to
// "cancelled". Both can be sent in the same request.
ordersRouter.patch("/:id", async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM orders WHERE id = $1", [req.params.id]);
  const order = rows[0];
  if (!order) return res.status(404).json({ error: "Order not found" });

  const { status, items, note } = req.body ?? {};
  if (status === undefined && items === undefined && note === undefined) {
    return res.status(400).json({ error: "status, items, or note is required" });
  }

  const isOwnerOrAdmin = order.user_id === req.user.id || req.user.role === "admin";
  let nextLines = null;
  let nextTotal = order.total_amd;

  if (items !== undefined) {
    if (!isOwnerOrAdmin) return res.status(403).json({ error: "Not allowed to edit this order" });
    if (order.status !== "submitted") {
      return res.status(409).json({ error: "Only a submitted order's items can still be edited" });
    }
    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: "At least one item is required" });
    }
    try {
      nextLines = await buildOrderLines(items);
    } catch (err) {
      if (err instanceof OrderValidationError) return res.status(400).json({ error: err.message });
      throw err;
    }
    nextTotal = nextLines.reduce((sum, l) => sum + l.line_total_amd, 0);
  }

  let nextStatus = order.status;
  if (status !== undefined) {
    if (status === "cancelled") {
      if (!isOwnerOrAdmin && !FULFILLMENT_ROLES.has(req.user.role)) {
        return res.status(403).json({ error: "Not allowed to cancel this order" });
      }
    } else if (!FULFILLMENT_ROLES.has(req.user.role)) {
      return res.status(403).json({ error: "Only warehouse/delivery staff can update fulfillment status" });
    }
    if (!NEXT_STATUS[order.status]?.includes(status)) {
      return res.status(409).json({ error: `Cannot move an order from "${order.status}" to "${status}"` });
    }
    nextStatus = status;
  }

  const client = await pool.connect();
  let updated;
  try {
    await client.query("BEGIN");
    const { rows: updatedRows } = await client.query(
      `UPDATE orders SET status = $1, total_amd = $2, note = COALESCE($3, note), updated_at = now()
       WHERE id = $4 RETURNING *`,
      [nextStatus, nextTotal, note ?? null, order.id]
    );
    updated = updatedRows[0];

    if (nextLines) {
      await client.query("DELETE FROM order_items WHERE order_id = $1", [order.id]);
      for (const line of nextLines) {
        await client.query(
          `INSERT INTO order_items (order_id, product_id, product_name, unit_price_amd, quantity, line_total_amd)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [order.id, line.product_id, line.product_name, line.unit_price_amd, line.quantity, line.line_total_amd]
        );
      }
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  const { rows: items2 } = await pool.query("SELECT * FROM order_items WHERE order_id = $1 ORDER BY id", [order.id]);
  res.json({ ...updated, items: items2 });

  // Only the rep who placed the order cares about its fulfillment moving
  // forward, and only when the status actually changed (not a pure
  // items/note edit) -- and not when they made the change themselves.
  if (
    status !== undefined &&
    nextStatus !== order.status &&
    req.user.id !== order.user_id &&
    (await isNotificationEnabled(order.user_id, "order_status_changed"))
  ) {
    const { rows: customerRows } = await pool.query("SELECT name FROM customers WHERE id = $1", [order.customer_id]);
    notifyUser(order.user_id, {
      title: "Order update",
      body: `${customerRows[0]?.name || "Order"} is now "${nextStatus}".`,
      url: "/#/orders",
    });
  }
});
