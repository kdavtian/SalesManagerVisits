// The books track: which customer payments the Excel Cash sheet already holds (owner, 2026-11-02). Runs after every Excel refresh (job
// "payments-v2", every 10 minutes): links that point at an Excel row that is no longer there are undone, then open payments are matched by
// the one rule (matching.js). The Excel rows come from cash_entries (the whole Cash table, refreshed from the workbook), income rows with a
// customer: their account ("Source") and Excel row number are kept on the link, so "why is this booked" always has an answer.
import { pool } from "../../db/pool.js";
import { planMatches, MATCH_DAYS } from "./matching.js";
import { addEvent, getCutover } from "./service.js";

const roundAmd = (n) => Math.round(Number(n) || 0);
const ymd = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

/** The Excel income rows of customers since the cutover (minus the matching window), each with its stable key. */
export async function loadExcelRows(db, cutover) {
  const { rows } = await db.query(
    `SELECT e.id, e.erp_customer_id AS erp, e.entry_date, e.amount_amd, e.account_id, a.name AS account_name, a.kind AS account_kind, e.excel_row
     FROM cash_entries e
     JOIN cash_categories c ON c.id = e.category_id AND c.kind = 'income'
     LEFT JOIN cash_accounts a ON a.id = e.account_id
     WHERE e.amount_amd > 0 AND e.erp_customer_id IS NOT NULL AND btrim(e.erp_customer_id) <> '' AND e.entry_date >= $1::date - $2::int
     ORDER BY e.erp_customer_id, e.entry_date, round(e.amount_amd), e.account_id NULLS FIRST, e.excel_row NULLS LAST, e.id`,
    [cutover, MATCH_DAYS]
  );
  // customer | date | amount | account | n-th identical row: the same row keeps the same key when the sheet is refreshed
  const seen = new Map();
  return rows.map((r) => {
    const base = `${String(r.erp).trim()}|${ymd(r.entry_date)}|${roundAmd(r.amount_amd)}|${r.account_id ?? 0}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { key: `${base}|${n}`, erp: String(r.erp).trim(), day: ymd(r.entry_date), amount: roundAmd(r.amount_amd), accountName: r.account_name, accountKind: r.account_kind, excelRow: r.excel_row };
  });
}

const describe = (rows) =>
  rows.map((r) => `Excel ${r.day.slice(8, 10)}.${r.day.slice(5, 7)} · ${r.amount.toLocaleString("en-US")} AMD${r.accountName ? ` · ${r.accountName}` : ""}${r.excelRow ? ` · row ${r.excelRow}` : ""}`).join(" + ");

/**
 * One pass of the books track. Returns { reopened, matched, noErp, excelRows }.
 * Nothing is undone when the Excel holds no rows at all (an empty or half-loaded sheet must not reopen every payment).
 */
export async function runBooks(db = pool) {
  const cutover = await getCutover(db);
  const excel = await loadExcelRows(db, cutover);
  const byKey = new Map(excel.map((r) => [r.key, r]));
  const stats = { reopened: 0, matched: 0, noErp: 0, excelRows: excel.length };

  // 1. links to Excel rows that are gone: the payment is open again
  const { rows: links } = await db.query(
    `SELECT l.payment_id, l.entry_key, l.amount_amd FROM payment_book_links l JOIN customer_payments p ON p.id = l.payment_id WHERE p.voided_at IS NULL`
  );
  if (excel.length) {
    const gone = [...new Set(links.filter((l) => !byKey.has(l.entry_key)).map((l) => l.payment_id))];
    for (const id of gone) {
      await db.query("DELETE FROM payment_book_links WHERE payment_id = $1", [id]);
      await db.query("UPDATE customer_payments SET books_state = 'open', books_note = $2, updated_at = now() WHERE id = $1", [id, "The Excel row it was booked by is no longer in the sheet"]);
      await addEvent(db, id, null, "books_reopened", { reason: "excel_row_gone" });
      stats.reopened += 1;
    }
  }

  // 2. what is still free of each row
  const { rows: used } = await db.query(
    `SELECT l.entry_key, SUM(l.amount_amd)::numeric AS used FROM payment_book_links l JOIN customer_payments p ON p.id = l.payment_id
     WHERE p.voided_at IS NULL GROUP BY l.entry_key`
  );
  const usedBy = new Map(used.map((u) => [u.entry_key, roundAmd(u.used)]));
  const entries = excel.map((r) => ({ key: r.key, erp: r.erp, day: r.day, free: r.amount - (usedBy.get(r.key) ?? 0) })).filter((e) => e.free > 0);

  // 3. open payments
  const { rows: open } = await db.query(
    `SELECT id, erp_customer_id_snapshot AS erp, to_char(pay_day, 'YYYY-MM-DD') AS day, amount_amd, books_note FROM customer_payments
     WHERE books_state = 'open' AND voided_at IS NULL AND pay_day >= $1`,
    [cutover]
  );
  const NO_ERP = "The customer has no ERP id: link it to the Excel row by hand";
  for (const p of open.filter((x) => !x.erp)) {
    stats.noErp += 1;
    if (p.books_note !== NO_ERP) await db.query("UPDATE customer_payments SET books_note = $2 WHERE id = $1", [p.id, NO_ERP]);
  }
  const plan = planMatches(
    open.filter((p) => p.erp).map((p) => ({ id: p.id, erp: String(p.erp).trim(), day: p.day, amount: roundAmd(p.amount_amd) })),
    entries
  );
  for (const m of plan) {
    const rows = m.links.map((l) => ({ ...byKey.get(l.key), part: l.amount }));
    for (const r of rows) {
      await db.query(
        `INSERT INTO payment_book_links (payment_id, entry_key, entry_date, entry_amount_amd, account_name, excel_row, amount_amd, how)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'auto')`,
        [m.paymentId, r.key, r.day, r.amount, r.accountName ?? null, r.excelRow ?? null, r.part]
      );
    }
    const note = describe(rows);
    await db.query("UPDATE customer_payments SET books_state = 'matched', books_note = $2, updated_at = now() WHERE id = $1 AND books_state = 'open'", [m.paymentId, note]);
    await addEvent(db, m.paymentId, null, "booked_auto", { rows: rows.map((r) => ({ key: r.key, amount: r.part, account: r.accountName, excel_row: r.excelRow })) });
    stats.matched += 1;
  }
  return stats;
}

/** Excel income rows on CASH desks that no payment in the app accounts for: money booked that nobody recorded (a control that did not exist). */
export async function unrecordedCashRows(db = pool) {
  const cutover = await getCutover(db);
  const excel = (await loadExcelRows(db, cutover)).filter((r) => r.day >= ymd(cutover) && r.accountKind === "cash");
  const { rows: used } = await db.query(
    `SELECT l.entry_key, SUM(l.amount_amd)::numeric AS used FROM payment_book_links l JOIN customer_payments p ON p.id = l.payment_id
     WHERE p.voided_at IS NULL GROUP BY l.entry_key`
  );
  const usedBy = new Map(used.map((u) => [u.entry_key, roundAmd(u.used)]));
  return excel.map((r) => ({ ...r, free: r.amount - (usedBy.get(r.key) ?? 0) })).filter((r) => r.free > 0);
}
