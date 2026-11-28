// The data side of correcting an order after review (routes/orders.js POST /:id/correct; owner 2026-11-07, Phase 0 items 0.4 / 0.17, 2026-11-28).
// Lines change IN PLACE: a product still on the order keeps its order line (returns and Lily's ln_<id> keep pointing at it); only a removed
// product's line goes, a new product gets a new line. An order whose document Lily is making or made is flagged "order changed after the document".
import { DOCUMENT_STARTED_STATUSES } from "./accountingStatus.js";
import { returnedByProduct } from "./orderReturns.js";

export const ORDER_CHANGED_CODE = "order_changed";
const ORDER_CHANGED_ERROR = JSON.stringify({ code: ORDER_CHANGED_CODE, message: "Order changed after the document" });

/** The order was corrected after its document: a person must fix the document (Lily may still report what she made; nothing wipes it). */
export const isOrderChangedFlag = (order) => order?.accounting_status === "needs_attention" && order?.accounting_error?.code === ORDER_CHANGED_CODE;

/** Each priced line takes over an existing line of the same product, in order (a product twice on the order matches line by line). */
export function matchExistingLines(before, priced) {
  const oldByProduct = new Map();
  for (const b of before) {
    if (!oldByProduct.has(b.product_id)) oldByProduct.set(b.product_id, []);
    oldByProduct.get(b.product_id).push(b);
  }
  const matched = priced.map((l) => ({ line: l, was: oldByProduct.get(l.product_id)?.shift() ?? null }));
  return { matched, goneLineIds: [...oldByProduct.values()].flat().map((b) => b.id) };
}

/**
 * Inside the caller's transaction, after its guarded UPDATE locked the order row: the flag, the checks against what changed meanwhile, the lines.
 * Returns { error: { status, body } } when refused (the caller rolls back), otherwise { order } (the row after the flag).
 */
export async function applyCorrection(client, { orderId, before, lines, goneLineIds, changed }) {
  // the accounting state is read under the row lock: a document Lily reported a moment ago is flagged too; documents are kept
  const { rows: [order] } = await client.query(
    `UPDATE orders SET accounting_status = 'needs_attention', accounting_error = $3::jsonb, accounting_updated_at = now()
      WHERE id = $1 AND $4 AND accounting_status = ANY($2::text[]) RETURNING *`,
    [orderId, DOCUMENT_STARTED_STATUSES, ORDER_CHANGED_ERROR, changed]
  );
  // the lines are still the ones read before (another correction at the same moment, now serialised by the row lock, may have changed them)
  const { rows: nowLines } = await client.query("SELECT id, quantity::float8 AS quantity, unit_price_amd::float8 AS price FROM order_items WHERE order_id = $1 ORDER BY id", [orderId]);
  const key = (ls) => ls.map((l) => `${l.id}:${Number(l.quantity)}:${Number(l.price ?? l.unit_price_amd)}`).join(",");
  if (key(nowLines) !== key(before)) return { error: { status: 409, body: { error: "This order was changed by someone else -- refresh and try again" } } };
  // goods the customer already returned cannot be corrected away (a return request locks the order row too)
  const newQty = new Map();
  for (const l of lines) newQty.set(l.product_id, (newQty.get(l.product_id) ?? 0) + Number(l.quantity));
  const below = (await returnedByProduct(orderId, client)).filter((r) => r.product_id != null && (newQty.get(r.product_id) ?? 0) < r.qty - 1e-9);
  if (below.length) {
    return {
      error: {
        status: 409,
        body: {
          error: `Already returned by the customer: ${below.map((r) => `${r.product_name} (${r.qty} returned)`).join(", ")} -- the order cannot have less than that`,
          code: "below_returned",
          products: below.map((r) => ({ id: r.product_id, name: r.product_name, returned: r.qty })),
        },
      },
    };
  }
  if (goneLineIds.length) await client.query("DELETE FROM order_items WHERE order_id = $1 AND id = ANY($2::int[])", [orderId, goneLineIds]);
  for (const line of lines) {
    const values = [line.product_name, line.brand, line.unit_price_amd, line.quantity, line.line_total_amd, line.campaign_id ?? null, line.list_price_amd ?? null];
    if (line.keepLineId) {
      await client.query(
        `UPDATE order_items SET product_name = $3, brand = $4, unit_price_amd = $5, quantity = $6, line_total_amd = $7, campaign_id = $8, list_price_amd = $9
         WHERE id = $2 AND order_id = $1`,
        [orderId, line.keepLineId, ...values]
      );
    } else {
      await client.query(
        `INSERT INTO order_items (order_id, product_id, product_name, brand, unit_price_amd, quantity, line_total_amd, campaign_id, list_price_amd)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [orderId, line.product_id, ...values]
      );
    }
  }
  return { order: order ?? null };
}
