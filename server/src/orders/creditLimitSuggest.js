// Suggested credit limits for customers that have NONE (a customer without a limit is never checked: unlimited credit).
// Suggestion = what the customer normally owes at any time if they pay on time, with a safety margin:
//   average monthly purchases of the last 6 months (Excel order lines) x payment term / 30 x 1.25,
//   rounded UP to 100,000 AMD, never below 300,000. Cash customers count a 7 day term.
// Customers whose current debt already exceeds the suggestion are flagged (over_now): the limit would put every new
// order of theirs into the director's approval queue straight away -- management decides, they start unticked.
export const LIMIT_FLOOR_AMD = 300_000;
export const LIMIT_SAFETY = 1.25;
const ROUND_TO = 100_000;

export function suggestLimit({ monthlyAvg, termDays, cash }) {
  const days = cash ? 7 : Number(termDays) > 0 ? Number(termDays) : 45;
  const raw = Math.max(0, Number(monthlyAvg) || 0) * (days / 30) * LIMIT_SAFETY;
  return Math.max(LIMIT_FLOOR_AMD, Math.ceil(raw / ROUND_TO) * ROUND_TO);
}

export async function creditLimitSuggestions(db) {
  const { rows } = await db.query(
    `SELECT c.id AS customer_id, c.name, c.sales_channel, c.payment_method, COALESCE(c.credit_term_days, 45) AS term_days,
            COALESCE(erp.debt_amd, 0)::float8 AS debt_amd, u.name AS rep_name,
            COALESCE((SELECT SUM(l.revenue_amd) FROM erp_order_lines l
                       WHERE l.erp_customer_id = c.erp_customer_id AND l.order_date >= (now() AT TIME ZONE 'Asia/Yerevan')::date - 180), 0)::float8 / 6 AS monthly_avg
     FROM customers c
     LEFT JOIN erp_customer_data erp ON erp.erp_customer_id = c.erp_customer_id
     LEFT JOIN users u ON u.id = c.assigned_manager_id
     WHERE c.credit_limit_amd IS NULL AND c.erp_customer_id IS NOT NULL AND c.erp_customer_id <> '10000'
       AND NOT COALESCE(c.checkin_for_all, false)
     ORDER BY COALESCE(erp.debt_amd, 0) DESC, c.name`
  );
  return rows.map((r) => {
    const suggested = suggestLimit({ monthlyAvg: r.monthly_avg, termDays: r.term_days, cash: r.payment_method === "cash" });
    return {
      customer_id: r.customer_id,
      name: r.name,
      sales_channel: r.sales_channel,
      rep_name: r.rep_name,
      term_days: Number(r.term_days),
      monthly_avg_amd: Math.round(r.monthly_avg),
      debt_amd: Math.round(r.debt_amd),
      suggested_amd: suggested,
      has_history: r.monthly_avg > 0,
      over_now: r.debt_amd > suggested,
    };
  });
}
