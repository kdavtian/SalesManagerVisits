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
//     marked by hand after the product's Excel stock last CHANGED, so the synced stock cannot include them yet).
//   + pieces of purchases received in the app (Warehouse > Incoming) that Excel does not show yet: no Excel purchase invoice of the same
//     number and date (erp_purchase_lines, from the bot), inside ARRIVED_WINDOW_DAYS.
// Packed orders follow the same 14-day "Excel clock" as deliveries (review 2026-11-23): a packed order the sync could not move to
// delivered (the accountant entered the sale under another total) used to be subtracted for ever.
// Orders only submitted or confirmed are NOT subtracted: their goods are still on the shelf (unlike products.js "reserved", which answers
// "how much can still be sold"). Unknown Excel stock stays unknown (NULL).
//
// `p` must be the products row alias of the surrounding query.
export const MATCH_WINDOW_DAYS = 14; // erpAutoMatch.js markAppRowsInExcel: erp.d <= delivered_d + 14
// The three corrections as separate pieces, so the stock count can SHOW where its number comes from (appStockParts) and the total below
// is built from exactly the same SQL. `p` must be the products row alias of the surrounding query.
// The Excel's "now": the newest order date the workbook holds (+1 day). An unmatched delivery is released after MATCH_WINDOW_DAYS of THAT clock,
// not of the wall clock: when the upload stops for two weeks (a holiday, a broken bot) the app must not hand those pieces back to sale while the
// Excel stock still includes them (review of 2026-11-11). No Excel orders at all: the wall clock.
export const EXCEL_NOW_SQL = `LEAST(now(), COALESCE((SELECT max(order_date) FROM erp_order_lines)::timestamp AT TIME ZONE 'Asia/Yerevan' + interval '1 day', now()))`;
export const PACKED_AT = `COALESCE((SELECT max(h.changed_at) FROM order_status_history h WHERE h.order_id = o.id AND h.new_status = 'packed_stock_out'), o.updated_at)`;
// Packed and taken out, inside the match window (updated_at first: a packing is never later than the order's last change). `o` = the orders alias.
export const PACKED_OUT_COND = `(o.status = 'packed_stock_out' AND o.updated_at > ${EXCEL_NOW_SQL} - interval '${MATCH_WINDOW_DAYS} days' AND ${PACKED_AT} > ${EXCEL_NOW_SQL} - interval '${MATCH_WINDOW_DAYS} days')`;
export const PACKED_OUT_SQL = `COALESCE((SELECT SUM(oi.quantity) FROM order_items oi JOIN orders o ON o.id = oi.order_id
              WHERE oi.product_id = p.id AND o.cancelled_at IS NULL AND ${PACKED_OUT_COND}), 0)`;
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
// `r` = order_returns, `ri` = order_return_items, `p` = products.
export const RETURNS_BACK_COND = `(r.kind = 'return' AND r.status = 'done' AND COALESCE(ri.condition, 'good') = 'good'
                AND (r.recorded_at IS NULL OR (r.recorded_via = 'manual' AND p.stock_changed_at IS NOT NULL AND r.recorded_at > p.stock_changed_at)))`;
export const RETURNS_BACK_SQL = `COALESCE((SELECT SUM(ri.quantity) FROM order_return_items ri JOIN order_returns r ON r.id = ri.return_id
              WHERE ri.product_id = p.id AND ${RETURNS_BACK_COND}), 0)`;
// Purchases received in the app that the Excel does not show yet (review 2026-11-23). "In Excel" = the bot sent an Excel purchase invoice of the
// same number and date (erp_purchase_lines, the same pairing as the Purchases screen). While the bot sends no purchases at all, the older rule:
// received after the product's Excel stock last changed. Only ARRIVED_WINDOW_DAYS: an invoice never entered must not stay added for ever.
// `i` = purchase_invoices, `p` = products.
export const ARRIVED_WINDOW_DAYS = 14;
const INVOICE_KEY = (col) => `lower(regexp_replace(trim(${col}), '\\s+', ' ', 'g'))`;
export const ARRIVED_NOT_IN_EXCEL_COND = `(i.status = 'arrived' AND i.arrived_at IS NOT NULL AND i.arrived_at > now() - interval '${ARRIVED_WINDOW_DAYS} days'
     AND NOT EXISTS (SELECT 1 FROM erp_purchase_lines e WHERE e.invoice_date = i.invoice_date AND ${INVOICE_KEY("e.invoice_no")} = ${INVOICE_KEY("i.invoice_no")})
     AND (EXISTS (SELECT 1 FROM erp_purchase_lines) OR i.arrived_at > COALESCE(p.stock_changed_at, '-infinity'::timestamptz)))`;
export const ARRIVED_NOT_IN_EXCEL_SQL = `COALESCE((SELECT SUM(COALESCE(l.received_qty, l.qty)) FROM purchase_lines l JOIN purchase_invoices i ON i.id = l.invoice_id
              WHERE l.product_id = p.id AND ${ARRIVED_NOT_IN_EXCEL_COND}), 0)`;
// An order HOLDS stock (it is subtracted from the Excel stock to get what can still be sold) while it is open, packed and out, or delivered in
// the app and not yet found in the Excel (the same "not in Excel yet" rule as DELIVERED_NOT_IN_EXCEL_SQL above). `o` = the orders alias.
// Owner, 2026-11-11 (Castrol Dexron VI 1L showed 0 although it is on the shelf, "17 pcs in other orders" nowhere to be found): the catalogue and
// the out-of-stock guard used "delivered and changed after the product's last stock sync" instead. A delivered order the Excel ALREADY holds
// (moved to delivered by the sync itself, or edited later: a signature, a payment link) was subtracted a second time, for as long as that
// product's Excel quantity did not change (synced_at only moves when it does).
// Owner, 2026-11-11: a SUBMITTED order (not yet confirmed) does not hold stock -- the availability is not reduced by it; the order screen warns
// the rep instead when submitted orders already want the pieces (SUBMITTED_SQL), and confirming checks the real stock (orderStock.js).
export const HOLDS_STOCK_SQL = `(o.cancelled_at IS NULL AND (o.status = 'confirmed' OR ${PACKED_OUT_COND} OR ${DELIVERED_NOT_IN_EXCEL_COND}))`;
export const SUBMITTED_SQL = `(o.cancelled_at IS NULL AND o.status = 'submitted')`;
export const APP_STOCK_SQL = `(p.stock_qty - ${PACKED_OUT_SQL} - ${DELIVERED_NOT_IN_EXCEL_SQL} + ${RETURNS_BACK_SQL} + ${ARRIVED_NOT_IN_EXCEL_SQL})`;

// FREE STOCK: what can still be sold (owner, 2026-11-23: one meaning of "reserved" everywhere a rep sells). The same definition in the catalogue,
// the product card, KAD OS, the order screen, the save / confirm checks and the Warehouse list:
//   free = Excel stock − held by orders (HOLDS_STOCK_SQL: confirmed, packed and out, delivered but not in Excel yet)
//          + good returns not in Excel yet + purchases received but not in Excel yet
// Submitted orders are NOT held (owner, 2026-11-11 and 2026-11-23); planning screens (To order, days left) add them on top (warehouse.js).
// `p` = products. heldSql(excludeOrder): an order's own lines never hold stock against itself (excludeOrder = an SQL expression, e.g. "$2").
export const heldSql = (excludeOrder = null) => `COALESCE((SELECT SUM(oi.quantity) FROM order_items oi JOIN orders o ON o.id = oi.order_id
              WHERE oi.product_id = p.id${excludeOrder ? ` AND o.id IS DISTINCT FROM ${excludeOrder}` : ""} AND ${HOLDS_STOCK_SQL}), 0)`;
export const SUBMITTED_QTY_SQL = `COALESCE((SELECT SUM(oi.quantity) FROM order_items oi JOIN orders o ON o.id = oi.order_id
              WHERE oi.product_id = p.id AND ${SUBMITTED_SQL}), 0)`;
// Back on the shelf but not in the Excel stock yet: added to the Excel stock by every stock number that means "on the shelf".
export const BACK_ON_SHELF_SQL = `(${RETURNS_BACK_SQL} + ${ARRIVED_NOT_IN_EXCEL_SQL})`;
export const freeStockSql = (excludeOrder = null) => `(p.stock_qty - ${heldSql(excludeOrder)} + ${BACK_ON_SHELF_SQL})`;

/** Where the app's number comes from, per product: Excel stock, packed out, delivered but not in Excel yet, returns back, purchases received. As of now. */
export async function appStockParts(db, productIds) {
  if (!productIds.length) return new Map();
  const { rows } = await db.query(
    `SELECT p.id, p.stock_qty AS excel, ${PACKED_OUT_SQL}::int AS packed_out, ${DELIVERED_NOT_IN_EXCEL_SQL}::int AS delivered_not_in_excel,
            ${RETURNS_BACK_SQL}::int AS returns_back, ${ARRIVED_NOT_IN_EXCEL_SQL}::int AS arrived_not_in_excel, ${DELIVERED_OLDER_NOT_IN_EXCEL_SQL}::int AS older_not_in_excel, to_char(p.synced_at AT TIME ZONE 'Asia/Yerevan', 'DD.MM HH24:MI') AS synced_at
     FROM products p WHERE p.id = ANY($1)`,
    [productIds]
  );
  return new Map(rows.map((r) => [r.id, { excel: r.excel, packed_out: r.packed_out, delivered_not_in_excel: r.delivered_not_in_excel, returns_back: r.returns_back, arrived_not_in_excel: r.arrived_not_in_excel, older_not_in_excel: r.older_not_in_excel, synced_at: r.synced_at }]));
}
