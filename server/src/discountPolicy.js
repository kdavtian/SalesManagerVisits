// Discount rules (owner, 2026-10-10):
//  - a discount up to AUTO_APPROVE_PCT (3 %) is approved automatically,
//    as long as no line drops below the product's net cost;
//  - a bigger discount needs a director: the sales director / operations
//    director may approve only while every line stays at or above net cost;
//    the CEO and admin may approve any discount;
//  - a line below LANDING cost needs the CEO or an admin whatever the discount (price floor, 2026-10-15).
// Net cost = products.net_cost_amd (per unit, same basis as the price). A line
// whose product has no net cost is not checked.
// The workbook's Net Cost (Products!AE) is computed at the Silver price and mixes a per-LITER landing
// cost into a per-PACK price (Products!AA/AB, workbook 2.1.0), which overstates it by ~18 % for packs
// over 1 L -- most 4 L and drum silver prices then look "below cost". So every line's net cost is
// recomputed here at its real selling price with the workbook's own parameters (Products!Z1, AA1,
// AB1, AD1) but per pack: landing + 4 % x price + 20 % VAT on (price - landing) + 18 % profit tax
// on the rest + 790 AMD fixed cost per litre. Where landing cost or pack size is unknown the flat
// workbook net cost is used. Keep the constants in step with the workbook.
export const AUTO_APPROVE_PCT = 3;
const UNLIMITED_APPROVER_ROLES = ["ceo", "admin"];

// Effective discount in percent of the subtotal (flat AMD discounts are converted).
export function effectiveDiscountPct(subtotal, discountPct, discountAmd) {
  if (Number(discountAmd) > 0) return subtotal > 0 ? (Number(discountAmd) / subtotal) * 100 : 0;
  return Number(discountPct) || 0;
}

const MANAGER_PCT = 0.04; // Products!Z1
const PROFIT_TAX_PCT = 0.18; // Products!AA1
const VAT_ON_MARGIN_PCT = 0.2; // Products!AB1
const FIXED_COST_PER_LITER_AMD = 790; // Products!AD1

// product: { net_cost_amd, landing_cost_amd, unit } (unit like "4L"); price = selling price per pack.
export function netCostAtPrice({ net_cost_amd, landing_cost_amd, unit }, price) {
  const flat = Number(net_cost_amd) || 0;
  const landing = Number(landing_cost_amd) || 0;
  const liters = parseFloat(String(unit ?? ""));
  const p = Number(price) || 0;
  if (!(landing > 0) || !(liters > 0) || !(p > 0)) return flat;
  const margin = Math.max(0, p - landing);
  const vat = VAT_ON_MARGIN_PCT * margin;
  return landing + MANAGER_PCT * p + vat + PROFIT_TAX_PCT * (margin - vat) + FIXED_COST_PER_LITER_AMD * liters;
}

// lines: [{ product_id, unit_price_amd, quantity }], total = subtotal after discount.
export async function orderCostCheck(db, lines, subtotal, total) {
  const ids = [...new Set(lines.map((l) => Number(l.product_id)).filter(Number.isInteger))];
  const { rows } = ids.length ? await db.query("SELECT id, net_cost_amd, landing_cost_amd, unit FROM products WHERE id = ANY($1)", [ids]) : { rows: [] };
  const products = new Map(rows.map((r) => [r.id, r]));
  const factor = subtotal > 0 ? Number(total) / subtotal : 1;
  let netCostTotal = 0;
  let belowCost = false;
  // Price floor (owner, 2026-10-15): a line selling BELOW LANDING COST (what the goods really cost us) needs the CEO or
  // an admin, with or without a discount -- a tier price, a special price or a discount can all cause it. Landing, not
  // net cost: net cost carries 790 AMD/L of allocated overhead and would flag ordinary drum sales.
  let belowLanding = false;
  const belowLandingProductIds = [];
  for (const l of lines) {
    const product = products.get(Number(l.product_id));
    if (!product) continue;
    const price = Number(l.unit_price_amd) * factor;
    const landing = Number(product.landing_cost_amd) || 0;
    if (price > 0 && landing > 0 && price < landing - 0.5) {
      belowLanding = true;
      belowLandingProductIds.push(Number(l.product_id));
    }
    if (!(Number(product.net_cost_amd) > 0)) continue;
    const c = netCostAtPrice(product, price);
    netCostTotal += c * Number(l.quantity);
    if (price < c - 0.5) belowCost = true;
  }
  const revenue = Number(total);
  const marginPct = netCostTotal > 0 && revenue > 0 ? ((revenue - netCostTotal) / revenue) * 100 : null;
  return { netCostTotal, revenue, marginPct, belowCost, belowLanding, belowLandingProductIds };
}

// 'not_required' | 'approved' (automatic) | 'pending'
export function decideDiscountApproval({ discountPct, discountAmd, subtotal, belowCost, belowLanding = false }) {
  if (belowLanding) return "pending"; // below landing cost: never automatic, even without a discount
  if (!(Number(discountPct) > 0) && !(Number(discountAmd) > 0)) return "not_required";
  const pct = effectiveDiscountPct(subtotal, discountPct, discountAmd);
  return pct <= AUTO_APPROVE_PCT && !belowCost ? "approved" : "pending";
}

export function canApproveDiscountRole(role, belowCost, belowLanding = false) {
  if (UNLIMITED_APPROVER_ROLES.includes(role)) return true;
  if (belowLanding) return false;
  if (role === "sales_director" || role === "operations_director") return !belowCost;
  return false;
}
