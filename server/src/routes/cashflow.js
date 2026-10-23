// Cashflow module (owner, 2026-10-23): read the ledger (accounts, categories, entries, summary) and refresh it from an Excel workbook.
// The bot's own push is POST /api/erp-sync/cashflow-ledger (routes/erpSync.js); both land in ../cashflow.js applyCashLedger.
import { Router } from "express";
import multer from "multer";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { canSeeCashflow, canEditCashflow } from "../roles.js";
import { readCashWorkbook, applyCashLedger } from "../cashflow.js";
import { yerevanToday } from "../utils/yerevanDate.js";

export const cashflowRouter = Router();
cashflowRouter.use(requireAuth);
cashflowRouter.use((req, res, next) => (canSeeCashflow(req.user.role) ? next() : res.status(403).json({ error: "Not allowed" })));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 1 } });
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// Accounts with their balance (as of `asOf`, default today) in their own currencies, the categories, and the last refresh.
cashflowRouter.get("/meta", async (req, res) => {
  const asOf = DATE.test(String(req.query.as_of ?? "")) ? req.query.as_of : yerevanToday();
  const [{ rows: accounts }, { rows: categories }, { rows: [sync] }, { rows: [range] }, { rows: [rate] }] = await Promise.all([
    pool.query(
      `SELECT a.id, a.name, a.kind, a.active, a.sort_order,
              COALESCE(json_agg(json_build_object('currency', b.currency, 'balance', b.balance, 'amd', b.amd) ORDER BY b.currency) FILTER (WHERE b.currency IS NOT NULL), '[]') AS balances
       FROM cash_accounts a
       LEFT JOIN (SELECT account_id, currency, SUM(amount)::float8 AS balance, SUM(amount_amd)::float8 AS amd FROM cash_entries WHERE entry_date <= $1 GROUP BY account_id, currency) b ON b.account_id = a.id
       GROUP BY a.id ORDER BY a.sort_order, a.name`,
      [asOf]
    ),
    pool.query("SELECT id, name, kind, sort_order FROM cash_categories ORDER BY sort_order, name"),
    pool.query("SELECT at, via, rows_in, rows_skipped, file_name FROM cash_syncs ORDER BY at DESC LIMIT 1"),
    pool.query("SELECT MIN(entry_date)::text AS first, MAX(entry_date)::text AS last, COUNT(*)::int AS n, COUNT(*) FILTER (WHERE origin = 'excel')::int AS excel_rows FROM cash_entries"),
    pool.query("SELECT fx_rate::float8 AS rate FROM cash_entries WHERE currency = 'USD' AND fx_rate IS NOT NULL ORDER BY entry_date DESC, id DESC LIMIT 1"),
  ]);
  res.json({ as_of: asOf, accounts, categories, last_sync: sync ?? null, range, usd_rate: rate?.rate ?? null, can_edit: canEditCashflow(req.user.role) });
});

// Shared filters for the list and the summary.
function filters(q, params) {
  const where = [];
  if (DATE.test(String(q.from ?? ""))) where.push(`e.entry_date >= $${params.push(q.from)}`);
  if (DATE.test(String(q.to ?? ""))) where.push(`e.entry_date <= $${params.push(q.to)}`);
  if (q.account) where.push(`e.account_id = $${params.push(Number(q.account))}`);
  if (q.category) where.push(`e.category_id = $${params.push(Number(q.category))}`);
  if (["income", "expense", "owner", "internal"].includes(q.kind)) where.push(`c.kind = $${params.push(q.kind)}`);
  if (q.dir === "in") where.push("e.amount > 0");
  if (q.dir === "out") where.push("e.amount < 0");
  if (q.customer) where.push(`e.erp_customer_id = $${params.push(String(q.customer))}`);
  const text = String(q.q ?? "").trim();
  if (text) {
    const p = params.push(`%${text.replace(/[%_]/g, "\\$&")}%`);
    where.push(`(e.info ILIKE $${p} OR e.ref ILIKE $${p} OR e.erp_customer_id ILIKE $${p} OR cu.name ILIKE $${p} OR e.sales_rep ILIKE $${p})`);
  }
  return where.length ? `WHERE ${where.join(" AND ")}` : "";
}

const FROM = `FROM cash_entries e
  LEFT JOIN cash_categories c ON c.id = e.category_id
  LEFT JOIN cash_accounts a ON a.id = e.account_id
  LEFT JOIN customers cu ON cu.erp_customer_id = e.erp_customer_id`;

cashflowRouter.get("/entries", async (req, res) => {
  const params = [];
  const where = filters(req.query, params);
  const limit = Math.min(200, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));
  const offset = Math.max(0, Number.parseInt(req.query.offset, 10) || 0);
  const [{ rows }, { rows: [tot] }] = await Promise.all([
    pool.query(
      `SELECT e.id, e.entry_date::text AS date, e.amount::float8 AS amount, e.currency, e.fx_rate::float8 AS fx_rate, e.amount_amd::float8 AS amount_amd,
              c.name AS category, c.kind AS category_kind, a.name AS account, e.erp_customer_id, cu.name AS customer_name, e.ref, e.info, e.sales_rep, e.origin
       ${FROM} ${where} ORDER BY e.entry_date DESC, e.id DESC LIMIT ${limit} OFFSET ${offset}`,
      params
    ),
    pool.query(
      `SELECT COUNT(*)::int AS n,
              COALESCE(SUM(e.amount_amd) FILTER (WHERE e.amount > 0 AND COALESCE(c.kind, '') <> 'internal'), 0)::float8 AS in_amd,
              COALESCE(-SUM(e.amount_amd) FILTER (WHERE e.amount < 0 AND COALESCE(c.kind, '') <> 'internal'), 0)::float8 AS out_amd
       ${FROM} ${where}`,
      params
    ),
  ]);
  res.json({ entries: rows, total: tot.n, in_amd: tot.in_amd, out_amd: tot.out_amd, has_more: offset + rows.length < tot.n });
});

// Totals for a period: money in / out (internal moves between our own accounts are NOT counted), per category, per month.
cashflowRouter.get("/summary", async (req, res) => {
  const params = [];
  const where = filters({ from: req.query.from, to: req.query.to, account: req.query.account }, params);
  const [{ rows: byCategory }, { rows: byMonth }] = await Promise.all([
    pool.query(
      `SELECT c.id, c.name, c.kind,
              COALESCE(SUM(e.amount_amd) FILTER (WHERE e.amount > 0), 0)::float8 AS in_amd,
              COALESCE(-SUM(e.amount_amd) FILTER (WHERE e.amount < 0), 0)::float8 AS out_amd,
              COUNT(*)::int AS n
       ${FROM} ${where} GROUP BY c.id, c.name, c.kind ORDER BY c.kind, SUM(ABS(e.amount_amd)) DESC`,
      params
    ),
    pool.query(
      `SELECT to_char(date_trunc('month', e.entry_date), 'YYYY-MM') AS month,
              COALESCE(SUM(e.amount_amd) FILTER (WHERE e.amount > 0 AND COALESCE(c.kind, '') <> 'internal'), 0)::float8 AS in_amd,
              COALESCE(-SUM(e.amount_amd) FILTER (WHERE e.amount < 0 AND COALESCE(c.kind, '') <> 'internal'), 0)::float8 AS out_amd
       ${FROM} ${where} GROUP BY 1 ORDER BY 1`,
      params
    ),
  ]);
  const real = byCategory.filter((r) => r.kind !== "internal");
  res.json({
    in_amd: real.reduce((s, r) => s + r.in_amd, 0),
    out_amd: real.reduce((s, r) => s + r.out_amd, 0),
    by_category: byCategory,
    by_month: byMonth,
  });
});

// A workbook uploaded in the app (while Excel is still the source): replaces the ledger rows that came from Excel.
cashflowRouter.post("/import", (req, res, next) => {
  if (!canEditCashflow(req.user.role)) return res.status(403).json({ error: "Not allowed" });
  upload.single("file")(req, res, (err) => (err ? res.status(400).json({ error: err.message }) : next()));
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Choose the Excel workbook (.xlsx)" });
  let rows;
  try {
    rows = await readCashWorkbook(req.file.buffer);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  try {
    res.json(await applyCashLedger(rows, { via: "upload", userId: req.user.id, fileName: req.file.originalname }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
