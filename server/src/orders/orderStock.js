// Out-of-stock guard for every way an order gets products (owner, 2026-10-28: "The system shouldn't allow to put products in order
// which are out of stock"). The New order screen already hid the Add button, but nothing on the server checked: a KAD OS order, an
// order edit, a reorder or a replayed offline order could still carry a product we do not have.
//
// A product is out of stock when its FREE stock leaves nothing: Excel stock minus what other orders hold (confirmed / packed, and delivered
// but not in the Excel yet) plus what is back on the shelf and not in the Excel yet (returns, purchases received) -- appStock.js freeStockSql,
// the same number the catalogue, the product card and KAD OS show. Submitted orders do not hold (owner, 2026-11-11): the
// full-quantity gate is shortStockProducts below, at confirming and at a correction. Unknown stock (no Excel figure) passes for
// our own staff, as on the order screen, but not for a customer ordering in KAD OS (its catalog never shows such a product).
// Only what an order ADDS is checked: a product already in the order may keep its quantity (or go down) when the stock ran out later.
import { pool } from "../db/pool.js";
import { freeStockSql } from "./appStock.js";

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
    `SELECT p.id, p.name, p.unit, p.stock_qty, ${freeStockSql("$2")}::int AS free
     FROM products p WHERE p.id = ANY($1)`,
    [added, excludeOrderId]
  );
  return rows
    .filter((p) => (p.stock_qty === null ? strictUnknown : p.free <= 0))
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
// `lines` = the order's lines as they WILL be (an edit or a correction sent with the same request); default: as stored.
export async function shortStockProducts(orderId, { lines = null, db = pool } = {}) {
  const wanted = new Map();
  for (const l of lines ?? []) {
    const id = Number(l.product_id);
    if (Number.isInteger(id) && Number(l.quantity) > 0) wanted.set(id, (wanted.get(id) ?? 0) + Number(l.quantity));
  }
  const { rows } = await db.query(
    `WITH mine AS (
       SELECT product_id, SUM(quantity)::int AS wanted FROM order_items WHERE $2::int[] IS NULL AND order_id = $1 AND product_id IS NOT NULL GROUP BY product_id
       UNION ALL SELECT id, qty FROM unnest($2::int[], $3::int[]) AS t(id, qty))
     SELECT p.id, p.name, p.unit, mine.wanted,
            ${freeStockSql("$1")}::int AS available
     FROM mine JOIN products p ON p.id = mine.product_id WHERE p.stock_qty IS NOT NULL`,
    [orderId, lines ? [...wanted.keys()] : null, lines ? [...wanted.values()] : null]
  );
  return rows.filter((r) => r.wanted > r.available).map((r) => ({ id: r.id, name: r.name, unit: r.unit, wanted: r.wanted, available: Math.max(0, r.available) }));
}

// Two people confirming the last pieces at the same moment (review 2026-11-23): both checks ran before either order held the stock, so both
// passed. Inside the confirming / correcting transaction each product of the order is locked (always in the same order: no deadlock) and the
// check runs again on that transaction, so the second one waits for the first and then sees its pieces held. Same result shape as shortStockProducts.
const STOCK_LOCK = 7223;
export async function lockAndCheckStock(client, orderId, { lines = null } = {}) {
  const ids = lines
    ? lines.map((l) => Number(l.product_id))
    : (await client.query("SELECT product_id FROM order_items WHERE order_id = $1 AND product_id IS NOT NULL", [orderId])).rows.map((r) => r.product_id);
  for (const id of [...new Set(ids.filter((x) => Number.isInteger(x) && x > 0))].sort((a, b) => a - b)) {
    await client.query("SELECT pg_advisory_xact_lock($1, $2)", [STOCK_LOCK, id]);
  }
  return shortStockProducts(orderId, { lines, db: client });
}
