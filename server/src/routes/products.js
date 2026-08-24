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
  let where = "WHERE active";
  if (q) {
    params.push(`%${q}%`);
    where += ` AND (name ILIKE $${params.length} OR sku ILIKE $${params.length} OR brand ILIKE $${params.length})`;
  }
  const { rows } = await pool.query(
    `SELECT * FROM products ${where} ORDER BY brand NULLS LAST, name`,
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

const EDITABLE_FIELDS = ["name", "sku", "brand", "unit", "unit_price_amd", "active"];

productsRouter.patch("/:id", async (req, res) => {
  const updates = Object.entries(req.body ?? {}).filter(([key]) => EDITABLE_FIELDS.includes(key));
  if (!updates.length) return res.status(400).json({ error: "No editable fields provided" });

  const setClauses = updates.map(([key], i) => `${key} = $${i + 1}`);
  const values = updates.map(([key, value]) => (key === "unit_price_amd" ? Number(value) : value));
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
