// The stock the app knows is on the shelf right now (owner, 2026-11-04: "the stock count should be compared with real product stock quantity
// from app, not from excel, as the recent sales may be not recorded in excel"). Used by the stock count (stockCount.js) as the number the
// counted quantity is compared with ("Ծրագրով մնացորդ").
//
//   Excel stock (products.stock_qty, as of the last sync)
//   - pieces packed and taken out of the warehouse (order status packed_stock_out) that Excel does not have yet
//   - pieces of orders delivered in the app that Excel does not hold yet: no "found in Excel" link (erp_matched_order_id, set by the sync
//     in erpAutoMatch.js). The same "not in Excel yet" rule as the live debt (money/liveDebt.js): a sync alone does not prove the
//     accountant entered the sale, only the match does. Only deliveries of the last MATCH_WINDOW_DAYS: the sync looks for an order in the
//     workbook up to 14 days after its delivery, so an older one that never matched (a customer with no ERP id, a total entered
//     differently) is taken as already in the Excel stock instead of being subtracted forever.
//   + pieces of returns the warehouse received back in good condition that Excel does not hold yet (order_returns.recorded_at empty, or
//     marked by hand after the last product sync, so the synced stock cannot include them yet).
// Orders only submitted or confirmed are NOT subtracted: their goods are still on the shelf (unlike products.js "reserved", which answers
// "how much can still be sold"). Unknown Excel stock stays unknown (NULL).
//
// "Excel does not have it yet" is also checked line by line (owner, 2026-11-04: Edge 0W-20 C5 1L showed 159 against 157 on the shelf):
// an order whose whole total did not match an Excel order (the accountant changed a price or a discount) is still in Excel when Excel
// shows a sale of THIS product, the SAME quantity, to the SAME customer, dated from the day before the order on, on an Excel order no
// other app order is linked to. Such a line is not subtracted -- the synced stock already went down by it. One Excel line covers one app
// line: with two identical app lines (same customer, product, quantity) and one Excel line, only the older app line counts as in Excel.
//
// `p` must be the products row alias of the surrounding query.
import { MATCH_WINDOW_DAYS } from "../erp/erpAutoMatch.js";

export { MATCH_WINDOW_DAYS };
// The line-by-line check below: a line is in Excel when Excel has at least as many free lines like it (customer, product, quantity) as
// there are such app lines up to this one, oldest first.
// An order line still off the shelf but maybe not in Excel: packed, or delivered without the "found in Excel" link, recently.
const pending = (o) => `${o}.cancelled_at IS NULL
  AND (${o}.status = 'packed_stock_out'
       OR (${o}.status = 'delivered' AND ${o}.erp_matched_order_id IS NULL AND NOT ${o}.delivered_from_erp
           AND COALESCE((SELECT max(h.changed_at) FROM order_status_history h WHERE h.order_id = ${o}.id AND h.new_status = 'delivered'), ${o}.updated_at)
               > now() - interval '${MATCH_WINDOW_DAYS} days'))`;

export const APP_STOCK_SQL = `(p.stock_qty
  - COALESCE((SELECT SUM(oi.quantity) FROM order_items oi JOIN orders o ON o.id = oi.order_id
              WHERE oi.product_id = p.id AND ${pending("o")}
                AND (SELECT count(*) FROM customers c JOIN erp_order_lines l ON l.erp_customer_id = c.erp_customer_id
                     WHERE c.id = o.customer_id AND p.erp_product_id IS NOT NULL AND lower(l.product_id) = lower(p.erp_product_id)
                       AND l.qty = oi.quantity AND l.order_date >= (o.created_at AT TIME ZONE 'Asia/Yerevan')::date - 1
                       AND NOT EXISTS (SELECT 1 FROM orders x WHERE x.erp_matched_order_id = l.order_id))
                    < (SELECT count(*) FROM order_items oi2 JOIN orders o2 ON o2.id = oi2.order_id
                       WHERE oi2.product_id = p.id AND oi2.quantity = oi.quantity AND o2.customer_id = o.customer_id AND ${pending("o2")}
                         AND (o2.created_at, o2.id, oi2.id) <= (o.created_at, o.id, oi.id))), 0)
  + COALESCE((SELECT SUM(ri.quantity) FROM order_return_items ri JOIN order_returns r ON r.id = ri.return_id
              WHERE ri.product_id = p.id AND r.kind = 'return' AND r.status = 'done' AND COALESCE(ri.condition, 'good') = 'good'
                AND (r.recorded_at IS NULL OR (r.recorded_via = 'manual' AND p.synced_at IS NOT NULL AND r.recorded_at > p.synced_at))), 0)
)`;
