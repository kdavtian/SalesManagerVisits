import crypto from "node:crypto";
import { Router } from "express";
import rateLimit from "express-rate-limit";
import multer from "multer";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { notifyUser } from "../notifications.js";

export const erpSyncRouter = Router();

// In-memory, not disk -- these are pushed once, stored straight into
// generated_reports.file_data, and never touched again on this server.
const reportFileUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});

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
  const { customers, order_lines, sales_performance, products, brand_volume } = req.body ?? {};
  if (!Array.isArray(customers)) {
    return res.status(400).json({ error: "customers must be an array" });
  }
  if (order_lines !== undefined && !Array.isArray(order_lines)) {
    return res.status(400).json({ error: "order_lines must be an array" });
  }
  if (sales_performance !== undefined && !Array.isArray(sales_performance)) {
    return res.status(400).json({ error: "sales_performance must be an array" });
  }
  if (products !== undefined && !Array.isArray(products)) {
    return res.status(400).json({ error: "products must be an array" });
  }
  if (brand_volume !== undefined && !Array.isArray(brand_volume)) {
    return res.status(400).json({ error: "brand_volume must be an array" });
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

  const prodErpIds = [];
  const prodNames = [];
  const prodBrands = [];
  const prodUnits = [];
  const prodPrices = [];
  const prodFamilies = [];
  const prodBronzePrices = [];
  const prodSilverPrices = [];
  const prodGoldPrices = [];
  const prodStockQtys = [];
  const prodLandingCosts = [];

  for (const p of Array.isArray(products) ? products : []) {
    if (!isPlainObject(p) || !p.erp_product_id || !p.name || !Number.isFinite(p.unit_price_amd)) continue;
    prodErpIds.push(String(p.erp_product_id));
    prodNames.push(String(p.name));
    prodBrands.push(p.brand != null ? String(p.brand) : null);
    prodUnits.push(p.unit != null ? String(p.unit) : null);
    prodPrices.push(p.unit_price_amd);
    prodFamilies.push(p.family != null ? String(p.family) : null);
    // bronze defaults to unit_price_amd (same source, "Price T1") when
    // omitted, so the extract doesn't have to send it twice.
    prodBronzePrices.push(Number.isFinite(p.bronze_price_amd) ? p.bronze_price_amd : p.unit_price_amd);
    prodSilverPrices.push(Number.isFinite(p.silver_price_amd) ? p.silver_price_amd : null);
    prodGoldPrices.push(Number.isFinite(p.gold_price_amd) ? p.gold_price_amd : null);
    prodStockQtys.push(Number.isFinite(p.stock_qty) ? Math.trunc(p.stock_qty) : null);
    // From the Pricelist sheet's own "Landing Cost" column -- no fallback
    // (unlike bronze above), since unit_price_amd isn't a stand-in for cost.
    prodLandingCosts.push(Number.isFinite(p.landing_cost_amd) ? p.landing_cost_amd : null);
  }

  const volChannelCodes = [];
  const volMonths = [];
  const volBrands = [];
  const volLiters = [];

  for (const v of Array.isArray(brand_volume) ? brand_volume : []) {
    if (!isPlainObject(v) || !v.channel_code || !v.month || !v.brand) continue;
    volChannelCodes.push(String(v.channel_code));
    volMonths.push(v.month);
    volBrands.push(String(v.brand));
    volLiters.push(Number.isFinite(v.liters) ? v.liters : 0);
  }

  const client = await pool.connect();
  let releaseErr;
  try {
    await client.query("BEGIN");
    await client.query("TRUNCATE erp_customer_data");

    // Immutable "first time we've ever seen this ERP customer" marker --
    // written once per erp_customer_id, ever, regardless of how many times
    // this sync runs. This is what "new customer" is actually counted
    // from (see erp_customer_first_seen, migration 037), since a single
    // Excel snapshot alone can't tell a brand-new customer from one that's
    // simply never been in an extract before today for an unrelated reason.
    if (erpIds.length) {
      await client.query(
        `INSERT INTO erp_customer_first_seen (erp_customer_id, first_seen_month)
         SELECT DISTINCT erp_customer_id, date_trunc('month', now())::date
         FROM unnest($1::text[]) AS t(erp_customer_id)
         ON CONFLICT (erp_customer_id) DO NOTHING`,
        [erpIds]
      );
    }
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
    // Upsert-only, never TRUNCATE: unlike the other tables above, products
    // can also be created directly in the app (no erp_product_id), and a
    // manual price/name correction here must survive later syncs -- so a
    // row an admin has touched since its last sync is skipped, not
    // overwritten out from under them.
    if (prodErpIds.length) {
      await client.query(
        `INSERT INTO products (erp_product_id, name, brand, unit, unit_price_amd, family, bronze_price_amd, silver_price_amd, gold_price_amd, stock_qty, landing_cost_amd, synced_at)
         SELECT erp_product_id, name, brand, unit, unit_price_amd, family, bronze_price_amd, silver_price_amd, gold_price_amd, stock_qty, landing_cost_amd, now()
         FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::numeric[], $6::text[], $7::numeric[], $8::numeric[], $9::numeric[], $10::int[], $11::numeric[])
           AS t(erp_product_id, name, brand, unit, unit_price_amd, family, bronze_price_amd, silver_price_amd, gold_price_amd, stock_qty, landing_cost_amd)
         ON CONFLICT (erp_product_id) DO UPDATE SET
           name = EXCLUDED.name, brand = EXCLUDED.brand, unit = EXCLUDED.unit,
           unit_price_amd = EXCLUDED.unit_price_amd, family = EXCLUDED.family,
           bronze_price_amd = EXCLUDED.bronze_price_amd, silver_price_amd = EXCLUDED.silver_price_amd,
           gold_price_amd = EXCLUDED.gold_price_amd, stock_qty = EXCLUDED.stock_qty,
           landing_cost_amd = EXCLUDED.landing_cost_amd,
           synced_at = now(), updated_at = now()
         WHERE products.manually_edited_at IS NULL`,
        [prodErpIds, prodNames, prodBrands, prodUnits, prodPrices, prodFamilies, prodBronzePrices, prodSilverPrices, prodGoldPrices, prodStockQtys, prodLandingCosts]
      );
    }

    if (brand_volume !== undefined) {
      await client.query("TRUNCATE perf_actuals_brand_monthly");
      if (volChannelCodes.length) {
        await client.query(
          `INSERT INTO perf_actuals_brand_monthly (channel_code, month, brand, liters)
           SELECT channel_code, month, brand, liters
           FROM unnest($1::text[], $2::date[], $3::text[], $4::numeric[])
             AS t(channel_code, month, brand, liters)
           ON CONFLICT (channel_code, month, brand) DO UPDATE SET
             liters = EXCLUDED.liters, synced_at = now()`,
          [volChannelCodes, volMonths, volBrands, volLiters]
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
    products_synced: products !== undefined ? prodErpIds.length : undefined,
    brand_volume_synced: brand_volume !== undefined ? volChannelCodes.length : undefined,
  });
});

function isFiniteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function isPlainArray(value) {
  return Array.isArray(value) ? value : [];
}

// Separate from the main sync above: this is the daily sales/collections/
// balance snapshot the CEO Telegram bot already sends as a formatted
// message, pushed here once per report_date so the same numbers are
// browsable in-app (see reports.js's "daily_management" report). Same
// shared-secret auth as the main sync, since it's the same Windows PC
// pipeline pushing it, just on its own schedule.
const REPORT_PERIODS = new Set(["daily", "weekly", "monthly", "quarterly", "annual"]);

erpSyncRouter.post("/daily-report", syncKeyLimiter, requireSyncKey, async (req, res) => {
  const body = req.body ?? {};
  const { report_date, sales, payments, balance } = body;
  const period = body.period !== undefined ? String(body.period) : "daily";
  if (typeof report_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(report_date)) {
    return res.status(400).json({ error: "report_date must be a YYYY-MM-DD string" });
  }
  if (!REPORT_PERIODS.has(period)) {
    return res.status(400).json({ error: `period must be one of ${[...REPORT_PERIODS].join(", ")}` });
  }
  if (!isPlainObject(sales) || !isPlainObject(payments) || !isPlainObject(balance)) {
    return res.status(400).json({ error: "sales, payments, and balance objects are required" });
  }

  const salesByChannel = isPlainArray(sales.by_channel)
    .filter((c) => isPlainObject(c) && c.channel_code)
    .map((c) => ({
      channel_code: String(c.channel_code),
      amd: isFiniteOrNull(c.amd),
      liters: isFiniteOrNull(c.liters),
      orders: isFiniteOrNull(c.orders),
    }));
  const paymentsByChannel = isPlainArray(payments.by_channel)
    .filter((c) => isPlainObject(c) && c.channel_code)
    .map((c) => ({
      channel_code: String(c.channel_code),
      amd: isFiniteOrNull(c.amd),
      customers: isFiniteOrNull(c.customers),
    }));
  const withManagers = isPlainArray(balance.with_managers_by_manager)
    .filter((m) => isPlainObject(m) && m.manager_name)
    .map((m) => ({ manager_name: String(m.manager_name), amd: isFiniteOrNull(m.amd) }));

  await pool.query(
    `INSERT INTO erp_daily_report (
       report_date,
       sales_ytd_amd, sales_ytd_liters, sales_ytd_orders,
       sales_mtd_amd, sales_mtd_liters, sales_mtd_orders,
       sales_wtd_amd, sales_wtd_liters, sales_wtd_orders,
       sales_day_amd, sales_day_liters, sales_day_orders,
       sales_change_amd, sales_change_liters,
       sales_margin_amd, sales_margin_pct, sales_by_channel,
       payments_ytd_amd, payments_ytd_customers,
       payments_mtd_amd, payments_mtd_customers,
       payments_wtd_amd, payments_wtd_customers,
       payments_day_amd, payments_day_customers, payments_by_channel,
       balance_amd, balance_usd, balance_total_amd, balance_total_usd,
       balance_cash_amd, balance_cash_usd, balance_noncash_amd, balance_noncash_usd,
       balance_with_managers_amd, balance_with_managers_by_manager,
       credit_line_usd, receivables_total_amd, receivables_net_amd,
       warehouse_value_amd, warehouse_liters,
       prev_report_date, change_total_amd, change_overdue_amd, synced_at, period
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
       $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34,
       $35, $36, $37, $38, $39, $40, $41, $42, $43, $44, $45, now(), $46
     )
     ON CONFLICT (period, report_date) DO UPDATE SET
       sales_ytd_amd = EXCLUDED.sales_ytd_amd, sales_ytd_liters = EXCLUDED.sales_ytd_liters, sales_ytd_orders = EXCLUDED.sales_ytd_orders,
       sales_mtd_amd = EXCLUDED.sales_mtd_amd, sales_mtd_liters = EXCLUDED.sales_mtd_liters, sales_mtd_orders = EXCLUDED.sales_mtd_orders,
       sales_wtd_amd = EXCLUDED.sales_wtd_amd, sales_wtd_liters = EXCLUDED.sales_wtd_liters, sales_wtd_orders = EXCLUDED.sales_wtd_orders,
       sales_day_amd = EXCLUDED.sales_day_amd, sales_day_liters = EXCLUDED.sales_day_liters, sales_day_orders = EXCLUDED.sales_day_orders,
       sales_change_amd = EXCLUDED.sales_change_amd, sales_change_liters = EXCLUDED.sales_change_liters,
       sales_margin_amd = EXCLUDED.sales_margin_amd, sales_margin_pct = EXCLUDED.sales_margin_pct, sales_by_channel = EXCLUDED.sales_by_channel,
       payments_ytd_amd = EXCLUDED.payments_ytd_amd, payments_ytd_customers = EXCLUDED.payments_ytd_customers,
       payments_mtd_amd = EXCLUDED.payments_mtd_amd, payments_mtd_customers = EXCLUDED.payments_mtd_customers,
       payments_wtd_amd = EXCLUDED.payments_wtd_amd, payments_wtd_customers = EXCLUDED.payments_wtd_customers,
       payments_day_amd = EXCLUDED.payments_day_amd, payments_day_customers = EXCLUDED.payments_day_customers, payments_by_channel = EXCLUDED.payments_by_channel,
       balance_amd = EXCLUDED.balance_amd, balance_usd = EXCLUDED.balance_usd,
       balance_total_amd = EXCLUDED.balance_total_amd, balance_total_usd = EXCLUDED.balance_total_usd,
       balance_cash_amd = EXCLUDED.balance_cash_amd, balance_cash_usd = EXCLUDED.balance_cash_usd,
       balance_noncash_amd = EXCLUDED.balance_noncash_amd, balance_noncash_usd = EXCLUDED.balance_noncash_usd,
       balance_with_managers_amd = EXCLUDED.balance_with_managers_amd, balance_with_managers_by_manager = EXCLUDED.balance_with_managers_by_manager,
       credit_line_usd = EXCLUDED.credit_line_usd, receivables_total_amd = EXCLUDED.receivables_total_amd, receivables_net_amd = EXCLUDED.receivables_net_amd,
       warehouse_value_amd = EXCLUDED.warehouse_value_amd, warehouse_liters = EXCLUDED.warehouse_liters,
       prev_report_date = EXCLUDED.prev_report_date, change_total_amd = EXCLUDED.change_total_amd, change_overdue_amd = EXCLUDED.change_overdue_amd,
       synced_at = now()`,
    [
      report_date,
      isFiniteOrNull(sales.ytd_amd), isFiniteOrNull(sales.ytd_liters), isFiniteOrNull(sales.ytd_orders),
      isFiniteOrNull(sales.mtd_amd), isFiniteOrNull(sales.mtd_liters), isFiniteOrNull(sales.mtd_orders),
      isFiniteOrNull(sales.wtd_amd), isFiniteOrNull(sales.wtd_liters), isFiniteOrNull(sales.wtd_orders),
      isFiniteOrNull(sales.day_amd), isFiniteOrNull(sales.day_liters), isFiniteOrNull(sales.day_orders),
      isFiniteOrNull(sales.change_amd), isFiniteOrNull(sales.change_liters),
      isFiniteOrNull(sales.margin_amd), isFiniteOrNull(sales.margin_pct), JSON.stringify(salesByChannel),
      isFiniteOrNull(payments.ytd_amd), isFiniteOrNull(payments.ytd_customers),
      isFiniteOrNull(payments.mtd_amd), isFiniteOrNull(payments.mtd_customers),
      isFiniteOrNull(payments.wtd_amd), isFiniteOrNull(payments.wtd_customers),
      isFiniteOrNull(payments.day_amd), isFiniteOrNull(payments.day_customers), JSON.stringify(paymentsByChannel),
      isFiniteOrNull(balance.amd), isFiniteOrNull(balance.usd),
      isFiniteOrNull(balance.total_amd), isFiniteOrNull(balance.total_usd),
      isFiniteOrNull(balance.cash_amd), isFiniteOrNull(balance.cash_usd),
      isFiniteOrNull(balance.noncash_amd), isFiniteOrNull(balance.noncash_usd),
      isFiniteOrNull(balance.with_managers_amd), JSON.stringify(withManagers),
      isFiniteOrNull(balance.credit_line_usd), isFiniteOrNull(balance.receivables_total_amd), isFiniteOrNull(balance.receivables_net_amd),
      isFiniteOrNull(balance.warehouse_value_amd), isFiniteOrNull(balance.warehouse_liters),
      balance.prev_report_date || null, isFiniteOrNull(balance.change_total_amd), isFiniteOrNull(balance.change_overdue_amd),
      period,
    ]
  );

  // Only the daily period is worth paging management about -- weekly/
  // monthly/quarterly/annual snapshots land at the same time as (or well
  // after) the daily one and would just be a duplicate ping.
  if (period === "daily") {
    const { rows: recipients } = await pool.query(
      "SELECT id FROM users WHERE role IN ('admin', 'ceo', 'sales_director', 'accountant')"
    );
    await Promise.all(
      recipients.map((u) =>
        notifyUser(u.id, "daily_report_ready", {
          title: "Daily management report ready",
          body: `Sales, payments, and balance data for ${report_date} is now available.`,
          url: "/#/reports?r=daily_management",
        })
      )
    );
  }

  res.json({ synced: true, report_date, period });
});

const GENERATED_REPORT_TYPES = new Set(["sales_director", "debt_receivables", "ceo_management"]);

// Pushes the literal generated Excel workbook (Sales Director report,
// debt/receivables workbook, CEO management report) the bot already builds
// correctly in Python, rather than re-parsing it into structured columns --
// see roles.js's seesGeneratedReports for why: these are rich, multi-sheet
// files (charts, full inventory, price lists) that would be a large,
// drift-prone duplicate effort to re-derive as native app screens.
// multipart/form-data, not JSON: report_type/report_date as fields, the
// workbook itself as `file`.
erpSyncRouter.post("/reports", syncKeyLimiter, requireSyncKey, reportFileUpload.single("file"), async (req, res) => {
  const { report_type, report_date } = req.body ?? {};
  if (!GENERATED_REPORT_TYPES.has(report_type)) {
    return res.status(400).json({ error: `report_type must be one of ${[...GENERATED_REPORT_TYPES].join(", ")}` });
  }
  if (typeof report_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(report_date)) {
    return res.status(400).json({ error: "report_date must be a YYYY-MM-DD string" });
  }
  if (!req.file) {
    return res.status(400).json({ error: "file is required" });
  }

  await pool.query(
    `INSERT INTO generated_reports (report_type, report_date, file_name, content_type, file_data, synced_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (report_type, report_date) DO UPDATE SET
       file_name = EXCLUDED.file_name, content_type = EXCLUDED.content_type,
       file_data = EXCLUDED.file_data, synced_at = now()`,
    [report_type, report_date, req.file.originalname || `${report_type}_${report_date}.xlsx`, req.file.mimetype, req.file.buffer]
  );

  const { rows: recipients } = await pool.query(
    "SELECT id FROM users WHERE role IN ('admin', 'ceo', 'sales_director', 'accountant')"
  );
  await Promise.all(
    recipients.map((u) =>
      notifyUser(u.id, "generated_report_ready", {
        title: "New report available",
        body: `${report_type.replace(/_/g, " ")} for ${report_date} is ready to download.`,
        url: "/#/reports?r=documents",
      })
    )
  );

  res.json({ synced: true, report_type, report_date });
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
