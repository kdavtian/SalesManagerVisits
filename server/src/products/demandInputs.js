// What the demand model (demandModel.js) needs from the database: the weekly sales of the last 26 weeks from the Excel order lines (keyed by the
// ERP product id). What open orders hold or want is NOT here any more (review 2026-11-23: this file had its own "reserved", the fourth meaning
// of the word): the warehouse routes read it from orders/appStock.js, the one definition.
//
// The weeks count back from the Excel's own "today" -- the newest order date it holds -- not from the wall clock: while the upload lags a few
// days the newest week would otherwise read as a week without sales, carry the highest weight and turn every trend "down" (the same Excel
// clock as appStock.js EXCEL_NOW_SQL).
import { MODEL, bucketWeeks } from "./demandModel.js";

export async function loadDemandInputs(db, today) {
  const { rows: weeks } = await db.query(
    `WITH anchor AS (SELECT LEAST($1::date, COALESCE((SELECT max(order_date) FROM erp_order_lines), $1::date)) AS d)
     SELECT product_id, floor((anchor.d - order_date) / 7)::int AS wk, SUM(qty) AS qty
       FROM erp_order_lines, anchor
      WHERE product_id IS NOT NULL AND order_date <= anchor.d AND order_date > anchor.d - ($2::int * 7)
      GROUP BY product_id, wk`,
    [today, MODEL.weeks]
  );
  return { weekly: bucketWeeks(weeks) };
}
