// Order returns and cancellations (see ../orderReturns.js). The rep asks, management / the accountant decides, the warehouse manager confirms the goods
// are back, the accountant records it in Excel.
import { Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { canApproveReturns, canReceiveReturns, canRecordReturns } from "../../shared/roles.js";
import { ReturnError, requestReturn, decideReturn, receiveReturn, markRecorded, listReturns, returnCounts, returnedQuantities } from "../orderReturns.js";
import { pool } from "../../db/pool.js";

export const returnsRouter = Router();
returnsRouter.use(requireAuth);

const fail = (res, err) => {
  if (err instanceof ReturnError) return res.status(err.status).json({ error: err.message, code: err.code });
  throw err;
};
const guard = (allowed) => (req, res, next) => (allowed(req.user.role) ? next() : res.status(403).json({ error: "Not allowed" }));

returnsRouter.get("/counts", async (req, res) => res.json(await returnCounts(req.user)));

returnsRouter.get("/", async (req, res) => {
  if (req.user.role === "delivery_manager") return res.status(403).json({ error: "Not allowed" });
  res.json(await listReturns(req.user, { status: req.query.status, orderId: req.query.order_id, customerId: req.query.customer_id }));
});

// What can still be returned from a delivered order (the sheet's steppers).
returnsRouter.get("/order/:orderId/returnable", async (req, res) => {
  const orderId = Number(req.params.orderId);
  const { rows: [order] } = Number.isInteger(orderId) ? await pool.query("SELECT o.user_id, o.status, o.cancelled_at, c.assigned_manager_id FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = $1", [orderId]) : { rows: [] };
  if (!order) return res.status(404).json({ error: "Order not found" });
  if (req.user.role === "sales_manager" && order.user_id !== req.user.id && order.assigned_manager_id !== req.user.id) return res.status(403).json({ error: "Not allowed" });
  const { rows: items } = await pool.query("SELECT id, product_name, brand, quantity::float8 AS quantity, unit_price_amd::float8 AS unit_price_amd FROM order_items WHERE order_id = $1 ORDER BY id", [orderId]);
  const already = await returnedQuantities(orderId);
  res.json({ status: order.status, cancelled: Boolean(order.cancelled_at), kind: order.status === "delivered" ? "return" : ["submitted", "confirmed", "packed_stock_out"].includes(order.status) && !order.cancelled_at ? "cancel" : null, items: items.map((i) => ({ ...i, returned: already.get(i.id) ?? 0, left: i.quantity - (already.get(i.id) ?? 0) })) });
});

returnsRouter.post("/", async (req, res) => {
  try {
    res.status(201).json(await requestReturn(req.user, req.body ?? {}));
  } catch (err) {
    fail(res, err);
  }
});
returnsRouter.post("/:id/approve", guard(canApproveReturns), async (req, res) => {
  try {
    res.json(await decideReturn(req.user, Number(req.params.id), { approve: true, note: req.body?.note }));
  } catch (err) {
    fail(res, err);
  }
});
returnsRouter.post("/:id/reject", guard(canApproveReturns), async (req, res) => {
  try {
    res.json(await decideReturn(req.user, Number(req.params.id), { approve: false, note: req.body?.note }));
  } catch (err) {
    fail(res, err);
  }
});
returnsRouter.post("/:id/receive", guard(canReceiveReturns), async (req, res) => {
  try {
    res.json(await receiveReturn(req.user, Number(req.params.id), req.body ?? {}));
  } catch (err) {
    fail(res, err);
  }
});
returnsRouter.post("/:id/recorded", guard(canRecordReturns), async (req, res) => {
  try {
    res.json(await markRecorded(req.user, Number(req.params.id)));
  } catch (err) {
    fail(res, err);
  }
});
