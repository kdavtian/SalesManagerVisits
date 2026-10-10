// "Visit first": which of a rep's customers deserve the next visit most. Score from
//  - overdue debt (Excel debt > 0 and its oldest unpaid invoice older than the credit term, see debtAge.js): 40
//  - visit overdue against the customer's cadence: up to 30 (2 points a day)
//  - gone quiet: no order for longer than 1.5x their usual rhythm: 20
// Customers already visited today and no-visit channels (KF/CAS/CVO/PCO/OEM) are left out.
import { pool } from "./db/pool.js";
import { NOT_NO_VISIT_CHANNEL_SQL } from "./routes/customers.js";
import { yerevanToday } from "./utils/yerevanDate.js";
import { DEBT_AGE_LATERAL, overdueDebtSql, debtAgeDaysSql } from "./debtAge.js";

export async function visitPriorities(userId, limit = 8, now = new Date()) {
  const today = yerevanToday(now);
  const { rows } = await pool.query(
    `SELECT c.id, c.name, c.erp_customer_id, c.visit_frequency_days, COALESCE(c.credit_term_days, 45) AS credit_term_days,
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
  if (erpIds.length) {
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
    const debt = Number(r.debt_amd) || 0;
    if (debt > 0 && r.debt_overdue) {
      score += 40;
      reasons.push({ type: "debt", amount: Math.round(debt), days: r.debt_days });
    }
    const lastVisitMs = r.last_visit ? new Date(r.last_visit).getTime() : null;
    const daysSinceVisit = lastVisitMs === null ? null : Math.floor((now.getTime() - lastVisitMs) / 86400000);
    const overdueDays = daysSinceVisit === null ? null : daysSinceVisit - r.visit_frequency_days;
    if (daysSinceVisit === null) {
      score += 15;
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
    if (score > 0) out.push({ customer_id: r.id, name: r.name, score, reasons });
  }
  out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return out.slice(0, limit);
}
