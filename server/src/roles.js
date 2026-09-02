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

// Who can reassign a customer's region/subregion/sales channel/manager
// without going through the edit-request approval flow -- a director is
// senior enough to fix a mis-assigned customer on the spot.
export function canReassignCustomers(role) {
  return role === "admin" || role === "sales_director" || role === "ceo";
}

// Linking a customer to its ERP record is treated separately from the rest
// of the edit-request flow -- it's a lookup/link action, not a factual
// change someone should have to review. Accountant/CEO/admin can link any
// customer (accountant is the one who actually reconciles against ERP data
// day to day); a sales manager or director can only link customers they
// personally created, so they can't relabel someone else's book.
export function canAssignErpCustomerId(role, customerCreatedBy, userId) {
  if (role === "admin" || role === "ceo" || role === "accountant") return true;
  if (role === "sales_manager" || role === "sales_director") return customerCreatedBy === userId;
  return false;
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

// --- Team Performance -------------------------------------------------
// admin is treated as a CEO-equivalent superset throughout: full authority,
// same as the spec's "CEO" role, so a technical admin account can always
// unblock a stuck workflow.

export function isPerfCeo(role) {
  return role === "admin" || role === "ceo";
}

// Who may create/edit a DRAFT plan for a channel owned by the given
// owner_role (see sales_channels.owner_role -- 'sales_director' for most
// channels, 'accountant' for KF/CAS). CEO can touch any channel directly.
export function canEditChannelPlan(role, ownerRole) {
  if (isPerfCeo(role)) return true;
  if (role === "sales_director") return ownerRole === "sales_director";
  if (role === "accountant") return ownerRole === "accountant";
  return false;
}

// Who may approve/reject a PENDING_APPROVAL plan. A Sales Director can
// never approve their own submission -- only CEO or Accountant review it;
// Accountant plans (KF/CAS) go to CEO only, since Accountant can't approve
// their own submission either.
export function canReviewPlan(role, submittedByRole) {
  if (isPerfCeo(role)) return true;
  if (role === "accountant") return submittedByRole === "sales_director";
  return false;
}

// Only CEO (or admin) may create a new revision of an already-approved
// plan -- this is the one mandatory-immutability rule in the whole
// workflow (see perf_plans.supersedes_plan_id).
export function canReviseApprovedPlan(role) {
  return isPerfCeo(role);
}

// Who sees company-wide Team Performance data (management dashboard, all
// channels) vs only their own channel's numbers.
export function seesAllPerformance(role) {
  return role === "admin" || role === "ceo" || role === "sales_director" || role === "accountant";
}

// Closing a month freezes its final numbers into an immutable snapshot --
// a finance-close action, so CEO or Accountant (the two roles that also
// reconcile against the Excel books), not a Sales Director.
export function canCloseMonth(role) {
  return isPerfCeo(role) || role === "accountant";
}
