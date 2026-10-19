// Ask KAD sends the question and the data to an outside AI company, so names never go with it (owner's
// decision, 2026-10-18: "fully anonymised"). Customers become CUST-<ERP id> and staff REP-<user id>: the
// codes are stable, so a follow-up question keeps meaning the same customer, and the answer is turned
// back into real names here on the server before the admin sees it.
//
// Three one-way gates:
//   maskText   the admin's question and the earlier turns: every known customer / staff name -> code
//   the tools  (tools.js) never select a name, phone, TIN, address or free text, only codes and numbers
//   unmaskText the model's answer: codes -> real names
// Armenian names are inflected ("Արտակին"), so a name written with a different ending may slip through
// the question mask; the tools never carry names, so nothing else can leak, and the admin sees the
// "masked N names" count with every answer.
import { pool } from "../db/pool.js";

const MIN_NEEDLE = 4; // shorter names ("Avto") would mask ordinary words
const CODE_RE = /\b(CUST|REP)-([A-Za-z0-9]+)\b/g;

export const customerCode = (erpId, id) => (erpId ? `CUST-${String(erpId).trim()}` : `CUST-A${id}`);
export const repCode = (userId) => `REP-${userId}`;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Everything needed to mask and unmask, loaded once per request.
export async function loadNameBook(db = pool) {
  const [customers, users, brands] = await Promise.all([
    db.query(
      `SELECT c.id, c.erp_customer_id, c.name, c.legal_name, e.customer_name AS erp_name
         FROM customers c LEFT JOIN erp_customer_data e ON e.erp_customer_id = c.erp_customer_id`
    ),
    db.query("SELECT id, name, name_hy FROM users"),
    // A customer called like a brand ("Castrol") must not turn every "Castrol" in a question into a code.
    db.query("SELECT DISTINCT lower(brand) AS b FROM products WHERE brand IS NOT NULL UNION SELECT DISTINCT lower(family) FROM products WHERE family IS NOT NULL"),
  ]);
  const protectedWords = new Set(brands.rows.map((r) => r.b));
  const display = new Map(); // code -> name shown to the admin
  const needles = new Map(); // lowercase name -> code
  const addNeedle = (name, code) => {
    const n = String(name ?? "").trim().toLowerCase();
    if (n.length >= MIN_NEEDLE && !/^[0-9\s-]+$/.test(n) && !protectedWords.has(n) && !needles.has(n)) needles.set(n, code);
  };
  for (const c of customers.rows) {
    const code = customerCode(c.erp_customer_id, c.id);
    display.set(code, c.name || c.erp_name || c.legal_name || code);
    for (const n of [c.name, c.erp_name, c.legal_name]) addNeedle(n, code);
  }
  // ERP-only customers (not in the customers table yet) still need a readable name in the answer.
  const { rows: erpOnly } = await db.query(
    "SELECT erp_customer_id, customer_name FROM erp_customer_data WHERE customer_name IS NOT NULL"
  );
  for (const e of erpOnly) {
    const code = customerCode(e.erp_customer_id);
    if (!display.has(code)) display.set(code, e.customer_name);
    addNeedle(e.customer_name, code);
  }
  for (const u of users.rows) {
    const code = repCode(u.id);
    display.set(code, u.name_hy || u.name || code);
    addNeedle(u.name, code);
    addNeedle(u.name_hy, code);
  }
  // Longest first, so "Nor Nork Yuxman ket NG CARS" is replaced before a shorter name inside it.
  const ordered = [...needles.entries()].sort((a, b) => b[0].length - a[0].length);
  return { display, needles: ordered };
}

// Returns { text, count }: the text with every known name replaced by its code.
export function maskText(text, book) {
  let out = String(text ?? "");
  let count = 0;
  for (const [needle, code] of book.needles) {
    if (!out.toLowerCase().includes(needle)) continue;
    out = out.replace(new RegExp(escapeRe(needle), "giu"), () => {
      count += 1;
      return code;
    });
  }
  return { text: out, count };
}

// Codes in the model's answer -> real names. An unknown code stays as it is (never invented).
export function unmaskText(text, book) {
  return String(text ?? "").replace(CODE_RE, (whole, kind, id) => book.display.get(`${kind}-${id}`) ?? whole);
}
