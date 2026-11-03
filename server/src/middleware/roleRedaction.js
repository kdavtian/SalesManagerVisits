// What a role must never receive, taken out of EVERY JSON answer in one place (owner, 2026-11-03: the warehouse manager sees no tier
// prices and no order amounts). Done on the way out of the server rather than route by route, so a route added later, or a new field in
// an old one, cannot leak: the keys below are removed at any depth. Retail prices stay (retail_price_amd, effective_retail_amd,
// erp_retail_price_amd); so do quantities. The screen hides the matching labels too (roles.js seesOrderAmounts / seesTierPrices).
import { seesOrderAmounts, seesTierPrices } from "../shared/roles.js";

// order and invoice money
const ORDER_MONEY = [
  "total_amd", "line_total_amd", "unit_price_amd", "list_price_amd", "discount_amd", "discount_pct", "app_discount_pct", "downpayment_amd",
  "downpayment_pct", "subtotal_amd", "credit_exposure_amd", "credit_limit_snapshot_amd", "revenue_amd", "pricing_check",
];
// the tier prices (bronze = unit_price_amd, which is also in ORDER_MONEY), promotions and costs
const TIER_PRICES = [
  "bronze_price_amd", "silver_price_amd", "gold_price_amd", "promo_price_amd", "effective_standard_amd", "effective_special_amd",
  "landing_cost_amd", "net_cost_amd", "net_cost_workbook_amd", "pack_cost_usd", "special_price_amd", "wholesale_price_amd",
];

export function keysToHide(role) {
  return new Set([...(seesOrderAmounts(role) ? [] : ORDER_MONEY), ...(seesTierPrices(role) ? [] : [...TIER_PRICES, "unit_price_amd"])]);
}

// A copy of `value` without the hidden keys at any depth (plain objects and arrays only: Dates, Buffers and the like pass through).
export function stripKeys(value, hidden) {
  if (Array.isArray(value)) return value.map((v) => stripKeys(v, hidden));
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const out = {};
    for (const [k, v] of Object.entries(value)) if (!hidden.has(k)) out[k] = stripKeys(v, hidden);
    return out;
  }
  return value;
}

// Called by requireAuth once the person is known: from here on this request's res.json drops the role's hidden keys.
export function applyRoleRedaction(res, role) {
  const hidden = keysToHide(role);
  if (!hidden.size) return;
  const send = res.json.bind(res);
  res.json = (body) => send(stripKeys(body, hidden));
}
