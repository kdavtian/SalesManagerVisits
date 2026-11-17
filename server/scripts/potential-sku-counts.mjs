#!/usr/bin/env node
// How many products sold in the last 12 months are placed on a volume-potential product line (customers/volumeActuals.js) -- COUNTS ONLY
// (no product names, no customers, no amounts), safe to paste anywhere. Read-only.
//
// Usage (on the droplet, from /opt/field-visits):
//   docker compose exec -T app node scripts/potential-sku-counts.mjs
import { skuMappings } from "../src/customers/volumeActuals.js";
import { pool } from "../src/db/pool.js";

const all = await skuMappings(pool);
const counts = { products_sold_12m: all.length, placed_by_rules: 0, placed_by_management: 0, not_a_line: 0, unmapped: 0 };
const why = {};
for (const m of all) {
  if (m.status === "auto") counts.placed_by_rules += 1;
  else if (m.status === "manual") counts.placed_by_management += 1;
  else if (m.status === "not_a_line") counts.not_a_line += 1;
  else {
    counts.unmapped += 1;
    why[m.reason] = (why[m.reason] ?? 0) + 1;
  }
}
console.log(JSON.stringify({ ...counts, unmapped_why: why }, null, 2));
await pool.end();
