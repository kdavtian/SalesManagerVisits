// Out-of-stock guard for every way an order gets products (owner, 2026-10-28: "The system shouldn't allow to put products in order
// which are out of stock"). The New order screen already hid the Add button, but nothing on the server checked: a KAD OS order, an
// order edit, a reorder or a replayed offline order could still carry a product we do not have.
//
// A product is out of stock when its Excel stock minus what other open orders already promised (submitted / confirmed / packed, and
// delivered since the last stock sync -- the same "reserved" as products.js) leaves nothing. Unknown stock (no Excel figure) passes for
// our own staff, as on the order screen, but not for a customer ordering in KAD OS (its catalog never shows such a product).
// Only what an order ADDS is checked: a product already in the order may keep its quantity (or go down) when the stock ran out later.
import { pool } from "../db/pool.js";

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
                      WHERE oi.product_id = p.id AND o.id IS DISTINCT FROM $2
                        AND (o.status IN ('submitted', 'confirmed', 'packed_stock_out')
                             OR (o.status = 'delivered' AND p.synced_at IS NOT NULL AND o.updated_at > p.synced_at))), 0)::int AS reserved
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
