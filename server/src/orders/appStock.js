// The stock the app knows is on the shelf right now (owner, 2026-11-04: "the stock count should be compared with real product stock quantity
// from app, not from excel, as the recent sales may be not recorded in excel"). Used by the stock count (stockCount.js) as the number the
// counted quantity is compared with ("Ծրագրով մնացորդ").
//
//   Excel stock (products.stock_qty, as of the last sync)
//   - pieces packed and taken out of the warehouse (order status packed_stock_out: Excel does not have them -- an order the workbook
//     shows is moved to delivered by the sync, erpAutoMatch.js)
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
// `p` must be the products row alias of the surrounding query.
export const MATCH_WINDOW_DAYS = 14; // erpAutoMatch.js markAppRowsInExcel: erp.d <= delivered_d + 14
export const APP_STOCK_SQL = `(p.stock_qty
  - COALESCE((SELECT SUM(oi.quantity) FROM order_items oi JOIN orders o ON o.id = oi.order_id
              WHERE oi.product_id = p.id AND o.cancelled_at IS NULL
                AND (o.status = 'packed_stock_out'
                     OR (o.status = 'delivered' AND o.erp_matched_order_id IS NULL AND NOT o.delivered_from_erp
                         AND COALESCE((SELECT max(h.changed_at) FROM order_status_history h WHERE h.order_id = o.id AND h.new_status = 'delivered'), o.updated_at)
                             > now() - interval '${MATCH_WINDOW_DAYS} days'))), 0)
  + COALESCE((SELECT SUM(ri.quantity) FROM order_return_items ri JOIN order_returns r ON r.id = ri.return_id
              WHERE ri.product_id = p.id AND r.kind = 'return' AND r.status = 'done' AND COALESCE(ri.condition, 'good') = 'good'
                AND (r.recorded_at IS NULL OR (r.recorded_via = 'manual' AND p.synced_at IS NOT NULL AND r.recorded_at > p.synced_at))), 0)
)`;
