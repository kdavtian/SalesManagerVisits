// Out-of-stock guard for every way an order gets products (owner, 2026-10-28: "The system shouldn't allow to put products in order
// which are out of stock"). The New order screen already hid the Add button, but nothing on the server checked: a KAD OS order, an
// order edit, a reorder or a replayed offline order could still carry a product we do not have.
//
// A product is out of stock when its Excel stock minus what other orders hold (submitted / confirmed / packed, and delivered but not in the
// Excel yet -- appStock.js HOLDS_STOCK_SQL, the same "reserved" as products.js) leaves nothing. Unknown stock (no Excel figure) passes for
// our own staff, as on the order screen, but not for a customer ordering in KAD OS (its catalog never shows such a product).
// Only what an order ADDS is checked: a product already in the order may keep its quantity (or go down) when the stock ran out later.
import { pool } from "../db/pool.js";
import { HOLDS_STOCK_SQL } from "./appStock.js";

export async function outOfStockProducts(items, { excludeOrderId = null, previous = new Map(), strictUnknown = false, db = pool } = {}) {
  const wanted = new Map();
  for (const it of items ?? []) {
    const id = Number(it.product_id);
    const qty = Number(it.quantity);
    if (!Number.isInteger(id) || !(qty > 0)) continue;
    wanted.set(id, (wanted.get(id) ?? 0) + qty);
  }
  const added = [...wanted].filter(([id, qty]) => qty > (previous.get(id) ?? 0)).map(([id]) => id);
  if (!added.length) return [];
  const { rows } = await db.query(
    `SELECT p.id, p.name, p.unit, p.stock_qty,
            COALESCE((SELECT SUM(oi.quantity) FROM order_items oi JOIN orders o ON o.id = oi.order_id
                      WHERE oi.product_id = p.id AND o.id IS DISTINCT FROM $2 AND ${HOLDS_STOCK_SQL}), 0)::int AS reserved
     FROM products p WHERE p.id = ANY($1)`,
    [added, excludeOrderId]
  );
  return rows
    .filter((p) => (p.stock_qty === null ? strictUnknown : Number(p.stock_qty) - p.reserved <= 0))
    .map((p) => ({ id: p.id, name: p.name, unit: p.unit }));
}

export function outOfStockResponse(res, products) {
  return res.status(409).json({
    error: `Out of stock: ${products.map((p) => p.name).join(", ")}. Remove ${products.length > 1 ? "them" : "it"} from the order.`,
    code: "out_of_stock",
    products,
  });
}

// At CONFIRMING (owner, 2026-11-11: submitted orders do not hold stock, so two of them may want the same last pieces): the order's own
// quantities must fit in what is left after the orders that already hold stock. Unknown stock passes. -> [{ id, name, unit, wanted, available }]
export async function shortStockProducts(orderId, db = pool) {
  const { rows } = await db.query(
    `WITH mine AS (SELECT product_id, SUM(quantity)::int AS wanted FROM order_items WHERE order_id = $1 AND product_id IS NOT NULL GROUP BY product_id)
     SELECT p.id, p.name, p.unit, mine.wanted,
            (p.stock_qty - COALESCE((SELECT SUM(oi.quantity) FROM order_items oi JOIN orders o ON o.id = oi.order_id
                                      WHERE oi.product_id = p.id AND o.id <> $1 AND ${HOLDS_STOCK_SQL}), 0))::int AS available
     FROM mine JOIN products p ON p.id = mine.product_id WHERE p.stock_qty IS NOT NULL`,
    [orderId]
  );
  return rows.filter((r) => r.wanted > r.available).map((r) => ({ id: r.id, name: r.name, unit: r.unit, wanted: r.wanted, available: Math.max(0, r.available) }));
}
