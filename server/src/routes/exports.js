import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { seesFinancialExports } from "../roles.js";
import { toCsv } from "../utils/csv.js";

export const exportsRouter = Router();

exportsRouter.use(requireAuth);
exportsRouter.use((req, res, next) => {
  if (!seesFinancialExports(req.user.role)) return res.status(403).json({ error: "Not allowed" });
  next();
});

function isValidDateString(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function sendCsv(res, filename, headers, rows) {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(toCsv(headers, rows));
}

// Every checkin where a rep recorded a collection -- the accountant's raw
// material for reconciling what's actually been paid in.
exportsRouter.get("/payments.csv", async (req, res) => {
  const { from, to } = req.query;
  const conditions = ["ch.amount_collected_amd IS NOT NULL"];
  const params = [];
  if (isValidDateString(from)) {
    params.push(from);
    conditions.push(`ch.timestamp >= $${params.length}::date`);
  }
  if (isValidDateString(to)) {
    params.push(to);
    conditions.push(`ch.timestamp < ($${params.length}::date + interval '1 day')`);
  }

  const { rows } = await pool.query(
    `SELECT ch.timestamp, u.name AS rep_name, c.name AS customer_name, ch.amount_collected_amd
     FROM checkins ch
     JOIN users u ON u.id = ch.user_id
     JOIN customers c ON c.id = ch.customer_id
     WHERE ${conditions.join(" AND ")}
     ORDER BY ch.timestamp DESC`,
    params
  );

  sendCsv(
    res,
    "payments.csv",
    ["date", "rep", "customer", "amount_amd"],
    rows.map((r) => ({
      date: new Date(r.timestamp).toISOString(),
      rep: r.rep_name,
      customer: r.customer_name,
      amount_amd: r.amount_collected_amd,
    }))
  );
});

// Current outstanding debt per ERP-linked customer, as of the last sync --
// the same figures shown on each customer's detail page, in one sheet.
exportsRouter.get("/debt.csv", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.name AS customer_name, c.erp_customer_id, erp.assigned_sales_rep,
            erp.debt_amd, erp.last_payment_date, erp.days_since_payment, erp.aging_bucket, erp.synced_at
     FROM customers c
     JOIN erp_customer_data erp ON erp.erp_customer_id = c.erp_customer_id
     WHERE erp.debt_amd IS NOT NULL AND erp.debt_amd > 0
     ORDER BY erp.debt_amd DESC`
  );

  sendCsv(
    res,
    "debt.csv",
    ["customer", "erp_customer_id", "assigned_sales_rep", "debt_amd", "last_payment_date", "days_since_payment", "aging_bucket", "synced_at"],
    rows.map((r) => ({
      customer: r.customer_name,
      erp_customer_id: r.erp_customer_id,
      assigned_sales_rep: r.assigned_sales_rep,
      debt_amd: r.debt_amd,
      last_payment_date: r.last_payment_date ? new Date(r.last_payment_date).toISOString().slice(0, 10) : "",
      days_since_payment: r.days_since_payment,
      aging_bucket: r.aging_bucket,
      synced_at: r.synced_at ? new Date(r.synced_at).toISOString() : "",
    }))
  );
});

// One row per order line -- flatter than the app's own order/item split,
// which is what a spreadsheet reconciliation actually wants.
exportsRouter.get("/orders.csv", async (req, res) => {
  const { from, to } = req.query;
  const conditions = [];
  const params = [];
  if (isValidDateString(from)) {
    params.push(from);
    conditions.push(`o.created_at >= $${params.length}::date`);
  }
  if (isValidDateString(to)) {
    params.push(to);
    conditions.push(`o.created_at < ($${params.length}::date + interval '1 day')`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const { rows } = await pool.query(
    `SELECT o.id AS order_id, o.created_at, o.status, u.name AS rep_name, c.name AS customer_name,
            oi.product_name, oi.quantity, oi.unit_price_amd, oi.line_total_amd
     FROM orders o
     JOIN users u ON u.id = o.user_id
     JOIN customers c ON c.id = o.customer_id
     JOIN order_items oi ON oi.order_id = o.id
     ${where}
     ORDER BY o.created_at DESC, o.id`,
    params
  );

  sendCsv(
    res,
    "orders.csv",
    ["order_id", "date", "status", "rep", "customer", "product", "quantity", "unit_price_amd", "line_total_amd"],
    rows.map((r) => ({
      order_id: r.order_id,
      date: new Date(r.created_at).toISOString(),
      status: r.status,
      rep: r.rep_name,
      customer: r.customer_name,
      product: r.product_name,
      quantity: r.quantity,
      unit_price_amd: r.unit_price_amd,
      line_total_amd: r.line_total_amd,
    }))
  );
});
