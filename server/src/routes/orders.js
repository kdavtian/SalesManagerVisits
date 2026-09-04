import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { seesAllActivity, canConfirmOrders, canAssignErpCustomerId, isFulfillmentRole, canManageWarehouse } from "../roles.js";
import { notifyTelegram, escapeHtml } from "../telegram.js";
import { notifyUser } from "../notifications.js";
import { ORDER_NOTIFY_ROLES, WAREHOUSE_NOTIFY_ROLES } from "../notificationPreferences.js";

export const ordersRouter = Router();

ordersRouter.use(requireAuth);

// Warehouse/delivery staff (plus admin) are the ones who actually move an
// order through fulfillment; a plain rep or director can request a
// cancellation but can't claim to have packed or delivered something.
// Kept as a re-export of roles.js's isFulfillmentRole so nothing else in
// this file (or its call sites) needs to change shape.
const FULFILLMENT_ROLES = { has: (role) => isFulfillmentRole(role) };

// What each status may legally become next. "cancelled" is reachable from
// anywhere in-flight; once delivered or cancelled, an order is final. This
// is the master map -- see routes/warehouse.js and routes/delivery.js for
// the dedicated endpoints that actually perform the note-required
// (stock_issue) and route-driven (out_for_delivery) transitions; the
// generic PATCH below only exposes a subset of this map (see
// GENERIC_PATCH_TARGETS) so those can't be bypassed without their required
// extra data.
export const NEXT_STATUS = {
  draft: ["cancelled"],
  submitted: ["confirmed", "cancelled"],
  // "confirmed" auto-chains straight into "warehouse_review" the moment a
  // director confirms it (see the PATCH handler below) -- it's never
  // actually left sitting at "confirmed" in the DB, just validated as a
  // reachable step so the review permission check has something to gate on.
  confirmed: ["warehouse_review", "cancelled"],
  warehouse_review: ["packed", "stock_issue", "cancelled"],
  // A flagged stock issue drops back to "confirmed" (the closest existing
  // equivalent of the spec's "pending") -- resolving it and re-confirming
  // re-enters warehouse_review automatically via the same auto-chain.
  stock_issue: ["confirmed", "cancelled"],
  packed: ["out_for_delivery", "cancelled"],
  out_for_delivery: ["delivered", "returned"],
  delivered: [],
  // A failed delivery attempt (no reason, no stock adjustment -- per spec)
  // also drops back to "confirmed" for a re-attempt.
  returned: ["confirmed", "cancelled"],
  cancelled: [],
};

// The generic PATCH /:id below only ever writes one of these statuses
// directly -- warehouse_review/stock_issue/out_for_delivery/returned all
// carry required extra data (a stock-issue note, a route assignment, a
// delivery signature) that only routes/warehouse.js and routes/delivery.js
// collect, so this endpoint refuses to set them directly.
const GENERIC_PATCH_TARGETS = new Set(["confirmed", "packed", "delivered", "cancelled"]);

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
      brand: product?.brand ?? item.brand ?? null,
      unit_price_amd: unitPrice,
      quantity,
      line_total_amd: unitPrice * quantity,
    });
  }
  return lines;
}

class OrderValidationError extends Error {}

// YYMMDD + a 2-digit daily sequence, e.g. the 1st order on 2026-05-30 is
// "26053001" and the 27th on 2026-07-18 is "26071827".
function formatOrderCode(date, seq) {
  const yy = String(date.getFullYear()).slice(-2);
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yy}${mm}${dd}${String(seq).padStart(2, "0")}`;
}

// Atomically claims the next sequence number for today within the given
// transaction -- the upsert prevents two orders placed in the same instant
// from racing to the same seq.
async function nextOrderCode(client) {
  // Stamp the code from the same row (and thus the same clock) that claimed
  // the sequence number, rather than the app server's own `new Date()` --
  // if the app container and the DB ever disagree on timezone, those two
  // clocks can land on different calendar days near midnight, producing a
  // code whose date doesn't match the counter it was actually assigned from.
  const { rows } = await client.query(
    `INSERT INTO daily_order_seq (day, seq) VALUES (CURRENT_DATE, 1)
     ON CONFLICT (day) DO UPDATE SET seq = daily_order_seq.seq + 1
     RETURNING seq, day`
  );
  return formatOrderCode(rows[0].day, rows[0].seq);
}

const DISCOUNT_APPROVER_ROLES = new Set(["admin", "sales_director", "ceo"]);

// A flat-AMD discount and a percent discount are mutually exclusive on one
// order -- discount_amd wins if both are somehow nonzero (shouldn't happen,
// since the two setters below reset the other), and never goes below 0.
function applyDiscount(subtotal, discountPct, discountAmd) {
  if (discountAmd > 0) return Math.max(0, subtotal - discountAmd);
  return subtotal * (1 - discountPct / 100);
}

// Create an order: an items array of {product_id, quantity} (or a free-text
// {product_name, unit_price_amd, quantity} line for something not yet in
// the catalog). Prices are snapshotted from the catalog at save time, not
// looked up live later -- an order is what was actually agreed, and must
// stay correct even if the catalog price changes afterward.
ordersRouter.post("/", async (req, res) => {
  const { customer_id, checkin_id, note, items, discount_pct, discount_amd } = req.body ?? {};
  const customerId = Number(customer_id);
  if (!customerId || !Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: "customer_id and at least one item are required" });
  }
  let discountPct = discount_pct !== undefined ? Number(discount_pct) : 0;
  if (!Number.isFinite(discountPct) || discountPct < 0 || discountPct > 100) {
    return res.status(400).json({ error: "discount_pct must be a number between 0 and 100" });
  }
  let discountAmd = discount_amd !== undefined ? Number(discount_amd) : 0;
  if (!Number.isFinite(discountAmd) || discountAmd < 0) {
    return res.status(400).json({ error: "discount_amd must be a non-negative number" });
  }
  // The two discount kinds are mutually exclusive -- a flat amount takes
  // priority if a caller somehow sent both.
  if (discountAmd > 0) discountPct = 0;

  const { rows: customerRows } = await pool.query("SELECT id, name, erp_customer_id FROM customers WHERE id = $1", [customerId]);
  const customer = customerRows[0];
  if (!customer) return res.status(404).json({ error: "Customer not found" });

  // An order can never be approved without its customer being linked to an
  // ERP record (see the confirm-transition guard below), so there is no
  // point letting one exist as "submitted" and waiting on a reviewer who
  // can never approve it. It lands as a draft instead -- not visible to
  // reviewers/fulfillment -- until POST /orders/:id/submit links the
  // customer (or confirms it's already linked) and moves it forward.
  const initialStatus = customer.erp_customer_id ? "submitted" : "draft";

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
  const totalAmd = applyDiscount(subtotalAmd, discountPct, discountAmd);
  // A discount needs a director's sign-off before the order can move past
  // "submitted" into fulfillment (see the approval_status gate in PATCH
  // below) -- no discount means nothing to approve.
  const approvalStatus = discountPct > 0 || discountAmd > 0 ? "pending" : "not_required";

  const client = await pool.connect();
  let order;
  try {
    await client.query("BEGIN");
    const orderCode = await nextOrderCode(client);
    const { rows } = await client.query(
      `INSERT INTO orders (customer_id, user_id, checkin_id, status, total_amd, note, discount_pct, discount_amd, approval_status, order_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [customerId, req.user.id, checkin_id || null, initialStatus, totalAmd, note || null, discountPct, discountAmd, approvalStatus, orderCode]
    );
    order = rows[0];
    for (const line of lines) {
      await client.query(
        `INSERT INTO order_items (order_id, product_id, product_name, brand, unit_price_amd, quantity, line_total_amd)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [order.id, line.product_id, line.product_name, line.brand, line.unit_price_amd, line.quantity, line.line_total_amd]
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
  // trip for their order confirmation. Wrapped so a late DB hiccup here
  // can't throw after headers are already sent (which would otherwise
  // crash the handler with ERR_HTTP_HEADERS_SENT). Skipped entirely for a
  // draft -- reviewers/fulfillment have nothing to act on until it's
  // actually submitted.
  if (initialStatus !== "submitted") return;
  (async () => {
    try {
      const { rows: repRows } = await pool.query("SELECT name FROM users WHERE id = $1", [req.user.id]);
      const repName = repRows[0]?.name || "Someone";
      const discountSuffix =
        discountAmd > 0
          ? ` (${discountAmd.toLocaleString()} AMD discount, pending director approval)`
          : discountPct > 0
          ? ` (${discountPct}% discount, pending director approval)`
          : "";
      notifyTelegram(
        `🛒 <b>New order</b>\n${escapeHtml(repName)} — ${escapeHtml(customer.name)}\n${lines.length} item${lines.length === 1 ? "" : "s"}, ${Number(totalAmd).toLocaleString()} AMD${escapeHtml(discountSuffix)}`
      );

      const { rows: notifyRecipients } = await pool.query("SELECT id FROM users WHERE role = ANY($1)", [ORDER_NOTIFY_ROLES]);
      for (const recipient of notifyRecipients) {
        notifyUser(recipient.id, "order_placed", {
          title: "New order placed",
          body: `${repName} placed an order for ${customer.name} — ${lines.length} item${lines.length === 1 ? "" : "s"}, ${Number(totalAmd).toLocaleString()} AMD.${discountSuffix}`,
          url: "/#/orders",
        });
      }
    } catch (err) {
      console.error("Post-order notification failed:", err);
    }
  })();
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
    `SELECT o.*, u.name AS user_name, c.name AS customer_name, c.sales_channel
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

// Backs the badge on the Orders nav icon -- how many orders are sitting in
// "submitted" waiting on a confirm/reject/edit decision. Declared ahead of
// GET /:id so Express doesn't try to match "pending-count" as an :id.
ordersRouter.get("/pending-count", async (req, res) => {
  if (!canConfirmOrders(req.user.role)) return res.json({ count: 0 });
  const { rows } = await pool.query("SELECT COUNT(*)::int AS count FROM orders WHERE status = 'submitted'");
  res.json({ count: rows[0].count });
});

ordersRouter.get("/:id", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT o.*, u.name AS user_name, c.name AS customer_name, c.erp_customer_id
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

// Moves a draft order to "submitted" -- the only path that transition can
// take (see NEXT_STATUS, where "submitted" isn't reachable from "draft" via
// the generic PATCH below). If the customer still has no ERP customer ID,
// one must be supplied here and passes through the same ownership check as
// the dedicated "assign ERP ID" sheet on the customer page.
ordersRouter.post("/:id/submit", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT o.*, c.erp_customer_id, c.created_by AS customer_created_by, c.name AS customer_name
     FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = $1`,
    [req.params.id]
  );
  const order = rows[0];
  if (!order) return res.status(404).json({ error: "Order not found" });
  if (order.user_id !== req.user.id && req.user.role !== "admin") {
    return res.status(403).json({ error: "Not allowed to submit this order" });
  }
  if (order.status !== "draft") {
    return res.status(409).json({ error: `Cannot submit an order that is already "${order.status}"` });
  }

  let erpCustomerId = order.erp_customer_id;
  if (!erpCustomerId) {
    const { erp_customer_id } = req.body ?? {};
    if (!erp_customer_id || !String(erp_customer_id).trim()) {
      return res.status(400).json({ error: "This customer has no ERP customer ID -- provide one to submit the order" });
    }
    if (!canAssignErpCustomerId(req.user.role, order.customer_created_by, req.user.id)) {
      return res.status(403).json({ error: "Not allowed to assign an ERP customer ID to this customer" });
    }
    erpCustomerId = String(erp_customer_id).trim();
    await pool.query("UPDATE customers SET erp_customer_id = $1 WHERE id = $2", [erpCustomerId, order.customer_id]);
  }

  const { rows: updatedRows } = await pool.query(
    "UPDATE orders SET status = 'submitted', updated_at = now() WHERE id = $1 RETURNING *",
    [order.id]
  );
  const updated = updatedRows[0];
  const { rows: items } = await pool.query("SELECT * FROM order_items WHERE order_id = $1 ORDER BY id", [order.id]);
  res.json({ ...updated, items });

  (async () => {
    try {
      const { rows: repRows } = await pool.query("SELECT name FROM users WHERE id = $1", [req.user.id]);
      const repName = repRows[0]?.name || "Someone";
      notifyTelegram(
        `🛒 <b>New order</b>\n${escapeHtml(repName)} — ${escapeHtml(order.customer_name)}\n${Number(order.total_amd).toLocaleString()} AMD`
      );
      const { rows: notifyRecipients } = await pool.query("SELECT id FROM users WHERE role = ANY($1)", [ORDER_NOTIFY_ROLES]);
      for (const recipient of notifyRecipients) {
        notifyUser(recipient.id, "order_placed", {
          title: "New order placed",
          body: `${repName} submitted an order for ${order.customer_name} — ${Number(order.total_amd).toLocaleString()} AMD.`,
          url: "/#/orders",
        });
      }
    } catch (err) {
      console.error("Post-order-submit notification failed:", err);
    }
  })();
});

// Edit line items (only while still "submitted", by the rep who placed it
// or an admin) and/or move the order's fulfillment status forward or to
// "cancelled". Both can be sent in the same request.
ordersRouter.patch("/:id", async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM orders WHERE id = $1", [req.params.id]);
  const order = rows[0];
  if (!order) return res.status(404).json({ error: "Order not found" });

  const { status, items, note, discount_pct, discount_amd } = req.body ?? {};
  if (status === undefined && items === undefined && note === undefined && discount_pct === undefined && discount_amd === undefined) {
    return res.status(400).json({ error: "status, items, note, discount_pct, or discount_amd is required" });
  }

  const isOwnerOrAdmin = order.user_id === req.user.id || req.user.role === "admin";
  // A sales director (or admin) reviewing a fresh order can confirm/reject
  // it or fix a mistake in it, same editing rights as the rep who placed it
  // -- but only while it's still "submitted"; once it's moved on, editing
  // goes back to owner/admin only.
  const canEditSubmitted = isOwnerOrAdmin || (order.status === "submitted" && canConfirmOrders(req.user.role));
  let nextLines = null;
  let nextTotal = order.total_amd;
  let nextDiscountPct = Number(order.discount_pct);
  let nextDiscountAmd = Number(order.discount_amd);
  let nextApprovalStatus = order.approval_status;

  if (discount_pct !== undefined || discount_amd !== undefined) {
    if (!canEditSubmitted) return res.status(403).json({ error: "Not allowed to edit this order" });
    if (order.status !== "submitted") {
      return res.status(409).json({ error: "Only a submitted order's discount can still be changed" });
    }
    if (discount_pct !== undefined) {
      const parsed = Number(discount_pct);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
        return res.status(400).json({ error: "discount_pct must be a number between 0 and 100" });
      }
      nextDiscountPct = parsed;
      // Setting one discount kind always clears the other -- an order
      // carries at most one active discount.
      if (parsed > 0) nextDiscountAmd = 0;
    }
    if (discount_amd !== undefined) {
      const parsed = Number(discount_amd);
      if (!Number.isFinite(parsed) || parsed < 0) {
        return res.status(400).json({ error: "discount_amd must be a non-negative number" });
      }
      nextDiscountAmd = parsed;
      if (parsed > 0) nextDiscountPct = 0;
    }
    // Changing the discount always resets any prior director decision --
    // none needs no approval, anything else needs a fresh sign-off even if
    // a previous (different) discount on this order was already approved.
    nextApprovalStatus = nextDiscountPct > 0 || nextDiscountAmd > 0 ? "pending" : "not_required";
  }

  if (items !== undefined) {
    if (!canEditSubmitted) return res.status(403).json({ error: "Not allowed to edit this order" });
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

  if (nextLines || discount_pct !== undefined || discount_amd !== undefined) {
    // Editing items recomputes the subtotal, but a discount already
    // approved (or awaiting approval) still applies to whatever the order
    // now totals -- it shouldn't silently vanish just because the rep
    // swapped a line.
    const subtotal = nextLines
      ? nextLines.reduce((sum, l) => sum + l.line_total_amd, 0)
      : (await pool.query("SELECT COALESCE(SUM(line_total_amd), 0) AS subtotal FROM order_items WHERE order_id = $1", [order.id])).rows[0]
          .subtotal;
    nextTotal = applyDiscount(Number(subtotal), nextDiscountPct, nextDiscountAmd);
  }

  let nextStatus = order.status;
  if (status !== undefined) {
    // A director (or admin) reviewing a fresh order can confirm it or
    // reject it (set status to "cancelled") -- same as the rep who placed
    // it or fulfillment staff can, but only while it's still "submitted".
    const canReviewSubmitted = order.status === "submitted" && canConfirmOrders(req.user.role);
    if (status === "cancelled") {
      if (!isOwnerOrAdmin && !FULFILLMENT_ROLES.has(req.user.role) && !canReviewSubmitted) {
        return res.status(403).json({ error: "Not allowed to cancel this order" });
      }
    } else {
      if (!FULFILLMENT_ROLES.has(req.user.role) && !canReviewSubmitted) {
        return res.status(403).json({ error: "Only warehouse/delivery staff -- or a director confirming a new order -- can update fulfillment status" });
      }
      if (order.approval_status === "pending" || order.approval_status === "rejected") {
        return res.status(409).json({
          error:
            order.approval_status === "pending"
              ? "This order's price change is awaiting director approval"
              : "This order's price change was rejected -- edit the order to remove or adjust it before it can proceed",
        });
      }
    }
    if (!NEXT_STATUS[order.status]?.includes(status)) {
      return res.status(409).json({ error: `Cannot move an order from "${order.status}" to "${status}"` });
    }
    if (!GENERIC_PATCH_TARGETS.has(status)) {
      return res.status(400).json({
        error: `"${status}" requires the dedicated warehouse/delivery endpoint, not a plain status edit`,
      });
    }
    // Defense in depth: draft orders can only reach "submitted" through
    // POST /:id/submit (see NEXT_STATUS, which doesn't even list it as
    // reachable from here), but a submitted order could in principle have
    // had its customer's ERP link removed after the fact -- re-check right
    // before confirming rather than trusting the state at submit time.
    if (status === "confirmed") {
      const { rows: cRows } = await pool.query("SELECT erp_customer_id FROM customers WHERE id = $1", [order.customer_id]);
      if (!cRows[0]?.erp_customer_id) {
        return res.status(409).json({ error: "This order's customer has no ERP customer ID -- link one before confirming" });
      }
    }
    nextStatus = status;
  }

  // Confirming an order isn't a resting state -- it immediately enters the
  // Warehouse Manager's queue (see task spec: "order confirmed -> enters
  // warehouse_review, notifies WM"). Chaining it here keeps that a single
  // atomic write instead of a second round trip.
  const enteringWarehouseReview = nextStatus === "confirmed";
  if (enteringWarehouseReview) nextStatus = "warehouse_review";

  const client = await pool.connect();
  let updated;
  try {
    await client.query("BEGIN");
    const { rows: updatedRows } = await client.query(
      `UPDATE orders
       SET status = $1, total_amd = $2, note = COALESCE($3, note),
           discount_pct = $4, discount_amd = $7, approval_status = $5, updated_at = now()
       WHERE id = $6 RETURNING *`,
      [nextStatus, nextTotal, note ?? null, nextDiscountPct, nextApprovalStatus, order.id, nextDiscountAmd]
    );
    updated = updatedRows[0];

    if (nextLines) {
      await client.query("DELETE FROM order_items WHERE order_id = $1", [order.id]);
      for (const line of nextLines) {
        await client.query(
          `INSERT INTO order_items (order_id, product_id, product_name, brand, unit_price_amd, quantity, line_total_amd)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [order.id, line.product_id, line.product_name, line.brand, line.unit_price_amd, line.quantity, line.line_total_amd]
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
  (async () => {
    try {
      if (status !== undefined && nextStatus !== order.status && req.user.id !== order.user_id) {
        const { rows: customerRows } = await pool.query("SELECT name FROM customers WHERE id = $1", [order.customer_id]);
        notifyUser(order.user_id, "order_status_changed", {
          title: "Order update",
          body: `${customerRows[0]?.name || "Order"} is now "${nextStatus === "warehouse_review" ? "confirmed" : nextStatus}".`,
          url: "/#/orders",
        });
      }
      if (enteringWarehouseReview) {
        const { rows: customerRows } = await pool.query("SELECT name FROM customers WHERE id = $1", [order.customer_id]);
        const customerName = customerRows[0]?.name || "Order";
        const { rows: wmRows } = await pool.query("SELECT id FROM users WHERE role = ANY($1)", [WAREHOUSE_NOTIFY_ROLES]);
        for (const wm of wmRows) {
          notifyUser(wm.id, "order_warehouse_review", {
            title: "Order ready for warehouse",
            body: `${customerName}'s order was confirmed and is ready to pick and pack.`,
            url: "/#/warehouse",
          });
        }
      }
    } catch (err) {
      console.error("Post-order-update notification failed:", err);
    }
  })();
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

  (async () => {
    try {
      const { rows: customerRows } = await pool.query("SELECT name FROM customers WHERE id = $1", [order.customer_id]);
      const customerName = customerRows[0]?.name || "Order";

      // Now that the discount is cleared, the accountant is the next stop --
      // same order_placed preference gate a rep's original order used.
      const { rows: accountants } = await pool.query("SELECT id FROM users WHERE role = 'accountant'");
      for (const accountant of accountants) {
        notifyUser(accountant.id, "order_placed", {
          title: "Order discount approved",
          body: `${customerName}'s discounted order was approved and is ready for fulfillment.`,
          url: "/#/orders",
        });
      }
      if (req.user.id !== order.user_id) {
        notifyUser(order.user_id, "order_status_changed", {
          title: "Discount approved",
          body: `${customerName}'s order discount was approved.`,
          url: "/#/orders",
        });
      }
    } catch (err) {
      console.error("Post-discount-approval notification failed:", err);
    }
  })();
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

  (async () => {
    try {
      if (req.user.id !== order.user_id) {
        const { rows: customerRows } = await pool.query("SELECT name FROM customers WHERE id = $1", [order.customer_id]);
        notifyUser(order.user_id, "order_status_changed", {
          title: "Discount rejected",
          body: `${customerRows[0]?.name || "Order"}'s discount was rejected -- edit the order or remove the discount to proceed.`,
          url: "/#/orders",
        });
      }
    } catch (err) {
      console.error("Post-discount-rejection notification failed:", err);
    }
  })();
});

// Permanent removal (not the same as cancelling, which keeps the order as
// a record) -- admin-only, for a duplicate or mistaken order that
// shouldn't appear in reports at all. order_items cascades with it.
ordersRouter.delete("/:id", requireAdmin, async (req, res) => {
  const { rowCount } = await pool.query("DELETE FROM orders WHERE id = $1", [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: "Order not found" });
  res.status(204).end();
});
