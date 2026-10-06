// One-time seed: attaches the product photos and commercial specifications
// from the company's pricelist workbook (seed/pricelist, built by
// scripts/build-pricelist-seed.mjs) to the matching products. Runs once per
// database (recorded in data_seeds) so a photo someone removes later is not
// re-added by a deploy; the manual importer (Products -> Export) can re-run it.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./db/pool.js";
import { matchGroupsToProducts } from "./pricelistImport.js";
import { applyMatchedGroups } from "./pricelistApply.js";

const SEED_NAME = "pricelist_photos_v1";
const SEED_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "seed", "pricelist");

export function loadSeedGroups() {
  const file = path.join(SEED_DIR, "groups.json");
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, "utf8")).map((g) => ({
    ...g,
    techParsed: g.tech,
    tech: null,
    image: g.image ? { buffer: fs.readFileSync(path.join(SEED_DIR, "images", g.image)), ext: path.extname(g.image).slice(1) } : null,
  }));
}

export async function runPricelistSeedOnce() {
  const { rows: done } = await pool.query("SELECT 1 FROM data_seeds WHERE name = $1", [SEED_NAME]);
  if (done[0]) return null;
  const groups = loadSeedGroups();
  if (!groups.length) return null;
  const { rows: products } = await pool.query("SELECT id, name, brand, unit, image_path FROM products WHERE active");
  // Nothing to attach to yet (fresh/empty catalogue): try again on a later start.
  if (!products.length) return null;
  const { matches } = matchGroupsToProducts(groups, products);
  const applied = await applyMatchedGroups(matches);
  await pool.query("INSERT INTO data_seeds (name, result) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING", [
    SEED_NAME,
    JSON.stringify({ ...applied, matched_groups: matches.size, groups: groups.length }),
  ]);
  console.log(`Pricelist seed: matched ${matches.size}/${groups.length} models, ${applied.photos} photos, ${applied.commercial} commercial products`);
  return applied;
}
