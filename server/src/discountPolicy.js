// Discount rules (owner, 2026-10-10):
//  - a discount up to AUTO_APPROVE_PCT (3 %) is approved automatically,
//    as long as no line drops below the product's net cost;
//  - a bigger discount needs a director: the sales director / operations
//    director may approve only while every line stays at or above net cost;
//    the CEO and admin may approve any discount.
// Net cost = products.net_cost_amd (per unit, same basis as the price). A line
// whose product has no net cost is not checked.
export const AUTO_APPROVE_PCT = 3;
const UNLIMITED_APPROVER_ROLES = ["ceo", "admin"];

// Effective discount in percent of the subtotal (flat AMD discounts are converted).
export function effectiveDiscountPct(subtotal, discountPct, discountAmd) {
  if (Number(discountAmd) > 0) return subtotal > 0 ? (Number(discountAmd) / subtotal) * 100 : 0;
  return Number(discountPct) || 0;
}

// lines: [{ product_id, unit_price_amd, quantity }], total = subtotal after discount.
export async function orderCostCheck(db, lines, subtotal, total) {
  const ids = [...new Set(lines.map((l) => Number(l.product_id)).filter(Number.isInteger))];
  const { rows } = ids.length ? await db.query("SELECT id, net_cost_amd FROM products WHERE id = ANY($1)", [ids]) : { rows: [] };
  const cost = new Map(rows.map((r) => [r.id, Number(r.net_cost_amd) || 0]));
  const factor = subtotal > 0 ? Number(total) / subtotal : 1;
  let netCostTotal = 0;
  let belowCost = false;
  for (const l of lines) {
    const c = cost.get(Number(l.product_id)) || 0;
    if (!c) continue;
    netCostTotal += c * Number(l.quantity);
    if (Number(l.unit_price_amd) * factor < c - 0.5) belowCost = true;
  }
  const revenue = Number(total);
  const marginPct = netCostTotal > 0 && revenue > 0 ? ((revenue - netCostTotal) / revenue) * 100 : null;
  return { netCostTotal, revenue, marginPct, belowCost };
}

// 'not_required' | 'approved' (automatic) | 'pending'
export function decideDiscountApproval({ discountPct, discountAmd, subtotal, belowCost }) {
  if (!(Number(discountPct) > 0) && !(Number(discountAmd) > 0)) return "not_required";
  const pct = effectiveDiscountPct(subtotal, discountPct, discountAmd);
  return pct <= AUTO_APPROVE_PCT && !belowCost ? "approved" : "pending";
}

export function canApproveDiscountRole(role, belowCost) {
  if (UNLIMITED_APPROVER_ROLES.includes(role)) return true;
  if (role === "sales_director" || role === "operations_director") return !belowCost;
  return false;
}
