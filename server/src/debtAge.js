// "Is this customer's debt overdue?" -- measured from the OLDEST UNPAID INVOICE, not from the
// last payment. A customer who paid long ago but only ordered 11 days ago (so the whole debt is
// that one recent order) is within a 45-day term; "days since last payment" (or "no payment
// found" for a customer who never paid yet) called that overdue and created collection tasks
// too early (owner, 2026-10-10, customer 10365).
//
// Payments are assumed to settle the oldest invoices first (FIFO): walk the customer's Excel
// orders from the newest back until they add up to the current debt; the order where that
// happens is the oldest one still (partly) unpaid. When the order history does not cover the
// debt, the rest is the opening balance (Balance0, dated 2025-05-01, so long overdue). With NO order
// lines at all the age is unknown and the old rule applies: days since the last payment (never
// paid = overdue).
//
// Usage: add DEBT_AGE_LATERAL after `erp_customer_data erp` in the FROM clause, then
// overdueDebtSql("$n::date") in the WHERE clause (customers is aliased `c`).
const COVER_TOLERANCE_AMD = 1000; // rounding between the Excel debt and the sum of order lines
export const ERP_OPENING_DATE = "2025-05-01"; // the electronic system started in May 2025: debt older than the order history is the opening balance (Balance0)

export const DEBT_AGE_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT CASE WHEN MAX(x.running) IS NULL THEN NULL
                WHEN MAX(x.running) >= erp.debt_amd - ${COVER_TOLERANCE_AMD}
                THEN MIN(x.d) FILTER (WHERE x.running - x.total < erp.debt_amd - ${COVER_TOLERANCE_AMD})
                ELSE DATE '${ERP_OPENING_DATE}' END AS oldest_unpaid
    FROM (
      SELECT o.d, o.total, SUM(o.total) OVER (ORDER BY o.d DESC, o.order_id DESC) AS running
      FROM (SELECT order_id, MIN(order_date) AS d, SUM(COALESCE(revenue_amd, 0)) AS total
            FROM erp_order_lines WHERE erp_customer_id = erp.erp_customer_id GROUP BY order_id) o
    ) x
  ) due ON true`;

export function overdueDebtSql(todayExpr) {
  return `(erp.debt_amd > 0 AND CASE
      WHEN due.oldest_unpaid IS NOT NULL THEN ${todayExpr} - due.oldest_unpaid > COALESCE(c.credit_term_days, 45)
      ELSE (erp.days_since_payment IS NULL OR erp.days_since_payment > COALESCE(c.credit_term_days, 45))
    END)`;
}

// Days the oldest unpaid invoice has been open, or NULL when unknown.
export const debtAgeDaysSql = (todayExpr) => `(${todayExpr} - due.oldest_unpaid)`;

// ---------------------------------------------------------------------------------------------
// Which ORDERS are still unpaid (FIFO), for the customer's order list, the Sales page and the
// debt chip on the customer card. The Excel debt is the truth; because payments clear the oldest
// invoices first, what is still owed is made of the NEWEST orders: walk them newest -> oldest
// until they add up to the debt. An order is unpaid for min(total, debt - newer orders). If the
// orders do not reach the debt, the rest is the opening balance (Balance0, the paper era before
// the electronic system started in May 2025) and counts as the oldest debt of all.
// ---------------------------------------------------------------------------------------------
const AMOUNT_EPSILON = 1; // AMD

const dayNumber = (dateStr) => Math.floor(Date.UTC(+dateStr.slice(0, 4), +dateStr.slice(5, 7) - 1, +dateStr.slice(8, 10)) / 86400000);

// Days past the end of the credit term: > 0 overdue by that many days, <= 0 not yet due
// (-12 = due in 12 days).
export function dueDays(dateStr, today, termDays) {
  return dayNumber(today) - dayNumber(String(dateStr).slice(0, 10)) - termDays;
}

// erpIds -> { orders: Map("erpId|orderId|date" -> { unpaid_amd, total_amd }), opening: Map(erpId -> { balance0_amd, unpaid_amd }) }
export async function loadUnpaidOrders(db, erpIds) {
  const ids = [...new Set((erpIds ?? []).filter(Boolean))];
  const result = { orders: new Map(), opening: new Map() };
  if (!ids.length) return result;
  const { rows } = await db.query(
    `WITH ord AS (
       SELECT erp_customer_id, order_id, order_date, SUM(COALESCE(revenue_amd, 0)) AS total
       FROM erp_order_lines WHERE erp_customer_id = ANY($1) GROUP BY erp_customer_id, order_id, order_date
     ), cum AS (
       SELECT o.*, SUM(o.total) OVER (PARTITION BY o.erp_customer_id ORDER BY o.order_date DESC, o.order_id DESC) AS running FROM ord o
     )
     SELECT cum.erp_customer_id, cum.order_id, to_char(cum.order_date, 'YYYY-MM-DD') AS order_date, cum.total,
            GREATEST(0, LEAST(cum.total, erp.debt_amd - (cum.running - cum.total))) AS unpaid_amd
     FROM cum JOIN erp_customer_data erp ON erp.erp_customer_id = cum.erp_customer_id
     WHERE erp.debt_amd > 0 AND cum.running - cum.total < erp.debt_amd - ${AMOUNT_EPSILON}`,
    [ids]
  );
  for (const r of rows) result.orders.set(`${r.erp_customer_id}|${r.order_id}|${r.order_date}`, { unpaid_amd: Number(r.unpaid_amd), total_amd: Number(r.total) });
  const { rows: open } = await db.query(
    `SELECT erp.erp_customer_id, erp.balance0_amd, GREATEST(erp.debt_amd - COALESCE(t.total, 0), 0) AS unpaid_amd
     FROM erp_customer_data erp
     LEFT JOIN (SELECT erp_customer_id, SUM(COALESCE(revenue_amd, 0)) AS total FROM erp_order_lines WHERE erp_customer_id = ANY($1) GROUP BY erp_customer_id) t
       ON t.erp_customer_id = erp.erp_customer_id
     WHERE erp.erp_customer_id = ANY($1) AND erp.debt_amd > 0`,
    [ids]
  );
  for (const r of open) {
    if (Number(r.unpaid_amd) > AMOUNT_EPSILON) result.opening.set(r.erp_customer_id, { balance0_amd: r.balance0_amd == null ? null : Number(r.balance0_amd), unpaid_amd: Number(r.unpaid_amd) });
  }
  return result;
}

// What the customer card needs: the opening balance, how much of the debt is overdue and how
// long the oldest unpaid invoice has been past (or until) its due date.
export function summarizeDebt({ unpaid, opening, today, termDays }) {
  const entries = [];
  for (const [key, v] of unpaid.orders) {
    const [, , date] = key.split("|");
    entries.push({ amount: v.unpaid_amd, due_days: dueDays(date, today, termDays) });
  }
  if (opening) entries.push({ amount: opening.unpaid_amd, due_days: dueDays(ERP_OPENING_DATE, today, termDays) });
  if (!entries.length) return { unpaid_orders: 0, oldest_due_days: null, overdue_amd: 0, opening_unpaid_amd: 0, opening_due_days: null };
  return {
    unpaid_orders: unpaid.orders.size,
    oldest_due_days: Math.max(...entries.map((e) => e.due_days)),
    overdue_amd: Math.round(entries.filter((e) => e.due_days > 0).reduce((s, e) => s + e.amount, 0)),
    opening_unpaid_amd: opening ? Math.round(opening.unpaid_amd) : 0,
    opening_due_days: opening ? dueDays(ERP_OPENING_DATE, today, termDays) : null,
  };
}
