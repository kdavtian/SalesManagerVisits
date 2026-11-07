function num(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// The list price for a customer tier. Bronze (and potential/competitor)
// pay bronze, falling back to the silver price when bronze is empty;
// silver pays silver, then bronze. Gold pays the SILVER list too (owner,
// 2026-11-07): what makes Gold different is that every product may carry a
// special price for that customer (customer_product_prices). The Excel
// "Price T3 Gold" column is kept on the product for reference only.
export function tierListPrice(product, tier) {
  // A 0 price means "not set" in the catalog, same as null.
  const pos = (v) => (num(v) > 0 ? num(v) : null);
  const bronzeRaw = pos(product.bronze_price_amd) ?? pos(product.unit_price_amd);
  const silverRaw = pos(product.silver_price_amd);
  const bronze = bronzeRaw ?? silverRaw ?? 0;
  if (tier === "silver" || tier === "gold") return silverRaw ?? bronze;
  return bronze;
}

