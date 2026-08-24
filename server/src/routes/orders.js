import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { seesAllActivity } from "../roles.js";

export const ordersRouter = Router();

ordersRouter.use(requireAuth);

// Create an order: an items array of {product_id, quantity} (or a free-text
// {product_name, unit_price_amd, quantity} line for something not yet in
// the catalog). Prices are snapshotted from the catalog at save time, not
// looked up live later -- an order is what was actually agreed, and must
// stay correct even if the catalog price changes afterward.
ordersRouter.post("/", async (req, res) => {
  const { customer_id, checkin_id, note, items } = req.body ?? {};
  const customerId = Number(customer_id);
  if (!customerId || !Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: "customer_id and at least one item are required" });
  }

  const { rows: customerRows } = await pool.query("SELECT id FROM customers WHERE id = $1", [customerId]);
  if (!customerRows[0]) return res.status(404).json({ error: "Customer not found" });

  const productIds = items.map((i) => Number(i.product_id)).filter(Number.isInteger);
  const { rows: products } = productIds.length
    ? await pool.query("SELECT * FROM products WHERE id = ANY($1)", [productIds])
    : { rows: [] };
  const productById = new Map(products.map((p) => [p.id, p]));

  const lines = [];
  for (const item of items) {
    const quantity = Number(item.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return res.status(400).json({ error: "Every item needs a positive quantity" });
    }
    const product = Number.isInteger(Number(item.product_id)) ? productById.get(Number(item.product_id)) : null;
    const productName = product ? product.name : item.product_name;
    const unitPrice = product ? Number(product.unit_price_amd) : Number(item.unit_price_amd);
    if (!productName || !Number.isFinite(unitPrice) || unitPrice < 0) {
      return res.status(400).json({ error: "Each item needs a valid product and a non-negative price" });
    }
    lines.push({
      product_id: product?.id ?? null,
      product_name: productName,
      unit_price_amd: unitPrice,
      quantity,
      line_total_amd: unitPrice * quantity,
    });
  }

  const totalAmd = lines.reduce((sum, l) => sum + l.line_total_amd, 0);

  const client = await pool.connect();
  let order;
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO orders (customer_id, user_id, checkin_id, total_amd, note)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [customerId, req.user.id, checkin_id || null, totalAmd, note || null]
    );
    order = rows[0];
    for (const line of lines) {
      await client.query(
        `INSERT INTO order_items (order_id, product_id, product_name, unit_price_amd, quantity, line_total_amd)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [order.id, line.product_id, line.product_name, line.unit_price_amd, line.quantity, line.line_total_amd]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  res.status(201).json({ ...order, items: lines });
});

ordersRouter.get("/", async (req, res) => {
  let { customer_id, user_id } = req.query;
  if (!seesAllActivity(req.user.role)) {
    user_id = req.user.id;
  }

  const conditions = [];
  const params = [];
  if (customer_id) {
    params.push(customer_id);
    conditions.push(`o.customer_id = $${params.length}`);
  }
  if (user_id) {
    params.push(user_id);
    conditions.push(`o.user_id = $${params.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const { rows } = await pool.query(
    `SELECT o.*, u.name AS user_name, c.name AS customer_name
     FROM orders o
     JOIN users u ON u.id = o.user_id
     JOIN customers c ON c.id = o.customer_id
     ${where}
     ORDER BY o.created_at DESC`,
    params
  );
  res.json(rows);
});

ordersRouter.get("/:id", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT o.*, u.name AS user_name, c.name AS customer_name
     FROM orders o
     JOIN users u ON u.id = o.user_id
     JOIN customers c ON c.id = o.customer_id
     WHERE o.id = $1`,
    [req.params.id]
  );
  const order = rows[0];
  if (!order) return res.status(404).json({ error: "Order not found" });
  if (!seesAllActivity(req.user.role) && order.user_id !== req.user.id) {
    return res.status(403).json({ error: "Not allowed" });
  }

  const { rows: items } = await pool.query(
    "SELECT * FROM order_items WHERE order_id = $1 ORDER BY id",
    [order.id]
  );
  res.json({ ...order, items });
});
