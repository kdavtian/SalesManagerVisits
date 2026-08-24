import crypto from "node:crypto";
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";

export const erpSyncRouter = Router();

const syncKeyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many sync attempts. Try again later." },
});

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // timingSafeEqual throws on mismatched lengths, which would itself leak
  // length via a caught-exception timing difference -- pad instead of
  // early-returning, so every call takes the same code path.
  if (bufA.length !== bufB.length) {
    return crypto.timingSafeEqual(bufA, bufA) && false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

// This is a machine-to-machine push from the Windows PC running the CEO
// Telegram bot pipeline (ceo_agent.py -> work/sync_field_visits.py), not a
// browser session, so it authenticates with a static shared secret instead
// of the usual cookie/JWT flow.
function requireSyncKey(req, res, next) {
  const key = req.get("X-Sync-Key") || "";
  const expected = process.env.ERP_SYNC_KEY || "";
  if (!expected || !timingSafeEqual(key, expected)) {
    return res.status(401).json({ error: "Invalid or missing sync key" });
  }
  next();
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The whole erp_customer_data table is replaced on every sync (rather than
// merged row by row) so a customer that drops out of the extract -- debt
// fully paid, no recent orders -- doesn't keep showing stale data forever.
erpSyncRouter.post("/", syncKeyLimiter, requireSyncKey, async (req, res) => {
  const { customers, order_lines, sales_performance } = req.body ?? {};
  if (!Array.isArray(customers)) {
    return res.status(400).json({ error: "customers must be an array" });
  }
  if (order_lines !== undefined && !Array.isArray(order_lines)) {
    return res.status(400).json({ error: "order_lines must be an array" });
  }
  if (sales_performance !== undefined && !Array.isArray(sales_performance)) {
    return res.status(400).json({ error: "sales_performance must be an array" });
  }

  const erpIds = [];
  const names = [];
  const reps = [];
  const debts = [];
  const lastPayments = [];
  const daysSince = [];
  const agingBuckets = [];
  const recentOrders = [];
  const regionErpIds = [];
  const regions = [];
  const subregions = [];

  for (const entry of customers) {
    if (!isPlainObject(entry) || !entry.erp_customer_id) continue;
    erpIds.push(String(entry.erp_customer_id));
    names.push(entry.customer_name != null ? String(entry.customer_name) : null);
    reps.push(entry.assigned_sales_rep != null ? String(entry.assigned_sales_rep) : null);
    debts.push(Number.isFinite(entry.debt_amd) ? entry.debt_amd : null);
    lastPayments.push(entry.last_payment_date || null);
    daysSince.push(Number.isFinite(entry.days_since_payment) ? entry.days_since_payment : null);
    agingBuckets.push(entry.aging_bucket || null);
    recentOrders.push(JSON.stringify(Array.isArray(entry.recent_orders) ? entry.recent_orders.slice(0, 10) : []));
    if (entry.region || entry.subregion) {
      regionErpIds.push(String(entry.erp_customer_id));
      regions.push(entry.region != null ? String(entry.region) : null);
      subregions.push(entry.subregion != null ? String(entry.subregion) : null);
    }
  }

  const lineErpIds = [];
  const lineOrderIds = [];
  const lineDates = [];
  const lineProductIds = [];
  const lineBrands = [];
  const lineProductNames = [];
  const lineSizes = [];
  const lineQtys = [];
  const lineUnitPrices = [];
  const lineRevenues = [];

  for (const line of Array.isArray(order_lines) ? order_lines : []) {
    if (!isPlainObject(line) || !line.erp_customer_id || !line.order_id || !line.date) continue;
    lineErpIds.push(String(line.erp_customer_id));
    lineOrderIds.push(String(line.order_id));
    lineDates.push(line.date);
    lineProductIds.push(line.product_id != null ? String(line.product_id) : null);
    lineBrands.push(line.brand != null ? String(line.brand) : null);
    lineProductNames.push(line.product != null ? String(line.product) : null);
    lineSizes.push(line.size_l != null ? String(line.size_l) : null);
    lineQtys.push(Number.isFinite(line.qty) ? line.qty : null);
    lineUnitPrices.push(Number.isFinite(line.unit_price_amd) ? line.unit_price_amd : null);
    lineRevenues.push(Number.isFinite(line.revenue_amd) ? line.revenue_amd : null);
  }

  const perfRepNames = [];
  const perfMonths = [];
  const perfSales = [];
  const perfCollected = [];
  const perfBudget = [];

  for (const rep of Array.isArray(sales_performance) ? sales_performance : []) {
    if (!isPlainObject(rep) || !rep.rep_name || !Array.isArray(rep.monthly)) continue;
    for (const m of rep.monthly) {
      if (!isPlainObject(m) || !m.month) continue;
      perfRepNames.push(String(rep.rep_name));
      perfMonths.push(m.month);
      perfSales.push(Number.isFinite(m.sales_amd) ? m.sales_amd : 0);
      perfCollected.push(Number.isFinite(m.collected_amd) ? m.collected_amd : 0);
      perfBudget.push(Number.isFinite(m.budget_amd) ? m.budget_amd : 0);
    }
  }

  const client = await pool.connect();
  let releaseErr;
  try {
    await client.query("BEGIN");
    await client.query("TRUNCATE erp_customer_data");
    // Single bulk insert via unnest() instead of one round trip per row --
    // keeps the TRUNCATE's ACCESS EXCLUSIVE lock (which blocks concurrent
    // reads of this table, e.g. a customer detail page) held for as short
    // a time as possible regardless of how many rows the extract contains.
    if (erpIds.length) {
      await client.query(
        `INSERT INTO erp_customer_data
           (erp_customer_id, customer_name, assigned_sales_rep, debt_amd, last_payment_date, days_since_payment, aging_bucket, recent_orders, synced_at)
         SELECT erp_customer_id, customer_name, assigned_sales_rep, debt_amd, last_payment_date, days_since_payment, aging_bucket, recent_orders, now()
         FROM unnest($1::text[], $2::text[], $3::text[], $4::numeric[], $5::date[], $6::int[], $7::text[], $8::jsonb[])
           AS t(erp_customer_id, customer_name, assigned_sales_rep, debt_amd, last_payment_date, days_since_payment, aging_bucket, recent_orders)`,
        [erpIds, names, reps, debts, lastPayments, daysSince, agingBuckets, recentOrders]
      );
    }

    // Auto-fill region/subregion for ERP-linked customers, but only where
    // still unset -- a rep's manual correction on a customer should stick,
    // not get silently overwritten by the next sync.
    if (regionErpIds.length) {
      await client.query(
        `UPDATE customers c
         SET region = COALESCE(c.region, t.region),
             subregion = COALESCE(c.subregion, t.subregion)
         FROM unnest($1::text[], $2::text[], $3::text[]) AS t(erp_customer_id, region, subregion)
         WHERE c.erp_customer_id = t.erp_customer_id`,
        [regionErpIds, regions, subregions]
      );
    }

    if (sales_performance !== undefined) {
      await client.query("TRUNCATE sales_performance");
      if (perfRepNames.length) {
        await client.query(
          `INSERT INTO sales_performance (rep_name, month, sales_amd, collected_amd, budget_amd)
           SELECT rep_name, month, sales_amd, collected_amd, budget_amd
           FROM unnest($1::text[], $2::date[], $3::numeric[], $4::numeric[], $5::numeric[])
             AS t(rep_name, month, sales_amd, collected_amd, budget_amd)
           ON CONFLICT (rep_name, month) DO UPDATE SET
             sales_amd = EXCLUDED.sales_amd, collected_amd = EXCLUDED.collected_amd,
             budget_amd = EXCLUDED.budget_amd, synced_at = now()`,
          [perfRepNames, perfMonths, perfSales, perfCollected, perfBudget]
        );
      }
    }

    if (order_lines !== undefined) {
      await client.query("TRUNCATE erp_order_lines");
      if (lineErpIds.length) {
        await client.query(
          `INSERT INTO erp_order_lines
             (erp_customer_id, order_id, order_date, product_id, brand, product_name, size_l, qty, unit_price_amd, revenue_amd)
           SELECT erp_customer_id, order_id, order_date, product_id, brand, product_name, size_l, qty, unit_price_amd, revenue_amd
           FROM unnest($1::text[], $2::text[], $3::date[], $4::text[], $5::text[], $6::text[], $7::text[], $8::numeric[], $9::numeric[], $10::numeric[])
             AS t(erp_customer_id, order_id, order_date, product_id, brand, product_name, size_l, qty, unit_price_amd, revenue_amd)`,
          [lineErpIds, lineOrderIds, lineDates, lineProductIds, lineBrands, lineProductNames, lineSizes, lineQtys, lineUnitPrices, lineRevenues]
        );
      }
    }
    await client.query("COMMIT");
  } catch (err) {
    releaseErr = err;
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release(releaseErr);
  }

  res.json({
    synced: erpIds.length,
    order_lines_synced: order_lines !== undefined ? lineErpIds.length : undefined,
    sales_performance_synced: sales_performance !== undefined ? perfRepNames.length : undefined,
  });
});

// Lets any logged-in rep browse the ERP extract by name instead of
// guessing at raw Customer IDs when creating/linking a customer -- normal
// cookie/JWT auth (not the sync key). Open to all roles (not admin-only)
// because managers do the initial bulk customer onboarding themselves.
erpSyncRouter.get("/unlinked", requireAuth, async (req, res) => {
  const { search } = req.query;
  const params = [];
  let searchFilter = "";
  if (search) {
    params.push(`%${search}%`);
    searchFilter = `AND erp.customer_name ILIKE $${params.length}`;
  }

  const { rows } = await pool.query(
    `SELECT erp.erp_customer_id, erp.customer_name, erp.debt_amd, erp.assigned_sales_rep
     FROM erp_customer_data erp
     WHERE NOT EXISTS (
       SELECT 1 FROM customers c WHERE c.erp_customer_id = erp.erp_customer_id
     ) ${searchFilter}
     ORDER BY erp.customer_name NULLS LAST, erp.erp_customer_id
     LIMIT 200`,
    params
  );
  res.json(rows);
});
