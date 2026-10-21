// KAD OS <-> KAD Motors: what a customer's KAD OS install sees and does here (owner, 2026-10-21). Every route belongs to ONE customer: the one the
// signed-in KAD user account is linked to in partner_links. No other customer's data is reachable, whatever the role of that account.
//   GET  /me        customer, the app perks, balance summary, progress (levels / streak / savings), running offers
//   GET  /catalog   the orderable products with this customer's tier price and what is available
//   GET  /offers    campaigns and bundles running for this customer
//   GET  /orders    this customer's orders with the 5-step status (received, confirmed, packed, on the way, delivered)
//   GET  /orders/:id
//   GET  /balance   debt, overdue part, credit limit, recent payments
//   POST /preview   the price of a basket (campaigns, app discount, delivery promise) without placing it
//   POST /orders    place an app order (same rules as POST /api/orders for a linked account)
import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { fetchPricedProducts } from "./products.js";
import { tierListPrice } from "../tierPricing.js";
import { allocateFifo, loadOrdersNewestFirst } from "../debtAging.js";
import { creditSnapshot } from "../creditLimit.js";
import { loadUnrecordedPayments } from "./debtBalances.js";
import { yerevanToday } from "../utils/yerevanDate.js";
import {
  partnerLinkFor, getAppOrderSettings, activeCampaignsFor, applyCampaigns, appDiscountAmd,
  promisedDateFor, partnerStatus, appProgress, PARTNER_STEPS,
} from "../appOrders.js";
import { createOrderHandler } from "./orders.js";

export const partnerRouter = Router();
partnerRouter.use(requireAuth);
partnerRouter.use(async (req, res, next) => {
  const link = await partnerLinkFor(req.user.id);
  if (!link) return res.status(403).json({ error: "This account is not linked to a KAD OS customer", code: "not_partner" });
  req.partner = link;
  next();
});

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
  };
}

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
    promised_date: promised,
    balance: { ...balance, payments: balance.payments.slice(0, 5) },
    progress,
    offers: campaigns.map(presentCampaign),
  });
});

partnerRouter.get("/catalog", async (req, res) => {
  const customer = await loadCustomer(req.partner.customerId);
  const rows = await fetchPricedProducts("WHERE p.active", [], "sales_manager"); // costs and the gold price are redacted for this role
  const individual = new Map();
  if (customer.customer_tier === "gold") {
    const { rows: ip } = await pool.query("SELECT product_id, price_amd FROM customer_product_prices WHERE customer_id = $1", [customer.id]);
    for (const r of ip) individual.set(r.product_id, Number(r.price_amd));
  }
  // The customer's own tier price comes from the full product row, never from the redacted one.
  const { rows: full } = await pool.query("SELECT * FROM products WHERE active");
  const fullById = new Map(full.map((p) => [p.id, p]));
  res.json({
    customer: { id: customer.id, name: customer.name, tier: customer.customer_tier },
    products: rows.map((p) => ({
      id: p.id, brand: p.brand ?? "", family: p.family ?? "", name: p.name, size: p.unit ?? "", sku: p.sku ?? "",
      price: individual.get(p.id) ?? tierListPrice(fullById.get(p.id), customer.customer_tier),
      available: p.available_qty,
    })),
  });
});

partnerRouter.get("/offers", async (req, res) => {
  res.json({ offers: (await activeCampaignsFor(req.partner.customerId)).map(presentCampaign) });
});

async function loadOrders(customerId, where = "", params = [], limit = 60) {
  const { rows } = await pool.query(
    `SELECT o.id, o.order_code, o.status, o.created_at, o.total_amd::float AS total_amd, o.discount_amd::float AS discount_amd, o.app_discount_pct::float AS app_discount_pct,
            to_char(o.promised_date, 'YYYY-MM-DD') AS promised_date, o.placed_via_app, o.note, o.payment_term_days, o.approval_status, o.credit_status,
            EXISTS (SELECT 1 FROM route_stops rs WHERE rs.order_id = o.id AND rs.completed_at IS NULL) AS on_route
       FROM orders o WHERE o.customer_id = $1 ${where} ORDER BY o.created_at DESC, o.id DESC LIMIT ${limit}`,
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
    const status = partnerStatus(o.status, o.on_route);
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
    const { on_route, approval_status, credit_status, ...rest } = o;
    // What the customer may know about a hold: that KAD Motors still has to approve the order (price or credit limit), or that it went back
    // for a correction. No internal reason is passed on.
    const attention = o.status === "draft" ? "returned" : (o.status === "submitted" || o.status === "confirmed") && (approval_status === "pending" || credit_status === "pending") ? "approval" : null;
    return { ...rest, status, raw_status: o.status, attention, timeline, items: lines, saved_amd: Math.round(saved) };
  });
}

partnerRouter.get("/orders", async (req, res) => {
  res.json({ orders: await loadOrders(req.partner.customerId) });
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
partnerRouter.post("/preview", async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ error: "At least one item is required" });
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

partnerRouter.post("/orders", createOrderHandler);
