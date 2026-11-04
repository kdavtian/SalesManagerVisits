// The stock the app knows is on the shelf right now (owner, 2026-11-04: "the stock count should be compared with real product stock quantity
// from app, not from excel, as the recent sales may be not recorded in excel"). Used by the stock count (stockCount.js) as the number the
// counted quantity is compared with ("Ծրագրով մնացորդ").
//
//   Excel stock (products.stock_qty, as of the last sync products.synced_at)
//   - pieces packed and taken out of the warehouse (order status packed_stock_out: Excel does not have them until the order is delivered /
//     matched with the workbook)
//   - pieces of orders delivered in the app after that sync (Excel does not have them yet). An order the ERP sync itself marked delivered
//     (delivered_from_erp) is already in the workbook, so it is never subtracted. The delivery time is read from the status history, not
//     orders.updated_at, which later edits of an old order also move.
//   + pieces of returns the warehouse received back in good condition after that sync (Excel gets the negative line later).
// Orders only submitted or confirmed are NOT subtracted: their goods are still on the shelf (unlike products.js "reserved", which answers
// "how much can still be sold"). Unknown Excel stock stays unknown (NULL).
//
// `p` must be the products row alias of the surrounding query.
export const APP_STOCK_SQL = `(p.stock_qty
  - COALESCE((SELECT SUM(oi.quantity) FROM order_items oi JOIN orders o ON o.id = oi.order_id
              WHERE oi.product_id = p.id AND o.cancelled_at IS NULL
                AND (o.status = 'packed_stock_out'
                     OR (o.status = 'delivered' AND NOT o.delivered_from_erp AND p.synced_at IS NOT NULL
                         AND (SELECT max(h.changed_at) FROM order_status_history h WHERE h.order_id = o.id AND h.new_status = 'delivered') > p.synced_at))), 0)
  + COALESCE((SELECT SUM(ri.quantity) FROM order_return_items ri JOIN order_returns r ON r.id = ri.return_id
              WHERE ri.product_id = p.id AND r.kind = 'return' AND r.status = 'done' AND COALESCE(ri.condition, 'good') = 'good'
                AND p.synced_at IS NOT NULL AND r.received_at > p.synced_at), 0)
)`;
