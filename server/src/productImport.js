// Excel import for the product catalog (item 28): upload -> parse -> match
// each row against the existing catalog -> classify as new/changed/
// unchanged/duplicate/invalid -> (on apply) write it. Column headers are
// auto-matched against the same schema GET /products/export/xlsx writes,
// so a sheet round-tripped through our own export always imports cleanly;
// a real-world supplier sheet works as long as its headers are close
// enough to one of the aliases below.
import ExcelJS from "exceljs";
import { pool } from "./db/pool.js";
import { normalizeErpText, normalizeErpUnitKey } from "./erpTransform.js";

const COLUMN_ALIASES = {
  brand: ["brand"],
  category: ["category", "type", "product type", "family"],
  sku: ["product code", "code", "sku"],
  name: ["product name", "name"],
  unit: ["package", "unit", "size", "pack"],
  standard: ["standard price amd", "standard price", "price"],
  special: ["special price amd", "special price"],
  specialFrom: ["special from", "special valid from"],
  specialTo: ["special to", "special valid to"],
  retail: ["retail price amd", "retail price"],
  // net_cost_amd (migration 080) is otherwise purely hand-entered, one
  // product at a time, in the admin Product edit sheet -- there is no ERP
  // source for it at all. A warehouse manager's own cost-tracking sheet
  // (a different workbook than the customer-facing pricelist GET
  // /products/export/xlsx produces, which deliberately never includes
  // internal cost columns -- see net_cost_hint, "not shown to reps") is
  // the realistic way this ever gets populated in bulk, so without this
  // alias its "Net Cost" column was silently dropped on import: reported
  // as "net costs are not showing" on the Warehouse inventory screen.
  netCost: ["net cost amd", "net cost", "cost price", "purchase cost", "purchase cost amd"],
};

function normalizeHeader(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function detectColumns(headerRow) {
  const columns = {};
  headerRow.eachCell((cell, colNumber) => {
    const normalized = normalizeHeader(cell.value);
    for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
      if (aliases.includes(normalized) && columns[field] === undefined) {
        columns[field] = colNumber;
      }
    }
  });
  return columns;
}

function numOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined; // undefined marks "present but invalid"
}

function dateOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const s = String(value).trim();
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : undefined;
}

// Parses the uploaded workbook into row objects. Throws with a
// user-facing message if the header row is missing required columns.
export async function parseImportFile(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error("The workbook has no sheets");

  const headerRow = sheet.getRow(1);
  const columns = detectColumns(headerRow);
  if (!columns.name) {
    throw new Error('Could not find a "Product Name" column in the header row');
  }

  const rows = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const get = (field) => (columns[field] ? row.getCell(columns[field]).value : null);
    // brand/category/name/unit go through normalizeErpText (trim + collapse
    // internal whitespace runs), same cleanup the automatic ERP sync applies
    // (see erpTransform.js) -- otherwise a stray double space or trailing
    // tab in the workbook defeats the identity match below and creates a
    // second row for a product that's already in the catalog. sku is left
    // as a plain trim: it's a code, not prose, so collapsing its internal
    // spacing isn't safe to assume.
    const raw = {
      rowNumber,
      brand: normalizeErpText(get("brand")?.toString()) || null,
      category: normalizeErpText(get("category")?.toString()) || null,
      sku: get("sku")?.toString().trim() || null,
      name: normalizeErpText(get("name")?.toString()) || null,
      unit: normalizeErpText(get("unit")?.toString()) || null,
      standard: numOrNull(get("standard")),
      special: numOrNull(get("special")),
      specialFrom: dateOrNull(get("specialFrom")),
      specialTo: dateOrNull(get("specialTo")),
      retail: numOrNull(get("retail")),
      netCost: numOrNull(get("netCost")),
    };
    // A fully blank row (Excel often pads a few) isn't a data row at all --
    // skip it silently rather than flagging it invalid.
    if (!raw.name && !raw.brand && !raw.sku) return;
    rows.push(raw);
  });
  return rows;
}

// Classifies parsed rows against the current catalog. Pure/no DB writes --
// used by both the preview endpoint and, as the first step, by apply.
export async function classifyImportRows(rows) {
  const { rows: existing } = await pool.query(
    "SELECT id, sku, brand, name, unit, bronze_price_amd, retail_price_amd, net_cost_amd FROM products WHERE active"
  );
  const bySku = new Map(existing.filter((p) => p.sku).map((p) => [p.sku.toLowerCase(), p]));
  // Existing rows go through the same normalizeErpText cleanup the
  // workbook rows already got when parsed (see parseImportFile) before
  // this identity key is built -- a pre-existing row's own stored
  // brand/name/unit can still carry stray whitespace from before this
  // normalization existed (or from the automatic ERP sync, which only
  // started collapsing it with this same fix), and comparing that
  // unnormalized text against the now-normalized workbook text would
  // silently miss the match and create a duplicate row again.
  // unit strips whitespace entirely rather than just collapsing it --
  // "4.5L" and "4.5 L" are the same size regardless of whether there's a
  // space before the L at all, unlike brand/name where a word-boundary
  // space is meaningful (see erpTransform.js's normalizeErpUnitKey).
  const identityKeyOf = (brand, name, unit) =>
    `${(normalizeErpText(brand) || "").toLowerCase()}|${(normalizeErpText(name) || "").toLowerCase()}|${normalizeErpUnitKey(unit)}`;
  const byIdentity = new Map(existing.map((p) => [identityKeyOf(p.brand, p.name, p.unit), p]));

  const seenKeys = new Set();
  const newProducts = [];
  const changedPrices = [];
  const unchanged = [];
  const duplicates = [];
  const invalidRows = [];
  const referencedIds = new Set();

  for (const row of rows) {
    if (!row.name) {
      invalidRows.push({ rowNumber: row.rowNumber, reason: "Missing product name" });
      continue;
    }
    if (row.standard === undefined || row.special === undefined || row.retail === undefined || row.netCost === undefined) {
      invalidRows.push({ rowNumber: row.rowNumber, reason: "A price column has a non-numeric value" });
      continue;
    }
    if ((row.special !== null && (row.specialFrom === undefined || row.specialTo === undefined)) || (row.specialFrom && !row.specialTo) || (row.specialTo && !row.specialFrom)) {
      invalidRows.push({ rowNumber: row.rowNumber, reason: "Special price needs both a valid From and To date" });
      continue;
    }

    const key = row.sku ? `sku:${row.sku.toLowerCase()}` : `id:${identityKeyOf(row.brand, row.name, row.unit)}`;
    if (seenKeys.has(key)) {
      duplicates.push({ rowNumber: row.rowNumber, name: row.name, reason: "Same product appears more than once in this file" });
      continue;
    }
    seenKeys.add(key);

    const identityKey = identityKeyOf(row.brand, row.name, row.unit);
    // SKU match first, but always fall back to the brand+name+unit identity
    // match rather than only trying it when the row has no SKU at all.
    // ERP-synced products (see erpSync.js's products upsert) never get a
    // sku written -- it's a column that only ever comes from this manual
    // import path or the admin's own product form -- so a row that
    // legitimately matches an existing ERP-synced product by name/brand/
    // unit, but happens to also carry a Product Code the ERP feed never
    // set, used to fail the SKU lookup and fall through to "new product",
    // creating a second row for the same physical item (reported live as
    // duplicate catalog entries, e.g. the same product appearing twice
    // with two different stock counts).
    const match = (row.sku && bySku.get(row.sku.toLowerCase())) || byIdentity.get(identityKey);

    if (!match) {
      if (row.standard === null) {
        invalidRows.push({ rowNumber: row.rowNumber, reason: "New product needs a Standard Price" });
        continue;
      }
      newProducts.push({
        rowNumber: row.rowNumber,
        name: row.name,
        brand: row.brand,
        sku: row.sku,
        unit: row.unit,
        standard: row.standard,
        retail: row.retail ?? row.standard,
        special: row.special,
        specialFrom: row.specialFrom,
        specialTo: row.specialTo,
        netCost: row.netCost,
      });
      continue;
    }

    referencedIds.add(match.id);
    const oldStandard = match.bronze_price_amd === null ? null : Number(match.bronze_price_amd);
    const oldRetail = match.retail_price_amd === null ? null : Number(match.retail_price_amd);
    const oldNetCost = match.net_cost_amd === null ? null : Number(match.net_cost_amd);
    const newStandard = row.standard ?? oldStandard;
    const newRetail = row.retail ?? oldRetail;
    const newNetCost = row.netCost ?? oldNetCost;
    const priceChanged = newStandard !== oldStandard || newRetail !== oldRetail || newNetCost !== oldNetCost;
    const hasSpecial = row.special !== null && row.specialFrom && row.specialTo;

    if (priceChanged || hasSpecial) {
      changedPrices.push({
        rowNumber: row.rowNumber,
        productId: match.id,
        name: row.name,
        oldStandard,
        newStandard,
        oldRetail,
        newRetail,
        oldNetCost,
        newNetCost,
        special: hasSpecial ? row.special : null,
        specialFrom: hasSpecial ? row.specialFrom : null,
        specialTo: hasSpecial ? row.specialTo : null,
      });
    } else {
      unchanged.push({ rowNumber: row.rowNumber, productId: match.id, name: row.name });
    }
  }

  const missingProducts = existing.filter((p) => !referencedIds.has(p.id) && !newProducts.some((n) => n.sku && p.sku && n.sku === p.sku));

  return { newProducts, changedPrices, unchanged, duplicates, invalidRows, missingProducts };
}

// Applies a classified import inside one transaction -- new products are
// created, changed prices are written with a price_history row each
// (note: "Excel import"), and a special row with dates creates a promo.
// Skips duplicates/invalid rows entirely (the caller already surfaced
// those in the preview; apply only ever touches the clean subset).
export async function applyImportRows(classified, userId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let created = 0;
    let updated = 0;
    let specialsCreated = 0;

    for (const p of classified.newProducts) {
      const { rows } = await client.query(
        `INSERT INTO products (name, sku, brand, unit, unit_price_amd, bronze_price_amd, retail_price_amd, net_cost_amd)
         VALUES ($1, $2, $3, $4, $5, $5, $6, $7) RETURNING id`,
        [p.name, p.sku || null, p.brand || null, p.unit || null, p.standard, p.retail, p.netCost ?? null]
      );
      created++;
      if (p.special !== null && p.specialFrom && p.specialTo) {
        await client.query(
          `INSERT INTO product_promos (product_id, promo_price_amd, starts_on, ends_on, created_by)
           VALUES ($1, $2, $3, $4, $5)`,
          [rows[0].id, p.special, p.specialFrom, p.specialTo, userId]
        );
        specialsCreated++;
      }
    }

    for (const c of classified.changedPrices) {
      if (c.newStandard !== c.oldStandard || c.newRetail !== c.oldRetail || c.newNetCost !== c.oldNetCost) {
        await client.query(
          "UPDATE products SET unit_price_amd = $1, bronze_price_amd = $1, retail_price_amd = $2, net_cost_amd = $3, updated_at = now(), manually_edited_at = now() WHERE id = $4",
          [c.newStandard, c.newRetail, c.newNetCost, c.productId]
        );
        if (c.newStandard !== c.oldStandard) {
          await client.query(
            `INSERT INTO product_price_history (product_id, price_type, old_value, new_value, changed_by, note)
             VALUES ($1, 'standard', $2, $3, $4, 'Excel import')`,
            [c.productId, c.oldStandard, c.newStandard, userId]
          );
        }
        if (c.newRetail !== c.oldRetail) {
          await client.query(
            `INSERT INTO product_price_history (product_id, price_type, old_value, new_value, changed_by, note)
             VALUES ($1, 'retail', $2, $3, $4, 'Excel import')`,
            [c.productId, c.oldRetail, c.newRetail, userId]
          );
        }
        updated++;
      }
      if (c.special !== null && c.specialFrom && c.specialTo) {
        await client.query(
          `INSERT INTO product_promos (product_id, promo_price_amd, starts_on, ends_on, created_by)
           VALUES ($1, $2, $3, $4, $5)`,
          [c.productId, c.special, c.specialFrom, c.specialTo, userId]
        );
        await client.query(
          `INSERT INTO product_price_history (product_id, price_type, old_value, new_value, changed_by, note)
           VALUES ($1, 'special', NULL, $2, $3, 'Excel import')`,
          [c.productId, c.special, userId]
        );
        specialsCreated++;
      }
    }

    await client.query("COMMIT");
    return { created, updated, specialsCreated };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
