// "Is this customer's debt overdue?" -- measured from the OLDEST UNPAID INVOICE, not from the
// last payment. A customer who paid long ago but only ordered 11 days ago (so the whole debt is
// that one recent order) is within a 45-day term; "days since last payment" (or "no payment
// found" for a customer who never paid yet) called that overdue and created collection tasks
// too early (owner, 2026-10-10, customer 10365).
//
// Payments are assumed to settle the oldest invoices first (FIFO): walk the customer's Excel
// orders from the newest back until they add up to the current debt; the order where that
// happens is the oldest one still (partly) unpaid. When the order history does not cover the
// debt (an opening balance from before the ERP, or no order lines synced) the age is unknown
// and the old rule applies: days since the last payment (never paid = overdue).
//
// Usage: add DEBT_AGE_LATERAL after `erp_customer_data erp` in the FROM clause, then
// overdueDebtSql("$n::date") in the WHERE clause (customers is aliased `c`).
const COVER_TOLERANCE_AMD = 1000; // rounding between the Excel debt and the sum of order lines

export const DEBT_AGE_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT CASE WHEN COALESCE(MAX(x.running), 0) >= erp.debt_amd - ${COVER_TOLERANCE_AMD}
                THEN MIN(x.d) FILTER (WHERE x.running - x.total < erp.debt_amd - ${COVER_TOLERANCE_AMD}) END AS oldest_unpaid
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
