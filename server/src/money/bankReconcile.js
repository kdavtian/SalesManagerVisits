// Bank statement lines against the Cashflow ledger (owner, 2026-11-11): the accountant already records every transaction in the Excel, so a statement
// is first CHECKED against it: which lines have their row (matched), which have none (missing in Excel), and which Excel rows of the account have
// no bank line (in Excel only). Matching is computed from the current ledger every time (the Excel refresh replaces its rows, so ids cannot be
// remembered). Every match also teaches the category rules (bankCategories.js).
import { pool } from "../db/pool.js";
import { matchLines } from "./bankStatement.js";
import { learn, suggestionContext, suggestCategory } from "./bankCategories.js";

const MATCH_DAYS = 3;

// The lines of an account (or all accounts) in a period with their reconciliation state, computed from the current ledger.
// Matched lines carry their Cashflow row's category / info; unmatched ones carry the category the app suggests.
export async function reconcile({ accountId = null, from = null, to = null, statuses = null } = {}) {
  const params = [];
  const where = [];
  if (accountId) where.push(`l.account_id = $${params.push(Number(accountId))}`);
  if (from) where.push(`l.line_date >= $${params.push(from)}`);
  if (to) where.push(`l.line_date <= $${params.push(to)}`);
  if (statuses) where.push(`l.status = ANY($${params.push(statuses)})`);
  const { rows: lines } = await pool.query(
    `SELECT l.id, l.account_id, a.name AS account, l.line_date::text AS date, l.amount::float8 AS amount, l.currency, l.description, l.counterparty, l.reference, l.balance::float8 AS balance,
            l.type_code, l.counterparty_account, l.learned_at,
            l.status, l.entry_id, l.decided_at, l.import_id
     FROM bank_statement_lines l JOIN cash_accounts a ON a.id = l.account_id
     ${where.length ? `WHERE ${where.join(" AND ") || "TRUE"}` : ""} ORDER BY l.line_date DESC, l.id DESC`,
    params
  );
  const matchedBy = new Map();
  const candidates = new Map(); // line id -> how many ledger rows could be its row (same amount and currency inside the window)
  const open = lines.filter((l) => l.status === "open");
  const accounts = [...new Set(open.map((l) => l.account_id))];
  for (const acc of accounts) {
    const mine = open.filter((l) => l.account_id === acc);
    const lo = mine.reduce((m, l) => (l.date < m ? l.date : m), "9999-12-31");
    const hi = mine.reduce((m, l) => (l.date > m ? l.date : m), "0000-01-01");
    // ±3 days either side of the statement lines; the rows already taken by 'added' lines are not offered again
    const { rows: entries } = await pool.query(
      `SELECT id, entry_date::text AS date, amount::float8 AS amount, currency FROM cash_entries
       WHERE account_id = $1 AND entry_date BETWEEN ($2::date - ${MATCH_DAYS}) AND ($3::date + ${MATCH_DAYS}) AND id <> ALL($4::int[])`,
      [acc, lo, hi, lines.filter((l) => l.entry_id).map((l) => l.entry_id)]
    );
    for (const [lineId, entryId] of matchLines(mine, entries, { days: MATCH_DAYS })) matchedBy.set(lineId, entryId);
    const day = (d) => Math.round(new Date(`${d}T00:00:00Z`).getTime() / 86400000);
    for (const l of mine) {
      candidates.set(l.id, entries.filter((e) => e.currency === l.currency && Math.abs(e.amount - l.amount) < 0.005 && Math.abs(day(e.date) - day(l.date)) <= MATCH_DAYS).length);
    }
  }
  // what the ledger says about the rows the lines matched (the accountant's category and note)
  const matchedIds = [...new Set(matchedBy.values())];
  const { rows: entryRows } = matchedIds.length
    ? await pool.query(
        `SELECT e.id, e.category_id, c.name AS category, e.info, e.erp_customer_id, e.entry_date::text AS date FROM cash_entries e LEFT JOIN cash_categories c ON c.id = e.category_id WHERE e.id = ANY($1)`,
        [matchedIds]
      )
    : { rows: [] };
  const entryById = new Map(entryRows.map((e) => [e.id, e]));
  const ctx = open.some((l) => !matchedBy.has(l.id)) ? await suggestionContext() : null;
  const out = lines.map((l) => {
    const entryId = matchedBy.get(l.id) ?? null;
    const entry = entryId ? entryById.get(entryId) : null;
    const state = l.status === "open" ? (entryId ? "matched" : "unmatched") : l.status;
    // a match is only a LESSON when it is unambiguous: one candidate row, at most a day apart, and no other open line of the same amount around it
    const twins = open.filter((o) => o.account_id === l.account_id && o.id !== l.id && o.currency === l.currency && Math.abs(o.amount - l.amount) < 0.005 && Math.abs(Date.parse(o.date) - Date.parse(l.date)) <= MATCH_DAYS * 86400000).length;
    const base = { ...l, matched_entry_id: entryId, state, sure_match: Boolean(entryId) && candidates.get(l.id) === 1 && twins === 0 };
    if (entry) {
      const gap = Math.abs(Date.parse(entry.date) - Date.parse(l.date)) / 86400000;
      return { ...base, sure_match: base.sure_match && gap <= 1, matched_category_id: entry.category_id, matched_category: entry.category, matched_info: entry.info, matched_date: entry.date };
    }
    if (state === "unmatched" && ctx) {
      const s = suggestCategory(l, ctx);
      if (s) return { ...base, suggested_category_id: s.category_id, suggested_confidence: s.confidence, suggested_reason: s.reason };
    }
    return base;
  });
  const counts = { matched: 0, unmatched: 0, added: 0, ignored: 0 };
  for (const l of out) counts[l.state]++;
  return { lines: out, counts };
}

// Lines that found their Cashflow row teach the rules, once each. Only SURE matches teach (one candidate row, at most a day apart, no twin line of the
// same amount): a wrong match would plant a wrong rule for good. The line is claimed first (learned_at) so two runs at once never count it twice.
// Runs after an import and after an Excel refresh -- never from a read.
export async function learnFromMatches(lines) {
  let taught = 0;
  for (const l of lines) {
    if (l.state !== "matched" || l.learned_at || !l.matched_category_id || !l.sure_match) continue;
    const claim = await pool.query("UPDATE bank_statement_lines SET learned_at = now() WHERE id = $1 AND learned_at IS NULL RETURNING id", [l.id]);
    if (!claim.rowCount) continue;
    if (await learn(pool, l, l.matched_category_id)) taught++;
  }
  return taught;
}

// The two-way check of an account over the period its imported lines cover (or the period given):
//   missing_in_excel  statement lines with no Cashflow row (the accountant forgot them, or booked another amount / date);
//   excel_only        Cashflow rows of the account in that period with no bank line (booked by mistake, a cash row on a bank account, or the
//                     statement does not cover them);
//   near              pairs that look like one transaction booked slightly differently (same amount, 4-10 days apart) -- offered to the accountant to look at.
export async function checkAgainstLedger({ accountId, from = null, to = null }) {
  const { lines } = await reconcile({ accountId, from, to });
  const live = lines.filter((l) => l.state === "matched" || l.state === "unmatched" || l.state === "added");
  if (!live.length) return { period: null, counts: { lines: 0, matched: 0, missing_in_excel: 0, excel_only: 0, near: 0 }, missing_in_excel: [], excel_only: [], near: [] };
  const lo = live.reduce((m, l) => (l.date < m ? l.date : m), "9999-12-31");
  const hi = live.reduce((m, l) => (l.date > m ? l.date : m), "0000-01-01");
  const used = new Set(lines.map((l) => l.matched_entry_id ?? l.entry_id).filter(Boolean));
  // "in Cashflow, not in the statement" only means something where a statement actually covers the days: each import's own period (a December file
  // imported without November must not turn every November row into a finding)
  const { rows: covered } = await pool.query(
    `SELECT COALESCE((i.statement_meta->>'period_from')::date, min(l.line_date)) AS from_day, COALESCE((i.statement_meta->>'period_to')::date, max(l.line_date)) AS to_day
     FROM bank_statement_lines l JOIN bank_imports i ON i.id = l.import_id WHERE l.account_id = $1 GROUP BY i.id, i.statement_meta`,
    [accountId]
  );
  const { rows: entries } = await pool.query(
    `SELECT e.id, e.entry_date::text AS date, e.amount::float8 AS amount, e.currency, e.info, e.ref, e.origin, c.name AS category, c.kind AS category_kind
            , EXISTS (SELECT 1 FROM unnest($4::date[], $5::date[]) AS r(f, t) WHERE e.entry_date BETWEEN r.f AND r.t) AS covered
     FROM cash_entries e LEFT JOIN cash_categories c ON c.id = e.category_id
     WHERE e.account_id = $1 AND e.entry_date BETWEEN ($2::date - 10) AND ($3::date + 10)
     ORDER BY e.entry_date, e.id`,
    [accountId, lo, hi, covered.map((c) => c.from_day), covered.map((c) => c.to_day)]
  );
  // near misses may sit a few days outside the statement's period (booked late); "Excel only" is only for rows INSIDE the days a statement covers
  const unused = entries.filter((e) => !used.has(e.id));
  const missing = live.filter((l) => l.state === "unmatched");
  const dayNumber = (d) => Math.round(new Date(`${d}T00:00:00Z`).getTime() / 86400000);
  const near = [];
  const takenEntries = new Set();
  for (const l of missing) {
    const twin = unused.find((e) => !takenEntries.has(e.id) && e.currency === l.currency && Math.abs(e.amount - l.amount) < 0.005 && Math.abs(dayNumber(e.date) - dayNumber(l.date)) <= 10);
    if (twin) {
      takenEntries.add(twin.id);
      near.push({ line: l, entry: twin, days: dayNumber(twin.date) - dayNumber(l.date) });
    }
  }
  const nearLines = new Set(near.map((n) => n.line.id));
  return {
    period: { from: lo, to: hi },
    counts: {
      lines: live.length,
      matched: live.filter((l) => l.state === "matched" || l.state === "added").length,
      missing_in_excel: missing.filter((l) => !nearLines.has(l.id)).length,
      excel_only: unused.filter((e) => e.covered && !takenEntries.has(e.id)).length,
      near: near.length,
    },
    missing_in_excel: missing.filter((l) => !nearLines.has(l.id)),
    excel_only: unused.filter((e) => e.covered && !takenEntries.has(e.id)),
    near,
  };
}
