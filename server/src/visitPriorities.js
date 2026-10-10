// "Visit first": which of a rep's customers deserve the next visit most -- ranked by the money
// at stake. Score from
//  - overdue debt (the unpaid invoices past their credit term, FIFO, see debtAge.js): 30 + up to 20
//    more as the overdue amount grows (1,000,000 AMD and more = the full 20)
//  - visit overdue against the customer's cadence: up to 30 (2 points a day)
//  - gone quiet: no order for longer than 1.5x their usual rhythm: 20
//  - never visited: 15 (+10 for a gold/silver customer)
//  - customer value: up to 10 more, by the average monthly purchases of the last 6 months
//    (2,000,000 AMD a month and more = 10), added only when there already is a reason to go
// Customers already visited today and no-visit channels (KF/CAS/CVO/PCO/OEM) are left out.
import { pool } from "./db/pool.js";
import { NOT_NO_VISIT_CHANNEL_SQL } from "./routes/customers.js";
import { yerevanToday } from "./utils/yerevanDate.js";
import { DEBT_AGE_LATERAL, overdueDebtSql, debtAgeDaysSql, loadUnpaidOrders, summarizeDebt } from "./debtAge.js";

export async function visitPriorities(userId, limit = 8, now = new Date()) {
  const today = yerevanToday(now);
  const { rows } = await pool.query(
    `SELECT c.id, c.name, c.erp_customer_id, c.customer_tier, c.visit_frequency_days, COALESCE(c.credit_term_days, 45) AS credit_term_days,
            (SELECT max(ch.timestamp) FROM checkins ch WHERE ch.customer_id = c.id AND ch.within_range) AS last_visit,
            EXISTS (SELECT 1 FROM checkins ch WHERE ch.customer_id = c.id AND ch.within_range
                    AND (ch.timestamp AT TIME ZONE 'Asia/Yerevan')::date = $2::date) AS visited_today,
            erp.debt_amd, ${overdueDebtSql("$2::date")} AS debt_overdue,
            COALESCE(${debtAgeDaysSql("$2::date")}, erp.days_since_payment) AS debt_days
     FROM customers c LEFT JOIN erp_customer_data erp ON erp.erp_customer_id = c.erp_customer_id ${DEBT_AGE_LATERAL}
     WHERE c.assigned_manager_id = $1 AND ${NOT_NO_VISIT_CHANNEL_SQL}`,
    [userId, today]
  );
  const erpIds = rows.map((r) => r.erp_customer_id).filter(Boolean);
  const rhythm = new Map();
  const monthly = new Map(); // erp id -> average purchases per month over the last 6 months (AMD)
  const overdueAmounts = new Map(); // erp id -> overdue part of the debt (AMD)
  if (erpIds.length) {
    const { rows: sales } = await pool.query(
      `SELECT erp_customer_id, SUM(COALESCE(revenue_amd, 0)) / 6 AS per_month FROM erp_order_lines
       WHERE erp_customer_id = ANY($1) AND order_date >= $2::date - 183 GROUP BY erp_customer_id`,
      [erpIds, today]
    );
    for (const s of sales) monthly.set(s.erp_customer_id, Number(s.per_month));
    const owing = rows.filter((r) => r.erp_customer_id && Number(r.debt_amd) > 0 && r.debt_overdue);
    if (owing.length) {
      const unpaid = await loadUnpaidOrders(pool, owing.map((r) => r.erp_customer_id));
      // loadUnpaidOrders returns every customer's unpaid orders in one map ("erpId|orderId|date"): split per customer.
      const perCustomer = new Map();
      for (const [key, v] of unpaid.orders) {
        const erpId = key.split("|")[0];
        if (!perCustomer.has(erpId)) perCustomer.set(erpId, new Map());
        perCustomer.get(erpId).set(key, v);
      }
      for (const r of owing) {
        const sum = summarizeDebt({ unpaid: { orders: perCustomer.get(r.erp_customer_id) ?? new Map() }, opening: unpaid.opening.get(r.erp_customer_id), today, termDays: r.credit_term_days });
        overdueAmounts.set(r.erp_customer_id, sum.overdue_amd);
      }
    }
    const { rows: stats } = await pool.query(
      `WITH days AS (
         SELECT erp_customer_id, order_date FROM erp_order_lines
         WHERE erp_customer_id = ANY($1) AND order_date >= $2::date - 400 GROUP BY erp_customer_id, order_date
       ), gaps AS (
         SELECT erp_customer_id, order_date, order_date - LAG(order_date) OVER (PARTITION BY erp_customer_id ORDER BY order_date) AS gap FROM days
       )
       SELECT erp_customer_id, MAX(order_date) AS last_order, COUNT(gap)::int AS n_gaps,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY gap) AS median_gap
       FROM gaps WHERE gap IS NOT NULL GROUP BY erp_customer_id`,
      [erpIds, today]
    );
    for (const s of stats) rhythm.set(s.erp_customer_id, s);
  }
  const todayMs = new Date(`${today}T00:00:00Z`).getTime();
  const out = [];
  for (const r of rows) {
    if (r.visited_today) continue;
    const reasons = [];
    let score = 0;
    let money = 0; // what a visit can bring in (AMD), shown on the card
    let moneyKind = "debt"; // "debt" = overdue amount to collect, "monthly" = a usual month of orders
    const debt = Number(r.debt_amd) || 0;
    if (debt > 0 && r.debt_overdue) {
      const overdue = overdueAmounts.get(r.erp_customer_id) || Math.round(debt);
      score += 30 + Math.min(20, Math.round(overdue / 50000));
      money += overdue;
      reasons.push({ type: "debt", amount: overdue, days: r.debt_days });
    }
    const lastVisitMs = r.last_visit ? new Date(r.last_visit).getTime() : null;
    const daysSinceVisit = lastVisitMs === null ? null : Math.floor((now.getTime() - lastVisitMs) / 86400000);
    const overdueDays = daysSinceVisit === null ? null : daysSinceVisit - r.visit_frequency_days;
    if (daysSinceVisit === null) {
      score += 15 + (["gold", "silver"].includes(r.customer_tier) ? 10 : 0);
      reasons.push({ type: "never_visited" });
    } else if (overdueDays > 0) {
      score += Math.min(30, overdueDays * 2);
      reasons.push({ type: "visit_overdue", days: overdueDays });
    }
    const st = rhythm.get(r.erp_customer_id);
    if (st && st.n_gaps >= 3 && st.median_gap >= 7 && st.median_gap <= 90) {
      const sinceOrder = Math.round((todayMs - new Date(`${String(st.last_order.toISOString?.().slice(0, 10) ?? st.last_order)}T00:00:00Z`).getTime()) / 86400000);
      if (sinceOrder > Math.max(st.median_gap * 1.5, st.median_gap + 7) && sinceOrder <= 365) {
        score += 20;
        reasons.push({ type: "dormant", days: sinceOrder, usual: Math.round(st.median_gap) });
      }
    }
    if (score > 0) {
      const perMonth = monthly.get(r.erp_customer_id) || 0;
      score += Math.min(10, Math.round(perMonth / 200000));
      if (!money && perMonth > 0) {
        money = Math.round(perMonth); // a usual month of orders is what a visit can win back
        moneyKind = "monthly";
      }
      out.push({ customer_id: r.id, name: r.name, score, money_amd: Math.round(money), money_kind: moneyKind, reasons });
    }
  }
  out.sort((a, b) => b.score - a.score || b.money_amd - a.money_amd || a.name.localeCompare(b.name));
  return out.slice(0, limit);
}
