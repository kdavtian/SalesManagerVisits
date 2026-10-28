// KAD OS <-> KAD Motors: what a customer's KAD OS install sees and does here (owner, 2026-10-21). Every route belongs to ONE customer: the one the
// signed-in KAD user account is linked to in partner_links. No other customer's data is reachable, whatever the role of that account.
//   GET  /me        customer, the app perks, balance summary, progress (levels / streak / savings), running offers
//   GET  /catalog   the orderable products with this customer's tier price and what is available
//   POST /wishes, GET /wishes   wished products (out of stock or never carried) and which of them are back
//   GET  /price-list   the Bronze list price of EVERY active product (also what is out of stock), for a shop that resells at the Bronze price
//   GET  /offers    campaigns and bundles running for this customer
//   GET  /orders    this customer's orders with the 5-step status (received, confirmed, packed, on the way, delivered)
//   GET  /orders/:id
//   GET  /balance   debt, overdue part, credit limit, recent payments
//   POST /preview   the price of a basket (campaigns, app discount, delivery promise) without placing it
//   POST /orders    place an app order (same rules as POST /api/orders for a linked account); with replaces_order_id it CHANGES a still-unconfirmed order
//   POST /orders/:id/cancel   cancel an app order that KAD Motors has not confirmed yet
//   POST /payments/dispute    "I don't see my payments": tells management (not the rep) and returns the office number to call
import { outOfStockProducts, outOfStockResponse } from "../orderStock.js";
import { addWish, cleanWish, WishValidationError } from "../productWishes.js";
import path from "node:path";
import { Router } from "express";
import { uploadDirPath } from "../../shared/upload.js";
import { pool } from "../../db/pool.js";
import { requireAuth } from "../../middleware/auth.js";
import { fetchPricedProducts } from "../../products/routes/products.js";
import { orderedProductIdsOf } from "../../customers/routes/customers.js";
import { companyFrequentIds } from "../../products/routes/productShortcuts.js";
import { tierListPrice } from "../../products/tierPricing.js";
import { compareProducts } from "../../../../client/public/js/productSort.js";
import { allocateFifo, loadOrdersNewestFirst } from "../../money/debtAging.js";
import { creditSnapshot } from "../creditLimit.js";
import { loadUnrecordedPayments } from "../../money/routes/debtBalances.js";
import { yerevanToday } from "../../utils/yerevanDate.js";
import {
  partnerLinkFor, getAppOrderSettings, activeCampaignsFor, applyCampaigns, appDiscountAmd,
  promisedDateFor, partnerStatus, appProgress, PARTNER_STEPS, maxQtyFor, firstOverLimit, contactFor as contactForId,
} from "../appOrders.js";
import { createOrderHandler } from "./orders.js";
import { notifyTelegram, escapeHtml } from "../../shared/telegram.js";
import { notifyUser } from "../../shared/notifications.js";
import { ORDER_NOTIFY_ROLES } from "../../shared/notificationPreferences.js";
import { bullets } from "../../utils/bullets.js";
import { recordCustomerDispute } from "../../money/antiFraud.js";
import { normalizePhoneForStorage } from "../../shared/phoneFormat.js";
import { OFFICE_PHONE } from "../../products/pricelistPdf.js";

export const partnerRouter = Router();
partnerRouter.use(requireAuth);
partnerRouter.use(async (req, res, next) => {
  const link = await partnerLinkFor(req.user.id);
  if (!link) return res.status(403).json({ error: "This account is not linked to a KAD OS customer", code: "not_partner" });
  req.partner = link;
  next();
});

const officePhone = () => normalizePhoneForStorage(OFFICE_PHONE);

async function loadCustomer(customerId) {
  const { rows } = await pool.query("SELECT id, name, erp_customer_id, customer_tier, credit_limit_amd, credit_term_days FROM customers WHERE id = $1", [customerId]);
  return rows[0];
}

function presentCampaign(c) {
  return { id: c.id, title: c.title, note: c.note, kind: c.kind, percent: c.percent, starts_at: c.starts_at, ends_at: c.ends_at, products: c.products };
}

async function balanceFor(customer) {
  const erpId = customer.erp_customer_id;
  const out = { debt_amd: 0, overdue_amd: 0, oldest_due_days: 0, credit_limit_amd: null, open_orders_amd: 0, available_credit_amd: null, unrecorded_amd: 0, payments: [], as_of: null };
  if (!erpId) return out;
  const { rows } = await pool.query("SELECT debt_amd, synced_at FROM erp_customer_data WHERE erp_customer_id = $1", [erpId]);
  const debt = Number(rows[0]?.debt_amd ?? 0);
  out.debt_amd = debt;
  out.as_of = rows[0]?.synced_at ?? null;
  const orders = await loadOrdersNewestFirst(pool, [erpId]);
  const a = allocateFifo({ orders: orders.get(erpId) ?? [], debt, today: yerevanToday(), termDays: customer.credit_term_days ?? 45 });
  out.overdue_amd = a.overdue_amd;
  out.oldest_due_days = a.oldest_due_days;
  const snap = await creditSnapshot(pool, customer.id);
  if (snap) {
    out.credit_limit_amd = snap.limit;
    out.open_orders_amd = snap.openOrders;
    if (snap.limit !== null) out.available_credit_amd = Math.max(0, snap.limit - snap.debt - snap.openOrders);
  }
  const unrecorded = await loadUnrecordedPayments([{ internal_customer_id: customer.id, customer_id: erpId }], null);
  out.unrecorded_amd = unrecorded.get(customer.id)?.amount ?? 0;
  const { rows: pay } = await pool.query(
    `SELECT to_char(cashflow_date, 'YYYY-MM-DD') AS date, amount_amd::float AS amount
       FROM erp_cashflow_lines WHERE erp_customer_id = $1 AND amount_amd > 0 AND cashflow_date >= (now() AT TIME ZONE 'Asia/Yerevan')::date - 365
      ORDER BY cashflow_date DESC, id DESC LIMIT 30`,
    [erpId]
  );
  out.payments = pay;
  return out;
}

function perks(settings) {
  return {
    discount_pct: settings.discount_enabled ? settings.discount_pct : 0,
    priority: settings.priority_enabled,
    promise_working_days: settings.promise_enabled ? settings.promise_working_days : null,
    promise_cutoff_hour: settings.promise_enabled ? settings.promise_cutoff_hour : null,
    progress: settings.progress_enabled,
    customer_edit: settings.customer_edit_enabled,
  };
}

// Who to call when an order can no longer be changed in the app: the customer's own sales manager, else the office.
const contactFor = (customer) => contactForId(customer.id);

partnerRouter.get("/me", async (req, res) => {
  const customer = await loadCustomer(req.partner.customerId);
  const settings = await getAppOrderSettings();
  const now = new Date();
  const [balance, campaigns, progress, promised] = await Promise.all([
    balanceFor(customer),
    activeCampaignsFor(customer.id, now),
    settings.progress_enabled ? appProgress(customer.id, settings, now) : null,
    promisedDateFor(now, settings),
  ]);
  res.json({
    customer: { id: customer.id, name: customer.name, erp_customer_id: customer.erp_customer_id, tier: customer.customer_tier },
    // The customer's own payment terms in KAD Motors (invoice, N days): KAD OS sends its orders with them instead of a number kept in its own settings.
    terms: { method: "invoice", days: customer.credit_term_days ?? 45 },
    perks: perks(settings),
    contact: await contactFor(customer),
    promised_date: promised,
    balance: { ...balance, payments: balance.payments.slice(0, 5) },
    progress,
    offers: campaigns.map(presentCampaign),
  });
});

partnerRouter.get("/catalog", async (req, res) => {
  const customer = await loadCustomer(req.partner.customerId);
  const settings = await getAppOrderSettings();
  const rows = (await fetchPricedProducts("WHERE p.active", [], "sales_manager")) // costs and the gold price are redacted for this role
    // The customer sees only what we have on the shelf, and never HOW MANY (owner, 2026-10-22): no stock figure leaves this server.
    .filter((p) => p.available_qty !== null && p.available_qty > 0);
  const individual = new Map();
  if (customer.customer_tier === "gold") {
    const { rows: ip } = await pool.query("SELECT product_id, price_amd FROM customer_product_prices WHERE customer_id = $1", [customer.id]);
    for (const r of ip) individual.set(r.product_id, Number(r.price_amd));
  }
  // The customer's own tier price comes from the full product row, never from the redacted one.
  const { rows: full } = await pool.query("SELECT * FROM products WHERE active");
  const fullById = new Map(full.map((p) => [p.id, p]));
  // The same display order as every product list in KAD Motors (brand, line, viscosity, specification, size): KAD OS keeps it.
  rows.sort(compareProducts);
  // "Frequent" (the same idea as the new-order screen here): what this customer ordered most, else what the whole company orders most.
  // Only products the customer can order now (on the shelf): filter BOTH rankings before choosing the fallback and before the limit.
  const orderable = new Set(rows.map((p) => p.id));
  const own = (await orderedProductIdsOf(customer.id, customer.erp_customer_id)).map((x) => x.product_id).filter((id) => orderable.has(id));
  const frequent = (own.length ? own : (await companyFrequentIds()).filter((id) => orderable.has(id))).slice(0, 60);
  res.json({
    customer: { id: customer.id, name: customer.name, tier: customer.customer_tier },
    frequent,
    products: rows.map((p) => ({
      id: p.id, brand: p.brand ?? "", family: p.family ?? "", name: p.name, size: p.unit ?? "", sku: p.sku ?? "",
      image_v: fullById.get(p.id)?.image_path ?? null, // the photo (GET /products/:id/image), so KAD OS can show it

      price: individual.get(p.id) ?? tierListPrice(fullById.get(p.id), customer.customer_tier),
      max_qty: maxQtyFor(p.unit, settings), // the most pieces of this product in one order (null = no limit)
    })),
  });
});

// The Bronze list price of every active product (in stock or not): KAD OS uses it as the wholesale price of a shop that resells our oil.
// Only the public list price -- never a cost, a stock figure, or another tier.
partnerRouter.get("/price-list", async (_req, res) => {
  const { rows } = await pool.query("SELECT id, brand, family, name, unit, sku, bronze_price_amd, silver_price_amd, unit_price_amd FROM products WHERE active ORDER BY id");
  res.json({
    products: rows
      .map((p) => ({ id: p.id, brand: p.brand ?? "", family: p.family ?? "", name: p.name, size: p.unit ?? "", sku: p.sku ?? "", bronze: tierListPrice(p, "bronze") }))
      .filter((p) => p.bronze > 0),
  });
});

// The product photo (the main one KAD Motors shows in its own lists). Only products of the catalog; no stock or cost data in it.
partnerRouter.get("/products/:id/image", async (req, res) => {
  const { rows } = await pool.query("SELECT image_path FROM products WHERE id = $1 AND active", [req.params.id]);
  const imagePath = rows[0]?.image_path;
  if (!imagePath) return res.status(404).json({ error: "No image set" });
  res.set("Cache-Control", "private, max-age=86400");
  res.sendFile(path.join(uploadDirPath, imagePath), (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: "Image not found" });
  });
});

partnerRouter.get("/offers", async (req, res) => {
  res.json({ offers: (await activeCampaignsFor(req.partner.customerId)).map(presentCampaign) });
});

async function loadOrders(customerId, where = "", params = [], limit = 60, offset = 0) {
  const editable = (await getAppOrderSettings()).customer_edit_enabled;
  const { rows } = await pool.query(
    `SELECT o.id, o.order_code, o.status, o.created_at, o.total_amd::float AS total_amd, o.discount_amd::float AS discount_amd, o.app_discount_pct::float AS app_discount_pct,
            to_char(o.promised_date, 'YYYY-MM-DD') AS promised_date, o.placed_via_app, o.note, o.payment_term_days, o.approval_status, o.credit_status,
            o.cancelled_at, o.cancel_reason, o.replaced_by_order_id,
            (SELECT r.order_code FROM orders r WHERE r.id = o.replaced_by_order_id) AS replaced_by_code,
            EXISTS (SELECT 1 FROM route_stops rs WHERE rs.order_id = o.id AND rs.completed_at IS NULL) AS on_route
       FROM orders o WHERE o.customer_id = $1 ${where} ORDER BY o.created_at DESC, o.id DESC LIMIT ${Number(limit)} OFFSET ${Number(offset)}`,
    [customerId, ...params]
  );
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [{ rows: items }, { rows: hist }, { rows: pods }] = await Promise.all([
    pool.query(
      `SELECT oi.order_id, oi.product_id, oi.product_name AS name, oi.brand, p.unit AS size, oi.quantity::float AS quantity, oi.unit_price_amd::float AS unit_price,
              oi.line_total_amd::float AS total, oi.list_price_amd::float AS list_price, oi.campaign_id, c.title AS campaign_title
         FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id LEFT JOIN campaigns c ON c.id = oi.campaign_id
        WHERE oi.order_id = ANY($1) ORDER BY oi.id`,
      [ids]
    ),
    pool.query("SELECT order_id, new_status, changed_at FROM order_status_history WHERE order_id = ANY($1) ORDER BY changed_at, id", [ids]),
    pool.query("SELECT order_id, max(delivered_at) AS at FROM pod_records WHERE order_id = ANY($1) GROUP BY order_id", [ids]),
  ]);
  const podAt = new Map(pods.map((p) => [p.order_id, p.at]));
  return rows.map((o) => {
    const cancelled = Boolean(o.cancelled_at);
    const status = cancelled ? "cancelled" : partnerStatus(o.status, o.on_route);
    const at = {};
    for (const h of hist.filter((x) => x.order_id === o.id)) {
      const step = h.new_status === "submitted" ? "received" : h.new_status === "confirmed" ? "confirmed" : h.new_status === "packed_stock_out" ? "packed" : h.new_status === "delivered" ? "delivered" : null;
      if (step) at[step] = h.changed_at;
    }
    at.received ??= o.created_at;
    if (podAt.get(o.id)) at.delivered = podAt.get(o.id);
    const reached = PARTNER_STEPS.indexOf(status);
    const timeline = PARTNER_STEPS.map((step, i) => ({ step, at: at[step] ?? null, done: reached >= 0 && i <= reached }));
    const lines = items.filter((i) => i.order_id === o.id).map(({ order_id, ...rest }) => rest);
    const saved = lines.reduce((s, l) => s + (l.list_price ? (l.list_price - l.unit_price) * l.quantity : 0), 0) + (o.discount_amd || 0);
    const { on_route, approval_status, credit_status, replaced_by_order_id, ...rest } = o;
    // What the customer may know about a hold: that KAD Motors still has to approve the order (price or credit limit), or that it went back
    // for a correction. No internal reason is passed on.
    const attention = cancelled ? null : o.status === "draft" ? "returned" : (o.status === "submitted" || o.status === "confirmed") && (approval_status === "pending" || credit_status === "pending") ? "approval" : null;
    // Until KAD Motors confirms it, the customer may still cancel or change the order (Settings -> KAD OS -> App perks can switch this off).
    const can_edit = editable && o.status === "submitted" && !cancelled && o.placed_via_app;
    return { ...rest, status, raw_status: o.status, attention, can_edit, replaced: replaced_by_order_id !== null, timeline, items: lines, saved_amd: Math.round(saved) };
  });
}

// ALL of the customer's orders, newest first, in pages: ?limit= (default 60, at most 200) and ?offset=. `total` = how many there are.
const pageOf = (query, defLimit, maxLimit) => ({
  limit: Math.min(maxLimit, Math.max(1, Number.parseInt(query.limit, 10) || defLimit)),
  offset: Math.max(0, Number.parseInt(query.offset, 10) || 0),
});

partnerRouter.get("/orders", async (req, res) => {
  const { limit, offset } = pageOf(req.query, 60, 200);
  const [orders, { rows: cnt }] = await Promise.all([
    loadOrders(req.partner.customerId, "", [], limit, offset),
    pool.query("SELECT count(*)::int AS n FROM orders WHERE customer_id = $1", [req.partner.customerId]),
  ]);
  res.json({ orders, total: cnt[0].n, has_more: offset + orders.length < cnt[0].n });
});

// ALL of the customer's payments (the Excel cash book, every year), newest first, in pages. `total_amount` is the sum of all of them.
partnerRouter.get("/payments", async (req, res) => {
  const customer = await loadCustomer(req.partner.customerId);
  const erpId = customer.erp_customer_id;
  const { limit, offset } = pageOf(req.query, 50, 500);
  if (!erpId) return res.json({ payments: [], total: 0, total_amount: 0, has_more: false, office_phone: officePhone() });
  const [{ rows: payments }, { rows: sum }] = await Promise.all([
    pool.query(
      `SELECT to_char(cashflow_date, 'YYYY-MM-DD') AS date, amount_amd::float AS amount
         FROM erp_cashflow_lines WHERE erp_customer_id = $1 AND amount_amd > 0
        ORDER BY cashflow_date DESC, id DESC LIMIT $2 OFFSET $3`,
      [erpId, limit, offset]
    ),
    pool.query("SELECT count(*)::int AS n, COALESCE(sum(amount_amd), 0)::float AS total FROM erp_cashflow_lines WHERE erp_customer_id = $1 AND amount_amd > 0", [erpId]),
  ]);
  res.json({ payments, total: sum[0].n, total_amount: sum[0].total, has_more: offset + payments.length < sum[0].n, office_phone: officePhone() });
});

// "I don't see my payments": the customer says the payments listed here are not what they paid. Management is told (never the rep) and the app
// gives them the office number to call right away (owner, 2026-10-25). One finding per customer per day.
partnerRouter.post("/payments/dispute", async (req, res) => {
  const result = await recordCustomerDispute({ customerId: req.partner.customerId, note: req.body?.note });
  res.json({ ok: true, new: Boolean(result?.id), office_phone: officePhone() });
});

partnerRouter.get("/orders/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(404).json({ error: "Order not found" });
  const [order] = await loadOrders(req.partner.customerId, "AND o.id = $2", [id], 1);
  if (!order) return res.status(404).json({ error: "Order not found" });
  res.json(order);
});

partnerRouter.get("/balance", async (req, res) => {
  const customer = await loadCustomer(req.partner.customerId);
  res.json(await balanceFor(customer));
});

// The same pricing a real order gets (campaigns, then the app discount on the rest, then the delivery promise), nothing saved.
// Wished products (productWishes.js): the customer asks for a product we do not have on the shelf (any product of the price list) or one we
// never carried (typed name). Management is told; when a wished product is back, it shows here with back_in_stock_at.
partnerRouter.post("/wishes", async (req, res) => {
  try {
    const wish = cleanWish(req.body);
    if (wish.productId !== null) {
      const { rows } = await pool.query("SELECT 1 FROM products WHERE id = $1 AND active", [wish.productId]);
      if (!rows[0]) return res.status(400).json({ error: "Product not found" });
    }
    const row = await addWish({ customerId: req.partner.customerId, userId: req.user.id, source: "kados", wish });
    res.status(201).json(presentWish(row));
  } catch (err) {
    if (err instanceof WishValidationError) return res.status(400).json({ error: err.message });
    throw err;
  }
});

// The customer's own wishes of the last 90 days, newest first; back_in_stock_at says "available again, order it now".
partnerRouter.get("/wishes", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT w.*, p.name AS product_name, p.unit FROM product_wishes w LEFT JOIN products p ON p.id = w.product_id
     WHERE w.customer_id = $1 AND w.created_at > now() - interval '90 days' ORDER BY w.created_at DESC LIMIT 200`,
    [req.partner.customerId]
  );
  res.json({ wishes: rows.map(presentWish) });
});

function presentWish(w) {
  return {
    id: w.id,
    product_id: w.product_id,
    name: w.product_id ? w.product_name : w.custom_name,
    size: w.product_id ? w.unit ?? "" : "",
    quantity: w.quantity,
    note: w.note,
    created_at: w.created_at,
    back_in_stock_at: w.back_in_stock_at,
  };
}

partnerRouter.post("/preview", async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ error: "At least one item is required" });
  const over = await firstOverLimit(items, await getAppOrderSettings());
  if (over) return res.status(400).json({ error: "This order is above the limit for one of its products", code: "order_limit", ...over, contact: await contactForId(req.partner.customerId) });
  // the basket may hold a product that sold out after the catalog was loaded: say so before the customer presses Send
  const outOfStock = await outOfStockProducts(items, { strictUnknown: true });
  if (outOfStock.length) return outOfStockResponse(res, outOfStock);
  const customer = await loadCustomer(req.partner.customerId);
  const ids = items.map((i) => Number(i.product_id)).filter(Number.isInteger);
  const { rows: products } = await pool.query("SELECT * FROM products WHERE id = ANY($1) AND active", [ids]);
  const byId = new Map(products.map((p) => [p.id, p]));
  const individual = new Map();
  if (customer.customer_tier === "gold") {
    const { rows } = await pool.query("SELECT product_id, price_amd FROM customer_product_prices WHERE customer_id = $1 AND product_id = ANY($2)", [customer.id, ids]);
    for (const r of rows) individual.set(r.product_id, Number(r.price_amd));
  }
  const lines = [];
  for (const it of items) {
    const p = byId.get(Number(it.product_id));
    const quantity = Number(it.quantity);
    if (!p || !Number.isFinite(quantity) || quantity <= 0) return res.status(400).json({ error: "Every item needs an active catalog product and a positive quantity" });
    const price = individual.get(p.id) ?? tierListPrice(p, customer.customer_tier);
    lines.push({ product_id: p.id, name: p.name, quantity, unit_price_amd: price, line_total_amd: price * quantity });
  }
  const settings = await getAppOrderSettings();
  const priced = applyCampaigns(lines, await activeCampaignsFor(customer.id));
  const discountPct = settings.discount_enabled ? settings.discount_pct : 0;
  const discountAmd = appDiscountAmd(priced, discountPct);
  const subtotal = priced.reduce((s, l) => s + l.line_total_amd, 0);
  res.json({
    lines: priced.map((l) => ({ product_id: l.product_id, quantity: l.quantity, unit_price: l.unit_price_amd, list_price: l.list_price_amd, total: l.line_total_amd, campaign_id: l.campaign_id })),
    subtotal_amd: subtotal,
    app_discount_amd: discountAmd,
    app_discount_pct: discountAmd > 0 ? discountPct : 0,
    total_amd: subtotal - discountAmd,
    saved_amd: priced.reduce((s, l) => s + (l.list_price_amd ? (l.list_price_amd - l.unit_price_amd) * l.quantity : 0), 0) + discountAmd,
    promised_date: await promisedDateFor(new Date(), settings),
  });
});

// ---- cancel / change until KAD Motors confirms (owner, 2026-10-21) -------------------------------------------------------
// "Cancelled" = the order goes back to draft with cancelled_at set (migration 137): out of every live queue, kept as a record, never submittable
// again. The UPDATE is guarded on status = 'submitted', exactly like the confirm: whichever of the customer's cancel and the office's confirm
// reaches the database first wins, the other gets a clean "too late". Past Confirmed the customer calls their manager (contact in GET /me).
const logCancelled = (userId, orderId, reason) =>
  pool.query(`INSERT INTO order_status_history (order_id, old_status, new_status, reason, changed_by) VALUES ($1, 'submitted', 'draft', $2, $3)`, [orderId, reason, userId]);

async function cancelAppOrder(userId, customerId, orderId, { reason, replacing }) {
  const { rows } = await pool.query(
    `UPDATE orders SET status = 'draft', cancelled_at = now(), cancel_reason = $3, draft_reason = $4, updated_at = now()
      WHERE id = $1 AND customer_id = $2 AND placed_via_app AND status = 'submitted' AND cancelled_at IS NULL
      RETURNING id, order_code, total_amd, user_id`,
    [orderId, customerId, reason || null, replacing ? "Changed by the customer (KAD OS)" : "Cancelled by the customer (KAD OS)"]
  );
  const order = rows[0];
  if (!order) return null;
  // A change writes its history row only once the new order exists (the log cannot be edited afterwards): see the POST /orders below.
  if (!replacing) await logCancelled(userId, order.id, `Cancelled by the customer (KAD OS)${reason ? `: ${reason}` : ""}`);
  return order;
}

// Put the order back exactly as it was (the change failed after the old order was already cancelled; nothing was logged for it, so nothing is lost).
async function restoreAppOrder(orderId) {
  await pool.query(
    `UPDATE orders SET status = 'submitted', cancelled_at = NULL, cancel_reason = NULL, draft_reason = NULL, updated_at = now()
      WHERE id = $1 AND status = 'draft' AND cancelled_at IS NOT NULL AND replaced_by_order_id IS NULL`,
    [orderId]
  );
}

// Staff hear about it at once: the order they may already be looking at, the customer's own manager, and the Telegram group.
async function tellStaffCancelled(order, customer, reason) {
  try {
    notifyTelegram(`↩️ <b>APP order cancelled by the customer</b>\n${escapeHtml(customer.name)} — ${escapeHtml(order.order_code)}\n${Number(order.total_amd).toLocaleString()} AMD${reason ? `\n${escapeHtml(reason)}` : ""}`);
    const { rows: roles } = await pool.query("SELECT id FROM users WHERE role = ANY($1)", [ORDER_NOTIFY_ROLES]);
    const { rows: mgr } = await pool.query("SELECT assigned_manager_id AS id FROM customers WHERE id = $1", [customer.id]);
    const ids = new Set(roles.map((r) => r.id));
    if (mgr[0]?.id) ids.add(mgr[0].id);
    for (const id of ids) {
      notifyUser(id, "order_status_changed", {
        title: "Հաճախորդը չեղարկեց պատվերը (KAD OS)",
        body: `${customer.name}\n${bullets([`Պատվեր՝ ${order.order_code}`, `Գումար՝ ${Number(order.total_amd).toLocaleString()} ԱՄԴ`, reason ? `Պատճառ՝ ${reason}` : null])}`,
        url: `/#/orders?open=${order.id}`,
      });
    }
  } catch (err) {
    console.error("Order-cancelled notification failed:", err);
  }
}

function cleanReason(v) {
  const s = typeof v === "string" ? v.trim().slice(0, 200) : "";
  return s || null;
}

async function editNotAllowed(res, customerId) {
  const settings = await getAppOrderSettings();
  if (!settings.customer_edit_enabled) {
    res.status(403).json({ error: "Orders can no longer be cancelled or changed in the app", code: "edit_disabled", contact: await contactFor({ id: customerId }) });
    return true;
  }
  return false;
}

async function tooLate(res, customerId, orderId) {
  const { rows } = await pool.query("SELECT status, cancelled_at FROM orders WHERE id = $1 AND customer_id = $2 AND placed_via_app", [orderId, customerId]);
  if (!rows[0]) return res.status(404).json({ error: "Order not found" });
  const code = rows[0].cancelled_at ? "already_cancelled" : "too_late";
  return res.status(409).json({
    error: rows[0].cancelled_at ? "This order is already cancelled" : "KAD Motors has already confirmed this order -- please call your sales manager to change it",
    code,
    contact: await contactFor({ id: customerId }),
  });
}

partnerRouter.post("/orders/:id/cancel", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(404).json({ error: "Order not found" });
  if (await editNotAllowed(res, req.partner.customerId)) return;
  const reason = cleanReason(req.body?.reason);
  const order = await cancelAppOrder(req.user.id, req.partner.customerId, id, { reason });
  if (!order) return tooLate(res, req.partner.customerId, id);
  const customer = await loadCustomer(req.partner.customerId);
  const [out] = await loadOrders(req.partner.customerId, "AND o.id = $2", [id], 1);
  res.json(out);
  tellStaffCancelled(order, customer, reason);
});

// Placing an order; with replaces_order_id it is a CHANGE: the old order is cancelled first (so it can no longer be confirmed behind the
// customer's back), the new one is placed by the normal order handler, and if that fails for any reason the old order comes back untouched.
partnerRouter.post("/orders", async (req, res) => {
  const replacesId = req.body?.replaces_order_id;
  if (replacesId === undefined || replacesId === null || replacesId === "") return createOrderHandler(req, res);
  const oldId = Number(replacesId);
  if (!Number.isInteger(oldId)) return res.status(400).json({ error: "replaces_order_id must be an order id" });
  const customerId = req.partner.customerId;
  if (await editNotAllowed(res, customerId)) return;

  // A retried change (same client_ref, the first attempt already went through) must not cancel anything again.
  if (req.body?.client_ref) {
    const { rows } = await pool.query("SELECT 1 FROM orders WHERE user_id = $1 AND client_ref = $2", [req.user.id, req.body.client_ref]);
    if (rows[0]) return createOrderHandler(req, res);
  }
  const old = await cancelAppOrder(req.user.id, customerId, oldId, { replacing: true });
  if (!old) return tooLate(res, customerId, oldId);
  req.replacesOrder = { id: old.id, order_code: old.order_code };

  const origJson = res.json.bind(res);
  let settled = false;
  res.json = (body) => {
    if (settled) return res;
    settled = true;
    (async () => {
      try {
        if (res.statusCode < 300 && body?.id) {
          await pool.query("UPDATE orders SET replaced_by_order_id = $2 WHERE id = $1", [old.id, body.id]);
          await logCancelled(req.user.id, old.id, `Changed by the customer (KAD OS) - replaced by ${body.order_code}`);
          origJson({ ...body, replaces: { id: old.id, order_code: old.order_code } });
        } else {
          await restoreAppOrder(old.id);
          origJson(body);
        }
      } catch (err) {
        console.error("Finishing an order change failed:", err);
        origJson(body);
      }
    })();
    return res;
  };
  try {
    await createOrderHandler(req, res);
  } catch (err) {
    if (!settled) {
      settled = true;
      await restoreAppOrder(old.id);
    }
    throw err;
  }
});
