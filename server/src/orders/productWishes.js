// Wished products (owner, 2026-10-28, migration 165): an order holds only what is on the shelf (orderStock.js); what a customer wants but
// we do not have -- a catalog product that is out of stock, or a product we never carried (typed by hand) -- is written down here, so the
// assortment can follow demand. Management is told at once (notification type product_wish) and reads them in Reports > Wished products;
// when a wished catalog product is available again after an Excel sync, the customer's rep is told (wish_back_in_stock, one notification per
// rep per sync) and a KAD OS customer sees it in their app (GET /api/partner/wishes).
import { pool } from "../db/pool.js";
import { notifyUser } from "../shared/notifications.js";

export const WISH_NOTIFY_ROLES = ["admin", "ceo", "operations_director", "sales_director"];
const MAX_NAME = 120;
const MAX_NOTE = 300;
const MAX_QTY = 100000;

export class WishValidationError extends Error {}

// What a "wish" body may hold; returns the clean values or throws WishValidationError.
export function cleanWish(body) {
  const productId = body?.product_id === undefined || body?.product_id === null || body?.product_id === "" ? null : Number(body.product_id);
  if (productId !== null && !Number.isInteger(productId)) throw new WishValidationError("product_id must be a product id");
  const customName = productId === null ? String(body?.custom_name ?? "").trim().slice(0, MAX_NAME) : null;
  if (productId === null && !customName) throw new WishValidationError("Choose a product or write its name");
  const quantity = body?.quantity === undefined || body?.quantity === null || body?.quantity === "" ? 1 : Number(body.quantity);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QTY) throw new WishValidationError("quantity must be a whole number from 1");
  const note = String(body?.note ?? "").trim().slice(0, MAX_NOTE) || null;
  return { productId, customName, quantity, note };
}

// Saves one wish and tells management (fire and forget). Returns the row with the product and customer names.
export async function addWish({ customerId, userId, source = "app", wish }, db = pool) {
  const { productId, customName, quantity, note } = wish;
  if (productId !== null) {
    const { rows } = await db.query("SELECT id FROM products WHERE id = $1", [productId]);
    if (!rows[0]) throw new WishValidationError("Product not found");
  }
  const { rows } = await db.query(
    `INSERT INTO product_wishes (customer_id, product_id, custom_name, quantity, note, source, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [customerId, productId, customName, quantity, note, source, userId]
  );
  const { rows: [names] } = await db.query(
    `SELECT c.name AS customer_name, p.name AS product_name, p.unit, u.name AS user_name
     FROM customers c LEFT JOIN products p ON p.id = $2 LEFT JOIN users u ON u.id = $3 WHERE c.id = $1`,
    [customerId, productId, userId]
  );
  const row = { ...rows[0], ...names };
  notifyManagement(row).catch((err) => console.error("Wish notification failed:", err.message));
  return row;
}

async function notifyManagement(w) {
  const { rows } = await pool.query("SELECT id FROM users WHERE role = ANY($1) AND status = 'active' AND id IS DISTINCT FROM $2", [WISH_NOTIFY_ROLES, w.created_by]);
  const what = w.product_name ? `${w.product_name}${w.unit ? ` ${w.unit}` : ""}` : w.custom_name;
  for (const u of rows) {
    notifyUser(u.id, "product_wish", {
      title: `${w.product_id ? "Ցանկալի ապրանք (չկա պահեստում)" : "Ցանկալի նոր ապրանք"}՝ ${what}`,
      body: [`• ${w.customer_name}`, `• ${w.quantity} հատ`, w.source === "kados" ? "• KAD OS-ից" : w.user_name ? `• ${w.user_name}` : null, w.note ? `• ${w.note}` : null]
        .filter(Boolean)
        .join("\n"),
      url: "/#/reports?r=product_wishes",
    }).catch(() => {});
  }
}

// After an Excel sync (stock changed): wished catalog products that are available again (stock minus what open orders promised > 0).
// Each waiting wish is marked once; the customer's rep (and whoever wrote the wish, if another staff member) gets ONE notification per run
// listing the customers and products. Returns the marked wishes.
export async function markWishesBackInStock(db = pool) {
  const { rows } = await db.query(
    `WITH avail AS (
       SELECT p.id, p.name, p.unit,
              p.stock_qty - COALESCE((SELECT SUM(oi.quantity) FROM order_items oi JOIN orders o ON o.id = oi.order_id
                                      WHERE oi.product_id = p.id
                                        AND (o.status IN ('submitted', 'confirmed', 'packed_stock_out')
                                             OR (o.status = 'delivered' AND p.synced_at IS NOT NULL AND o.updated_at > p.synced_at))), 0) AS available
       FROM products p
       WHERE p.active AND p.stock_qty IS NOT NULL AND p.id IN (SELECT product_id FROM product_wishes WHERE back_in_stock_at IS NULL AND product_id IS NOT NULL)
     )
     UPDATE product_wishes w SET back_in_stock_at = now()
     FROM avail a
     WHERE w.product_id = a.id AND w.back_in_stock_at IS NULL AND a.available > 0
     RETURNING w.id, w.customer_id, w.product_id, w.created_by, w.source, a.name AS product_name, a.unit`
  );
  if (!rows.length) return [];
  const { rows: customers } = await db.query("SELECT id, name, assigned_manager_id FROM customers WHERE id = ANY($1)", [[...new Set(rows.map((r) => r.customer_id))]]);
  const customerById = new Map(customers.map((c) => [c.id, c]));
  const { rows: staff } = await db.query("SELECT id FROM users WHERE id = ANY($1) AND role <> 'customer' AND status = 'active'", [
    [...new Set(rows.flatMap((r) => [r.created_by, customerById.get(r.customer_id)?.assigned_manager_id]).filter(Boolean))],
  ]);
  const staffIds = new Set(staff.map((s) => s.id));
  const linesByUser = new Map();
  for (const r of rows) {
    const c = customerById.get(r.customer_id);
    const line = `• ${r.product_name}${r.unit ? ` ${r.unit}` : ""} — ${c?.name ?? ""}`;
    for (const uid of new Set([c?.assigned_manager_id, r.source === "app" ? r.created_by : null])) {
      if (!uid || !staffIds.has(uid)) continue;
      if (!linesByUser.has(uid)) linesByUser.set(uid, new Set());
      linesByUser.get(uid).add(line);
    }
  }
  for (const [uid, lines] of linesByUser) {
    notifyUser(uid, "wish_back_in_stock", {
      title: "Ցանկալի ապրանքը կրկին առկա է",
      body: [...lines].slice(0, 12).join("\n"),
      url: "/#/reports?r=product_wishes",
    }).catch(() => {});
  }
  return rows;
}

// Reports > Wished products: one row per product (catalog) or per typed name, for the chosen period. The customers behind each row come along
// (name, quantity, date, who) so the report answers "who wants it" without another screen.
export async function wishReport({ since = null } = {}, db = pool) {
  const params = [];
  let where = "";
  if (since) {
    params.push(since);
    where = `WHERE w.created_at >= $1`;
  }
  const { rows } = await db.query(
    `SELECT w.id, w.product_id, w.custom_name, w.quantity, w.note, w.source, w.created_at, w.back_in_stock_at,
            c.id AS customer_id, c.name AS customer_name, u.name AS user_name,
            p.name AS product_name, p.unit, p.brand, p.stock_qty
     FROM product_wishes w
     JOIN customers c ON c.id = w.customer_id
     LEFT JOIN users u ON u.id = w.created_by
     LEFT JOIN products p ON p.id = w.product_id
     ${where}
     ORDER BY w.created_at DESC`,
    params
  );
  const groups = new Map();
  for (const r of rows) {
    const key = r.product_id ? `p:${r.product_id}` : `n:${r.custom_name.trim().toLowerCase().replace(/\s+/g, " ")}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        product_id: r.product_id,
        name: r.product_id ? r.product_name : r.custom_name.trim(),
        unit: r.unit ?? null,
        brand: r.brand ?? null,
        new_product: !r.product_id,
        in_stock_now: r.product_id ? r.stock_qty !== null && Number(r.stock_qty) > 0 : false,
        wishes: 0,
        quantity: 0,
        customers: new Set(),
        last_at: r.created_at,
        items: [],
      });
    }
    const g = groups.get(key);
    g.wishes += 1;
    g.quantity += r.quantity;
    g.customers.add(r.customer_id);
    g.items.push({
      id: r.id,
      customer_id: r.customer_id,
      customer_name: r.customer_name,
      quantity: r.quantity,
      note: r.note,
      source: r.source,
      by: r.source === "kados" ? null : r.user_name,
      created_at: r.created_at,
      back_in_stock_at: r.back_in_stock_at,
    });
  }
  return [...groups.values()]
    .map((g) => ({ ...g, customers: g.customers.size }))
    .sort((a, b) => b.customers - a.customers || b.quantity - a.quantity || new Date(b.last_at) - new Date(a.last_at));
}
