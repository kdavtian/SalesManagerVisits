// What the demand model (demandModel.js) needs from the database, for every product in two queries: the weekly sales of the last 26
// weeks from the Excel order lines (keyed by the ERP product id), and the pieces open orders have already reserved (keyed by product id).
import { MODEL, bucketWeeks } from "./demandModel.js";

export async function loadDemandInputs(db, today) {
  const [{ rows: weeks }, { rows: reserved }] = await Promise.all([
    db.query(
      `SELECT product_id, floor(($1::date - order_date) / 7)::int AS wk, SUM(qty) AS qty
         FROM erp_order_lines
        WHERE product_id IS NOT NULL AND order_date <= $1::date AND order_date > $1::date - ($2::int * 7)
        GROUP BY product_id, wk`,
      [today, MODEL.weeks]
    ),
    db.query(
      `SELECT oi.product_id, SUM(oi.quantity)::int AS qty
         FROM order_items oi JOIN orders o ON o.id = oi.order_id
        WHERE o.status IN ('submitted', 'confirmed', 'packed_stock_out') AND oi.product_id IS NOT NULL
        GROUP BY oi.product_id`
    ),
  ]);
  return { weekly: bucketWeeks(weeks), reserved: new Map(reserved.map((r) => [r.product_id, Number(r.qty)])) };
}
