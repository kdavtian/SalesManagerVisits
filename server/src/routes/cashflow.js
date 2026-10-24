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
              e.account_id, e.category_id, c.name AS category, c.kind AS category_kind, a.name AS account, e.erp_customer_id, cu.name AS customer_name, e.ref, e.info, e.sales_rep, e.origin
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

// ---- add / edit / delete an entry in the app (phase 2) ---------------------------------------------------------------------------------
// Rows that came from Excel are read-only while Excel is the source (the next refresh would replace them); rows made here (origin manual / bank) are
// never touched by a refresh. The form sends a direction (in / out) and a positive amount; the ledger stores the signed amount.
async function cleanEntry(b) {
  const err = (m) => ({ error: m });
  if (!DATE.test(String(b.date ?? ""))) return err("Choose the date");
  const direction = b.direction === "in" ? 1 : b.direction === "out" ? -1 : 0;
  if (!direction) return err("Choose money in or money out");
  const amount = Number(b.amount);
  if (!(amount > 0) || amount > 1e12) return err("Enter the amount");
  const currency = b.currency === "USD" ? "USD" : "AMD";
  let fx = null;
  if (currency === "USD") {
    fx = Number(b.fx_rate);
    if (!(fx > 0)) {
      const { rows } = await pool.query("SELECT fx_rate::float8 AS r FROM cash_entries WHERE currency = 'USD' AND fx_rate IS NOT NULL ORDER BY entry_date DESC, id DESC LIMIT 1");
      fx = rows[0]?.r ?? null;
    }
    if (!(fx > 0)) return err("Enter the USD rate (AMD per USD)");
  }
  const accountId = Number(b.account_id);
  const categoryId = Number(b.category_id);
  const [{ rowCount: hasAccount }, { rowCount: hasCategory }] = await Promise.all([
    pool.query("SELECT 1 FROM cash_accounts WHERE id = $1", [accountId]),
    pool.query("SELECT 1 FROM cash_categories WHERE id = $1", [categoryId]),
  ]);
  if (!hasAccount) return err("Choose the account");
  if (!hasCategory) return err("Choose the category");
  const text = (k, max) => (typeof b[k] === "string" ? b[k].trim().slice(0, max) || null : null);
  const signed = direction * amount;
  return {
    value: {
      entry_date: b.date, amount: signed, currency, fx_rate: fx, amount_amd: currency === "USD" ? Math.round(signed * fx * 100) / 100 : signed,
      category_id: categoryId, account_id: accountId, erp_customer_id: text("erp_customer_id", 40), ref: text("ref", 100), info: text("info", 300), sales_rep: text("sales_rep", 40),
    },
  };
}

const ENTRY_COLS = ["entry_date", "amount", "currency", "fx_rate", "amount_amd", "category_id", "account_id", "erp_customer_id", "ref", "info", "sales_rep"];

cashflowRouter.post("/entries", async (req, res) => {
  if (!canEditCashflow(req.user.role)) return res.status(403).json({ error: "Not allowed" });
  const c = await cleanEntry(req.body ?? {});
  if (c.error) return res.status(400).json({ error: c.error });
  const { rows } = await pool.query(
    `INSERT INTO cash_entries (${ENTRY_COLS.join(", ")}, origin, created_by) VALUES (${ENTRY_COLS.map((_, i) => `$${i + 1}`).join(", ")}, 'manual', $${ENTRY_COLS.length + 1}) RETURNING id`,
    [...ENTRY_COLS.map((k) => c.value[k]), req.user.id]
  );
  res.status(201).json({ id: rows[0].id });
});

cashflowRouter.put("/entries/:id", async (req, res) => {
  if (!canEditCashflow(req.user.role)) return res.status(403).json({ error: "Not allowed" });
  const id = Number(req.params.id);
  const { rows: [row] } = await pool.query("SELECT origin FROM cash_entries WHERE id = $1", [id]);
  if (!row) return res.status(404).json({ error: "Not found" });
  if (row.origin === "excel") return res.status(409).json({ error: "This row comes from Excel and changes there" });
  const c = await cleanEntry(req.body ?? {});
  if (c.error) return res.status(400).json({ error: c.error });
  await pool.query(`UPDATE cash_entries SET ${ENTRY_COLS.map((k, i) => `${k} = $${i + 1}`).join(", ")}, updated_at = now() WHERE id = $${ENTRY_COLS.length + 1}`, [...ENTRY_COLS.map((k) => c.value[k]), id]);
  res.json({ ok: true });
});

cashflowRouter.delete("/entries/:id", async (req, res) => {
  if (!canEditCashflow(req.user.role)) return res.status(403).json({ error: "Not allowed" });
  const id = Number(req.params.id);
  const { rows: [row] } = await pool.query("SELECT origin FROM cash_entries WHERE id = $1", [id]);
  if (!row) return res.status(404).json({ error: "Not found" });
  if (row.origin === "excel") return res.status(409).json({ error: "This row comes from Excel and changes there" });
  await pool.query("DELETE FROM cash_entries WHERE id = $1", [id]);
  res.json({ ok: true });
});

// A new account (Source) or category (For) when the list has no fitting one.
cashflowRouter.post("/accounts", async (req, res) => {
  if (!canEditCashflow(req.user.role)) return res.status(403).json({ error: "Not allowed" });
  const name = String(req.body?.name ?? "").trim().slice(0, 60);
  const kind = ["cash", "bank", "credit", "other"].includes(req.body?.kind) ? req.body.kind : "bank";
  if (!name) return res.status(400).json({ error: "Enter the name" });
  try {
    const { rows } = await pool.query("INSERT INTO cash_accounts (name, kind) VALUES ($1, $2) RETURNING id", [name, kind]);
    res.status(201).json({ id: rows[0].id });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "This account already exists" });
    throw err;
  }
});
cashflowRouter.post("/categories", async (req, res) => {
  if (!canEditCashflow(req.user.role)) return res.status(403).json({ error: "Not allowed" });
  const name = String(req.body?.name ?? "").trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: "Enter the name" });
  if (!["income", "expense", "owner", "internal"].includes(req.body?.kind)) return res.status(400).json({ error: "Choose what kind of category it is" });
  try {
    const { rows } = await pool.query("INSERT INTO cash_categories (name, kind) VALUES ($1, $2) RETURNING id", [name, req.body.kind]);
    res.status(201).json({ id: rows[0].id });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "This category already exists" });
    throw err;
  }
});
