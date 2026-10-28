import * as R from "./shared/roles.js";

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

// The logged-in person's permissions, read from the rules the server enforces (js/shared/roles.js): UI gates only, the server re-checks
// every request.
const role = () => state.user?.role;
export const canManageProducts = () => R.canManageProducts(role());
// gold price, landing and net cost (the API strips them for everyone else)
export const seesProductCosts = () => R.seesProductCosts(role());
// landing / net cost printed into a pricelist PDF
export const canPrintCostColumns = () => R.canPrintCostColumns(role());
// a sales manager sees only their own data, every other role everyone's
export const seesAllActivity = () => R.seesAllActivity(role());
export const canEditDirectly = () => R.canDeleteOrEditDirectly(role());
export const canViewTeamLocations = () => R.canViewTeamLocations(role());
// who drives a route
export const canDeliverOrders = () => R.canDeliverOrders(role());
export const broadcastsLocation = () => R.broadcastsLocation(role());
export const seesFinancialExports = () => R.seesFinancialExports(role());
export const canPlanForOthers = () => R.canPlanForOthers(role());
// everyone who can plan for others, plus the accountant (read-only)
export const canViewAllRoutePlans = () => R.canViewAllRoutePlans(role());
// who gives tasks to others; everybody receives and completes them
export const canCreateTasks = () => R.canCreateTasks(role());
// the accountant / financial director sends REQUESTS (Խնդրանք) to the sales director: a task under another name (owner, 2026-10-27)
export const sendsRequests = () => R.sendsRequests(role());
export const canReassignCustomers = () => R.canReassignCustomers(role());
export const canAssignErpCustomerId = (customer) => R.canAssignErpCustomerId(role(), customer.created_by, state.user?.id);
export const canEditOwnSalesChannel = (customer) => R.canEditOwnSalesChannel(role(), customer.created_by, state.user?.id);

// Team Performance: which screen renders (the server enforces the same rules)
export const isPerfCeo = () => R.isPerfCeo(role());
export const seesAllPerformance = () => R.seesAllPerformance(role());
export const canEditChannelPlan = (ownerRole) => R.canEditChannelPlan(role(), ownerRole);
export const canReviewPerfPlan = (submittedByRole) => R.canReviewPlan(role(), submittedByRole);
export const canCloseMonth = () => R.canCloseMonth(role());
// the "Move to draft" unblock action on a pending_approval / approved plan
export const canReopenPerfPlanAsDraft = () => R.canReopenPlanAsDraft(role());

// Special pricelist of a Gold customer (individually negotiated prices): the roles that review orders (PUT /customers/:id/product-prices).
export const canSetCustomerPrices = () => R.canConfirmOrders(role());
