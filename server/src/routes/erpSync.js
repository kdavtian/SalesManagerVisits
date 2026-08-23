import crypto from "node:crypto";
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { pool } from "../db/pool.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";

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
  const { customers } = req.body ?? {};
  if (!Array.isArray(customers)) {
    return res.status(400).json({ error: "customers must be an array" });
  }

  const erpIds = [];
  const names = [];
  const reps = [];
  const debts = [];
  const lastPayments = [];
  const daysSince = [];
  const agingBuckets = [];
  const recentOrders = [];

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
    await client.query("COMMIT");
  } catch (err) {
    releaseErr = err;
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release(releaseErr);
  }

  res.json({ synced: erpIds.length });
});

// Lets an admin browse the ERP extract by name instead of guessing at raw
// Customer IDs when linking a Field Visits customer -- normal cookie/JWT
// auth (not the sync key), since this is read by an admin in the browser.
erpSyncRouter.get("/unlinked", requireAuth, requireAdmin, async (req, res) => {
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
