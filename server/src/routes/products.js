import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";

export const productsRouter = Router();

productsRouter.use(requireAuth);

// Everyone (any logged-in role) can browse the catalog to build an order --
// only editing it is admin-only, same trust split as customers/team data.
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
    `SELECT p.*, promo.promo_price_amd, promo.ends_on AS promo_ends_on
     FROM products p
     LEFT JOIN LATERAL (
       SELECT promo_price_amd, ends_on FROM product_promos
       WHERE product_id = p.id AND CURRENT_DATE BETWEEN starts_on AND ends_on
       ORDER BY created_at DESC LIMIT 1
     ) promo ON true
     ${where}
     ORDER BY p.brand NULLS LAST, p.name`,
    params
  );
  res.json(rows);
});

productsRouter.use(requireAdmin);

// Admin also sees inactive (discontinued) products, for the catalog
// management screen -- the public GET above hides them from order entry.
productsRouter.get("/all", async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM products ORDER BY active DESC, brand NULLS LAST, name");
  res.json(rows);
});

productsRouter.post("/", async (req, res) => {
  const { name, sku, brand, unit, unit_price_amd } = req.body ?? {};
  const price = Number(unit_price_amd);
  if (!name || !Number.isFinite(price) || price < 0) {
    return res.status(400).json({ error: "name and a non-negative unit_price_amd are required" });
  }
  const { rows } = await pool.query(
    `INSERT INTO products (name, sku, brand, unit, unit_price_amd) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [name, sku || null, brand || null, unit || null, price]
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
  "stock_qty",
];
const NUMERIC_FIELDS = new Set(["unit_price_amd", "bronze_price_amd", "silver_price_amd", "gold_price_amd", "stock_qty"]);

productsRouter.patch("/:id", async (req, res) => {
  const updates = Object.entries(req.body ?? {}).filter(([key]) => EDITABLE_FIELDS.includes(key));
  if (!updates.length) return res.status(400).json({ error: "No editable fields provided" });

  const setClauses = updates.map(([key], i) => `${key} = $${i + 1}`);
  const values = updates.map(([key, value]) => (NUMERIC_FIELDS.has(key) && value !== null ? Number(value) : value));
  values.push(req.params.id);

  const { rows } = await pool.query(
    `UPDATE products SET ${setClauses.join(", ")}, updated_at = now(), manually_edited_at = now() WHERE id = $${values.length} RETURNING *`,
    values
  );
  if (!rows[0]) return res.status(404).json({ error: "Product not found" });
  res.json(rows[0]);
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

// Admin-managed date-ranged promo ("special period") pricing -- item 6 of
// the pricelist feature. Past promos are kept (not deleted) as a record of
// what ran when; only the currently-active one (if any) is surfaced on the
// public GET / above.
productsRouter.get("/:id/promos", async (req, res) => {
  const { rows } = await pool.query(
    "SELECT * FROM product_promos WHERE product_id = $1 ORDER BY starts_on DESC",
    [req.params.id]
  );
  res.json(rows);
});

productsRouter.post("/:id/promos", async (req, res) => {
  const { promo_price_amd, starts_on, ends_on } = req.body ?? {};
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
  res.status(201).json(rows[0]);
});

productsRouter.delete("/:id/promos/:promoId", async (req, res) => {
  const { rowCount } = await pool.query(
    "DELETE FROM product_promos WHERE id = $1 AND product_id = $2",
    [req.params.promoId, req.params.id]
  );
  if (!rowCount) return res.status(404).json({ error: "Promo not found" });
  res.status(204).end();
});
