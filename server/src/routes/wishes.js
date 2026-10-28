// Wished products from the KAD Motors app (productWishes.js): a rep or the office writes down what a customer wants but we do not have.
import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { addWish, cleanWish, WishValidationError } from "../productWishes.js";

export const wishesRouter = Router();
wishesRouter.use(requireAuth);

wishesRouter.post("/", async (req, res) => {
  const customerId = Number(req.body?.customer_id);
  if (!Number.isInteger(customerId)) return res.status(400).json({ error: "customer_id is required" });
  const { rows } = await pool.query("SELECT id FROM customers WHERE id = $1", [customerId]);
  if (!rows[0]) return res.status(404).json({ error: "Customer not found" });
  try {
    const wish = await addWish({ customerId, userId: req.user.id, source: "app", wish: cleanWish(req.body) });
    res.status(201).json(wish);
  } catch (err) {
    if (err instanceof WishValidationError) return res.status(400).json({ error: err.message });
    throw err;
  }
});

// The customer's catalog wishes of the last 60 days (the order screen marks those products "Wished").
wishesRouter.get("/", async (req, res) => {
  const customerId = Number(req.query.customer_id);
  if (!Number.isInteger(customerId)) return res.status(400).json({ error: "customer_id is required" });
  const { rows } = await pool.query(
    `SELECT id, product_id, custom_name, quantity, created_at, back_in_stock_at FROM product_wishes
     WHERE customer_id = $1 AND created_at > now() - interval '60 days' ORDER BY created_at DESC`,
    [customerId]
  );
  res.json(rows);
});
