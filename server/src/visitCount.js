// What counts as a VISIT of a customer -- last visit, visited today / this week, overdue, the visit
// plan's due date, "Visit first", dashboards, the daily summary: a check-in made by a FIELD REP (role
// sales_manager). A director / admin / CEO dropping by is saved too, but it must not tick the customer
// off: a visit that was due today stays due today.
// Distance is NOT part of it (owner, 2026-10-13): a rep's check-in always counts, because the Check-in
// allowance setting (settings.js, 300 m by default) already refuses a rep's check-in made too far away.
// One place so every screen reports the same "last visit" for the same customer.
export const FIELD_REP_ROLE = "sales_manager";

// SQL condition for a checkins row aliased `alias` that counts as a visit.
export function repVisitSql(alias = "ch") {
  return `${alias}.user_id IN (SELECT id FROM users WHERE role = '${FIELD_REP_ROLE}')`;
}
