import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth, requireProductManager } from "../middleware/auth.js";
import { getEffectiveProductPricing } from "../pricingService.js";

export const productsRouter = Router();

productsRouter.use(requireAuth);

// Everyone (any logged-in role) can browse the catalog to build an order --
// only editing it is restricted to product managers (see requireProductManager).
productsRouter.get("/", async (req, res) => {
  const { q } = req.query;
  const params = [];
  let where = "WHERE p.active";
  if (q) {
    params.push(`%${q}%`);
    where += ` AND (p.name ILIKE $${params.length} OR p.sku ILIKE $${params.length} OR p.brand ILIKE $${params.length})`;
  }
  // The one promo (if any) covering today, per product -- DISTINCT ON picks
  // the most recently created if two promo windows somehow overlap, rather
  // than erroring or picking arbitrarily.
  const { rows } = await pool.query(
    `SELECT p.*, promo.id AS promo_id, promo.promo_price_amd, promo.starts_on AS promo_starts_on, promo.ends_on AS promo_ends_on
     FROM products p
     LEFT JOIN LATERAL (
       SELECT id, promo_price_amd, starts_on, ends_on FROM product_promos
       WHERE product_id = p.id AND CURRENT_DATE BETWEEN starts_on AND ends_on
       ORDER BY created_at DESC LIMIT 1
     ) promo ON true
     ${where}
     ORDER BY p.brand NULLS LAST, p.name`,
    params
  );
  // Every surface (this list, the pricelist page, PDF/print, Excel) reads
  // its prices through the same canonical function -- see pricingService.js.
  res.json(
    rows.map((row) => {
      const pricing = getEffectiveProductPricing(
        row,
        row.promo_id ? { promo_price_amd: row.promo_price_amd, starts_on: row.promo_starts_on, ends_on: row.promo_ends_on } : null
      );
      return {
        ...row,
        effective_standard_amd: pricing.standard,
        effective_special_amd: pricing.special,
        effective_retail_amd: pricing.retail,
        special_valid_from: pricing.specialValidFrom,
        special_valid_to: pricing.specialValidTo,
      };
    })
  );
});

productsRouter.use(requireProductManager);

// Product managers also see inactive (discontinued) products, for the
// catalog management screen -- the public GET above hides them from order
// entry.
productsRouter.get("/all", async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM products ORDER BY active DESC, brand NULLS LAST, name");
  res.json(rows);
});

productsRouter.post("/", async (req, res) => {
  const { name, sku, brand, unit, unit_price_amd, retail_price_amd } = req.body ?? {};
  const price = Number(unit_price_amd);
  if (!name || !Number.isFinite(price) || price < 0) {
    return res.status(400).json({ error: "name and a non-negative unit_price_amd are required" });
  }
  const retail = retail_price_amd !== undefined && retail_price_amd !== null ? Number(retail_price_amd) : price;
  if (!Number.isFinite(retail) || retail < 0) {
    return res.status(400).json({ error: "retail_price_amd must be a non-negative number" });
  }
  const { rows } = await pool.query(
    `INSERT INTO products (name, sku, brand, unit, unit_price_amd, bronze_price_amd, retail_price_amd)
     VALUES ($1, $2, $3, $4, $5, $5, $6) RETURNING *`,
    [name, sku || null, brand || null, unit || null, price, retail]
  );
  res.status(201).json(rows[0]);
});

const EDITABLE_FIELDS = [
  "name",
  "sku",
  "brand",
  "unit",
  "unit_price_amd",
  "active",
  "family",
  "bronze_price_amd",
  "silver_price_amd",
  "gold_price_amd",
  "retail_price_amd",
  "stock_qty",
];
const NUMERIC_FIELDS = new Set([
  "unit_price_amd",
  "bronze_price_amd",
  "silver_price_amd",
  "gold_price_amd",
  "retail_price_amd",
  "stock_qty",
]);
// Which editable fields count as a "price" for history-logging purposes --
// bronze is the standard/trade price (see pricingService.getEffectiveProductPricing).
const PRICE_HISTORY_FIELD = { bronze_price_amd: "standard", retail_price_amd: "retail" };

productsRouter.patch("/:id", async (req, res) => {
  const updates = Object.entries(req.body ?? {}).filter(([key]) => EDITABLE_FIELDS.includes(key));
  if (!updates.length) return res.status(400).json({ error: "No editable fields provided" });

  const { rows: beforeRows } = await pool.query("SELECT * FROM products WHERE id = $1", [req.params.id]);
  const before = beforeRows[0];
  if (!before) return res.status(404).json({ error: "Product not found" });

  const setClauses = updates.map(([key], i) => `${key} = $${i + 1}`);
  const values = updates.map(([key, value]) => (NUMERIC_FIELDS.has(key) && value !== null ? Number(value) : value));
  values.push(req.params.id);

  const { rows } = await pool.query(
    `UPDATE products SET ${setClauses.join(", ")}, updated_at = now(), manually_edited_at = now() WHERE id = $${values.length} RETURNING *`,
    values
  );
  const after = rows[0];

  await logPriceChanges(before, after, req.user.id);

  res.json(after);
});

// Shared by the single-product PATCH above and the bulk price-update
// endpoint below -- one place decides what counts as a loggable price
// change, so neither path can silently skip the audit trail.
async function logPriceChanges(before, after, userId, note = null) {
  const entries = [];
  for (const [field, priceType] of Object.entries(PRICE_HISTORY_FIELD)) {
    const oldValue = before[field] === null ? null : Number(before[field]);
    const newValue = after[field] === null ? null : Number(after[field]);
    if (oldValue !== newValue) {
      entries.push([after.id, priceType, oldValue, newValue, userId, note]);
    }
  }
  for (const entry of entries) {
    await pool.query(
      `INSERT INTO product_price_history (product_id, price_type, old_value, new_value, changed_by, note)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      entry
    );
  }
}

// Full price-change trail for one product -- standard/retail edits and
// special-price create/cancel events, newest first.
productsRouter.get("/:id/price-history", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT h.*, u.name AS changed_by_name
     FROM product_price_history h
     LEFT JOIN users u ON u.id = h.changed_by
     WHERE h.product_id = $1
     ORDER BY h.changed_at DESC
     LIMIT 200`,
    [req.params.id]
  );
  res.json(rows);
});

// Clears a manual-edit lock so the next sync is free to update this
// product again -- otherwise a one-time manual correction would keep
// blocking every future price update from the catalog forever.
productsRouter.post("/:id/resync", async (req, res) => {
  const { rows } = await pool.query(
    "UPDATE products SET manually_edited_at = NULL WHERE id = $1 RETURNING *",
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: "Product not found" });
  res.json(rows[0]);
});

productsRouter.delete("/:id", async (req, res) => {
  const { rowCount } = await pool.query("DELETE FROM products WHERE id = $1", [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: "Product not found" });
  res.status(204).end();
});

// Date-ranged promo ("special period") pricing. Past promos are kept (not
// deleted) as a record of what ran when; only the currently-active one (if
// any) is surfaced on the public GET / above.
productsRouter.get("/:id/promos", async (req, res) => {
  const { rows } = await pool.query(
    "SELECT * FROM product_promos WHERE product_id = $1 ORDER BY starts_on DESC",
    [req.params.id]
  );
  res.json(rows);
});

productsRouter.post("/:id/promos", async (req, res) => {
  const { promo_price_amd, starts_on, ends_on, note } = req.body ?? {};
  const price = Number(promo_price_amd);
  if (!Number.isFinite(price) || price < 0) {
    return res.status(400).json({ error: "promo_price_amd must be a non-negative number" });
  }
  if (!starts_on || !ends_on || new Date(ends_on) < new Date(starts_on)) {
    return res.status(400).json({ error: "starts_on and ends_on are required, and ends_on must not be before starts_on" });
  }
  const { rows } = await pool.query(
    `INSERT INTO product_promos (product_id, promo_price_amd, starts_on, ends_on, created_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [req.params.id, price, starts_on, ends_on, req.user.id]
  );
  await pool.query(
    `INSERT INTO product_price_history (product_id, price_type, old_value, new_value, changed_by, note)
     VALUES ($1, 'special', NULL, $2, $3, $4)`,
    [req.params.id, price, req.user.id, note || null]
  );
  res.status(201).json(rows[0]);
});

productsRouter.delete("/:id/promos/:promoId", async (req, res) => {
  const { rows } = await pool.query(
    "DELETE FROM product_promos WHERE id = $1 AND product_id = $2 RETURNING promo_price_amd",
    [req.params.promoId, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: "Promo not found" });
  await pool.query(
    `INSERT INTO product_price_history (product_id, price_type, old_value, new_value, changed_by, note)
     VALUES ($1, 'special', $2, NULL, $3, 'Cancelled')`,
    [req.params.id, Number(rows[0].promo_price_amd), req.user.id]
  );
  res.status(204).end();
});

const BULK_PRICE_FIELDS = new Set(["bronze_price_amd", "retail_price_amd"]);

// Preview-then-apply bulk price editing across a filtered set of products
// (explicit ids, or all products matching a brand/family). `apply: false`
// (the default) computes and returns the same change list without writing
// anything -- the frontend renders that as the confirmation screen before
// a second call with `apply: true` commits it. Both calls share this one
// function so the numbers a user confirms are exactly the numbers applied.
productsRouter.post("/bulk-price-update", async (req, res) => {
  const { product_ids, brand, family, price_field, operation, value, apply } = req.body ?? {};

  if (!BULK_PRICE_FIELDS.has(price_field)) {
    return res.status(400).json({ error: `price_field must be one of: ${[...BULK_PRICE_FIELDS].join(", ")}` });
  }
  if (!["percent", "fixed", "exact"].includes(operation)) {
    return res.status(400).json({ error: "operation must be one of: percent, fixed, exact" });
  }
  const amount = Number(value);
  if (!Number.isFinite(amount)) {
    return res.status(400).json({ error: "value must be a number" });
  }
  if (operation === "exact" && amount < 0) {
    return res.status(400).json({ error: "value must be non-negative for an exact price" });
  }

  const params = [];
  let where = "WHERE active";
  if (Array.isArray(product_ids) && product_ids.length) {
    params.push(product_ids.map(Number));
    where += ` AND id = ANY($${params.length})`;
  } else {
    if (brand) {
      params.push(brand);
      where += ` AND brand = $${params.length}`;
    }
    if (family) {
      params.push(family);
      where += ` AND family = $${params.length}`;
    }
    if (!brand && !family) {
      return res.status(400).json({ error: "Provide product_ids, brand, and/or family to select which products to update" });
    }
  }

  const { rows: products } = await pool.query(`SELECT id, name, brand, ${price_field} AS old_value FROM products ${where}`, params);

  const changes = products
    .map((p) => {
      const oldValue = p.old_value === null ? null : Number(p.old_value);
      if (oldValue === null) return null; // nothing to base a percent/fixed change on
      let newValue;
      if (operation === "percent") newValue = oldValue * (1 + amount / 100);
      else if (operation === "fixed") newValue = oldValue + amount;
      else newValue = amount;
      newValue = Math.max(0, Math.round(newValue));
      return { id: p.id, name: p.name, brand: p.brand, old_value: oldValue, new_value: newValue, diff: newValue - oldValue };
    })
    .filter(Boolean);

  if (!apply) {
    return res.json({ count: changes.length, changes: changes.slice(0, 500) });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const change of changes) {
      if (change.new_value === change.old_value) continue;
      await client.query(`UPDATE products SET ${price_field} = $1, updated_at = now(), manually_edited_at = now() WHERE id = $2`, [
        change.new_value,
        change.id,
      ]);
      await client.query(
        `INSERT INTO product_price_history (product_id, price_type, old_value, new_value, changed_by, note)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [change.id, PRICE_HISTORY_FIELD[price_field], change.old_value, change.new_value, req.user.id, "Bulk update"]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  res.json({ count: changes.length, changes: changes.slice(0, 500) });
});

export { logPriceChanges };
