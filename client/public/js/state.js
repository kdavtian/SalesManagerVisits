export const state = {
  user: null,
};

export function setUser(user) {
  state.user = user;
}

export function isAdmin() {
  return state.user?.role === "admin";
}

// Sales managers only see their own data; every other role sees
// everyone's — mirrors server/src/roles.js.
export function seesAllActivity() {
  return state.user?.role !== "sales_manager";
}

export function canEditDirectly() {
  return state.user?.role === "admin";
}

export function canViewTeamLocations() {
  return (
    state.user?.role === "admin" || state.user?.role === "sales_director" || state.user?.role === "ceo"
  );
}

export function broadcastsLocation() {
  return state.user?.role !== "admin" && state.user?.role !== "ceo";
}

export function seesFinancialExports() {
  return (
    state.user?.role === "admin" ||
    state.user?.role === "ceo" ||
    state.user?.role === "sales_director" ||
    state.user?.role === "accountant"
  );
}

export function canPlanForOthers() {
  return (
    state.user?.role === "admin" || state.user?.role === "sales_director" || state.user?.role === "ceo"
  );
}

// Mirrors canReassignCustomers in the server's roles.js.
export function canReassignCustomers() {
  return (
    state.user?.role === "admin" || state.user?.role === "sales_director" || state.user?.role === "ceo"
  );
}

// --- Team Performance -- mirrors server/src/roles.js exactly. The server
// enforces all of this independently; these are UI-only gates so the right
// screen renders in the first place, not a security boundary.

export function isPerfCeo() {
  return state.user?.role === "admin" || state.user?.role === "ceo";
}

export function seesAllPerformance() {
  return (
    state.user?.role === "admin" ||
    state.user?.role === "ceo" ||
    state.user?.role === "sales_director" ||
    state.user?.role === "accountant"
  );
}

export function canEditChannelPlan(ownerRole) {
  if (isPerfCeo()) return true;
  if (state.user?.role === "sales_director") return ownerRole === "sales_director";
  if (state.user?.role === "accountant") return ownerRole === "accountant";
  return false;
}

export function canReviewPerfPlan(submittedByRole) {
  if (isPerfCeo()) return true;
  if (state.user?.role === "accountant") return submittedByRole === "sales_director";
  return false;
}

export function canCloseMonth() {
  return isPerfCeo() || state.user?.role === "accountant";
}
