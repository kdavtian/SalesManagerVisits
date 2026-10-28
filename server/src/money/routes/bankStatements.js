// Bank statements (Cashflow phase 3, owner 2026-10-24), mounted at /api/cashflow/bank (so the Cashflow access check already ran).
//   POST /preview   one account's statement file -> what the file contains and how its columns were read (nothing is saved)
//   POST /import    the same file -> new lines are kept (a line already imported is skipped), the result says how many matched the ledger
//   GET  /lines     the lines with their reconciliation: matched (the ledger has its row), open (no row yet), added, ignored
//   POST /lines/:id/add | /ignore | /reopen   the accountant's decision about a line without a row
import { Router } from "express";
import multer from "multer";
import { pool } from "../../db/pool.js";
import { canEditCashflow } from "../../shared/roles.js";
import { cleanEntry } from "../cashflow.js";
import { readStatement, hashLines, matchLines, FIELDS } from "../bankStatement.js";

export const bankRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 1 } });
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const edit = (req, res, next) => (canEditCashflow(req.user.role) ? next() : res.status(403).json({ error: "Not allowed" }));
const withFile = (req, res, next) => upload.single("file")(req, res, (err) => (err ? res.status(400).json({ error: err.message }) : next()));

// "mapping" arrives as JSON { field: columnIndex }; anything else is ignored.
function parseMapping(raw) {
  if (!raw) return null;
  try {
    const m = JSON.parse(raw);
    const out = {};
    for (const f of FIELDS) if (Number.isInteger(m?.[f]) && m[f] >= 0 && m[f] < 200) out[f] = m[f];
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}

async function loadAccount(id) {
  const { rows: [a] } = await pool.query("SELECT id, name FROM cash_accounts WHERE id = $1", [Number(id)]);
  return a ?? null;
}

async function readFor(req) {
  if (!req.file) throw Object.assign(new Error("Choose the statement file (.csv or .xlsx)"), { status: 400 });
  const account = await loadAccount(req.body?.account_id);
  if (!account) throw Object.assign(new Error("Choose the bank account of this statement"), { status: 400 });
  const defaultCurrency = /usd|dollar/i.test(account.name) ? "USD" : "AMD";
  let statement;
  try {
    statement = await readStatement(req.file.buffer, req.file.originalname, { mapping: parseMapping(req.body?.mapping), defaultCurrency });
  } catch (err) {
    throw Object.assign(new Error(`The file could not be read: ${err.message}`), { status: 400 });
  }
  return { account, statement };
}

const fail = (res, err) => (err.status ? res.status(err.status).json({ error: err.message }) : Promise.reject(err));

bankRouter.post("/preview", edit, withFile, async (req, res) => {
  try {
    const { account, statement } = await readFor(req);
    const hashes = hashLines(account.id, statement.lines);
    const { rows: known } = hashes.length ? await pool.query("SELECT line_hash FROM bank_statement_lines WHERE account_id = $1 AND line_hash = ANY($2)", [account.id, hashes]) : { rows: [] };
    const knownSet = new Set(known.map((r) => r.line_hash));
    res.json({
      needs_mapping: statement.needsMapping,
      headers: statement.headers,
      mapping: statement.mapping,
      total: statement.lines.length,
      already_imported: statement.lines.filter((_, i) => knownSet.has(hashes[i])).length,
      skipped: statement.skipped.slice(0, 20),
      skipped_count: statement.skipped.length,
      first_date: statement.lines.reduce((m, l) => (!m || l.line_date < m ? l.line_date : m), null),
      last_date: statement.lines.reduce((m, l) => (!m || l.line_date > m ? l.line_date : m), null),
      sample: statement.lines.slice(0, 8),
    });
  } catch (err) {
    return fail(res, err);
  }
});

bankRouter.post("/import", edit, withFile, async (req, res) => {
  let account;
  let statement;
  try {
    ({ account, statement } = await readFor(req));
  } catch (err) {
    return fail(res, err);
  }
  if (statement.needsMapping || !statement.lines.length) return res.status(400).json({ error: "No statement lines were found: check the date and amount columns" });
  const hashes = hashLines(account.id, statement.lines);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: [imp] } = await client.query(
      "INSERT INTO bank_imports (account_id, file_name, rows_in, rows_new, rows_duplicate, rows_skipped, user_id) VALUES ($1, $2, $3, 0, 0, $4, $5) RETURNING id",
      [account.id, req.file.originalname?.slice(0, 200) ?? null, statement.lines.length, statement.skipped.length, req.user.id]
    );
    let added = 0;
    for (let i = 0; i < statement.lines.length; i++) {
      const l = statement.lines[i];
      const r = await client.query(
        `INSERT INTO bank_statement_lines (import_id, account_id, line_date, amount, currency, description, counterparty, reference, balance, line_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (account_id, line_hash) DO NOTHING`,
        [imp.id, account.id, l.line_date, l.amount, l.currency, l.description, l.counterparty, l.reference, l.balance, hashes[i]]
      );
      added += r.rowCount;
    }
    await client.query("UPDATE bank_imports SET rows_new = $2, rows_duplicate = $3 WHERE id = $1", [imp.id, added, statement.lines.length - added]);
    await client.query("COMMIT");
    const recon = await reconcile({ accountId: account.id, from: statement.lines.reduce((m, l) => (l.line_date < m ? l.line_date : m), "9999-12-31"), to: statement.lines.reduce((m, l) => (l.line_date > m ? l.line_date : m), "0000-01-01") });
    res.status(201).json({ import_id: imp.id, new_lines: added, duplicate_lines: statement.lines.length - added, skipped: statement.skipped.length, ...recon.counts });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
});

// The lines of an account (or all accounts) in a period with their reconciliation state, computed from the current ledger.
async function reconcile({ accountId = null, from = null, to = null, statuses = null }) {
  const params = [];
  const where = [];
  if (accountId) where.push(`l.account_id = $${params.push(Number(accountId))}`);
  if (from) where.push(`l.line_date >= $${params.push(from)}`);
  if (to) where.push(`l.line_date <= $${params.push(to)}`);
  if (statuses) where.push(`l.status = ANY($${params.push(statuses)})`);
  const { rows: lines } = await pool.query(
    `SELECT l.id, l.account_id, a.name AS account, l.line_date::text AS date, l.amount::float8 AS amount, l.currency, l.description, l.counterparty, l.reference, l.balance::float8 AS balance,
            l.status, l.entry_id, l.decided_at, l.import_id
     FROM bank_statement_lines l JOIN cash_accounts a ON a.id = l.account_id
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY l.line_date DESC, l.id DESC`,
    params
  );
  const matchedBy = new Map();
  const open = lines.filter((l) => l.status === "open");
  const accounts = [...new Set(open.map((l) => l.account_id))];
  for (const acc of accounts) {
    const mine = open.filter((l) => l.account_id === acc);
    const lo = mine.reduce((m, l) => (l.date < m ? l.date : m), "9999-12-31");
    const hi = mine.reduce((m, l) => (l.date > m ? l.date : m), "0000-01-01");
    // ±3 days either side of the statement lines; the rows already taken by 'added' lines are not offered again
    const { rows: entries } = await pool.query(
      `SELECT id, entry_date::text AS date, amount::float8 AS amount, currency FROM cash_entries
       WHERE account_id = $1 AND entry_date BETWEEN ($2::date - 3) AND ($3::date + 3) AND id <> ALL($4::int[])`,
      [acc, lo, hi, lines.filter((l) => l.entry_id).map((l) => l.entry_id)]
    );
    for (const [lineId, entryId] of matchLines(mine, entries)) matchedBy.set(lineId, entryId);
  }
  const out = lines.map((l) => ({ ...l, matched_entry_id: matchedBy.get(l.id) ?? null, state: l.status === "open" ? (matchedBy.has(l.id) ? "matched" : "unmatched") : l.status }));
  const counts = { matched: 0, unmatched: 0, added: 0, ignored: 0 };
  for (const l of out) counts[l.state]++;
  return { lines: out, counts };
}

bankRouter.get("/lines", async (req, res) => {
  const state = ["matched", "unmatched", "added", "ignored"].includes(req.query.state) ? req.query.state : null;
  const { lines, counts } = await reconcile({
    accountId: req.query.account || null,
    from: DATE.test(String(req.query.from ?? "")) ? req.query.from : null,
    to: DATE.test(String(req.query.to ?? "")) ? req.query.to : null,
  });
  const limit = Math.min(300, Math.max(1, Number.parseInt(req.query.limit, 10) || 100));
  const shown = state ? lines.filter((l) => l.state === state) : lines;
  const { rows: imports } = await pool.query(
    "SELECT i.id, i.file_name, i.rows_in, i.rows_new, i.rows_duplicate, i.created_at, a.name AS account FROM bank_imports i JOIN cash_accounts a ON a.id = i.account_id ORDER BY i.created_at DESC LIMIT 5"
  );
  res.json({ counts, lines: shown.slice(0, limit), total: shown.length, imports });
});

async function loadLine(id) {
  const { rows: [l] } = await pool.query("SELECT * FROM bank_statement_lines WHERE id = $1", [Number(id)]);
  return l ?? null;
}

// A line without a row becomes a manual ledger row (origin 'bank'): the category (and customer / note) is the accountant's choice.
bankRouter.post("/lines/:id/add", edit, async (req, res) => {
  const line = await loadLine(req.params.id);
  if (!line) return res.status(404).json({ error: "Not found" });
  if (line.status !== "open") return res.status(409).json({ error: "This line is already decided" });
  const amount = Number(line.amount);
  const c = await cleanEntry({
    date: line.line_date instanceof Date ? line.line_date.toISOString().slice(0, 10) : String(line.line_date).slice(0, 10),
    direction: amount > 0 ? "in" : "out",
    amount: Math.abs(amount),
    currency: line.currency,
    fx_rate: req.body?.fx_rate,
    account_id: line.account_id,
    category_id: req.body?.category_id,
    erp_customer_id: req.body?.erp_customer_id,
    info: typeof req.body?.info === "string" && req.body.info.trim() ? req.body.info : [line.counterparty, line.description].filter(Boolean).join(" - "),
    ref: line.reference,
  });
  if (c.error) return res.status(400).json({ error: c.error });
  const cols = ["entry_date", "amount", "currency", "fx_rate", "amount_amd", "category_id", "account_id", "erp_customer_id", "ref", "info", "sales_rep"];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: [entry] } = await client.query(
      `INSERT INTO cash_entries (${cols.join(", ")}, origin, created_by) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}, 'bank', $${cols.length + 1}) RETURNING id`,
      [...cols.map((k) => c.value[k]), req.user.id]
    );
    const r = await client.query("UPDATE bank_statement_lines SET status = 'added', entry_id = $2, decided_by = $3, decided_at = now() WHERE id = $1 AND status = 'open'", [line.id, entry.id, req.user.id]);
    if (!r.rowCount) throw Object.assign(new Error("This line is already decided"), { status: 409 });
    await client.query("COMMIT");
    res.status(201).json({ entry_id: entry.id });
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.status) return res.status(err.status).json({ error: err.message });
    throw err;
  } finally {
    client.release();
  }
});

bankRouter.post("/lines/:id/ignore", edit, async (req, res) => {
  const r = await pool.query("UPDATE bank_statement_lines SET status = 'ignored', decided_by = $2, decided_at = now() WHERE id = $1 AND status = 'open'", [Number(req.params.id), req.user.id]);
  if (!r.rowCount) return res.status(409).json({ error: "This line is already decided (or does not exist)" });
  res.json({ ok: true });
});

bankRouter.post("/lines/:id/reopen", edit, async (req, res) => {
  const line = await loadLine(req.params.id);
  if (!line) return res.status(404).json({ error: "Not found" });
  if (line.status !== "ignored") return res.status(409).json({ error: "Only an ignored line can be reopened" });
  await pool.query("UPDATE bank_statement_lines SET status = 'open', decided_by = NULL, decided_at = NULL WHERE id = $1", [line.id]);
  res.json({ ok: true });
});
