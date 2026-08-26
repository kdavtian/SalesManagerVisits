export const ROLES = [
  "admin",
  "ceo",
  "sales_director",
  "sales_manager",
  "warehouse_manager",
  "delivery_manager",
  "accountant",
];

// Field reps (sales managers) only see their own data; every other role
// sees everyone's (admins can also delete/edit directly, the others cannot).
export function seesAllActivity(role) {
  return role !== "sales_manager";
}

// Who can pull the financial CSV exports (payments, debt, orders) --
// narrower than seesAllActivity, which also includes warehouse/delivery
// staff who have no reconciliation reason to need this data.
export function seesFinancialExports(role) {
  return role === "admin" || role === "ceo" || role === "sales_director" || role === "accountant";
}

export function canDeleteOrEditDirectly(role) {
  return role === "admin";
}

// Per spec: admin, sales director, and CEO see the live team-location map.
export function canViewTeamLocations(role) {
  return role === "admin" || role === "sales_director" || role === "ceo";
}

// Who can plan a *different* rep's route (day-of or recurring), not just
// their own. A plain sales_manager can only ever plan for themselves.
export function canPlanForOthers(role) {
  return role === "admin" || role === "sales_director" || role === "ceo";
}

// Who reviews a freshly-submitted order -- confirms it, rejects it, or
// edits its items/discount before it moves into fulfillment. Distinct from
// FULFILLMENT_ROLES in routes/orders.js, which owns packed/delivered.
export function canConfirmOrders(role) {
  return role === "admin" || role === "sales_director" || role === "ceo";
}

// Every field-facing role broadcasts its own foreground location while the
// app is open, so the office-based roles (admin, CEO) have something to
// look at; those two don't visit customers themselves, so they don't
// broadcast.
export function broadcastsLocation(role) {
  return role !== "admin" && role !== "ceo";
}
