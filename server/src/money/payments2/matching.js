// The one matching rule between customer payments and the Excel Cash rows (owner, 2026-11-02, answer 5). Pure: no database, so every case is
// unit-tested (test/payments2Matching.test.js); books.js feeds it and saves what it decides.
//
// A payment is booked by Excel rows of the SAME customer (ERP id), dated within MATCH_DAYS of the payment, whose amounts add up exactly:
//   1. one row = one payment (the usual case), closest date first;
//   2. one row = several payments (the accountant booked a shop's day in one row), up to MAX_GROUP payments;
//   3. several rows = one payment (one payment booked in parts), up to MAX_GROUP rows.
// Every Excel row books at most its own amount (`free` = what is still unused of it). Nothing is ever matched across customers or on
// "nearly the same" amounts: anything the rule cannot place stays open for the accountant to link by hand.
export const MATCH_DAYS = 5;
export const MAX_GROUP = 4;
const MAX_CANDIDATES = 12; // a customer with more open payments than this in one window is left for the accountant (no slow search)

const DAY_MS = 86400000;
export const dayGap = (a, b) => Math.round(Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY_MS);

// Subsets of `items` (already sorted by preference) of size 2..MAX_GROUP whose `value(item)` adds up to `target`: the first one found in
// preference order, or null.
function findSubset(items, target, value) {
  const pool = items.slice(0, MAX_CANDIDATES);
  const pick = [];
  const walk = (start, left) => {
    if (left === 0) return pick.length >= 2;
    if (pick.length === MAX_GROUP || left < 0) return false;
    for (let i = start; i < pool.length; i++) {
      const v = value(pool[i]);
      if (v > left) continue;
      pick.push(pool[i]);
      if (walk(i + 1, left - v)) return true;
      pick.pop();
    }
    return false;
  };
  return walk(0, target) ? [...pick] : null;
}

/**
 * payments: [{ id, erp, day: "YYYY-MM-DD", amount }]  (open payments; amount whole AMD)
 * entries:  [{ key, erp, day, free }]                    (Excel income rows with what is still unused of them, whole AMD)
 * Returns [{ paymentId, links: [{ key, amount }] }] -- each payment booked in full, never part of one.
 */
export function planMatches(payments, entries) {
  const free = new Map(entries.map((e) => [e.key, e.free]));
  const done = new Set();
  const out = [];
  const book = (paymentId, links) => {
    done.add(paymentId);
    for (const l of links) free.set(l.key, free.get(l.key) - l.amount);
    out.push({ paymentId, links });
  };
  const near = (p, e) => p.erp === e.erp && dayGap(p.day, e.day) <= MATCH_DAYS;

  // 1. one row = one payment: every possible pair, closest dates first, then the older payment
  const pairs = [];
  for (const p of payments) for (const e of entries) if (near(p, e) && e.free === p.amount) pairs.push({ p, e, gap: dayGap(p.day, e.day) });
  pairs.sort((a, b) => a.gap - b.gap || a.p.day.localeCompare(b.p.day) || a.p.id - b.p.id || a.e.day.localeCompare(b.e.day));
  for (const { p, e } of pairs) {
    if (done.has(p.id) || free.get(e.key) !== p.amount) continue;
    book(p.id, [{ key: e.key, amount: p.amount }]);
  }

  // 2. one row = several payments
  for (const e of [...entries].sort((a, b) => a.day.localeCompare(b.day))) {
    const left = free.get(e.key);
    if (left <= 0) continue;
    const candidates = payments
      .filter((p) => !done.has(p.id) && near(p, e) && p.amount < left)
      .sort((a, b) => dayGap(a.day, e.day) - dayGap(b.day, e.day) || a.id - b.id);
    const group = findSubset(candidates, left, (p) => p.amount);
    if (group) for (const p of group) book(p.id, [{ key: e.key, amount: p.amount }]);
  }

  // 3. several rows = one payment (each row used in full)
  for (const p of [...payments].sort((a, b) => a.day.localeCompare(b.day) || a.id - b.id)) {
    if (done.has(p.id)) continue;
    const candidates = entries
      .filter((e) => near(p, e) && free.get(e.key) > 0 && free.get(e.key) === e.free && e.free < p.amount)
      .sort((a, b) => dayGap(a.day, p.day) - dayGap(b.day, p.day) || a.day.localeCompare(b.day));
    const group = findSubset(candidates, p.amount, (e) => free.get(e.key));
    if (group) book(p.id, group.map((e) => ({ key: e.key, amount: free.get(e.key) })));
  }
  return out;
}
