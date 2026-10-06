// The one-time pricelist seed attaches workbook photos / commercial specs to
// products named like the company's catalogue (name without brand or size).
import test from "node:test";
import assert from "node:assert/strict";
import { cleanupAll, createProduct } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { runPricelistSeedOnce } from "../../src/pricelistSeed.js";

let products = {};

async function mk(name, brand, unit) {
  const p = await createProduct({ name, unit });
  await pool.query("UPDATE products SET brand = $1 WHERE id = $2", [brand, p.id]);
  return p.id;
}

test.before(async () => {
  await pool.query("DELETE FROM data_seeds WHERE name = 'pricelist_photos_v1'");
  products.edge = await mk("Edge 0w20 C5", "Castrol", "1L");
  products.pro = await mk("Edge Professional EC 0w20", "Castrol", "4L");
  products.hyspin = await mk("Hyspin AWS 46", "Castrol", "208L");
  products.other = await mk("Totally Unknown Product", "Castrol", "1L");
});
test.after(async () => {
  await pool.query("DELETE FROM product_images WHERE product_id = ANY($1)", [Object.values(products)]);
  await pool.query("DELETE FROM data_seeds WHERE name = 'pricelist_photos_v1'");
  await cleanupAll();
  await pool.end?.();
});

test("seed attaches photos by model name, flags commercial oils, runs once", async () => {
  const applied = await runPricelistSeedOnce();
  assert.ok(applied && applied.photos >= 2, "photos attached");
  const { rows } = await pool.query("SELECT id, image_path, is_commercial, cardinality(approvals) AS approvals FROM products WHERE id = ANY($1)", [Object.values(products)]);
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.ok(byId[products.edge].image_path);
  assert.ok(byId[products.pro].image_path);
  assert.equal(byId[products.other].image_path, null);
  assert.equal(byId[products.hyspin].is_commercial, true);
  const { rows: imgs } = await pool.query("SELECT count(*)::int AS n FROM product_images WHERE product_id = $1 AND is_main", [products.edge]);
  assert.equal(imgs[0].n, 1);
  // second run does nothing
  assert.equal(await runPricelistSeedOnce(), null);
});
