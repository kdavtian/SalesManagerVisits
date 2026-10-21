// KAD OS link, supplier side (owner, 2026-10-21): the app-order perks' settings, which KAD account belongs to which customer, and the
// campaigns / bundles sent to those customers. The customer's own view is routes/partner.js; the rules are in ../appOrders.js.
import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { canManageAppOrders, canManageCampaigns } from "../roles.js";
import { getAppOrderSettings, saveAppOrderSettings, validateSettingsPatch, campaignBelowCost, forgetPartnerCache } from "../appOrders.js";
import { yerevanCustomRangeBounds } from "../utils/yerevanDate.js";

export const appOrdersAdminRouter = Router();
appOrdersAdminRouter.use(requireAuth);

async function audit(req, action, detail) {
  await pool.query("INSERT INTO app_orders_log (user_id, action, detail) VALUES ($1, $2, $3::jsonb)", [req.user.id, action, JSON.stringify(detail ?? {})]);
}

const needSettings = (req, res, next) => (canManageAppOrders(req.user.role) ? next() : res.status(403).json({ error: "Not allowed" }));
const needCampaigns = (req, res, next) => (canManageCampaigns(req.user.role) ? next() : res.status(403).json({ error: "Not allowed" }));

// ---- settings + account links ---------------------------------------------------------------------------------------
async function loadLinks() {
  const { rows } = await pool.query(
    `SELECT l.user_id, u.name AS user_name, u.email, l.customer_id, c.name AS customer_name, c.erp_customer_id, l.created_at,
            (SELECT COUNT(*)::int FROM orders o WHERE o.customer_id = l.customer_id AND o.placed_via_app) AS app_orders
       FROM partner_links l JOIN users u ON u.id = l.user_id JOIN customers c ON c.id = l.customer_id ORDER BY c.name`
  );
  return rows;
}

appOrdersAdminRouter.get("/settings", needSettings, async (req, res) => {
  res.json({ settings: await getAppOrderSettings(), links: await loadLinks() });
});

appOrdersAdminRouter.put("/settings", needSettings, async (req, res) => {
  const v = validateSettingsPatch(req.body ?? {});
  if (v.error) return res.status(400).json({ error: v.error });
  const { before, after } = await saveAppOrderSettings(v.value);
  await audit(req, "settings.app_orders", { from: before, to: after });
  res.json({ settings: after, links: await loadLinks() });
});

appOrdersAdminRouter.post("/links", needSettings, async (req, res) => {
  const userId = Number(req.body?.user_id);
  const customerId = Number(req.body?.customer_id);
  if (!Number.isInteger(userId) || !Number.isInteger(customerId)) return res.status(400).json({ error: "user_id and customer_id are required" });
  const { rows: u } = await pool.query("SELECT id, role FROM users WHERE id = $1", [userId]);
  if (!u[0]) return res.status(404).json({ error: "User not found" });
  if (u[0].role === "admin" || u[0].role === "ceo") return res.status(400).json({ error: "An admin / CEO account cannot be a KAD OS account -- create a separate account for the customer" });
  const { rows: c } = await pool.query("SELECT id, erp_customer_id FROM customers WHERE id = $1", [customerId]);
  if (!c[0]) return res.status(404).json({ error: "Customer not found" });
  if (!c[0].erp_customer_id) return res.status(400).json({ error: "The customer must be linked to its ERP record first" });
  await pool.query(
    `INSERT INTO partner_links (user_id, customer_id, created_by) VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET customer_id = EXCLUDED.customer_id, created_by = EXCLUDED.created_by, created_at = now()`,
    [userId, customerId, req.user.id]
  );
  forgetPartnerCache();
  await audit(req, "app_orders.link", { user_id: userId, customer_id: customerId });
  res.status(201).json({ links: await loadLinks() });
});

appOrdersAdminRouter.delete("/links/:userId", needSettings, async (req, res) => {
  const userId = Number(req.params.userId);
  const { rowCount } = await pool.query("DELETE FROM partner_links WHERE user_id = $1", [userId]);
  if (!rowCount) return res.status(404).json({ error: "Link not found" });
  forgetPartnerCache();
  await audit(req, "app_orders.unlink", { user_id: userId });
  res.json({ links: await loadLinks() });
});

// ---- campaigns ------------------------------------------------------------------------------------------------------
const CAMPAIGN_SELECT = `
  SELECT c.id, c.title, c.note, c.kind, c.percent::float AS percent, c.starts_at, c.ends_at, c.audience, c.paused, c.created_at, u.name AS created_by_name,
         CASE WHEN c.paused THEN 'paused' WHEN c.ends_at <= now() THEN 'ended' WHEN c.starts_at > now() THEN 'scheduled' ELSE 'running' END AS state,
         COALESCE((SELECT json_agg(json_build_object('product_id', cp.product_id, 'min_qty', cp.min_qty, 'name', p.name, 'brand', p.brand, 'size', p.unit) ORDER BY p.brand, p.name)
                     FROM campaign_products cp JOIN products p ON p.id = cp.product_id WHERE cp.campaign_id = c.id), '[]'::json) AS products,
         COALESCE((SELECT json_agg(json_build_object('customer_id', cc.customer_id, 'name', cu.name, 'erp_customer_id', cu.erp_customer_id) ORDER BY cu.name)
                     FROM campaign_customers cc JOIN customers cu ON cu.id = cc.customer_id WHERE cc.campaign_id = c.id), '[]'::json) AS customers,
         (SELECT COUNT(DISTINCT oi.order_id)::int FROM order_items oi WHERE oi.campaign_id = c.id) AS orders_count,
         (SELECT COALESCE(SUM(oi.line_total_amd), 0)::float FROM order_items oi WHERE oi.campaign_id = c.id) AS sales_amd,
         (SELECT COALESCE(SUM((oi.list_price_amd - oi.unit_price_amd) * oi.quantity), 0)::float FROM order_items oi WHERE oi.campaign_id = c.id) AS discount_amd
    FROM campaigns c LEFT JOIN users u ON u.id = c.created_by`;

appOrdersAdminRouter.get("/campaigns", needCampaigns, async (req, res) => {
  const { rows } = await pool.query(`${CAMPAIGN_SELECT} ORDER BY (c.ends_at > now()) DESC, c.starts_at DESC, c.id DESC LIMIT 200`);
  res.json({ campaigns: rows });
});

const isYmd = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));

appOrdersAdminRouter.post("/campaigns", needCampaigns, async (req, res) => {
  const b = req.body ?? {};
  const title = String(b.title ?? "").trim();
  if (!title || title.length > 80) return res.status(400).json({ error: "A title of up to 80 characters is required" });
  const note = b.note ? String(b.note).trim().slice(0, 300) : null;
  if (b.kind !== "discount" && b.kind !== "bundle") return res.status(400).json({ error: "kind must be 'discount' or 'bundle'" });
  const percent = Number(b.percent);
  if (!Number.isFinite(percent) || percent <= 0 || percent > 50) return res.status(400).json({ error: "percent must be above 0 and at most 50" });
  if (!isYmd(b.starts_on) || !isYmd(b.ends_on) || b.ends_on < b.starts_on) return res.status(400).json({ error: "starts_on and ends_on (YYYY-MM-DD) are required, the end not before the start" });
  const audience = b.audience === "selected" ? "selected" : "all";
  const prods = Array.isArray(b.products) ? b.products : [];
  const productIds = [...new Set(prods.map((p) => Number(p.product_id)).filter(Number.isInteger))];
  if (!productIds.length || productIds.length !== prods.length) return res.status(400).json({ error: "Pick at least one product, each only once" });
  if (b.kind === "bundle" && productIds.length < 2) return res.status(400).json({ error: "A bundle needs at least two products" });
  for (const p of prods) {
    if (!Number.isInteger(Number(p.min_qty ?? 1)) || Number(p.min_qty ?? 1) < 1 || Number(p.min_qty ?? 1) > 10000) return res.status(400).json({ error: "min_qty must be a whole number from 1" });
  }
  const { rows: found } = await pool.query("SELECT id FROM products WHERE id = ANY($1) AND active", [productIds]);
  if (found.length !== productIds.length) return res.status(400).json({ error: "Every product must be an active catalog product" });
  let customerIds = null;
  if (audience === "selected") {
    customerIds = [...new Set((Array.isArray(b.customer_ids) ? b.customer_ids : []).map(Number).filter(Number.isInteger))];
    if (!customerIds.length) return res.status(400).json({ error: "Pick at least one customer, or send the campaign to all" });
    const { rows } = await pool.query("SELECT id FROM customers WHERE id = ANY($1)", [customerIds]);
    if (rows.length !== customerIds.length) return res.status(400).json({ error: "A selected customer was not found" });
  }
  // The price floor: a campaign can never sell a product below what it costs us (net cost, and never below landing cost).
  const tooCheap = await campaignBelowCost({ percent, productIds, customerIds });
  if (tooCheap.length) {
    return res.status(409).json({ error: `${percent}% would sell below cost: ${tooCheap.slice(0, 5).join(", ")}${tooCheap.length > 5 ? "…" : ""}. Lower the percent or remove these products.`, code: "below_cost", products: tooCheap });
  }
  const { startAt, endAt } = yerevanCustomRangeBounds(b.starts_on, b.ends_on);
  const client = await pool.connect();
  let id;
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO campaigns (title, note, kind, percent, starts_at, ends_at, audience, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [title, note, b.kind, percent, startAt, endAt, audience, req.user.id]
    );
    id = rows[0].id;
    for (const p of prods) await client.query("INSERT INTO campaign_products (campaign_id, product_id, min_qty) VALUES ($1, $2, $3)", [id, Number(p.product_id), Number(p.min_qty ?? 1)]);
    for (const cid of customerIds ?? []) await client.query("INSERT INTO campaign_customers (campaign_id, customer_id) VALUES ($1, $2)", [id, cid]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  await audit(req, "campaign.create", { id, title, kind: b.kind, percent, audience });
  const { rows } = await pool.query(`${CAMPAIGN_SELECT} WHERE c.id = $1`, [id]);
  res.status(201).json(rows[0]);
});

// Pause / resume, or end it now. Nothing else changes after creation (prices already promised to customers must not move).
appOrdersAdminRouter.patch("/campaigns/:id", needCampaigns, async (req, res) => {
  const id = Number(req.params.id);
  const { paused, end_now } = req.body ?? {};
  const { rows: cur } = await pool.query("SELECT id, paused, ends_at, starts_at FROM campaigns WHERE id = $1", [id]);
  if (!cur[0]) return res.status(404).json({ error: "Campaign not found" });
  if (typeof paused === "boolean") await pool.query("UPDATE campaigns SET paused = $2 WHERE id = $1", [id, paused]);
  if (end_now === true) await pool.query("UPDATE campaigns SET ends_at = GREATEST(starts_at + interval '1 second', LEAST(ends_at, now())) WHERE id = $1", [id]);
  await audit(req, "campaign.update", { id, paused, end_now });
  const { rows } = await pool.query(`${CAMPAIGN_SELECT} WHERE c.id = $1`, [id]);
  res.json(rows[0]);
});

// A campaign nobody has used can be deleted; a used one stays as history (end it instead).
appOrdersAdminRouter.delete("/campaigns/:id", needCampaigns, async (req, res) => {
  const id = Number(req.params.id);
  const { rows: used } = await pool.query("SELECT 1 FROM order_items WHERE campaign_id = $1 LIMIT 1", [id]);
  if (used[0]) return res.status(409).json({ error: "This campaign is already on orders -- end it instead of deleting it" });
  const { rowCount } = await pool.query("DELETE FROM campaigns WHERE id = $1", [id]);
  if (!rowCount) return res.status(404).json({ error: "Campaign not found" });
  await audit(req, "campaign.delete", { id });
  res.status(204).end();
});
