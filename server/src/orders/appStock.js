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
// The three corrections as separate pieces, so the stock count can SHOW where its number comes from (appStockParts) and the total below
// is built from exactly the same SQL. `p` must be the products row alias of the surrounding query.
export const PACKED_OUT_SQL = `COALESCE((SELECT SUM(oi.quantity) FROM order_items oi JOIN orders o ON o.id = oi.order_id
              WHERE oi.product_id = p.id AND o.cancelled_at IS NULL AND o.status = 'packed_stock_out'), 0)`;
// The Excel's "now": the newest order date the workbook holds (+1 day). An unmatched delivery is released after MATCH_WINDOW_DAYS of THAT clock,
// not of the wall clock: when the upload stops for two weeks (a holiday, a broken bot) the app must not hand those pieces back to sale while the
// Excel stock still includes them (review of 2026-11-11). No Excel orders at all: the wall clock.
export const EXCEL_NOW_SQL = `LEAST(now(), COALESCE((SELECT max(order_date) FROM erp_order_lines)::timestamp AT TIME ZONE 'Asia/Yerevan' + interval '1 day', now()))`;
export const DELIVERED_AT = `COALESCE((SELECT max(h.changed_at) FROM order_status_history h WHERE h.order_id = o.id AND h.new_status = 'delivered' AND h.old_status IS DISTINCT FROM 'recorded'), o.updated_at)`;
// Delivered in the app, not found in the Excel, inside the match window. `o` = the orders alias. updated_at is checked first (a delivery is never
// later than the order's last change), so the history lookup runs only for the few recent ones -- the products list stays fast.
export const DELIVERED_NOT_IN_EXCEL_COND = `(o.status IN ('delivered', 'recorded') AND o.erp_matched_order_id IS NULL AND NOT o.delivered_from_erp
     AND o.updated_at > ${EXCEL_NOW_SQL} - interval '${MATCH_WINDOW_DAYS} days'
     AND ${DELIVERED_AT} > ${EXCEL_NOW_SQL} - interval '${MATCH_WINDOW_DAYS} days')`;
export const DELIVERED_NOT_IN_EXCEL_SQL = `COALESCE((SELECT SUM(oi.quantity) FROM order_items oi JOIN orders o ON o.id = oi.order_id
              WHERE oi.product_id = p.id AND o.cancelled_at IS NULL AND ${DELIVERED_NOT_IN_EXCEL_COND}), 0)`;
// FOR INFORMATION, never subtracted: delivered in the app 15..180 days ago and still not found in Excel. After MATCH_WINDOW_DAYS the app stops
// subtracting an unmatched delivery (it takes it as already in the Excel stock). If Excel in fact never got that sale (a customer without an
// ERP id, a sale the accountant forgot), the app's number is TOO HIGH by exactly this much: the shelf holds less than the app says.
export const DELIVERED_OLDER_NOT_IN_EXCEL_SQL = `COALESCE((SELECT SUM(oi.quantity) FROM order_items oi JOIN orders o ON o.id = oi.order_id
              WHERE oi.product_id = p.id AND o.cancelled_at IS NULL
                AND o.status IN ('delivered', 'recorded') AND o.erp_matched_order_id IS NULL AND NOT o.delivered_from_erp
                AND ${DELIVERED_AT} BETWEEN ${EXCEL_NOW_SQL} - interval '180 days' AND ${EXCEL_NOW_SQL} - interval '${MATCH_WINDOW_DAYS} days'), 0)`;
export const RETURNS_BACK_SQL = `COALESCE((SELECT SUM(ri.quantity) FROM order_return_items ri JOIN order_returns r ON r.id = ri.return_id
              WHERE ri.product_id = p.id AND r.kind = 'return' AND r.status = 'done' AND COALESCE(ri.condition, 'good') = 'good'
                AND (r.recorded_at IS NULL OR (r.recorded_via = 'manual' AND p.synced_at IS NOT NULL AND r.recorded_at > p.synced_at))), 0)`;
// An order HOLDS stock (it is subtracted from the Excel stock to get what can still be sold) while it is open, packed and out, or delivered in
// the app and not yet found in the Excel (the same "not in Excel yet" rule as DELIVERED_NOT_IN_EXCEL_SQL above). `o` = the orders alias.
// Owner, 2026-11-11 (Castrol Dexron VI 1L showed 0 although it is on the shelf, "17 pcs in other orders" nowhere to be found): the catalogue and
// the out-of-stock guard used "delivered and changed after the product's last stock sync" instead. A delivered order the Excel ALREADY holds
// (moved to delivered by the sync itself, or edited later: a signature, a payment link) was subtracted a second time, for as long as that
// product's Excel quantity did not change (synced_at only moves when it does).
// Owner, 2026-11-11: a SUBMITTED order (not yet confirmed) does not hold stock -- the availability is not reduced by it; the order screen warns
// the rep instead when submitted orders already want the pieces (SUBMITTED_SQL), and confirming checks the real stock (orderStock.js).
export const HOLDS_STOCK_SQL = `(o.cancelled_at IS NULL AND (o.status IN ('confirmed', 'packed_stock_out') OR ${DELIVERED_NOT_IN_EXCEL_COND}))`;
export const SUBMITTED_SQL = `(o.cancelled_at IS NULL AND o.status = 'submitted')`;
export const APP_STOCK_SQL = `(p.stock_qty - ${PACKED_OUT_SQL} - ${DELIVERED_NOT_IN_EXCEL_SQL} + ${RETURNS_BACK_SQL})`;

/** Where the app's number comes from, per product: Excel stock, packed out, delivered but not in Excel yet, returns back. As of now. */
export async function appStockParts(db, productIds) {
  if (!productIds.length) return new Map();
  const { rows } = await db.query(
    `SELECT p.id, p.stock_qty AS excel, ${PACKED_OUT_SQL}::int AS packed_out, ${DELIVERED_NOT_IN_EXCEL_SQL}::int AS delivered_not_in_excel,
            ${RETURNS_BACK_SQL}::int AS returns_back, ${DELIVERED_OLDER_NOT_IN_EXCEL_SQL}::int AS older_not_in_excel, to_char(p.synced_at AT TIME ZONE 'Asia/Yerevan', 'DD.MM HH24:MI') AS synced_at
     FROM products p WHERE p.id = ANY($1)`,
    [productIds]
  );
  return new Map(rows.map((r) => [r.id, { excel: r.excel, packed_out: r.packed_out, delivered_not_in_excel: r.delivered_not_in_excel, returns_back: r.returns_back, older_not_in_excel: r.older_not_in_excel, synced_at: r.synced_at }]));
}
