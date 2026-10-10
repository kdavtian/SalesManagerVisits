// Price changes that arrive with the Excel sync: recorded in product_price_history
// (price_type bronze / silver / gold, note "ERP sync", no user) and counted so the
// sales team gets ONE "prices changed" notification per sync. A price that was
// empty/0 before (a new product, a price filled in for the first time) is not a change.
const FIELDS = { bronze_price_amd: "bronze", silver_price_amd: "silver", gold_price_amd: "gold" };

export async function snapshotTierPrices(client, erpProductIds) {
  const { rows } = await client.query(
    "SELECT id, erp_product_id, bronze_price_amd, silver_price_amd, gold_price_amd FROM products WHERE erp_product_id = ANY($1)",
    [erpProductIds]
  );
  return new Map(rows.map((r) => [r.erp_product_id, r]));
}

// Returns the number of distinct products whose price changed.
export async function logTierPriceChanges(client, before, erpProductIds) {
  const after = await snapshotTierPrices(client, erpProductIds);
  const changed = new Set();
  for (const [erpId, now] of after) {
    const was = before.get(erpId);
    if (!was) continue;
    for (const [field, priceType] of Object.entries(FIELDS)) {
      const oldValue = was[field] === null ? null : Number(was[field]);
      const newValue = now[field] === null ? null : Number(now[field]);
      if (!oldValue || !newValue || oldValue === newValue) continue;
      await client.query(
        `INSERT INTO product_price_history (product_id, price_type, old_value, new_value, changed_by, note)
         VALUES ($1, $2, $3, $4, NULL, 'ERP sync')`,
        [now.id, priceType, oldValue, newValue]
      );
      changed.add(now.id);
    }
  }
  return changed.size;
}
