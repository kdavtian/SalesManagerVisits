import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { seesAllActivity } from "../roles.js";
import { notifyTelegram, escapeHtml } from "../telegram.js";
import { notifyUser } from "../push.js";
import { isNotificationEnabled, ORDER_NOTIFY_ROLES } from "../notificationPreferences.js";

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

const DISCOUNT_APPROVER_ROLES = new Set(["admin", "sales_director"]);

function applyDiscount(subtotal, discountPct) {
  return subtotal * (1 - discountPct / 100);
}

// Create an order: an items array of {product_id, quantity} (or a free-text
// {product_name, unit_price_amd, quantity} line for something not yet in
// the catalog). Prices are snapshotted from the catalog at save time, not
// looked up live later -- an order is what was actually agreed, and must
// stay correct even if the catalog price changes afterward.
ordersRouter.post("/", async (req, res) => {
  const { customer_id, checkin_id, note, items, discount_pct } = req.body ?? {};
  const customerId = Number(customer_id);
  if (!customerId || !Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: "customer_id and at least one item are required" });
  }
  const discountPct = discount_pct !== undefined ? Number(discount_pct) : 0;
  if (!Number.isFinite(discountPct) || discountPct < 0 || discountPct > 100) {
    return res.status(400).json({ error: "discount_pct must be a number between 0 and 100" });
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

  const subtotalAmd = lines.reduce((sum, l) => sum + l.line_total_amd, 0);
  const totalAmd = applyDiscount(subtotalAmd, discountPct);
  // A discount needs a director's sign-off before the order can move past
  // "submitted" into fulfillment (see the approval_status gate in PATCH
  // below) -- no discount means nothing to approve.
  const approvalStatus = discountPct > 0 ? "pending" : "not_required";

  const client = await pool.connect();
  let order;
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO orders (customer_id, user_id, checkin_id, total_amd, note, discount_pct, approval_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [customerId, req.user.id, checkin_id || null, totalAmd, note || null, discountPct, approvalStatus]
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
  const repName = repRows[0]?.name || "Someone";
  const discountSuffix = discountPct > 0 ? ` (${discountPct}% discount, pending director approval)` : "";
  notifyTelegram(
    `🛒 <b>New order</b>\n${escapeHtml(repName)} — ${escapeHtml(customer.name)}\n${lines.length} item${lines.length === 1 ? "" : "s"}, ${Number(totalAmd).toLocaleString()} AMD${escapeHtml(discountSuffix)}`
  );

  const { rows: notifyRecipients } = await pool.query("SELECT id FROM users WHERE role = ANY($1)", [ORDER_NOTIFY_ROLES]);
  for (const recipient of notifyRecipients) {
    if (await isNotificationEnabled(recipient.id, "order_placed")) {
      notifyUser(recipient.id, {
        title: "New order placed",
        body: `${repName} placed an order for ${customer.name} — ${lines.length} item${lines.length === 1 ? "" : "s"}, ${Number(totalAmd).toLocaleString()} AMD.${discountSuffix}`,
        url: "/#/orders",
      });
    }
  }
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

  const { status, items, note, discount_pct } = req.body ?? {};
  if (status === undefined && items === undefined && note === undefined && discount_pct === undefined) {
    return res.status(400).json({ error: "status, items, note, or discount_pct is required" });
  }

  const isOwnerOrAdmin = order.user_id === req.user.id || req.user.role === "admin";
  let nextLines = null;
  let nextTotal = order.total_amd;
  let nextDiscountPct = Number(order.discount_pct);
  let nextApprovalStatus = order.approval_status;

  if (discount_pct !== undefined) {
    if (!isOwnerOrAdmin) return res.status(403).json({ error: "Not allowed to edit this order" });
    if (order.status !== "submitted") {
      return res.status(409).json({ error: "Only a submitted order's discount can still be changed" });
    }
    const parsed = Number(discount_pct);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
      return res.status(400).json({ error: "discount_pct must be a number between 0 and 100" });
    }
    nextDiscountPct = parsed;
    // Changing the discount always resets any prior director decision --
    // 0 needs no approval, anything else needs a fresh sign-off even if a
    // previous (different) discount on this order was already approved.
    nextApprovalStatus = parsed > 0 ? "pending" : "not_required";
  }

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
  }

  if (nextLines || discount_pct !== undefined) {
    // Editing items recomputes the subtotal, but a discount already
    // approved (or awaiting approval) still applies to whatever the order
    // now totals -- it shouldn't silently vanish just because the rep
    // swapped a line.
    const subtotal = nextLines
      ? nextLines.reduce((sum, l) => sum + l.line_total_amd, 0)
      : (await pool.query("SELECT COALESCE(SUM(line_total_amd), 0) AS subtotal FROM order_items WHERE order_id = $1", [order.id])).rows[0]
          .subtotal;
    nextTotal = applyDiscount(Number(subtotal), nextDiscountPct);
  }

  let nextStatus = order.status;
  if (status !== undefined) {
    if (status === "cancelled") {
      if (!isOwnerOrAdmin && !FULFILLMENT_ROLES.has(req.user.role)) {
        return res.status(403).json({ error: "Not allowed to cancel this order" });
      }
    } else {
      if (!FULFILLMENT_ROLES.has(req.user.role)) {
        return res.status(403).json({ error: "Only warehouse/delivery staff can update fulfillment status" });
      }
      if (order.approval_status === "pending" || order.approval_status === "rejected") {
        return res.status(409).json({
          error:
            order.approval_status === "pending"
              ? "This order's discount is awaiting director approval"
              : "This order's discount was rejected -- edit the order to remove or adjust the discount before it can proceed",
        });
      }
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
      `UPDATE orders
       SET status = $1, total_amd = $2, note = COALESCE($3, note),
           discount_pct = $4, approval_status = $5, updated_at = now()
       WHERE id = $6 RETURNING *`,
      [nextStatus, nextTotal, note ?? null, nextDiscountPct, nextApprovalStatus, order.id]
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

// A discounted order can't reach fulfillment until a sales director (or
// admin) approves or rejects it here -- see the approval_status gate on
// the fulfillment-status branch of PATCH /:id above.
ordersRouter.post("/:id/approve-discount", async (req, res) => {
  if (!DISCOUNT_APPROVER_ROLES.has(req.user.role)) {
    return res.status(403).json({ error: "Only a sales director can approve a discount" });
  }
  const { rows } = await pool.query("SELECT * FROM orders WHERE id = $1", [req.params.id]);
  const order = rows[0];
  if (!order) return res.status(404).json({ error: "Order not found" });
  if (order.approval_status !== "pending") {
    return res.status(409).json({ error: "This order has no pending discount to approve" });
  }

  const { rows: updatedRows } = await pool.query(
    `UPDATE orders SET approval_status = 'approved', approved_by = $1, approved_at = now(), updated_at = now()
     WHERE id = $2 RETURNING *`,
    [req.user.id, order.id]
  );
  res.json(updatedRows[0]);

  const { rows: customerRows } = await pool.query("SELECT name FROM customers WHERE id = $1", [order.customer_id]);
  const customerName = customerRows[0]?.name || "Order";

  // Now that the discount is cleared, the accountant is the next stop --
  // same order_placed preference gate a rep's original order used.
  const { rows: accountants } = await pool.query("SELECT id FROM users WHERE role = 'accountant'");
  for (const accountant of accountants) {
    if (await isNotificationEnabled(accountant.id, "order_placed")) {
      notifyUser(accountant.id, {
        title: "Order discount approved",
        body: `${customerName}'s discounted order was approved and is ready for fulfillment.`,
        url: "/#/orders",
      });
    }
  }
  if (req.user.id !== order.user_id && (await isNotificationEnabled(order.user_id, "order_status_changed"))) {
    notifyUser(order.user_id, {
      title: "Discount approved",
      body: `${customerName}'s order discount was approved.`,
      url: "/#/orders",
    });
  }
});

ordersRouter.post("/:id/reject-discount", async (req, res) => {
  if (!DISCOUNT_APPROVER_ROLES.has(req.user.role)) {
    return res.status(403).json({ error: "Only a sales director can reject a discount" });
  }
  const { rows } = await pool.query("SELECT * FROM orders WHERE id = $1", [req.params.id]);
  const order = rows[0];
  if (!order) return res.status(404).json({ error: "Order not found" });
  if (order.approval_status !== "pending") {
    return res.status(409).json({ error: "This order has no pending discount to reject" });
  }

  const { rows: updatedRows } = await pool.query(
    `UPDATE orders SET approval_status = 'rejected', approved_by = $1, approved_at = now(), updated_at = now()
     WHERE id = $2 RETURNING *`,
    [req.user.id, order.id]
  );
  res.json(updatedRows[0]);

  if (req.user.id !== order.user_id && (await isNotificationEnabled(order.user_id, "order_status_changed"))) {
    const { rows: customerRows } = await pool.query("SELECT name FROM customers WHERE id = $1", [order.customer_id]);
    notifyUser(order.user_id, {
      title: "Discount rejected",
      body: `${customerRows[0]?.name || "Order"}'s discount was rejected -- edit the order or remove the discount to proceed.`,
      url: "/#/orders",
    });
  }
});

// Permanent removal (not the same as cancelling, which keeps the order as
// a record) -- admin-only, for a duplicate or mistaken order that
// shouldn't appear in reports at all. order_items cascades with it.
ordersRouter.delete("/:id", requireAdmin, async (req, res) => {
  const { rowCount } = await pool.query("DELETE FROM orders WHERE id = $1", [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: "Order not found" });
  res.status(204).end();
});
