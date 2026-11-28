// Cashflow module (owner, 2026-10-23): the Excel Cashflow sheet (table `Cash`) as a ledger in the app.
// This file: reading the sheet from a workbook, normalising its rows, and replacing the Excel-origin part of the ledger.
// Manual rows (origin = 'manual' / 'bank') are never touched by a refresh.
import ExcelJS from "exceljs";
import { pool } from "../db/pool.js";

export const CASH_COLUMNS = ["date", "amount", "currency", "for", "id", "source", "info", "customer_name", "currency_rate", "amount_amd", "sales_rep", "transaction_id"];

const norm = (v) => String(v ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const HEADER_ALIASES = {
  date: ["date"],
  amount: ["amount"],
  currency: ["currency"],
  for: ["for"],
  id: ["id"],
  source: ["source"],
  info: ["info"],
  currency_rate: ["currency rate", "rate"],
  amount_amd: ["amount amd"],
  sales_rep: ["sales rep"],
  transaction_id: ["transactionid", "transaction id"],
};

// A cell value as exceljs gives it: a formula cell is { formula, result }, a date is a Date, rich text has .richText.
function cellValue(cell) {
  let v = cell?.value;
  if (v && typeof v === "object" && !(v instanceof Date)) {
    if ("result" in v) v = v.result;
    else if ("richText" in v) v = v.richText.map((r) => r.text).join("");
    else if ("text" in v) v = v.text;
  }
  if (v && typeof v === "object" && !(v instanceof Date)) return null; // an error cell (#REF! ...)
  return v ?? null;
}

export function ymd(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? ""));
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(String(value ?? "").trim());
  return d ? `${d[3]}-${d[2].padStart(2, "0")}-${d[1].padStart(2, "0")}` : null;
}

const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[\s,]/g, ""));
  return Number.isFinite(n) ? n : null;
};
const text = (v) => {
  const s = String(v ?? "").trim();
  return s || null;
};

// One raw row (keys = CASH_COLUMNS) -> a clean ledger row, or { skip: reason }.
export function normalizeCashRow(raw) {
  const date = ymd(raw.date);
  const amount = num(raw.amount);
  if (!date) return { skip: "no date" };
  if (amount === null) return { skip: "no amount" };
  const currency = String(raw.currency ?? "AMD").trim().toUpperCase() === "USD" ? "USD" : "AMD";
  const rate = num(raw.currency_rate);
  let amountAmd = num(raw.amount_amd);
  // A dollar row with neither an AMD amount nor a rate (plan 0.9): used to count as 0 AMD silently. Now flagged; applyCashLedger fills the
  // nearest known rate, or keeps the row at 0 AMD with fx_missing so the Cashflow screen says how many rows need the accountant's rate.
  const needsRate = amountAmd === null && currency === "USD" && !(rate > 0);
  if (amountAmd === null) amountAmd = currency === "USD" ? (needsRate ? 0 : Math.round(amount * rate)) : amount;
  const category = text(raw.for);
  const idText = text(raw.id);
  const isCustomerId = category && category.toLowerCase() === "oil order" && idText && /^\d+$/.test(idText);
  return {
    date,
    amount,
    currency,
    fx_rate: currency === "USD" ? rate : null,
    amount_amd: Math.round(amountAmd * 100) / 100,
    category,
    account: text(raw.source),
    erp_customer_id: isCustomerId ? idText : null,
    ref: isCustomerId ? null : idText,
    info: text(raw.info),
    sales_rep: text(raw.sales_rep),
    transaction_id: text(raw.transaction_id),
    fx_missing: needsRate,
  };
}

// The rate for a dollar row that has none (plan 0.9): the rate of the dollar row nearest in date in the same sheet (a typed rate, or AMD / USD
// when both amounts are there), else `fallback` (the newest rate the app knows, the same one a manual entry uses: cleanEntry). Fills the rows
// in place; returns { filled, missing }. A row with no rate anywhere stays at 0 AMD with fx_missing = true.
export function fillMissingRates(rows, fallback = null) {
  const known = [];
  for (const r of rows) {
    if (r.currency !== "USD" || r.fx_missing) continue;
    const rate = r.fx_rate > 0 ? r.fx_rate : r.amount ? Math.abs(r.amount_amd / r.amount) : null;
    if (rate > 0 && Number.isFinite(rate)) known.push({ t: Date.parse(r.date), rate });
  }
  let filled = 0;
  let missing = 0;
  for (const r of rows) {
    if (!r.fx_missing) continue;
    const t = Date.parse(r.date);
    let best = null;
    for (const k of known) if (!best || Math.abs(k.t - t) < Math.abs(best.t - t)) best = k;
    const rate = best ? Math.round(best.rate * 10000) / 10000 : fallback > 0 ? fallback : null;
    if (rate) {
      r.fx_rate = rate;
      r.amount_amd = Math.round(r.amount * rate * 100) / 100;
      r.fx_missing = false;
      filled++;
    } else {
      missing++;
    }
  }
  return { filled, missing };
}

// The rows of the `Cashflow` sheet of a workbook buffer. The header row is found by its labels (it moved between workbook versions).
export async function readCashWorkbook(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets.find((s) => norm(s.name) === "cashflow") ?? wb.worksheets.find((s) => norm(s.name) === "cash");
  if (!ws) throw new Error('The workbook has no "Cashflow" sheet');
  let headerRow = null;
  const cols = {};
  for (let r = 1; r <= Math.min(40, ws.rowCount) && !headerRow; r++) {
    const found = {};
    ws.getRow(r).eachCell((cell, c) => {
      const n = norm(cellValue(cell));
      for (const [field, aliases] of Object.entries(HEADER_ALIASES)) if (aliases.includes(n) && found[field] === undefined) found[field] = c;
    });
    if (found.date && found.amount && found.for) {
      headerRow = r;
      Object.assign(cols, found);
    }
  }
  if (!headerRow) throw new Error("Could not find the Cashflow table header (Date, Amount, For ...)");
  const rows = [];
  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const raw = {};
    let any = false;
    for (const [field, c] of Object.entries(cols)) {
      raw[field] = cellValue(row.getCell(c));
      if (raw[field] !== null && raw[field] !== "") any = true;
    }
    if (any) rows.push({ ...raw, excel_row: r });
  }
  return rows;
}

// "Cash YVN", "Office desk", "SM YVN desk" are cash desks (payments2/desks.js); the rest is a bank account unless it says credit.
const guessKind = (name) => (/^cash\b|\bdesk\b|դրամարկղ/i.test(name) ? "cash" : /credit/i.test(name) ? "credit" : "bank");

// Replaces every Excel-origin ledger row with `rawRows` (raw = CASH_COLUMNS keys). Atomic.
// Returns { rows, skipped, usd_rate_filled, usd_no_rate, accounts_added, categories_added }.
// `guard` (the bot's push, erp/erpSyncGuard.js): async ({ incoming, previous }) -> { ok, ... }; when it says no, nothing is changed and
// { refused: <its answer> } is returned.
export async function applyCashLedger(rawRows, { via, userId = null, fileName = null, note = null, guard = null } = {}) {
  const clean = [];
  let skipped = 0;
  for (const raw of rawRows) {
    const n = normalizeCashRow(raw);
    if (n.skip) skipped++;
    else clean.push({ ...n, excel_row: raw.excel_row ?? null });
  }
  if (!clean.length) throw new Error("No usable Cashflow rows");
  if (guard) {
    const { rows: [prev] } = await pool.query("SELECT COUNT(*)::int AS n FROM cash_entries WHERE origin = 'excel'");
    const check = await guard({ incoming: { ledger_rows: clean.length }, previous: { ledger_rows: prev.n } });
    if (!check.ok) return { refused: check };
  }
  let rates = { filled: 0, missing: 0 };
  if (clean.some((r) => r.fx_missing)) {
    const { rows: [last] } = await pool.query("SELECT fx_rate::float8 AS r FROM cash_entries WHERE currency = 'USD' AND fx_rate > 0 AND NOT fx_missing ORDER BY entry_date DESC, id DESC LIMIT 1");
    rates = fillMissingRates(clean, last?.r ?? null);
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // an account renamed in the app keeps its old name as an Excel alias (payments2/desks.js): the sheet still lands on it
    const { rows: accountRows } = await client.query("SELECT id, name, excel_aliases FROM cash_accounts ORDER BY id");
    const accounts = new Map();
    for (const a of accountRows) for (const alias of a.excel_aliases ?? []) accounts.set(alias.toLowerCase(), a.id);
    for (const a of accountRows) accounts.set(a.name.toLowerCase(), a.id);
    const categories = new Map((await client.query("SELECT id, name FROM cash_categories")).rows.map((c) => [c.name.toLowerCase(), c.id]));
    // a renamed or removed category's old Excel name still lands where it was moved (cash_category_aliases, migration 193)
    for (const a of (await client.query("SELECT name, category_id FROM cash_category_aliases")).rows) if (!categories.has(a.name)) categories.set(a.name, a.category_id);
    let accountsAdded = 0;
    let categoriesAdded = 0;
    for (const name of new Set(clean.map((r) => r.account).filter(Boolean))) {
      if (accounts.has(name.toLowerCase())) continue;
      const { rows } = await client.query("INSERT INTO cash_accounts (name, kind) VALUES ($1, $2) RETURNING id", [name, guessKind(name)]);
      accounts.set(name.toLowerCase(), rows[0].id);
      accountsAdded++;
    }
    for (const name of new Set(clean.map((r) => r.category).filter(Boolean))) {
      if (categories.has(name.toLowerCase())) continue;
      // a category the sheet invented: an expense until the owner classifies it
      const { rows } = await client.query("INSERT INTO cash_categories (name, kind) VALUES ($1, 'expense') RETURNING id", [name]);
      categories.set(name.toLowerCase(), rows[0].id);
      categoriesAdded++;
    }
    await client.query("DELETE FROM cash_entries WHERE origin = 'excel'");
    const CHUNK = 1000;
    for (let i = 0; i < clean.length; i += CHUNK) {
      const part = clean.slice(i, i + CHUNK).map((r) => ({
        d: r.date, a: r.amount, c: r.currency, fx: r.fx_rate, aa: r.amount_amd,
        cat: r.category ? categories.get(r.category.toLowerCase()) : null,
        acc: r.account ? accounts.get(r.account.toLowerCase()) : null,
        cu: r.erp_customer_id, rf: r.ref, i: r.info, s: r.sales_rep, t: r.transaction_id, x: r.excel_row, fm: r.fx_missing,
      }));
      await client.query(
        `INSERT INTO cash_entries (entry_date, amount, currency, fx_rate, amount_amd, category_id, account_id, erp_customer_id, ref, info, sales_rep, transaction_id, origin, excel_row, fx_missing)
         SELECT d, a, c, fx, aa, cat, acc, cu, rf, i, s, t, 'excel', x, fm
         FROM jsonb_to_recordset($1::jsonb) AS x(d date, a numeric, c text, fx numeric, aa numeric, cat int, acc int, cu text, rf text, i text, s text, t text, x int, fm boolean)`,
        [JSON.stringify(part)]
      );
    }
    await client.query("INSERT INTO cash_syncs (via, rows_in, rows_skipped, file_name, user_id, note, rows_rate_filled, rows_no_rate) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)", [via, clean.length, skipped, fileName, userId, note, rates.filled, rates.missing]);
    await client.query("COMMIT");
    // the accountant's rows may now match bank lines imported earlier: they teach the category rules (best effort, never fails the refresh)
    import("./bankReconcile.js").then(async (m) => m.learnFromMatches((await m.reconcile({ statuses: ["open"] })).lines)).catch((err) => console.error("Bank category learning failed:", err.message));
    return { rows: clean.length, skipped, usd_rate_filled: rates.filled, usd_no_rate: rates.missing, accounts_added: accountsAdded, categories_added: categoriesAdded };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// A manual ledger row from the form's fields (shared by the entry routes and "add from a bank line"). { error } or { value }.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export async function cleanEntry(b) {
  const err = (m) => ({ error: m });
  if (!DATE_RE.test(String(b.date ?? ""))) return err("Choose the date");
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
  if (!Number.isInteger(accountId)) return err("Choose the account");
  if (!Number.isInteger(categoryId)) return err("Choose the category");
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

