import { Router } from "express";
import { pool } from "../db/pool.js";

export const erpSyncRouter = Router();

// This is a machine-to-machine push from the Windows PC running the CEO
// Telegram bot pipeline (ceo_agent.py -> work/sync_field_visits.py), not a
// browser session, so it authenticates with a static shared secret instead
// of the usual cookie/JWT flow.
function requireSyncKey(req, res, next) {
  const key = req.get("X-Sync-Key");
  if (!process.env.ERP_SYNC_KEY || key !== process.env.ERP_SYNC_KEY) {
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
erpSyncRouter.post("/", requireSyncKey, async (req, res) => {
  const { customers } = req.body ?? {};
  if (!Array.isArray(customers)) {
    return res.status(400).json({ error: "customers must be an array" });
  }

  const rows = [];
  for (const entry of customers) {
    if (!isPlainObject(entry) || !entry.erp_customer_id) continue;
    rows.push([
      String(entry.erp_customer_id),
      entry.assigned_sales_rep != null ? String(entry.assigned_sales_rep) : null,
      Number.isFinite(entry.debt_amd) ? entry.debt_amd : null,
      entry.last_payment_date || null,
      Number.isFinite(entry.days_since_payment) ? entry.days_since_payment : null,
      entry.aging_bucket || null,
      JSON.stringify(Array.isArray(entry.recent_orders) ? entry.recent_orders.slice(0, 10) : []),
    ]);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("TRUNCATE erp_customer_data");
    for (const row of rows) {
      await client.query(
        `INSERT INTO erp_customer_data
           (erp_customer_id, assigned_sales_rep, debt_amd, last_payment_date, days_since_payment, aging_bucket, recent_orders, synced_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
        row
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  res.json({ synced: rows.length });
});
