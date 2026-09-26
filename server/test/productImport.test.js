// Excel product/pricelist import (server/src/productImport.js): net cost
// column support, and the brand+name+unit identity fallback that stops a
// re-import from creating a duplicate catalog row for a product that was
// never ERP-synced (see erpSync.js's own claim step for the mirror-image
// fix on that side).
import "dotenv/config";
import test from "node:test";
import assert from "node:assert/strict";
import { classifyImportRows, applyImportRows } from "../src/productImport.js";
import { pool } from "../src/db/pool.js";
import { createUser, cleanupAll, trackProduct } from "./integration/helpers.js";

test.after(async () => {
  await cleanupAll();
});

async function insertProduct(overrides = {}) {
  const { rows } = await pool.query(
    `INSERT INTO products (name, sku, brand, unit, unit_price_amd, bronze_price_amd, retail_price_amd, net_cost_amd, erp_product_id, active)
     VALUES ($1, $2, $3, $4, $5, $5, $6, $7, $8, true) RETURNING *`,
    [
      overrides.name,
      overrides.sku ?? null,
      overrides.brand ?? null,
      overrides.unit ?? null,
      overrides.standard ?? 5000,
      overrides.retail ?? 6000,
      overrides.net_cost_amd ?? null,
      overrides.erp_product_id ?? null,
    ]
  );
  trackProduct(rows[0].id);
  return rows[0];
}

test("classifyImportRows: a row whose SKU matches nothing still matches an existing never-synced product by brand+name+unit, instead of being classified as new", async () => {
  const existing = await insertProduct({
    name: "Itest Duplicate Guard Oil",
    brand: "Itest Brand",
    unit: "4L",
    standard: 5000,
    retail: 6000,
  });

  const rows = [
    {
      rowNumber: 2,
      brand: "Itest Brand",
      name: "Itest Duplicate Guard Oil",
      unit: "4L",
      sku: "ITEST-SKU-NEW",
      standard: 5200,
      special: null,
      specialFrom: null,
      specialTo: null,
      retail: 6100,
      netCost: 3000,
    },
  ];
  const classified = await classifyImportRows(rows);

  assert.equal(classified.newProducts.length, 0, "must not classify as a new product");
  assert.equal(classified.changedPrices.length, 1);
  assert.equal(classified.changedPrices[0].productId, existing.id);
  assert.equal(classified.changedPrices[0].oldNetCost, null);
  assert.equal(classified.changedPrices[0].newNetCost, 3000);
});

test("classifyImportRows/applyImportRows: net cost changes are detected and written to net_cost_amd", async () => {
  const existing = await insertProduct({
    name: "Itest Net Cost Oil",
    brand: "Itest Brand",
    unit: "1L",
    standard: 4000,
    retail: 4800,
    net_cost_amd: 2000,
  });
  const user = await createUser("admin");

  const rows = [
    {
      rowNumber: 2,
      brand: "Itest Brand",
      name: "Itest Net Cost Oil",
      unit: "1L",
      sku: null,
      standard: 4000,
      special: null,
      specialFrom: null,
      specialTo: null,
      retail: 4800,
      netCost: 2500,
    },
  ];
  const classified = await classifyImportRows(rows);
  assert.equal(classified.changedPrices.length, 1);
  assert.equal(classified.changedPrices[0].oldNetCost, 2000);
  assert.equal(classified.changedPrices[0].newNetCost, 2500);

  await applyImportRows(classified, user.id);

  const { rows: after } = await pool.query("SELECT net_cost_amd FROM products WHERE id = $1", [existing.id]);
  assert.equal(Number(after[0].net_cost_amd), 2500);
});

test("classifyImportRows/applyImportRows: a brand-new product's Net Cost column is captured on insert", async () => {
  const user = await createUser("admin");
  const rows = [
    {
      rowNumber: 2,
      brand: "Itest Brand",
      name: "Itest Brand New Oil",
      unit: "4L",
      sku: null,
      standard: 7000,
      special: null,
      specialFrom: null,
      specialTo: null,
      retail: 8000,
      netCost: 4500,
    },
  ];
  const classified = await classifyImportRows(rows);
  assert.equal(classified.newProducts.length, 1);
  assert.equal(classified.newProducts[0].netCost, 4500);

  const result = await applyImportRows(classified, user.id);
  assert.equal(result.created, 1);

  const { rows: created } = await pool.query(
    "SELECT id, net_cost_amd FROM products WHERE name = $1 AND brand = $2",
    ["Itest Brand New Oil", "Itest Brand"]
  );
  assert.equal(created.length, 1);
  trackProduct(created[0].id);
  assert.equal(Number(created[0].net_cost_amd), 4500);
});
