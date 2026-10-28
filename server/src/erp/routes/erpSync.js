import { markWishesBackInStock } from "../../orders/productWishes.js";
import { cashSheetFilename, cashSheetText, cashSheetXlsx, closeSheetsFoundInExcel, loadCashSheet } from "../../money/cashSheets.js";
import crypto from "node:crypto";
import { Router } from "express";
import rateLimit from "express-rate-limit";
import multer from "multer";
import { pool } from "../../db/pool.js";
import { requireAuth } from "../../middleware/auth.js";
import { queueReportLabel, queueSyncNotice } from "../syncNotifier.js";
import { autoDeliverOrdersFromErp, autoApprovePaymentsFromErp, markAppRowsInExcel } from "../erpAutoMatch.js";
import { matchReturnsToErp } from "../../orders/orderReturns.js";
import { recordSyncAttempt, latestSyncAttempts } from "../erpSyncAttempts.js";
import { recordSyncRun, getSyncStatus, createSyncRequest, pickPendingRequest, finishRequest } from "../erpSyncStatus.js";
import { runAutoTasks } from "../../money/debtCollectionTasks.js";
import { runAntiFraud } from "../../money/antiFraud.js";
import { runExpenseWatch } from "../../money/expenseWatch.js";
import { resolvePlaces } from "../../customers/places.js";
import { refreshOrderRhythm } from "../../orders/orderRhythm.js";
import { applyCashLedger } from "../../money/cashflow.js";
import { snapshotTierPrices, logTierPriceChanges } from "../../products/priceSyncLog.js";
import { applyLandingCosts, applyExcelRetail, getLandingSettings } from "../../products/landingCalc.js";
import { syncProductsAndWholesaleCustomersToPlatform } from "../platformSync.js";
import {
  transformErpCustomers,
  transformErpCustomerLegal,
  transformErpOrderLines,
  transformErpCashflowLines,
  transformErpSalesPerformance,
  transformErpProducts,
  transformErpBrandVolume,
} from "../erpTransform.js";

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
  // Same test-only bypass as the login limiter (routes/auth.js): a no-op unless
  // E2E_RATE_LIMIT_BYPASS_TOKEN is set AND the request carries it, so the
  // integration suite can make more than 20 sync calls in one file.
  skip: (req) =>
    Boolean(process.env.E2E_RATE_LIMIT_BYPASS_TOKEN) &&
    req.get("x-e2e-rate-limit-bypass") === process.env.E2E_RATE_LIMIT_BYPASS_TOKEN,
});

export function timingSafeEqual(a, b) {
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
// Runs a step inside a SAVEPOINT: if it throws, only that step is undone, the transaction (and the sync) goes on, and the failure is reported.
export async function optionalSyncStep(client, label, fn, warnings = []) {
  await client.query("SAVEPOINT optional_step");
  try {
    const result = await fn();
    await client.query("RELEASE SAVEPOINT optional_step");
    return result;
  } catch (err) {
    await client.query("ROLLBACK TO SAVEPOINT optional_step");
    warnings.push(`${label}: ${err.message}`);
    console.error(`[erp-sync] optional step "${label}" failed and was skipped:`, err.message);
    return null;
  }
}

erpSyncRouter.post("/", syncKeyLimiter, requireSyncKey, async (req, res) => {
  const { customers, order_lines, cashflow_lines, sales_performance, products, brand_volume, customer_legal, meta } = req.body ?? {};
  if (!Array.isArray(customers)) {
    return res.status(400).json({ error: "customers must be an array" });
  }
  if (order_lines !== undefined && !Array.isArray(order_lines)) {
    return res.status(400).json({ error: "order_lines must be an array" });
  }
  if (cashflow_lines !== undefined && !Array.isArray(cashflow_lines)) {
    return res.status(400).json({ error: "cashflow_lines must be an array" });
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
  if (customer_legal !== undefined && !Array.isArray(customer_legal)) {
    return res.status(400).json({ error: "customer_legal must be an array" });
  }

  const { erpIds, names, reps, debts, balance0s, lastPayments, daysSince, agingBuckets, recentOrders, regionErpIds, regions, subregions, tierErpIds, tiers, legalErpIds: extractLegalIds, tins: extractTins, legalNames: extractLegalNames, legalAddresses: extractLegalAddresses } =
    transformErpCustomers(customers);
  const extra = transformErpCustomerLegal(customer_legal);
  const legalErpIds = [...extractLegalIds, ...extra.legalErpIds];
  const tins = [...extractTins, ...extra.tins];
  const legalNames = [...extractLegalNames, ...extra.legalNames];
  const legalAddresses = [...extractLegalAddresses, ...extra.legalAddresses];

  const {
    lineErpIds,
    lineOrderIds,
    lineDates,
    lineProductIds,
    lineBrands,
    lineProductNames,
    lineSizes,
    lineQtys,
    lineUnitPrices,
    lineRevenues,
    lineDiscounts,
    lineSalesReps,
  } = transformErpOrderLines(order_lines);

  const { cashErpIds, cashDates, cashAmounts } = transformErpCashflowLines(cashflow_lines);

  const { perfRepNames, perfMonths, perfSales, perfCollected, perfBudget } = transformErpSalesPerformance(sales_performance);

  const {
    prodErpIds,
    prodNames,
    prodBrands,
    prodUnits,
    prodPrices,
    prodFamilies,
    prodBronzePrices,
    prodSilverPrices,
    prodGoldPrices,
    prodStockQtys,
    prodLandingCosts,
    prodNetCosts,
    prodPackCostUsd,
    prodItemsPerPack,
    prodPackNettoKg,
    prodSizeL,
    prodRetail,
    prodHcCodes,
    prodActives,
  } = transformErpProducts(products);

  const { volChannelCodes, volMonths, volBrands, volLiters } = transformErpBrandVolume(brand_volume);

  const client = await pool.connect();
  let priceChangedProducts = 0;
  let excelRetailChanged = 0;
  let releaseErr;
  const syncWarnings = [];
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
           (erp_customer_id, customer_name, assigned_sales_rep, debt_amd, balance0_amd, last_payment_date, days_since_payment, aging_bucket, recent_orders, synced_at)
         SELECT erp_customer_id, customer_name, assigned_sales_rep, debt_amd, balance0_amd, last_payment_date, days_since_payment, aging_bucket, recent_orders, now()
         FROM unnest($1::text[], $2::text[], $3::text[], $4::numeric[], $5::numeric[], $6::date[], $7::int[], $8::text[], $9::jsonb[])
           AS t(erp_customer_id, customer_name, assigned_sales_rep, debt_amd, balance0_amd, last_payment_date, days_since_payment, aging_bucket, recent_orders)`,
        [erpIds, names, reps, debts, balance0s, lastPayments, daysSince, agingBuckets, recentOrders]
      );
    }

    // Auto-fill region/subregion for ERP-linked customers, but only where
    // still unset -- a rep's manual correction on a customer should stick,
    // not get silently overwritten by the next sync.
    if (regionErpIds.length) {
      // the Excel's spelling goes through the Armenian places too (places.js), so a new customer never starts with a misspelt region
      regionErpIds.forEach((_id, i) => {
        const r = resolvePlaces({ region: regions[i], subregion: subregions[i] });
        regions[i] = r.region;
        subregions[i] = r.subregion;
      });
      await client.query(
        `UPDATE customers c
         SET region = COALESCE(c.region, t.region),
             subregion = COALESCE(c.subregion, t.subregion)
         FROM unnest($1::text[], $2::text[], $3::text[]) AS t(erp_customer_id, region, subregion)
         WHERE c.erp_customer_id = t.erp_customer_id`,
        [regionErpIds, regions, subregions]
      );
    }

    // Auto-fill TIN, legal name and legal address from the workbook, only where the app
    // value is still empty -- a value typed/looked-up in the app sticks.
    if (legalErpIds.length) {
      await client.query(
        `UPDATE customers c
         SET tin = COALESCE(NULLIF(btrim(c.tin), ''), t.tin),
             legal_name = COALESCE(NULLIF(btrim(c.legal_name), ''), t.legal_name),
             legal_address = COALESCE(NULLIF(btrim(c.legal_address), ''), t.legal_address)
         FROM unnest($1::text[], $2::text[], $3::text[], $4::text[]) AS t(erp_customer_id, tin, legal_name, legal_address)
         WHERE c.erp_customer_id = t.erp_customer_id
           AND ((NULLIF(btrim(c.tin), '') IS NULL AND t.tin IS NOT NULL)
             OR (NULLIF(btrim(c.legal_name), '') IS NULL AND t.legal_name IS NOT NULL)
             OR (NULLIF(btrim(c.legal_address), '') IS NULL AND t.legal_address IS NOT NULL))`,
        [legalErpIds, tins, legalNames, legalAddresses]
      );
    }

    // Customer tier follows the workbook's Tier column for ERP-linked
    // customers (competitors are never touched). Every actual change is
    // logged to customer_level_audit like the other system-driven changes.
    if (tierErpIds.length) {
      await client.query(
        `WITH changes AS (
           SELECT c.id, c.customer_tier AS old_tier, t.tier AS new_tier
           FROM customers c
           JOIN unnest($1::text[], $2::text[]) AS t(erp_customer_id, tier) ON t.erp_customer_id = c.erp_customer_id
           WHERE c.customer_tier IS DISTINCT FROM t.tier AND c.customer_tier IS DISTINCT FROM 'competitor'
         ), upd AS (
           UPDATE customers c SET customer_tier = ch.new_tier FROM changes ch WHERE c.id = ch.id RETURNING c.id
         )
         INSERT INTO customer_level_audit (customer_id, old_tier, new_tier, reason, changed_by)
         SELECT id, old_tier, new_tier, 'Tier from ERP workbook', NULL FROM changes`,
        [tierErpIds, tiers]
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
             (erp_customer_id, order_id, order_date, product_id, brand, product_name, size_l, qty, unit_price_amd, revenue_amd, discount_amd, sales_rep)
           SELECT erp_customer_id, order_id, order_date, product_id, brand, product_name, size_l, qty, unit_price_amd, revenue_amd, discount_amd, sales_rep
           FROM unnest($1::text[], $2::text[], $3::date[], $4::text[], $5::text[], $6::text[], $7::text[], $8::numeric[], $9::numeric[], $10::numeric[], $11::numeric[], $12::text[])
             AS t(erp_customer_id, order_id, order_date, product_id, brand, product_name, size_l, qty, unit_price_amd, revenue_amd, discount_amd, sales_rep)`,
          [lineErpIds, lineOrderIds, lineDates, lineProductIds, lineBrands, lineProductNames, lineSizes, lineQtys, lineUnitPrices, lineRevenues, lineDiscounts, lineSalesReps]
        );
      }
      // How often each customer usually orders ("Reorder due" chip), from the order history just replaced.
      await refreshOrderRhythm(client);
    }

    if (cashflow_lines !== undefined) {
      await client.query("TRUNCATE erp_cashflow_lines");
      if (cashErpIds.length) {
        await client.query(
          `INSERT INTO erp_cashflow_lines (erp_customer_id, cashflow_date, amount_amd)
           SELECT erp_customer_id, cashflow_date, amount_amd
           FROM unnest($1::text[], $2::date[], $3::numeric[])
             AS t(erp_customer_id, cashflow_date, amount_amd)`,
          [cashErpIds, cashDates, cashAmounts]
        );
      }
    }
    // Anything the workbook already shows is settled in KAD too: matching
    // orders become Delivered, matching pending cash payments become
    // Approved (both marked "from ERP"; see erpAutoMatch.js).
    // These three only DERIVE app state from the rows just stored: a failure in one of them must never roll the whole sync back (Excel is the
    // truth; 2026-10-24 the returns step threw on a database that had not got migration 143 yet and nothing was updated).
    if (order_lines !== undefined) await optionalSyncStep(client, "auto-deliver orders", () => autoDeliverOrdersFromErp(client), syncWarnings);
    // Returns the accountant typed into Excel (negative lines) are marked "recorded in ERP" here.
    if (order_lines !== undefined) await optionalSyncStep(client, "match returns", () => matchReturnsToErp(client), syncWarnings);
    if (cashflow_lines !== undefined) await optionalSyncStep(client, "auto-approve payments", () => autoApprovePaymentsFromErp(client), syncWarnings);
    // Delivered orders and collected payments Excel already holds (the previous debt on the blanks adds only the ones it does not).
    if (order_lines !== undefined || cashflow_lines !== undefined) await optionalSyncStep(client, "mark app rows found in Excel", () => markAppRowsInExcel(client), syncWarnings);
    // Upsert-only, never TRUNCATE: unlike the other tables above, products
    // can also be created directly in the app (no erp_product_id), and a
    // manual price/name correction here must survive later syncs -- so a
    // row an admin has touched since its last sync is skipped, not
    // overwritten out from under them.
    if (prodErpIds.length) {
      const pricesBefore = await snapshotTierPrices(client, prodErpIds);
      // A product can already exist here with erp_product_id still NULL --
      // created by hand in the admin Product edit sheet, or by the Excel
      // pricelist import (see productImport.js), both of which predate
      // this product ever appearing in the ERP feed. Without this claim
      // step, the INSERT below has no way to recognize that row (its own
      // ON CONFLICT only matches on erp_product_id, which that row has
      // never had), so the very first sync of a product created some other
      // way always created a second row for the same physical item instead
      // of linking to the existing one -- reported live as the same
      // product listed twice with two different stock counts. Only ever
      // claims a row that has NEVER been erp-linked (erp_product_id IS
      // NULL): a product whose own erp_product_id simply changed upstream
      // (a genuine re-code, not "never synced") is left alone rather than
      // silently reassigned, since that's much harder to distinguish from
      // an actual new product and belongs in front of an admin, not
      // auto-merged.
      // Matched case/whitespace-insensitively on both sides: the incoming
      // name/brand/unit are already whitespace-normalized by
      // transformErpProducts, but a pre-existing row (created by hand, by
      // productImport.js, or synced before that normalization existed) can
      // still have its own stray/doubled spacing stored -- lower() alone
      // missed that, which is what let a whitespace-only difference slip
      // past this claim step and insert a duplicate row below instead of
      // linking to the one that's already there. name/brand collapse
      // whitespace runs to one space (meaningful word-boundary spacing in
      // prose); unit strips whitespace entirely, since a size token like
      // "4.5L"/"4.5 L"/"4.5  L" is the same size regardless of whether
      // there's a space before the L at all -- not just how many.
      await client.query(
        `UPDATE products AS p
         SET erp_product_id = t.erp_product_id, synced_at = now()
         FROM unnest($1::text[], $2::text[], $3::text[], $4::text[]) AS t(erp_product_id, name, brand, unit)
         WHERE p.active
           AND p.erp_product_id IS NULL
           AND lower(regexp_replace(trim(p.name), '\\s+', ' ', 'g')) = lower(t.name)
           AND lower(regexp_replace(trim(coalesce(p.brand, '')), '\\s+', ' ', 'g')) = lower(coalesce(t.brand, ''))
           AND lower(regexp_replace(trim(coalesce(p.unit, '')), '\\s+', '', 'g')) = lower(regexp_replace(trim(coalesce(t.unit, '')), '\\s+', '', 'g'))`,
        [prodErpIds, prodNames, prodBrands, prodUnits]
      );
      // net_cost_amd rides along in this same gated upsert (unlike
      // landing_cost_amd below, which is never exposed on any edit form and
      // so is always applied) -- it IS admin-editable (migration 080), so a
      // sync-supplied value must respect manually_edited_at the same way
      // name/brand/price/family already do, never silently overwriting a
      // correction an admin made by hand. No extract currently sends this
      // field, so this is a no-op (prodNetCosts is all null) until one does.
      await client.query(
        `INSERT INTO products (erp_product_id, name, brand, unit, unit_price_amd, family, bronze_price_amd, silver_price_amd, gold_price_amd, stock_qty, landing_cost_amd, net_cost_amd, synced_at)
         SELECT erp_product_id, name, brand, unit, unit_price_amd, family, bronze_price_amd, silver_price_amd, gold_price_amd, stock_qty, landing_cost_amd, net_cost_amd, now()
         FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::numeric[], $6::text[], $7::numeric[], $8::numeric[], $9::numeric[], $10::int[], $11::numeric[], $12::numeric[])
           AS t(erp_product_id, name, brand, unit, unit_price_amd, family, bronze_price_amd, silver_price_amd, gold_price_amd, stock_qty, landing_cost_amd, net_cost_amd)
         WHERE NOT (erp_product_id = ANY($13::text[]))
         ON CONFLICT (erp_product_id) DO UPDATE SET
           name = EXCLUDED.name, brand = EXCLUDED.brand, unit = EXCLUDED.unit,
           unit_price_amd = EXCLUDED.unit_price_amd, family = EXCLUDED.family,
           bronze_price_amd = EXCLUDED.bronze_price_amd, silver_price_amd = EXCLUDED.silver_price_amd,
           gold_price_amd = EXCLUDED.gold_price_amd, stock_qty = EXCLUDED.stock_qty,
           net_cost_amd = COALESCE(EXCLUDED.net_cost_amd, products.net_cost_amd),
           synced_at = now(), updated_at = now()
         WHERE products.manually_edited_at IS NULL`,
        [prodErpIds, prodNames, prodBrands, prodUnits, prodPrices, prodFamilies, prodBronzePrices, prodSilverPrices, prodGoldPrices, prodStockQtys, prodLandingCosts, prodNetCosts, prodErpIds.filter((_, i) => prodActives[i] === false)]
      );
      // landing_cost_amd specifically is never exposed on any product edit
      // form (see migration 064 -- "read-only in the app: ... only ever
      // written by the sync"), so unlike every other column in the upsert
      // above, no manual correction could ever conflict with the sync
      // writing it. Gating it behind manually_edited_at the same way meant
      // an admin fixing one unrelated field on a product -- a stock
      // recount, a name typo -- silently froze that product's landing cost
      // forever, with nothing on screen to show anything was wrong. Always
      // applied, for every synced product regardless of manual-edit state.
      // Since 1.370.0 the workbook's value is kept as landing_workbook_amd (reference + fallback) and the app's own
      // calculation from the pack data decides landing_cost_amd (landingCalc.js). Pack data and the workbook's Retail Price are
      // optional in the payload: an older bot sends none and the stored values stay.
      await client.query(
        `UPDATE products SET landing_workbook_amd = t.landing_cost_amd
         FROM unnest($1::text[], $2::numeric[]) AS t(erp_product_id, landing_cost_amd)
         WHERE products.erp_product_id = t.erp_product_id`,
        [prodErpIds, prodLandingCosts]
      );
      if ([...prodPackCostUsd, ...prodItemsPerPack, ...prodPackNettoKg, ...prodSizeL].some((v) => v !== null)) {
        await client.query(
          `UPDATE products SET pack_cost_usd = t.pack_cost_usd, items_per_pack = t.items_per_pack, pack_netto_kg = t.pack_netto_kg, size_l = t.size_l
           FROM unnest($1::text[], $2::numeric[], $3::numeric[], $4::numeric[], $5::numeric[]) AS t(erp_product_id, pack_cost_usd, items_per_pack, pack_netto_kg, size_l)
           WHERE products.erp_product_id = t.erp_product_id`,
          [prodErpIds, prodPackCostUsd, prodItemsPerPack, prodPackNettoKg, prodSizeL]
        );
      }
      if (prodRetail.some((v) => v !== null)) {
        await client.query(
          `UPDATE products SET erp_retail_price_amd = t.retail
           FROM unnest($1::text[], $2::numeric[]) AS t(erp_product_id, retail)
           WHERE products.erp_product_id = t.erp_product_id`,
          [prodErpIds, prodRetail]
        );
      }
      await applyLandingCosts(client, prodErpIds);
      if ((await getLandingSettings(client)).retailFromExcel) excelRetailChanged = await applyExcelRetail(client, prodErpIds);
      // Tier prices and net cost come straight from the workbook (the trusted
      // source), so they refresh on every sync even for a product an admin
      // touched by hand -- otherwise one unrelated manual edit freezes its
      // prices forever (reported: prices/LC/NC not updating). Name, brand,
      // family and stock stay gated by manually_edited_at above. A blank
      // sheet value never wipes an existing price.
      await client.query(
        `UPDATE products p SET
           unit_price_amd = COALESCE(t.unit_price_amd, p.unit_price_amd),
           bronze_price_amd = COALESCE(t.bronze_price_amd, p.bronze_price_amd),
           silver_price_amd = COALESCE(t.silver_price_amd, p.silver_price_amd),
           gold_price_amd = COALESCE(t.gold_price_amd, p.gold_price_amd),
           net_cost_amd = COALESCE(t.net_cost_amd, p.net_cost_amd),
           family = COALESCE(t.family, p.family)
         FROM unnest($1::text[], $2::numeric[], $3::numeric[], $4::numeric[], $5::numeric[], $6::numeric[], $7::text[])
           AS t(erp_product_id, unit_price_amd, bronze_price_amd, silver_price_amd, gold_price_amd, net_cost_amd, family)
         WHERE p.erp_product_id = t.erp_product_id AND p.manually_edited_at IS NOT NULL AND t.unit_price_amd > 0`,
        [prodErpIds, prodPrices, prodBronzePrices, prodSilverPrices, prodGoldPrices, prodNetCosts, prodFamilies]
      );
      // SKU Status from the workbook decides what is sold: ACTIVE products are
      // active in the app, everything else is hidden from inventory, new orders
      // and the catalogue. Applied regardless of manual edits (the workbook is
      // the source of truth); a workbook without a status column sends null and
      // changes nothing.
      await client.query(
        `UPDATE products p SET active = t.active, updated_at = now()
         FROM unnest($1::text[], $2::boolean[]) AS t(erp_product_id, active)
         WHERE p.erp_product_id = t.erp_product_id AND t.active IS NOT NULL AND p.active IS DISTINCT FROM t.active`,
        [prodErpIds, prodActives]
      );
      // HC code from the workbook's Products sheet: like landing cost it is
      // applied regardless of manually_edited_at (editing a price must not
      // freeze it), and only when the sheet actually has a value -- a blank
      // sheet cell never wipes a code an admin set in the app.
      await client.query(
        `UPDATE products SET hc_code = t.hc_code
         FROM unnest($1::text[], $2::text[]) AS t(erp_product_id, hc_code)
         WHERE products.erp_product_id = t.erp_product_id AND t.hc_code IS NOT NULL AND products.hc_code IS DISTINCT FROM t.hc_code`,
        [prodErpIds, prodHcCodes]
      );
      priceChangedProducts = (await logTierPriceChanges(client, pricesBefore, prodErpIds)) + excelRetailChanged;
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
    await recordSyncAttempt({ endpoint: "/api/erp-sync", ok: false, error: err.message });
    throw err;
  } finally {
    client.release(releaseErr);
  }

  // Prices that changed in this sync: one line in the sales team's single sync notification (syncNotifier.js).
  if (priceChangedProducts > 0) {
    queueSyncNotice({
      type: "price_changed",
      roles: ["sales_manager", "sales_director"],
      text: `${priceChangedProducts} ապրանքի գինը փոխվել է`,
      url: "/#/pricelist",
      title: "Գները թարմացվել են",
      order: 2,
    });
  }

  // New stock just landed: wished products that are available again are announced to the customers' reps (and KAD OS).
  if (prodErpIds.length) markWishesBackInStock().catch((err) => console.error("Wishes back in stock failed:", err.message));
  closeSheetsFoundInExcel().catch((err) => console.error("Cash sheets auto-close failed:", err.message));

  // New debt figures just landed: give reps a "collect the debt" task where due.
  if (process.env.NODE_ENV !== "test") {
    runAutoTasks(new Date(), { viaSync: true }).catch((err) => console.error("Automatic tasks failed:", err.message));
    // New cashflow rows landed: payments that are still missing (or have just appeared) are re-checked at once.
    runAntiFraud().catch((err) => console.error("Anti-fraud run failed:", err.message));
  }

  // Push the current product catalog and wholesale customers to Platform (the
  // public website/PWA) so it stays mirrored. Best-effort: never let a
  // Platform-side outage affect this response.
  if (process.env.NODE_ENV !== "test") {
    syncProductsAndWholesaleCustomersToPlatform().catch((err) =>
      console.error("Platform sync failed:", err.message)
    );
  }

  if (syncWarnings.length) await recordSyncAttempt({ endpoint: "/api/erp-sync", ok: true, warnings: syncWarnings });
  await recordSyncRun({
    counts: {
      customers: erpIds.length,
      order_lines: order_lines !== undefined ? lineErpIds.length : null,
      cashflow_lines: cashflow_lines !== undefined ? cashErpIds.length : null,
      products: products !== undefined ? prodErpIds.length : null,
    },
    warnings: syncWarnings,
    meta,
  });
  res.json({
    synced: erpIds.length,
    warnings: syncWarnings.length ? syncWarnings : undefined,
    order_lines_synced: order_lines !== undefined ? lineErpIds.length : undefined,
    cashflow_lines_synced: cashflow_lines !== undefined ? cashErpIds.length : undefined,
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
// The whole Cashflow sheet (every money movement, not just the customer payments of the main sync): replaces the ledger rows that came from
// Excel (owner, 2026-10-23). Body: { rows: [{ date, amount, currency, for, id, source, info, currency_rate, amount_amd, sales_rep, transaction_id }] }.
erpSyncRouter.post("/cashflow-ledger", syncKeyLimiter, requireSyncKey, async (req, res) => {
  const rows = req.body?.rows;
  if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: "rows must be a non-empty array" });
  try {
    const applied = await applyCashLedger(rows.filter(isPlainObject).map((r, i) => ({ ...r, excel_row: r.excel_row ?? i + 1 })), { via: "bot", note: req.body?.note ?? null, fileName: req.body?.file_name ?? null });
    // the new cashflow rows are the data the expense watch (and "is it in the Excel?") reads
    if (process.env.NODE_ENV !== "test") {
      runExpenseWatch().catch((err) => console.error("Expense watch failed:", err.message));
      runAntiFraud().catch((err) => console.error("Anti-fraud run failed:", err.message));
    }
    res.json(applied);
  } catch (err) {
    await recordSyncAttempt({ endpoint: "/api/erp-sync/cashflow-ledger", ok: false, error: err.message });
    res.status(400).json({ error: err.message });
  }
});

// Daily cash sheets for the CEO bot (cashSheets.js): the bot asks what is waiting, posts each to the accounting Telegram group (the text and
// the Excel file) and says whether it worked. A sheet that keeps failing stops being offered after 10 tries (it stays in the app's list).
erpSyncRouter.get("/cash-sheets/pending", syncKeyLimiter, requireSyncKey, async (_req, res) => {
  const { rows } = await pool.query("SELECT id FROM cash_sheets WHERE posted_at IS NULL AND post_attempts < 10 ORDER BY id LIMIT 20");
  const sheets = [];
  for (const { id } of rows) {
    const data = await loadCashSheet(id);
    if (data) sheets.push({ id, text: cashSheetText(data), filename: cashSheetFilename(data) });
  }
  res.json({ sheets });
});

erpSyncRouter.get("/cash-sheets/:id/xlsx", syncKeyLimiter, requireSyncKey, async (req, res) => {
  const data = await loadCashSheet(Number(req.params.id));
  if (!data) return res.status(404).json({ error: "Cash sheet not found" });
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${cashSheetFilename(data)}"`);
  res.send(await cashSheetXlsx(data));
});

erpSyncRouter.post("/cash-sheets/:id/posted", syncKeyLimiter, requireSyncKey, async (req, res) => {
  const ok = req.body?.ok !== false;
  const { rows } = await pool.query(
    ok
      ? "UPDATE cash_sheets SET posted_at = COALESCE(posted_at, now()), post_attempts = post_attempts + 1, last_post_error = NULL WHERE id = $1 RETURNING id"
      : "UPDATE cash_sheets SET post_attempts = post_attempts + 1, last_post_error = left($2, 500) WHERE id = $1 RETURNING id",
    ok ? [Number(req.params.id)] : [Number(req.params.id), String(req.body?.error ?? "failed")]
  );
  if (!rows[0]) return res.status(404).json({ error: "Cash sheet not found" });
  res.json({ ok: true });
});

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
  // Same shape as the two above, but for the week -- optional, since the
  // sync PC doesn't send these yet (see migration 067). Parsed the same
  // way so it starts working the moment it does, no further code change.
  const salesByChannelWtd = isPlainArray(sales.by_channel_wtd)
    .filter((c) => isPlainObject(c) && c.channel_code)
    .map((c) => ({
      channel_code: String(c.channel_code),
      amd: isFiniteOrNull(c.amd),
      liters: isFiniteOrNull(c.liters),
      orders: isFiniteOrNull(c.orders),
    }));
  const paymentsByChannelWtd = isPlainArray(payments.by_channel_wtd)
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
       sales_margin_amd, sales_margin_pct, sales_by_channel, sales_by_channel_wtd,
       payments_ytd_amd, payments_ytd_customers,
       payments_mtd_amd, payments_mtd_customers,
       payments_wtd_amd, payments_wtd_customers,
       payments_day_amd, payments_day_customers, payments_by_channel, payments_by_channel_wtd,
       balance_amd, balance_usd, balance_total_amd, balance_total_usd,
       balance_cash_amd, balance_cash_usd, balance_noncash_amd, balance_noncash_usd,
       balance_with_managers_amd, balance_with_managers_by_manager,
       credit_line_usd, receivables_total_amd, receivables_net_amd,
       warehouse_value_amd, warehouse_liters,
       prev_report_date, change_total_amd, change_overdue_amd, synced_at, period
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19,
       $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35,
       $36, $37, $38, $39, $40, $41, $42, $43, $44, $45, $46, $47, now(), $48
     )
     ON CONFLICT (period, report_date) DO UPDATE SET
       sales_ytd_amd = EXCLUDED.sales_ytd_amd, sales_ytd_liters = EXCLUDED.sales_ytd_liters, sales_ytd_orders = EXCLUDED.sales_ytd_orders,
       sales_mtd_amd = EXCLUDED.sales_mtd_amd, sales_mtd_liters = EXCLUDED.sales_mtd_liters, sales_mtd_orders = EXCLUDED.sales_mtd_orders,
       sales_wtd_amd = EXCLUDED.sales_wtd_amd, sales_wtd_liters = EXCLUDED.sales_wtd_liters, sales_wtd_orders = EXCLUDED.sales_wtd_orders,
       sales_day_amd = EXCLUDED.sales_day_amd, sales_day_liters = EXCLUDED.sales_day_liters, sales_day_orders = EXCLUDED.sales_day_orders,
       sales_change_amd = EXCLUDED.sales_change_amd, sales_change_liters = EXCLUDED.sales_change_liters,
       sales_margin_amd = EXCLUDED.sales_margin_amd, sales_margin_pct = EXCLUDED.sales_margin_pct, sales_by_channel = EXCLUDED.sales_by_channel, sales_by_channel_wtd = EXCLUDED.sales_by_channel_wtd,
       payments_ytd_amd = EXCLUDED.payments_ytd_amd, payments_ytd_customers = EXCLUDED.payments_ytd_customers,
       payments_mtd_amd = EXCLUDED.payments_mtd_amd, payments_mtd_customers = EXCLUDED.payments_mtd_customers,
       payments_wtd_amd = EXCLUDED.payments_wtd_amd, payments_wtd_customers = EXCLUDED.payments_wtd_customers,
       payments_day_amd = EXCLUDED.payments_day_amd, payments_day_customers = EXCLUDED.payments_day_customers, payments_by_channel = EXCLUDED.payments_by_channel, payments_by_channel_wtd = EXCLUDED.payments_by_channel_wtd,
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
      isFiniteOrNull(sales.margin_amd), isFiniteOrNull(sales.margin_pct), JSON.stringify(salesByChannel), JSON.stringify(salesByChannelWtd),
      isFiniteOrNull(payments.ytd_amd), isFiniteOrNull(payments.ytd_customers),
      isFiniteOrNull(payments.mtd_amd), isFiniteOrNull(payments.mtd_customers),
      isFiniteOrNull(payments.wtd_amd), isFiniteOrNull(payments.wtd_customers),
      isFiniteOrNull(payments.day_amd), isFiniteOrNull(payments.day_customers), JSON.stringify(paymentsByChannel), JSON.stringify(paymentsByChannelWtd),
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
    queueReportLabel("Օրական հաշվետվություն");
  }

  res.json({ synced: true, report_date, period });
});

const GENERATED_REPORT_TYPES = new Set(["sales_director", "debt_receivables", "ceo_management"]);

// Mirrors the client's own report_documents_type_* i18n labels (see
// client/public/js/i18n.js) so the notification names the report the same
// way the Reports & Documents page does.
const GENERATED_REPORT_TYPE_LABELS_HY = {
  sales_director: "Sales Director հաշվետվություն",
  debt_receivables: "Դեբիտորական հաշվետվություն",
  ceo_management: "CEO կառավարման հաշվետվություն",
};

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

  queueReportLabel(GENERATED_REPORT_TYPE_LABELS_HY[report_type] ?? report_type);

  res.json({ synced: true, report_type, report_date });
});

// Lets any logged-in rep browse the ERP extract by name instead of
// guessing at raw Customer IDs when creating/linking a customer -- normal
// cookie/JWT auth (not the sync key). Open to all roles (not admin-only)
// because managers do the initial bulk customer onboarding themselves.
// The latest failed (or partly skipped) sync calls, with the real error text: admin / CEO / operations director.
erpSyncRouter.get("/attempts", requireAuth, async (req, res) => {
  if (!["admin", "ceo", "operations_director"].includes(req.user.role)) return res.status(403).json({ error: "Not allowed" });
  res.json(await latestSyncAttempts());
});

// ---- Sync status and the admin's "Sync now" (owner, 2026-10-24) ----
const SYNC_VIEW_ROLES = ["admin", "ceo", "operations_director"];

// The bot polls often (every 30 s) with the sync key: its own, roomier limiter.
const pollLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => Boolean(process.env.E2E_RATE_LIMIT_BYPASS_TOKEN) && req.get("x-e2e-rate-limit-bypass") === process.env.E2E_RATE_LIMIT_BYPASS_TOKEN,
});

erpSyncRouter.get("/status", requireAuth, async (req, res) => {
  if (!SYNC_VIEW_ROLES.includes(req.user.role)) return res.status(403).json({ error: "Not allowed" });
  res.json(await getSyncStatus());
});

erpSyncRouter.post("/request", requireAuth, async (req, res) => {
  if (!SYNC_VIEW_ROLES.includes(req.user.role)) return res.status(403).json({ error: "Not allowed" });
  res.status(202).json(await createSyncRequest(req.user.id));
});

// For the bot (sync key): is a "Sync now" waiting? -> { request_id } or { request_id: null }
erpSyncRouter.get("/requests/pending", pollLimiter, requireSyncKey, async (req, res) => {
  res.json({ request_id: await pickPendingRequest() });
});

// The bot reports what happened. A failed run also becomes a failed attempt, so the admins are notified like for any rejected sync.
erpSyncRouter.post("/requests/:id/result", pollLimiter, requireSyncKey, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid request id" });
  const { ok, message } = req.body ?? {};
  const done = await finishRequest(id, ok, message);
  if (done && !ok) await recordSyncAttempt({ endpoint: "sync now (bot)", ok: false, error: message || "The bot could not run the sync" });
  res.json({ finished: done });
});

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
