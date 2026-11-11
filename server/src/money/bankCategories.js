// Which Cashflow category does a bank statement line belong to? (owner, 2026-11-11: "learn from the Excel the accountant already filled")
// Two sources, in this order:
//   1. what the app learned: a statement line that found its Cashflow row (the accountant's own category) counts for its payer / the other side's
//      account / its kind of operation; the next line of the same payer is suggested that category;
//   2. a few built-in rules that need no history (a transfer between our own accounts, a bank fee, a salary).
// A suggestion is only a suggestion: the accountant confirms it (or the account is switched to automatic recording after the cutover).
import { pool } from "../db/pool.js";
import { payerKey } from "./payments2/payerMatch.js";

const dir = (amount) => (amount >= 0 ? "in" : "out");

// The keys a line is remembered by, most specific first. Money in and money out of the same payer are different facts.
export function lineKeys(line) {
  const d = dir(Number(line.amount));
  const keys = [];
  const cp = payerKey(line.counterparty);
  if (cp) keys.push(`cp:${cp}|${d}`);
  if (line.counterparty_account) keys.push(`acc:${String(line.counterparty_account).replace(/\s+/g, "")}|${d}`);
  if (line.type_code && !cp) keys.push(`type:${String(line.type_code).toUpperCase()}|${d}`);
  return keys;
}

// A line matched its ledger row: that row's category counts for every key of the line.
export async function learn(db, line, categoryId) {
  if (!categoryId) return 0;
  const keys = lineKeys(line);
  for (const key of keys) {
    await db.query(
      `INSERT INTO bank_category_rules (key, category_id, hits) VALUES ($1, $2, 1)
       ON CONFLICT (key, category_id) DO UPDATE SET hits = bank_category_rules.hits + 1, updated_at = now()`,
      [key, categoryId]
    );
  }
  return keys.length;
}

const SALARY = /աշխատավարձ|արձակուրդային|վերջնահաշվարկ|salary|payroll|зарплат|отпускн/i;
const FEE = /commission|գանձում|կոմիսիա|комисс|statement fee|քաղվածքների վճար/i;

// ctx: { rules: Map(key -> [{ category_id, hits }]), categories: Map(lower name -> id), ownNumbers: Set }
export async function suggestionContext(db = pool) {
  const [{ rows: rules }, { rows: cats }, { rows: own }] = await Promise.all([
    db.query("SELECT key, category_id, hits FROM bank_category_rules ORDER BY hits DESC, updated_at DESC"),
    db.query("SELECT id, name FROM cash_categories WHERE active IS NOT FALSE"),
    db.query("SELECT account_number FROM cash_accounts WHERE account_number IS NOT NULL"),
  ]);
  const byKey = new Map();
  for (const r of rules) byKey.set(r.key, [...(byKey.get(r.key) ?? []), r]);
  return { rules: byKey, categories: new Map(cats.map((c) => [c.name.toLowerCase(), c.id])), ownNumbers: new Set(own.map((o) => o.account_number)) };
}

// -> { category_id, confidence: 'high' | 'low', reason } or null
export function suggestCategory(line, ctx) {
  const amount = Number(line.amount);
  for (const key of lineKeys(line)) {
    const found = ctx.rules.get(key);
    if (!found?.length) continue;
    const total = found.reduce((a, r) => a + r.hits, 0);
    const best = found[0];
    return { category_id: best.category_id, confidence: best.hits >= 2 && best.hits / total >= 0.7 ? "high" : "low", reason: `learned:${key.split(":")[0]}` };
  }
  const pick = (...names) => names.map((n) => ctx.categories.get(n.toLowerCase())).find(Boolean) ?? null;
  const text = `${line.description ?? ""} ${line.counterparty ?? ""}`;
  // a transfer between two of OUR accounts is neither income nor expense
  if (line.counterparty_account && ctx.ownNumbers.has(String(line.counterparty_account).replace(/\s+/g, ""))) {
    const id = pick("Transfer");
    if (id) return { category_id: id, confidence: "high", reason: "own_account" };
  }
  if (String(line.type_code ?? "").toUpperCase() === "FEE" || FEE.test(text)) {
    const id = pick("Bank fees", "Bank charges", "Other");
    if (id) return { category_id: id, confidence: "low", reason: "fee" };
  }
  if (amount < 0 && SALARY.test(text)) {
    const id = pick("Salary");
    if (id) return { category_id: id, confidence: "high", reason: "salary" };
  }
  return null;
}
