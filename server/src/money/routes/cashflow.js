// Cashflow module (owner, 2026-10-23): read the ledger (accounts, categories, entries, summary) and refresh it from an Excel workbook.
// The bot's own push is POST /api/erp-sync/cashflow-ledger (routes/erpSync.js); both land in ../cashflow.js applyCashLedger.
import { Router } from "express";
import multer from "multer";
import { pool } from "../../db/pool.js";
import { requireAuth } from "../../middleware/auth.js";
import { canSeeCashflow, canEditCashflow, isCashflowManagement, CASH_EDIT_WINDOW_DAYS } from "../../shared/roles.js";
import { readCashWorkbook, applyCashLedger, cleanEntry } from "../cashflow.js";
import { bankRouter } from "./bankStatements.js";
import { yerevanToday } from "../../utils/yerevanDate.js";

export const cashflowRouter = Router();
cashflowRouter.use(requireAuth);
cashflowRouter.use((req, res, next) => (canSeeCashflow(req.user.role) ? next() : res.status(403).json({ error: "Not allowed" })));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 1 } });
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// Bank statements (phase 3): upload, reconcile with the ledger.
cashflowRouter.use("/bank", bankRouter);

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
  const management = isCashflowManagement(req.user.role);
  const { rows: [pending] } = await pool.query("SELECT COUNT(*)::int AS n FROM cash_entry_requests WHERE status = 'pending'" + (management ? "" : " AND requested_by = $1"), management ? [] : [req.user.id]);
  res.json({
    as_of: asOf, accounts, categories, last_sync: sync ?? null, range, usd_rate: rate?.rate ?? null, can_edit: canEditCashflow(req.user.role),
    is_management: management, edit_window_days: CASH_EDIT_WINDOW_DAYS, pending_requests: pending.n,
  });
});

// Shared filters for the list and the summary.
function filters(q, params) {
  const where = [];
  if (DATE.test(String(q.from ?? ""))) where.push(`e.entry_date >= $${params.push(q.from)}`);
  if (DATE.test(String(q.to ?? ""))) where.push(`e.entry_date <= $${params.push(q.to)}`);
  if (q.account) where.push(`e.account_id = $${params.push(Number(q.account))}`);
  if (q.category) where.push(`e.category_id = $${params.push(Number(q.category))}`);
  const cats = String(q.categories ?? "").split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (cats.length) where.push(`e.category_id = ANY($${params.push(cats)}::int[])`);
  // In / Out cards: money that really came in or went out -- moves between our own accounts are not counted (same rule as the totals).
  if (q.real === "1") where.push("COALESCE(c.kind, '') <> 'internal'");
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
  // The In / Out / Net cards show the totals of everything else that is filtered, whichever of the three is tapped.
  const totParams = [];
  const totWhere = filters({ ...req.query, dir: undefined, real: undefined }, totParams);
  const limit = Math.min(200, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));
  const offset = Math.max(0, Number.parseInt(req.query.offset, 10) || 0);
  const [{ rows }, { rows: [tot] }, { rows: [sums] }] = await Promise.all([
    pool.query(
      `SELECT e.id, e.entry_date::text AS date, e.amount::float8 AS amount, e.currency, e.fx_rate::float8 AS fx_rate, e.amount_amd::float8 AS amount_amd,
              e.account_id, e.category_id, c.name AS category, c.kind AS category_kind, a.name AS account, e.erp_customer_id, cu.name AS customer_name, e.ref, e.info, e.sales_rep, e.origin,
              e.created_at, e.updated_at,
              EXISTS (SELECT 1 FROM bank_statement_lines b WHERE b.account_id = e.account_id AND b.amount = e.amount AND b.currency = e.currency AND b.line_date BETWEEN e.entry_date - 3 AND e.entry_date + 3) AS bank_ok
       ${FROM} ${where} ORDER BY e.entry_date DESC, e.id DESC LIMIT ${limit} OFFSET ${offset}`,
      params
    ),
    pool.query(`SELECT COUNT(*)::int AS n ${FROM} ${where}`, params),
    pool.query(
      `SELECT COALESCE(SUM(e.amount_amd) FILTER (WHERE e.amount > 0 AND COALESCE(c.kind, '') <> 'internal'), 0)::float8 AS in_amd,
              COALESCE(-SUM(e.amount_amd) FILTER (WHERE e.amount < 0 AND COALESCE(c.kind, '') <> 'internal'), 0)::float8 AS out_amd,
              COUNT(*) FILTER (WHERE e.amount > 0 AND COALESCE(c.kind, '') <> 'internal')::int AS n_in,
              COUNT(*) FILTER (WHERE e.amount < 0 AND COALESCE(c.kind, '') <> 'internal')::int AS n_out
       ${FROM} ${totWhere}`,
      totParams
    ),
  ]);
  res.json({ entries: rows, total: tot.n, in_amd: sums.in_amd, out_amd: sums.out_amd, n_in: sums.n_in, n_out: sums.n_out, has_more: offset + rows.length < tot.n });
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
const ENTRY_COLS = ["entry_date", "amount", "currency", "fx_rate", "amount_amd", "category_id", "account_id", "erp_customer_id", "ref", "info", "sales_rep"];

// Every change is logged (owner, 2026-10-27: "records logs are saved with date time"); a deleted row keeps its history.
async function logEntry(db, entryId, action, userId, { before = null, after = null, note = null } = {}) {
  await db.query("INSERT INTO cash_entry_log (entry_id, action, user_id, before, after, note) VALUES ($1, $2, $3, $4, $5, $6)", [
    entryId, action, userId, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, note,
  ]);
}
const ROW_COLS = `id, entry_date::text AS date, amount::float8 AS amount, currency, fx_rate::float8 AS fx_rate, amount_amd::float8 AS amount_amd, category_id,
  account_id, erp_customer_id, ref, info, sales_rep, origin, created_by, created_at`;
async function rowOf(db, id) {
  const { rows: [row] } = await db.query(`SELECT ${ROW_COLS} FROM cash_entries WHERE id = $1`, [id]);
  return row ?? null;
}

// What this user may do with a row right now: "now" = change it directly, "request" = ask management, "none" = read only.
function changeRight(user, row) {
  if (!row || row.origin === "excel" || !canEditCashflow(user.role)) return "none";
  if (isCashflowManagement(user.role)) return "now";
  const ageDays = (Date.now() - new Date(row.created_at).getTime()) / 86400000;
  return ageDays <= CASH_EDIT_WINDOW_DAYS ? "now" : "request";
}
const tooOld = (res) =>
  res.status(409).json({ error: `Rows older than ${CASH_EDIT_WINDOW_DAYS} days change only through a request to management`, needs_request: true });

cashflowRouter.post("/entries", async (req, res) => {
  if (!canEditCashflow(req.user.role)) return res.status(403).json({ error: "Not allowed" });
  const c = await cleanEntry(req.body ?? {});
  if (c.error) return res.status(400).json({ error: c.error });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO cash_entries (${ENTRY_COLS.join(", ")}, origin, created_by) VALUES (${ENTRY_COLS.map((_, i) => `$${i + 1}`).join(", ")}, 'manual', $${ENTRY_COLS.length + 1}) RETURNING id`,
      [...ENTRY_COLS.map((k) => c.value[k]), req.user.id]
    );
    await logEntry(client, rows[0].id, "create", req.user.id, { after: await rowOf(client, rows[0].id) });
    await client.query("COMMIT");
    res.status(201).json({ id: rows[0].id });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
});

// Apply an update / delete with its log line, inside the caller's transaction. false = the row is gone.
async function changeIn(client, id, action, value, userId, logAction = action, note = null) {
  const before = await rowOf(client, id);
  if (!before) return false;
  if (action === "delete") await client.query("DELETE FROM cash_entries WHERE id = $1", [id]);
  else await client.query(`UPDATE cash_entries SET ${ENTRY_COLS.map((k, i) => `${k} = $${i + 1}`).join(", ")}, updated_at = now() WHERE id = $${ENTRY_COLS.length + 1}`, [...ENTRY_COLS.map((k) => value[k]), id]);
  await logEntry(client, id, logAction, userId, { before, after: action === "delete" ? null : await rowOf(client, id), note });
  return true;
}

async function inTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query(result === false || result?.rollback ? "ROLLBACK" : "COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// A direct update / delete in one transaction, with its log line.
const applyChange = (id, action, value, userId) => inTransaction((client) => changeIn(client, id, action, value, userId));

// One row in full: the row, its history (with date and time), a waiting request, and what this user may do with it.
cashflowRouter.get("/entries/:id", async (req, res) => {
  const id = Number(req.params.id);
  const { rows: [row] } = await pool.query(
    `SELECT e.id, e.entry_date::text AS date, e.amount::float8 AS amount, e.currency, e.fx_rate::float8 AS fx_rate, e.amount_amd::float8 AS amount_amd,
            e.account_id, e.category_id, c.name AS category, c.kind AS category_kind, a.name AS account, e.erp_customer_id, cu.id AS customer_id, cu.name AS customer_name,
            e.ref, e.info, e.sales_rep, e.origin, e.transaction_id, e.created_at, e.updated_at, u.name AS created_by_name
     ${FROM} LEFT JOIN users u ON u.id = e.created_by WHERE e.id = $1`,
    [id]
  );
  const [{ rows: log }, { rows: [pending] }] = await Promise.all([
    pool.query(
      `SELECT l.action, l.at, l.note, u.name AS user_name, l.before, l.after FROM cash_entry_log l LEFT JOIN users u ON u.id = l.user_id WHERE l.entry_id = $1 ORDER BY l.at, l.id`,
      [id]
    ),
    pool.query(
      `SELECT r.id, r.action, r.reason, r.requested_at, u.name AS requested_by_name FROM cash_entry_requests r LEFT JOIN users u ON u.id = r.requested_by
       WHERE r.entry_id = $1 AND r.status = 'pending'`,
      [id]
    ),
  ]);
  if (!row) return log.length ? res.json({ entry: null, log, right: "none" }) : res.status(404).json({ error: "Not found" });
  res.json({ entry: row, log, pending_request: pending ?? null, right: changeRight(req.user, row), is_management: isCashflowManagement(req.user.role) });
});

cashflowRouter.put("/entries/:id", async (req, res) => {
  if (!canEditCashflow(req.user.role)) return res.status(403).json({ error: "Not allowed" });
  const id = Number(req.params.id);
  const row = await rowOf(pool, id);
  if (!row) return res.status(404).json({ error: "Not found" });
  if (row.origin === "excel") return res.status(409).json({ error: "This row comes from Excel and changes there" });
  if (changeRight(req.user, row) !== "now") return tooOld(res);
  const c = await cleanEntry(req.body ?? {});
  if (c.error) return res.status(400).json({ error: c.error });
  await applyChange(id, "update", c.value, req.user.id);
  res.json({ ok: true });
});

cashflowRouter.delete("/entries/:id", async (req, res) => {
  if (!canEditCashflow(req.user.role)) return res.status(403).json({ error: "Not allowed" });
  const id = Number(req.params.id);
  const row = await rowOf(pool, id);
  if (!row) return res.status(404).json({ error: "Not found" });
  if (row.origin === "excel") return res.status(409).json({ error: "This row comes from Excel and changes there" });
  if (changeRight(req.user, row) !== "now") return tooOld(res);
  await applyChange(id, "delete", null, req.user.id);
  res.json({ ok: true });
});

// A change of an older row: the accountant asks, management decides.
cashflowRouter.post("/entries/:id/requests", async (req, res) => {
  if (!canEditCashflow(req.user.role)) return res.status(403).json({ error: "Not allowed" });
  const id = Number(req.params.id);
  const row = await rowOf(pool, id);
  if (!row) return res.status(404).json({ error: "Not found" });
  if (row.origin === "excel") return res.status(409).json({ error: "This row comes from Excel and changes there" });
  const action = req.body?.action === "delete" ? "delete" : "update";
  let payload = null;
  if (action === "update") {
    const c = await cleanEntry(req.body?.data ?? {});
    if (c.error) return res.status(400).json({ error: c.error });
    payload = c.value;
  }
  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim().slice(0, 300) || null : null;
  try {
    const { rows } = await pool.query(
      "INSERT INTO cash_entry_requests (entry_id, action, payload, reason, requested_by) VALUES ($1, $2, $3, $4, $5) RETURNING id",
      [id, action, payload ? JSON.stringify(payload) : null, reason, req.user.id]
    );
    await logEntry(pool, id, "request", req.user.id, { before: row, after: payload, note: [action, reason].filter(Boolean).join(": ") });
    res.status(201).json({ id: rows[0].id });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "A request for this row is already waiting" });
    throw err;
  }
});

cashflowRouter.get("/requests", async (req, res) => {
  const management = isCashflowManagement(req.user.role);
  const { rows } = await pool.query(
    `SELECT r.id, r.entry_id, r.action, r.payload, r.reason, r.requested_at, u.name AS requested_by_name,
            e.entry_date::text AS date, e.amount::float8 AS amount, e.currency, c.name AS category, a.name AS account, e.info
     FROM cash_entry_requests r LEFT JOIN users u ON u.id = r.requested_by
     LEFT JOIN cash_entries e ON e.id = r.entry_id LEFT JOIN cash_categories c ON c.id = e.category_id LEFT JOIN cash_accounts a ON a.id = e.account_id
     WHERE r.status = 'pending' ${management ? "" : "AND r.requested_by = $1"} ORDER BY r.requested_at`,
    management ? [] : [req.user.id]
  );
  res.json({ requests: rows, can_decide: management });
});

cashflowRouter.post("/requests/:id/:decision", async (req, res) => {
  if (!isCashflowManagement(req.user.role)) return res.status(403).json({ error: "Not allowed" });
  const decision = req.params.decision;
  if (!["approve", "reject"].includes(decision)) return res.status(404).json({ error: "Not found" });
  // The decision, the change and both log lines commit together: a change that fails leaves the request waiting, not "approved" with nothing done.
  const outcome = await inTransaction(async (client) => {
    const { rows: [r] } = await client.query(
      "UPDATE cash_entry_requests SET status = $2, decided_by = $3, decided_at = now() WHERE id = $1 AND status = 'pending' RETURNING *",
      [Number(req.params.id), decision === "approve" ? "approved" : "rejected", req.user.id]
    );
    if (!r) return { status: 404, error: "Request not found or already decided" };
    if (decision === "reject") {
      await logEntry(client, r.entry_id, "reject", req.user.id, { note: `#${r.id}` });
      return { ok: true };
    }
    // The row was changed after the request was made: approving would silently undo that newer change.
    const { rows: [cur] } = await client.query("SELECT updated_at > $2 AS newer FROM cash_entries WHERE id = $1", [r.entry_id, r.requested_at]);
    if (!cur) return { status: 404, error: "The row no longer exists", rollback: true };
    if (cur.newer && r.action === "update") return { status: 409, error: "The row was changed after this request was made; reject it and ask again", rollback: true };
    await changeIn(client, r.entry_id, r.action, r.payload, req.user.id, r.action, `approved request #${r.id}`);
    await logEntry(client, r.entry_id, "approve", req.user.id, { note: `#${r.id}` });
    return { ok: true };
  });
  if (outcome.error) return res.status(outcome.status).json({ error: outcome.error });
  res.json({ ok: true });
});

// Customers for the "Customer ID" field of the Add sheet: ERP id, name and the channel of the rep the customer is assigned to.
cashflowRouter.get("/customers", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT d.erp_customer_id, COALESCE(c.name, d.customer_name) AS name, COALESCE(d.assigned_sales_rep, c.sales_channel) AS channel
     FROM erp_customer_data d LEFT JOIN customers c ON c.erp_customer_id = d.erp_customer_id
     UNION ALL
     SELECT c.erp_customer_id, c.name, c.sales_channel FROM customers c
     WHERE c.erp_customer_id IS NOT NULL AND c.erp_customer_id <> '' AND NOT EXISTS (SELECT 1 FROM erp_customer_data d WHERE d.erp_customer_id = c.erp_customer_id)
     ORDER BY 1`
  );
  res.json({ customers: rows });
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
