// What counts as a VISIT of a customer -- last visit, visited today / this week, overdue, the visit
// plan's due date, "Visit first", dashboards, the daily summary. Two conditions, both needed:
//   1. within_range: the check-in was made at the customer's pin (a check-in from far away is still
//      saved in the history, but it is not a visit);
//   2. made by a field rep (role sales_manager). A director / admin / CEO dropping by is saved too, but
//      it must not tick the customer off: a visit that was due today stays due today.
// One place so every screen reports the same "last visit" for the same customer.
export const FIELD_REP_ROLE = "sales_manager";

// SQL condition for a checkins row aliased `alias` that counts as a visit.
export function repVisitSql(alias = "ch") {
  return `(${alias}.within_range AND ${alias}.user_id IN (SELECT id FROM users WHERE role = '${FIELD_REP_ROLE}'))`;
}

// Correlated subselects (customers aliased `c`) for the check-ins that were saved by a rep but did not
// count because they were made far from the customer's pin -- so "Not visited yet" can say why.
export const FAR_VISITS_COLUMNS_SQL = `
  (SELECT count(*)::int FROM checkins fv WHERE fv.customer_id = c.id AND NOT fv.within_range
     AND fv.user_id IN (SELECT id FROM users WHERE role = '${FIELD_REP_ROLE}')) AS far_visits,
  (SELECT max(fv.timestamp) FROM checkins fv WHERE fv.customer_id = c.id AND NOT fv.within_range
     AND fv.user_id IN (SELECT id FROM users WHERE role = '${FIELD_REP_ROLE}')) AS far_visit_last_at`;
