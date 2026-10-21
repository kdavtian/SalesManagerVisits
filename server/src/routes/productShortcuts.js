// New order screen shortcuts: the "Frequent" ranking.
// Mounted under /api/products BEFORE productsRouter (whose later routes need product-manager rights; these are for
// everyone who can build an order).
import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";

export const productShortcutsRouter = Router();
productShortcutsRouter.use(requireAuth);

const FREQUENT_DAYS = 90;
const FREQUENT_LIMIT = 30;

// "Frequent": the active products ordered most often (distinct orders) over the last 90 days across the whole
// company -- Excel order lines plus app orders the Excel does not hold yet. Only ids, no money or customer data,
// so it is open to every order-taking role. The customer's own usual basket comes from /customers/:id/reorder-profile.
export async function companyFrequentIds() {
  const { rows } = await pool.query(
    `SELECT product_id FROM (
       SELECT p.id AS product_id, count(DISTINCT l.order_id) AS n
         FROM erp_order_lines l JOIN products p ON lower(p.erp_product_id) = lower(l.product_id)
        WHERE l.order_date >= (now() AT TIME ZONE 'Asia/Yerevan')::date - $1::int
          AND COALESCE(l.qty, 0) > 0 AND l.erp_customer_id <> '10000' AND p.active
        GROUP BY p.id
       UNION ALL
       SELECT oi.product_id, count(DISTINCT o.id)
         FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN products p ON p.id = oi.product_id
        WHERE o.created_at >= now() - ($1::int || ' days')::interval AND o.status <> 'draft' AND p.active
        GROUP BY oi.product_id
     ) x GROUP BY product_id ORDER BY sum(n) DESC, product_id LIMIT $2`,
    [FREQUENT_DAYS, FREQUENT_LIMIT]
  );
  return rows.map((r) => r.product_id);
}
productShortcutsRouter.get("/frequent", async (_req, res) => {
  res.json(await companyFrequentIds());
});
