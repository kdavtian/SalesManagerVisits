export const state = {
  user: null,
};

const USER_CACHE_KEY = "fieldvisits_cached_user";

export function setUser(user) {
  state.user = user;
  // Best-effort cache of the logged-in user's own profile -- read once at
  // boot (see app.js's init()) so the very first paint doesn't have to wait
  // on a full /api/me round trip before it knows whether to show the login
  // screen or the app shell, and with which role's nav/visibility. Always
  // provisional: the real /api/me response that follows on every boot is
  // what actually decides anything security-sensitive -- the server
  // re-checks role on every request regardless of what's cached here.
  try {
    if (user) localStorage.setItem(USER_CACHE_KEY, JSON.stringify(user));
    else localStorage.removeItem(USER_CACHE_KEY);
  } catch {
    // localStorage unavailable (private browsing, storage pressure) --
    // just means the next cold boot can't optimistically render before
    // /api/me resolves, not a reason to fail the actual sign-in/out.
  }
}

export function loadCachedUser() {
  try {
    const raw = localStorage.getItem(USER_CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function isAdmin() {
  return state.user?.role === "admin";
}

// Mirrors canManageProducts in the server's roles.js -- UI gate only, the
// server independently re-checks on every product/pricing mutation.
export function canManageProducts() {
  const role = state.user?.role;
  return role === "admin" || role === "ceo" || role === "accountant";
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

// Mirrors canAssignErpCustomerId in the server's roles.js -- UI gate only,
// the server independently re-checks ownership on every PATCH.
export function canAssignErpCustomerId(customer) {
  const role = state.user?.role;
  if (role === "admin" || role === "ceo" || role === "accountant") return true;
  if (role === "sales_manager" || role === "sales_director") return customer.created_by === state.user.id;
  return false;
}

// Mirrors canEditOwnSalesChannel in the server's roles.js -- UI gate only,
// the server independently re-checks ownership on every PATCH.
export function canEditOwnSalesChannel(customer) {
  if (canReassignCustomers()) return true;
  return state.user?.role === "sales_manager" && customer.created_by === state.user.id;
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

// Mirrors canReopenPlanAsDraft in server/src/roles.js -- who sees the
// "Move to draft" unblock action on a pending_approval/approved plan.
export function canReopenPerfPlanAsDraft() {
  return isPerfCeo() || state.user?.role === "sales_director" || state.user?.role === "accountant";
}
