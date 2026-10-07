import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { seesFinancialExports } from "../roles.js";
import { yerevanToday, yerevanMonthStart } from "../utils/yerevanDate.js";
import { erpSyncFreshness } from "../erpSyncFreshness.js";

export const salesRouter = Router();

salesRouter.use(requireAuth);

// Read-only viewer over the ERP-synced order history (erp_order_lines) --
// same "no write-back, ERP/Excel stays the source of truth" contract as
// Debt Balances. Company-wide, not per-customer like the existing
// GET /customers/:id/erp-orders (which this deliberately mirrors the shape
// of) -- same visibility line as the financial exports/Company Dashboard,
// since this is the same class of raw commercial data.
function requireFinancialAccess(req, res, next) {
  if (!seesFinancialExports(req.user.role)) return res.status(403).json({ error: "Not allowed" });
  next();
}
salesRouter.use(requireFinancialAccess);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Defaults to the current calendar month -- same "this month" framing the
// rest of the app's period pickers default to (see dashboardOverview.js's
// DEFAULT_PERIOD). Both computed in Yerevan's own calendar (see
// utils/yerevanDate.js), not the server's UTC clock -- this used to read
// yesterday's date as "today"/"the 1st" for part of every day.
function resolveDateRange(query) {
  const from = DATE_RE.test(query.from || "") ? query.from : yerevanMonthStart();
  const to = DATE_RE.test(query.to || "") ? query.to : yerevanToday();
  return { from, to };
}

// One row per order (order_id/order_date), summed across its line items --
// the per-line detail is a drill-down (GET /:orderId below), not the list
// view, same split as the existing per-customer erp-orders/erp-orders/:id
// pair. erp_customer_id doesn't always have a matching app customer (an
// ERP account not yet added here), so the name/channel columns fall back
// to the raw erp_customer_id and NULL rather than dropping the row.
// Search syntax (the `q` box): whitespace-separated terms, ALL of which must
// match the same order. A term is either an amount comparison on the order
// total (">50000", ">=50000", "<20000", "<=20000", "=49000") or plain text
// matched (case-insensitive substring) against the order id, the ERP customer
// id, the customer name, or any line of the order (brand + product + size,
// so "edge 0w20 c5 4l" finds the order with that product). A search narrows
// the selected date range (it no longer ignores it); widen the From/To dates
// to look further back.
const AMOUNT_TERM_RE = /^(>=|<=|>|<|=)\s*([0-9][0-9,]*(?:\.[0-9]+)?)$/;
const MAX_SEARCH_TERMS = 8;
const SEARCH_ROW_LIMIT = 1000;

export function parseSalesSearch(q) {
  const amountFilters = [];
  const textTerms = [];
  for (const raw of String(q || "").trim().split(/\s+/).filter(Boolean).slice(0, MAX_SEARCH_TERMS)) {
    const m = raw.match(AMOUNT_TERM_RE);
    if (m) amountFilters.push({ op: m[1], value: Number(m[2].replace(/,/g, "")) });
    else textTerms.push(raw);
  }
  return { amountFilters, textTerms };
}

salesRouter.get("/", async (req, res) => {
  const q = (req.query.q || "").trim();
  const { amountFilters, textTerms } = parseSalesSearch(q);
  const searching = amountFilters.length > 0 || textTerms.length > 0;

  const { from, to } = resolveDateRange(req.query);
  const params = [from, to];
  let where = "WHERE eol.order_date BETWEEN $1 AND $2";

  const channel = (req.query.channel || "").trim();
  if (channel) {
    params.push(channel);
    where += ` AND COALESCE(ecd.assigned_sales_rep, c.sales_channel) = $${params.length}`;
  }

  // Order-level conditions go in HAVING: the line text is aggregated per
  // order (bool_or over its lines), the amount is the order's own sum.
  const having = [];
  for (const term of textTerms) {
    params.push(`%${term.replace(/[\\%_]/g, "\\$&")}%`);
    const p = `$${params.length}`;
    // Product text is also compared with every non-alphanumeric stripped on
    // both sides, so "0w20" finds a product spelled "0W-20" and "5w30c3"
    // style runs still match across spaces/dashes.
    const squashed = term.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
    let squashedSql = "";
    if (squashed) {
      params.push(`%${squashed}%`);
      squashedSql = ` OR bool_or(regexp_replace(lower(concat_ws(' ', eol.brand, eol.product_name, trim(eol.size_l) || 'L')), '[^[:alnum:]]', '', 'g') LIKE $${params.length})`;
    }
    having.push(
      `(eol.order_id ILIKE ${p} OR eol.erp_customer_id ILIKE ${p} OR COALESCE(c.name, '') ILIKE ${p}
        OR bool_or(concat_ws(' ', eol.brand, eol.product_name, trim(eol.size_l) || 'L') ILIKE ${p})${squashedSql})`
    );
  }
  for (const f of amountFilters) {
    params.push(f.value);
    having.push(`sum(eol.revenue_amd) ${f.op} $${params.length}`);
  }
  const havingSql = having.length ? `HAVING ${having.join(" AND ")}` : "";

  const { rows } = await pool.query(
    `SELECT eol.order_id, eol.order_date, eol.erp_customer_id,
            c.id AS internal_customer_id,
            COALESCE(c.name, eol.erp_customer_id) AS customer_name,
            COALESCE(ecd.assigned_sales_rep, c.sales_channel) AS channel,
            sum(eol.revenue_amd) AS total_amd,
            sum(eol.qty) AS total_qty,
            -- size_l is free-text from the ERP extract (usually a plain
            -- number, occasionally with a trailing "L" like products.unit).
            -- Stripping to just digits/dots (as an earlier version of this
            -- query did) isn't safe on its own: malformed text with more
            -- than one dot or number (e.g. "1.5/2.0L") strips down to
            -- something like "1.52.0", which isn't valid numeric syntax and
            -- throws instead of degrading -- turning one bad ERP row into a
            -- 500 for the whole date range. So the trailing "L" is stripped
            -- first, then the WHOLE remaining string is validated as a
            -- single clean number before ever being cast; anything that
            -- doesn't match (multiple numbers, stray punctuation, empty)
            -- degrades to 0 for that line, same as size_l being unset.
            sum(eol.qty * (CASE WHEN regexp_replace(trim(eol.size_l), '[Ll]$', '') ~ '^[0-9]+(\.[0-9]+)?$'
                                 THEN regexp_replace(trim(eol.size_l), '[Ll]$', '')::numeric
                                 ELSE 0 END)) AS total_liters
     FROM erp_order_lines eol
     LEFT JOIN customers c ON c.erp_customer_id = eol.erp_customer_id
     LEFT JOIN erp_customer_data ecd ON ecd.erp_customer_id = eol.erp_customer_id
     ${where}
     GROUP BY eol.order_id, eol.order_date, eol.erp_customer_id, c.id, c.name, ecd.assigned_sales_rep, c.sales_channel
     ${havingSql}
     ORDER BY eol.order_date DESC, eol.order_id DESC
     LIMIT ${searching ? SEARCH_ROW_LIMIT : 10000}`,
    params
  );
  // erp_order_lines has no synced_at column of its own (it's TRUNCATEd
  // and re-inserted in the same transaction as erp_customer_data on every
  // sync -- see routes/erpSync.js), so erp_customer_data's own synced_at
  // is an accurate proxy for "when was this order data last refreshed".
  res.json({ from, to, searching, rows, sync: await erpSyncFreshness("erp_customer_data") });
});

// Line-item detail for one order -- erp_customer_id + order_id together,
// since order_id alone (a free-text ERP order number) isn't guaranteed
// unique across different customers.
salesRouter.get("/order", async (req, res) => {
  const erpCustomerId = String(req.query.erp_customer_id || "");
  const orderId = String(req.query.order_id || "");
  if (!erpCustomerId || !orderId) return res.status(400).json({ error: "erp_customer_id and order_id are required" });

  const { rows } = await pool.query(
    `SELECT eol.order_id, eol.order_date, eol.erp_customer_id, eol.product_id, eol.brand, eol.product_name,
            eol.size_l, eol.qty, eol.unit_price_amd, eol.revenue_amd, eol.discount_amd,
            c.id AS internal_customer_id, COALESCE(c.name, eol.erp_customer_id) AS customer_name,
            COALESCE(ecd.assigned_sales_rep, c.sales_channel) AS channel
     FROM erp_order_lines eol
     LEFT JOIN customers c ON c.erp_customer_id = eol.erp_customer_id
     LEFT JOIN erp_customer_data ecd ON ecd.erp_customer_id = eol.erp_customer_id
     WHERE eol.erp_customer_id = $1 AND eol.order_id = $2
     ORDER BY eol.brand, eol.product_name`,
    [erpCustomerId, orderId]
  );
  if (!rows.length) return res.status(404).json({ error: "Order not found" });
  res.json({
    order_id: rows[0].order_id,
    order_date: rows[0].order_date,
    erp_customer_id: rows[0].erp_customer_id,
    internal_customer_id: rows[0].internal_customer_id,
    customer_name: rows[0].customer_name,
    channel: rows[0].channel,
    total_amd: rows.reduce((sum, r) => sum + Number(r.revenue_amd || 0), 0),
    lines: rows,
  });
});
