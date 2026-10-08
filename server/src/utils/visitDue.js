// When is a customer's next visit planned, and is it overdue?
//
// Cadence (customers.visit_frequency_days, default 7) says how long a visit
// "lasts": the earliest the next one is needed is last visit + N days. If the
// customer is on a recurring Route Plans weekday, the planned date is the
// first such weekday on/after that point -- a route day that falls inside the
// N days after a visit is skipped (visited Tue 22 Sep, route day Fri, N = 7:
// Fri 25 Sep is skipped, planned = Fri 2 Oct). The customer stays "visited"
// until that planned date passes; only then is it overdue.
import { yerevanToday } from "./yerevanDate.js";

const YEREVAN_OFFSET_MS = 4 * 60 * 60 * 1000;

function addDays(dateOnly, n) {
  const d = new Date(`${dateOnly}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Weekdays (0-6, Sunday = 0) of the active recurring rules that cover this
// customer, by id or by region/subregion area.
export function ruleWeekdaysFor(customer, rules) {
  const days = new Set();
  for (const r of rules) {
    // customer_id_set: optional precomputed Set (see customers.js) so a long list
    // doesn't scan every rule's id array once per customer.
    const byId = r.customer_id_set ? r.customer_id_set.has(customer.id) : (r.customer_ids ?? []).includes(customer.id);
    const byArea =
      Array.isArray(r.areas) &&
      r.areas.some((a) => a?.region && a.region === customer.region && (!a.subregion || a.subregion === customer.subregion));
    if (byId || byArea) days.add(r.day_of_week);
  }
  return days;
}

export function computeVisitDue({ lastVisitAt, frequencyDays, ruleWeekdays, today = yerevanToday() }) {
  if (!lastVisitAt) return { never_visited: true, last_visit_date: null, earliest_next: null, planned_date: null, overdue: true, overdue_days: 0 };
  const freq = Number(frequencyDays) > 0 ? Number(frequencyDays) : 7;
  const lastDate = new Date(new Date(lastVisitAt).getTime() + YEREVAN_OFFSET_MS).toISOString().slice(0, 10);
  const earliest = addDays(lastDate, freq);
  let planned = earliest;
  if (ruleWeekdays?.size) {
    for (let i = 0; i < 7; i++) {
      const d = addDays(earliest, i);
      if (ruleWeekdays.has(new Date(`${d}T00:00:00Z`).getUTCDay())) {
        planned = d;
        break;
      }
    }
  }
  const overdue = today > planned;
  const overdueDays = overdue ? Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${planned}T00:00:00Z`)) / 86400000) : 0;
  return { never_visited: false, last_visit_date: lastDate, earliest_next: earliest, planned_date: planned, overdue, overdue_days: overdueDays };
}
