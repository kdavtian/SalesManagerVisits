// Tier price of a catalog product for a customer tier -- shared by the order screen and the "usual order"
// estimate on the customer card. Mirrors tierListPrice on the server: an empty bronze falls back to silver;
// silver AND gold pay the silver list (gold differs only by its special prices, owner 2026-11-07);
// bronze/potential/competitor customers pay the bronze (standard) price.
export function numOrNull(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function tierPrice(product, tier) {
  const pos = (v) => (numOrNull(v) > 0 ? numOrNull(v) : null);
  const silverRaw = pos(product.silver_price_amd);
  const bronze = pos(product.bronze_price_amd) ?? pos(product.unit_price_amd) ?? silverRaw ?? 0;
  if (tier === "silver" || tier === "gold") return silverRaw ?? bronze;
  return bronze;
}
