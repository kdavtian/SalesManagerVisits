import { APP_VERSION } from "./version.js";
import { t } from "./i18n.js";
import { patchCachedCustomer, removeCachedCustomer, dropCachedCustomerLists } from "./listCache.js";

// The bottom-nav tabs (Dashboard/Activity/Customers/Orders) each re-fetch
// their list/summary data from scratch on every visit, showing a "Loading"
// placeholder until it resolves -- reported live as "loading every time"
// switching tabs on an iPhone, where cellular round-trips to these
// endpoints can run a couple of seconds each. A short-lived cache for just
// these list/summary GETs means a tab revisited within GET_CACHE_TTL_MS
// resolves from memory: since that happens on the microtask queue rather
// than a real network round trip, the browser never gets a paint
// opportunity between the view clearing to "Loading" and it filling back
// in with content, so the flash disappears for that revisit. Any
// non-GET request (the user actually changing something) clears the whole
// cache, so a check-in, order, or payment the user just submitted is never
// hidden behind stale cached data -- correctness always wins over the
// cache. Deliberately an allowlist of exact base paths (not "every GET"):
// endpoints this app polls for live data (team locations on the map,
// badge counts) need to stay genuinely live, not just "fresh within 20s".
const GET_CACHE_TTL_MS = 20000;
const GET_TIMEOUT_MS = 30000;
const CACHEABLE_BASE_PATHS = new Set(["/dashboard/summary", "/dashboard/trends", "/settings", "/customers", "/checkins", "/orders", "/products"]);
const getCache = new Map();

// Touch-down prefetch (see prefetch.js): the detail GET a tap is about to
// need is started when the finger lands, and the real request a moment later
// takes over that same in-flight promise. Single use and short-lived (a tap
// follows within a second or not at all), so nothing here can show stale
// data the way a general response cache could.
const PREFETCH_TTL_MS = 8000;
const prefetched = new Map();

export function prefetchGet(path) {
  const hit = prefetched.get(path);
  if (hit && hit.expires > Date.now()) return;
  const promise = doRequest(path, {});
  promise.catch(() => prefetched.delete(path));
  prefetched.set(path, { expires: Date.now() + PREFETCH_TTL_MS, promise });
}

// Two parts of one screen asking for the same GET at the same moment (the Home tab asked for its open tasks and the sync status twice) share
// one round trip. Only requests that are in flight at the same time are shared -- nothing is kept after the answer arrives.
const inflightGets = new Map();
function sharedGet(path, options) {
  const hit = inflightGets.get(path);
  if (hit) return hit;
  const promise = doRequest(path, options);
  inflightGets.set(path, promise);
  const done = () => inflightGets.get(path) === promise && inflightGets.delete(path);
  promise.then(done, done);
  return promise;
}

async function request(path, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  if (method !== "GET") {
    getCache.clear();
    prefetched.clear();
    inflightGets.clear(); // a GET sent after a change must not share an answer that left before it
    // Screens keeping their own copies (listCache.js, the customer card) drop answers that left before this change.
    window.dispatchEvent(new Event("fv:data-changed"));
    return doRequest(path, options);
  }
  // { fresh: true }: a screen that must show what is true NOW (the Orders list other people keep changing) skips both
  // short-lived caches below.
  if (options.fresh) return sharedGet(path, {});
  const hit = prefetched.get(path);
  if (hit) {
    prefetched.delete(path);
    if (hit.expires > Date.now()) return hit.promise;
  }
  if (CACHEABLE_BASE_PATHS.has(path.split("?")[0])) {
    const cached = getCache.get(path);
    if (cached && cached.expires > Date.now()) return cached.promise;
    const promise = sharedGet(path, options);
    getCache.set(path, { expires: Date.now() + GET_CACHE_TTL_MS, promise });
    promise.catch(() => getCache.delete(path));
    return promise;
  }
  return sharedGet(path, options);
}

// Double-submit-cookie CSRF token (see server/src/middleware/csrf.js) --
// the server sets this as a plain (non-httpOnly) cookie alongside the
// session cookie on login, specifically so this can read it back and echo
// it in a header the server then compares against its own cookie copy.
function getCsrfToken() {
  const match = document.cookie.match(/(?:^|; )csrf_token=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

async function doRequest(path, options) {
  const method = (options.method || "GET").toUpperCase();
  const csrfToken = method !== "GET" ? getCsrfToken() : null;
  // A JSON string body without a Content-Type is silently ignored by the server's
  // express.json() (req.body stays empty): the credit limit and the manual Excel order
  // link both "saved" nothing that way. Default it here so no call can forget it.
  const jsonBody = typeof options.body === "string" && !options.headers?.["Content-Type"];
  // A read that has not answered in 30 s is given up (owner, 2026-10-26: a customer card spun forever): the screen gets an error it can show
  // with a Retry instead of an endless "Loading". Writes and uploads keep their own, longer patience.
  const controller = method === "GET" && !options.signal ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), GET_TIMEOUT_MS) : null;
  let res;
  try {
    res = await fetch(`/api${path}`, {
      credentials: "include",
      ...options,
      ...(controller ? { signal: controller.signal } : {}),
      headers: {
        ...(jsonBody ? { "Content-Type": "application/json" } : {}),
        "X-App-Version": APP_VERSION,
        ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
        ...options.headers,
      },
    });
  } catch (err) {
    if (controller?.signal.aborted) {
      const timeout = new Error(t("request_timeout"));
      timeout.status = 408;
      throw timeout;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 204) return null;

  const isJson = res.headers.get("content-type")?.includes("application/json");
  const body = isJson ? await res.json() : null;

  if (!res.ok) {
    if (res.status === 423 && body?.locked) {
      // Emergency Disconnect just engaged (or was already on) -- take the
      // whole tab over immediately rather than letting whichever view
      // triggered this request quietly swallow it in its own try/catch
      // (most callers do), which would leave stale data on screen. Fires
      // for every in-flight request the same instant, but the overlay
      // itself is idempotent about being shown twice.
      import("./lockdownScreen.js").then((m) => m.showLockdownOverlay());
    }
    // 45 server routes answer a role check with the bare English "Not
    // allowed", which then showed as a red error line on whatever screen the
    // request came from (Warehouse, Reports, Recorded... reached by link or
    // bookmark). Say what it means, in the user's language. Specific 403
    // messages ("Only the recipient can confirm this handoff") are left alone.
    const message = res.status === 403 && (body?.message || body?.error) === "Not allowed" ? t("not_available_for_role") : body?.message || body?.error;
    const err = new Error(message || `Request failed (${res.status})`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

function json(path, method, data) {
  return request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

function bankForm(file, accountId, mapping) {
  const form = new FormData();
  form.set("file", file);
  form.set("account_id", String(accountId));
  if (mapping) form.set("mapping", JSON.stringify(mapping));
  return form;
}

export const api = {
  login: (email, password) => json("/auth/login", "POST", { email, password }),
  logout: () => request("/auth/logout", { method: "POST" }),
  me: () => request("/me"),

  // Backs app.js's periodic (every-60s) badge poll -- one request for all
  // seven Home-tab/nav counts instead of seven separate ones. Event-driven
  // refreshes right after a specific action still use each badge's own
  // single-purpose endpoint below (getOrdersPendingCount etc.), unchanged.
  getBadgeCounts: () => request("/badges"),

  getCustomerRegions: () => request("/customers/regions"),
  getBrandStatusByCustomer: () => request("/customers/brand-status"),
  getBrandSummary: (params = {}) => request(`/customers/brand-summary${params.customer_id ? `?customer_id=${encodeURIComponent(params.customer_id)}` : ""}`),
  lookupTin: (tin) => request(`/customers/tin-lookup?tin=${encodeURIComponent(tin)}`),
  listCustomers: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/customers${qs ? `?${qs}` : ""}`);
  },
  // Order returns and cancellations (see server/src/orderReturns.js)
  listReturns: (params = {}) => request(`/returns?${new URLSearchParams(params)}`, { fresh: true }),
  getReturnable: (orderId) => request(`/returns/order/${orderId}/returnable`, { fresh: true }),
  getReturnCounts: () => request("/returns/counts", { fresh: true }),
  requestReturn: (data) => json("/returns", "POST", data),
  approveReturn: (id, note) => json(`/returns/${id}/approve`, "POST", { note }),
  rejectReturn: (id, note) => json(`/returns/${id}/reject`, "POST", { note }),
  receiveReturn: (id, items) => json(`/returns/${id}/receive`, "POST", { items }),
  recordReturn: (id) => request(`/returns/${id}/recorded`, { method: "POST" }),
  getPotentialSummary: () => request("/customers/potential-summary", { fresh: true }),
  setCustomerPotential: (id, data) => json(`/customers/${id}/potential`, "PUT", data),
  getPotentialHistory: (id) => request(`/customers/${id}/potential-history`, { fresh: true }),
  resolveCounterfeit: (id, data) => json(`/customers/${id}/counterfeit-resolve`, "POST", data),
  createCustomer: async (data) => {
    const created = await json("/customers", "POST", data);
    await dropCachedCustomerLists();
    return created;
  },
  getCustomer: (id) => request(`/customers/${id}`),
  getVolumeReport: (params) => request(`/volume-report?${new URLSearchParams(params).toString()}`),
  getPinReview: () => request("/pin-review"),
  acceptPinReview: (customerId) => json(`/pin-review/${customerId}/accept`, "POST", {}),
  dismissPinReview: (customerId) => json(`/pin-review/${customerId}/dismiss`, "POST", {}),
  reportFarAttempt: (data) => json("/checkins/far-attempt", "POST", data),
  getCheckinSpots: (id) => request(`/customers/${id}/checkin-spots`),
  priceCheckOrder: (body) => json("/orders/price-check", "POST", body),
  getCustomerProductPrices: (id) => request(`/customers/${id}/product-prices`),
  saveCustomerProductPrices: (id, prices) => json(`/customers/${id}/product-prices`, "PUT", { prices }),
  updateCustomer: async (id, data) => {
    const updated = await json(`/customers/${id}`, "PATCH", data);
    // Patch with what the server returned (falling back to what we sent) so
    // the Customers list is already right when the rep navigates back.
    await patchCachedCustomer(id, updated && typeof updated === "object" && !Array.isArray(updated) ? updated : data);
    return updated;
  },
  deleteCustomer: async (id) => {
    const result = await request(`/customers/${id}`, { method: "DELETE" });
    await removeCachedCustomer(id);
    return result;
  },
  // limit/offset: the customer card loads the latest visits first and the older ones on request.
  customerCheckins: (id, { limit, offset } = {}) => {
    const qs = new URLSearchParams();
    if (limit) qs.set("limit", limit);
    if (offset) qs.set("offset", offset);
    return request(`/customers/${id}/checkins${qs.size ? `?${qs}` : ""}`);
  },
  // Ids and dates of every check-in photo of the customer (the Files sheet's Photos section).
  customerPhotos: (id) => request(`/customers/${id}/photos`),
  customerPlannedVisits: (id) => request(`/customers/${id}/planned-visits`),
  getVisitSchedule: (id) => request(`/customers/${id}/visit-schedule`),
  getMapFacts: (id) => request(`/customers/${id}/map-facts`),
  getMapFactsBatch: (ids) => request(`/customers/map-facts?ids=${ids.join(",")}`),
  customerOrderedProducts: (id) => request(`/customers/${id}/ordered-products`),
  getOrderedProductIds: (customerId) => request(`/customers/${customerId}/ordered-product-ids`),
  getFrequentProducts: () => request("/products/frequent"),
  getReorderProfile: (id, from) => request(`/customers/${id}/reorder-profile${from ? `?from=${encodeURIComponent(from)}` : ""}`),

  getArrivalSettings: () => request("/delivery/arrival-settings", { fresh: true }),
  saveArrivalSettings: (data) => json("/delivery/arrival-settings", "PUT", data),
  arrivalPing: (lat, lng, accuracy) => json("/delivery/arrival", "POST", { lat, lng, accuracy }),
  arrivalDeliver: (customerId) => json("/delivery/arrival/deliver", "POST", { customer_id: customerId }),
  createCheckin: (formData) =>
    request("/checkins", { method: "POST", body: formData }),
  getDeliverableOrders: (customerId) => request(`/checkins/deliverable-orders?customer_id=${customerId}`),
  listCheckins: (params = {}, options = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/checkins${qs ? `?${qs}` : ""}`, options);
  },
  checkinPhotoByIdUrl: (photoId) => `/api/checkins/photos/${photoId}`,
  checkinPhotoThumbUrl: (photoId) => `/api/checkins/photos/${photoId}?size=thumb`,
  deleteCheckinPhotoById: (photoId) => request(`/checkins/photos/${photoId}`, { method: "DELETE" }),

  // Operations control
  opsLegacyBalances: () => request("/ops/legacy-balances"),
  opsDecideLegacy: (customerId, decision, note) => json(`/ops/legacy-balances/${customerId}`, "PUT", { decision, note }),
  opsCreditLimits: () => request("/ops/credit-limits"),
  opsMargin: (days) => request(`/ops/margin?days=${days}`),
  opsSetFx: (rate) => json("/ops/fx", "POST", { rate }),
  opsFxReviewDone: () => json("/ops/fx/review-done", "POST", {}),
  opsStock: () => request("/ops/stock"),
  opsStockAction: (productId, body) => json(`/ops/stock/${productId}`, "PUT", body),
  opsCustomers: () => request("/ops/customers"),
  opsFlow: (days) => request(`/ops/flow?days=${days}`),
  opsData: () => request("/ops/data"),
  opsApplyCreditLimits: (items) => json("/ops/credit-limits/apply", "POST", { items }),
  // Vaghinak (the AI operations deputy director)
  vaghinakBadge: () => request("/vaghinak/badge"),
  vaghinakPending: () => request("/vaghinak/pending"),
  vaghinakInbox: () => request("/vaghinak/inbox"),
  vaghinakReadAll: () => json("/vaghinak/messages/read-all", "POST", {}),
  vaghinakReact: (id, reaction) => json(`/vaghinak/messages/${id}/react`, "POST", { reaction }),
  vaghinakAnswer: (id, body) => json(`/vaghinak/messages/${id}/answer`, "POST", body),
  vaghinakPulse: () => request("/vaghinak/pulse"),
  retailDifferences: () => request("/settings/retail-differences", { fresh: true }),
  askKadStatus: () => request("/ask-kad/status", { fresh: true }),
  testAskKad: () => json("/ask-kad/test", "POST", {}),
  askKad: (question, history) => json("/ask-kad", "POST", { question, history }),
  vaghinakQa: () => request("/vaghinak/qa"),
  vaghinakFeed: () => request("/vaghinak/feed"),
  expenses: () => request("/expenses", { fresh: true }),
  expensesRunNow: () => json("/expenses/run-now", "POST", {}),
  expensesDismiss: (id) => json(`/expenses/alerts/${id}/dismiss`, "POST", {}),
  placeReviews: (status = "pending") => json(`/places/reviews?status=${status}`),
  placeReviewsCount: () => json("/places/reviews/count"),
  placeReviewResolve: (id, body) => json(`/places/reviews/${id}/resolve`, "POST", body),
  placeCleanup: () => json("/places/cleanup"),
  placeCleanupApply: () => json("/places/cleanup/apply", "POST", {}),
  antiFraud: () => request("/anti-fraud", { fresh: true }),
  antiFraudRunNow: () => json("/anti-fraud/run-now", "POST", {}),
  antiFraudVerdict: (id, status, note) => json(`/anti-fraud/alerts/${id}`, "PATCH", { status, note }),
  antiFraudSpotCheck: (id, status, note) => json(`/anti-fraud/spot-checks/${id}`, "PATCH", { status, note }),
  antiFraudSettings: (patch) => json("/anti-fraud/settings", "PUT", patch),
  vaghinakAutoTasks: () => request("/vaghinak/auto-tasks", { fresh: true }),
  vaghinakSettings: () => request("/vaghinak/settings"),
  vaghinakSaveSettings: (patch) => json("/vaghinak/settings", "PUT", patch),
  vaghinakSetAddress: (id, address) => json(`/vaghinak/people/${id}/address`, "PUT", { address }),
  vaghinakMute: (id, muted) => json(`/vaghinak/people/${id}/mute`, "PUT", { muted }),
  vaghinakRunNow: () => json("/vaghinak/run-now", "POST", {}),
  dashboardSummary: () => request("/dashboard/summary"),
  dashboardKpis: () => request("/dashboard/kpis"),
  dashboardToday: () => request("/dashboard/today"),
  dashboardTrends: () => request("/dashboard/trends"),
  getRepProgress: (period) => request(`/dashboard/rep-progress?period=${encodeURIComponent(period)}`),
  closeOutMonth: (month) => json("/dashboard/points/close-out", "POST", { month }),
  listMonthlyCloseouts: (month) => request(`/dashboard/points/closeouts${month ? `?month=${month}` : ""}`),

  fuelReport: (month, retry = false) => request(`/fuel/report?month=${month}${retry ? "&retry=1" : ""}`),
  fuelSettings: (month) => request(`/fuel/settings?month=${month}`),
  setFuelUser: (id, data) => json(`/fuel/settings/users/${id}`, "PUT", data),
  setFuelPrice: (month, price) => json(`/fuel/prices/${month}`, "PUT", { price_amd_per_l: price }),
  setFuelOverride: (data) => json("/fuel/overrides", "PUT", data),

  listUsers: () => request("/users"),
  listPlannableUsers: () => request("/users/plannable"),
  listAssignableManagers: () => request("/users/assignable-managers"),
  createUser: (data) => json("/users", "POST", data),
  updateUser: (id, data) => json(`/users/${id}`, "PATCH", data),
  updateUserRole: (id, role) => json(`/users/${id}/role`, "PATCH", { role }),
  resetUserPassword: (id, password) => json(`/users/${id}/password`, "PATCH", { password }),
  unlockUser: (id) => json(`/users/${id}/unlock`, "POST", {}),
  deleteUser: (id) => request(`/users/${id}`, { method: "DELETE" }),
  getUserDeletionReport: (id) => request(`/users/${id}/deletion-report`),
  purgeUser: (id) => json(`/users/${id}/purge`, "POST", { confirm: true }),
  getUserOffboarding: (id) => request(`/users/${id}/offboarding`),
  setUserStatus: (id, data) => json(`/users/${id}/status`, "POST", data),
  deleteUserRecords: (id) => request(`/users/${id}/records`, { method: "DELETE" }),

  getSettings: () => request("/settings"),
  updateSettings: async (data) => {
    const result = await json("/settings", "PATCH", data);
    // Admin settings change what Home / the sidebar show: drop stale screens.
    window.dispatchEvent(new Event("app-preferences-changed"));
    return result;
  },

  // Unauthenticated on purpose -- see routes/lockdown.js.
  getLockdownStatus: () => request("/lockdown"),
  engageLockdown: () => json("/lockdown/engage", "POST", {}),
  liftLockdown: () => json("/lockdown/lift", "POST", {}),

  getMySalesPerformance: () => request("/sales-performance/me"),
  getSalesPerformanceLeaderboard: (period = "ytd") => request(`/sales-performance/?period=${period}`),

  createEditRequest: async (customerId, changes, note) => {
    const created = await json("/edit-requests", "POST", { customer_id: customerId, changes, note });
    // A pin correction by the rep (or management) is applied at once on the server and comes back "approved": the
    // cached customer lists (Customers, Map) must show the new spot right away, not the old one until a refetch.
    if (created?.status === "approved") await patchCachedCustomer(customerId, changes);
    return created;
  },
  listEditRequests: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/edit-requests${qs ? `?${qs}` : ""}`);
  },
  reviewEditRequest: (id, action, note) => json(`/edit-requests/${id}`, "PATCH", { action, note }),

  postLocation: (lat, lng) => json("/locations", "POST", { lat, lng }),
  getTeamLocations: () => request("/locations"),

  getUnlinkedErpCustomers: (search = "") => {
    const qs = search ? `?search=${encodeURIComponent(search)}` : "";
    return request(`/erp-sync/unlinked${qs}`);
  },
  getCustomerPaymentsReceived: (customerId) => request(`/customers/${customerId}/payments-received`),
  getErpOrders: (customerId, scope = "recent") => request(`/customers/${customerId}/erp-orders?scope=${scope}`),
  getErpOrderDetail: (customerId, orderId) =>
    request(`/customers/${customerId}/erp-orders/${encodeURIComponent(orderId)}`),

  reverseGeocode: (lat, lng) => request(`/geocode/reverse?lat=${lat}&lng=${lng}`),
  searchAddress: (q) => request(`/geocode/search?q=${encodeURIComponent(q)}`),

  changeMyPassword: (currentPassword, newPassword) =>
    json("/me/password", "PATCH", { current_password: currentPassword, new_password: newPassword }),
  logoutOtherSessions: () => request("/me/logout-other-sessions", { method: "POST" }),
  uploadMyAvatar: (formData) => request("/me/avatar", { method: "POST", body: formData }),
  deleteMyAvatar: () => request("/me/avatar", { method: "DELETE" }),
  saveMySignature: (blob) => {
    const form = new FormData();
    form.set("signature", blob, "signature.png");
    return request("/me/signature", { method: "POST", body: form });
  },
  mySignatureUrl: () => `/api/me/signature?t=${Date.now()}`,
  myAvatarUrl: () => `/api/me/avatar?t=${Date.now()}`,

  getMyVisitPlan: (date, userId) => {
    const params = new URLSearchParams();
    if (date) params.set("date", date);
    if (userId) params.set("user_id", userId);
    const qs = params.toString();
    return request(`/visit-plans/mine${qs ? `?${qs}` : ""}`);
  },
  saveVisitPlan: (date, customerIds, userId) =>
    json("/visit-plans", "POST", { date, customer_ids: customerIds, user_id: userId }),
  getPendingVisitPlans: () => request("/visit-plans/pending"),
  getTeamTodayVisitPlans: () => request("/visit-plans/team-today"),
  reviewVisitPlan: (id, action) => json(`/visit-plans/${id}`, "PATCH", { action }),
  getVisitPlanRules: (userId) => request(`/visit-plans/rules${userId ? `?user_id=${userId}` : ""}`),
  // planChannel: "" = save the main plan, "SM B2B" = that channel's own plan (the person's other plans stay as they are);
  // undefined = replace the whole day (the Map's quick planner)
  saveVisitPlanRule: (dayOfWeek, areas, userId, customerIds, planChannel) =>
    json(`/visit-plans/rules/${dayOfWeek}`, "PUT", { areas, user_id: userId, customer_ids: customerIds, ...(planChannel === undefined ? {} : { plan_channel: planChannel }) }),
  listRoutePlanSets: () => request("/route-plan-sets"),
  autoRoutePlanSet: (data) => json("/route-plan-sets/auto", "POST", data),
  snapshotRoutePlanSet: (name) => json("/route-plan-sets/snapshot", "POST", { name }),
  getRoutePlanSet: (id) => request(`/route-plan-sets/${id}`),
  updateRoutePlanSet: (id, data) => json(`/route-plan-sets/${id}`, "PATCH", data),
  setRoutePlanSetRep: (id, userId, days, scope) => json(`/route-plan-sets/${id}/reps/${userId}`, "PUT", scope === undefined ? { days } : { days, scope }),
  duplicateRoutePlanSet: (id, name) => json(`/route-plan-sets/${id}/duplicate`, "POST", { name }),
  activateRoutePlanSet: (id, previousName) => json(`/route-plan-sets/${id}/activate`, "POST", { previous_name: previousName }),
  deleteRoutePlanSet: (id) => request(`/route-plan-sets/${id}`, { method: "DELETE" }),
  getRoutePlansOverview: () => request("/visit-plans/rules/overview"),
  // scope: "" = the main plan, "SM B2B" = that channel's separate plan; undefined = every customer of the person
  getRoutePlanCustomers: (userId, scope) => {
    const qs = [userId ? `user_id=${userId}` : "", scope === undefined ? "" : `scope=${encodeURIComponent(scope)}`].filter(Boolean).join("&");
    return request(`/visit-plans/rules/customers${qs ? `?${qs}` : ""}`);
  },
  getMyRoutePlans: (userId) => request(`/visit-plans/rules/plans${userId ? `?user_id=${userId}` : ""}`),

  listProducts: (q = "") => request(`/products${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  listAllProducts: () => request("/products/all"),
  getProductSyncDiagnostics: () => request("/products/sync-diagnostics"),
  getProductDuplicates: () => request("/products/duplicates"),
  createProduct: (data) => json("/products", "POST", data),
  updateProduct: (id, data) => json(`/products/${id}`, "PATCH", data),
  deleteProduct: (id) => request(`/products/${id}`, { method: "DELETE" }),
  resyncProduct: (id) => request(`/products/${id}/resync`, { method: "POST" }),
  listProductPromos: (id) => request(`/products/${id}/promos`),
  createProductPromo: (id, data) => json(`/products/${id}/promos`, "POST", data),
  deleteProductPromo: (id, promoId) => request(`/products/${id}/promos/${promoId}`, { method: "DELETE" }),
  getProductPriceHistory: (id) => request(`/products/${id}/price-history`),
  getProduct: (id) => request(`/products/${id}`),
  uploadProductPhoto: (id, formData) => request(`/products/${id}/images`, { method: "POST", body: formData }),
  updateProductPhoto: (id, imageId, data) => json(`/products/${id}/images/${imageId}`, "PATCH", data),
  deleteProductPhoto: (id, imageId) => request(`/products/${id}/images/${imageId}`, { method: "DELETE" }),
  importPricelistWorkbook: (formData) => request("/products/import-pricelist", { method: "POST", body: formData }),
  // The pricelist PDF is binary, so it bypasses request()'s JSON handling.
  buildPricelistPdf: async (options) => {
    const res = await fetch("/api/products/pricelist.pdf", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", "X-App-Version": APP_VERSION, ...(getCsrfToken() ? { "X-CSRF-Token": getCsrfToken() } : {}) },
      body: JSON.stringify(options),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => null);
      throw new Error(err?.error || t("pdf_failed"));
    }
    return res.blob();
  },
  // Print-ready order blanks (PDF) for one or more orders; variant null = automatic.
  buildOrderBlanks: async (orderIds, variant) => {
    const res = await fetch("/api/orders/blank-pdf", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", "X-App-Version": APP_VERSION, ...(getCsrfToken() ? { "X-CSRF-Token": getCsrfToken() } : {}) },
      body: JSON.stringify({ order_ids: orderIds, variant: variant || undefined }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => null);
      throw new Error(err?.error || t("pdf_failed"));
    }
    return res.blob();
  },
  // One-page Armenian PDF of the customer's unpaid invoices (debt statement).
  buildDebtStatement: async (customerId) => {
    const res = await fetch(`/api/customers/${customerId}/debt-statement`, { credentials: "include", headers: { "X-App-Version": APP_VERSION } });
    if (!res.ok) {
      const err = await res.json().catch(() => null);
      throw new Error(err?.error || t("pdf_failed"));
    }
    return res.blob();
  },
  // Excel file of a table the client already holds (Sales / Payments export).
  buildXlsx: async (payload) => {
    const res = await fetch("/api/table-export/xlsx", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", "X-App-Version": APP_VERSION, ...(getCsrfToken() ? { "X-CSRF-Token": getCsrfToken() } : {}) },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => null);
      throw new Error(err?.error || `HTTP ${res.status}`);
    }
    return res.blob();
  },
  productImageUrl: (id) => `/api/products/${id}/image`,
  uploadProductImage: (id, formData) => request(`/products/${id}/image`, { method: "POST", body: formData }),
  deleteProductImage: (id) => request(`/products/${id}/image`, { method: "DELETE" }),
  previewBulkPriceUpdate: (data) => json("/products/bulk-price-update", "POST", { ...data, apply: false }),
  applyBulkPriceUpdate: (data) => json("/products/bulk-price-update", "POST", { ...data, apply: true }),
  productsExportXlsxUrl: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return `/api/products/export/xlsx${qs ? `?${qs}` : ""}`;
  },
  previewProductImport: (formData) => request("/products/import/preview", { method: "POST", body: formData }),
  applyProductImport: (formData) => request("/products/import/apply", { method: "POST", body: formData }),

  getCompanyProfile: () => request("/company-profile"),
  updateCompanyProfile: (data) => json("/company-profile", "PATCH", data),
  updateMyProfile: (data) => json("/me/profile", "PATCH", data),

  listRouteDistribution: () => request("/route-distribution"),
  suggestCustomerNameNumber: (base) => request(`/customers/name-suggestion?${new URLSearchParams({ base })}`, { fresh: true }),
  lookupRouteDistribution: (region, subregion) => {
    const qs = new URLSearchParams({ region, ...(subregion ? { subregion } : {}) }).toString();
    return request(`/route-distribution/lookup?${qs}`);
  },
  bulkRouteDistribution: (items) => json("/route-distribution/bulk", "PUT", { items }),
  createRouteDistribution: (data) => json("/route-distribution", "POST", data),
  updateRouteDistribution: (id, data) => json(`/route-distribution/${id}`, "PATCH", data),
  deleteRouteDistribution: (id) => request(`/route-distribution/${id}`, { method: "DELETE" }),

  listTaskAssignees: () => request("/tasks/assignees"),
  getErpSyncStatus: () => request("/erp-sync/status", { fresh: true }),
  getPotentialReasonMemory: () => request("/customers/potential-reason-memory", { fresh: true }),
  getAdminCounts: () => request("/settings/admin-counts", { fresh: true }),
  requestErpSync: () => json("/erp-sync/request", "POST", {}),
  listTasks: (params = {}) => request(`/tasks?${new URLSearchParams(params).toString()}`),
  getTask: (id) => request(`/tasks/${id}`),
  createTask: (data) => json("/tasks", "POST", data),
  updateTask: (id, data) => json(`/tasks/${id}`, "PATCH", data),
  taskCallResult: (id, body) => json(`/tasks/${id}/call-result`, "POST", body),
  completeTask: (id, note, extra = {}) => json(`/tasks/${id}/complete`, "POST", { ...(note ? { note } : {}), ...extra }),
  reopenTask: (id) => json(`/tasks/${id}/reopen`, "POST", {}),
  setTaskItemDone: (id, itemId, done) => json(`/tasks/${id}/items/${itemId}`, "POST", { done }),
  getTaskCustomerFlags: () => request("/tasks/customer-flags"),
  getCustomerDebtFlags: () => request("/customers/debt-flags"),
  createOrder: (data) => json("/orders", "POST", data),
  submitOrder: (id, erpCustomerId) => json(`/orders/${id}/submit`, "POST", erpCustomerId ? { erp_customer_id: erpCustomerId } : {}),
  listOrders: (params = {}, options = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/orders${qs ? `?${qs}` : ""}`, options);
  },
  getOrder: (id) => request(`/orders/${id}`),
  listOrderDocuments: (id) => request(`/orders/${id}/documents`),
  listCustomerDocuments: (id) => request(`/customers/${id}/documents`),
  // The sentence the customer reads before signing (signStatement.js); never cached: the debt changes with every visit.
  signStatement: (id, { orderIds = [], paymentAmd = 0 } = {}) =>
    request(`/customers/${id}/sign-statement?order_ids=${orderIds.join(",")}&payment=${Math.round(Number(paymentAmd) || 0)}`, { fresh: true }),
  // Customer documents (signed order blanks, payment slips, ...): routes/files.js
  customerFiles: (customerId) => request(`/files/customer/${customerId}`, { fresh: true }),
  orderFiles: (orderId) => request(`/files/order/${orderId}`, { fresh: true }),
  filesInbox: (params = {}) => request(`/files?${new URLSearchParams(params)}`, { fresh: true }),
  addCustomerFile: (customerId, formData) => request(`/files/customer/${customerId}`, { method: "POST", body: formData }),
  recheckFile: (id) => request(`/files/${id}/ai-check`, { method: "POST" }),
  rotateFile: (id, degrees) => json(`/files/${id}/rotate`, "POST", { degrees }),
  deleteFile: (id) => request(`/files/${id}`, { method: "DELETE" }),
  fileUrl: (file, { thumb = false } = {}) => `/api/files/${file.id}/content?v=${file.version ?? 1}${thumb ? "&size=thumb" : ""}`,
  // A PDF document as one JPEG (server pdfPreview.js); 501 when the server cannot render it.
  filePreviewUrl: (file) => `/api/files/${file.id}/preview?v=${file.version ?? 1}`,
  printPaymentSlips: async (ids) => {
    const res = await fetch("/api/files/print-slips", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", "X-App-Version": APP_VERSION, ...(getCsrfToken() ? { "X-CSRF-Token": getCsrfToken() } : {}) },
      body: JSON.stringify({ ids }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    return res.blob();
  },
  orderDocumentUrl: (docId) => `/api/orders/documents/${docId}/file`,
  orderDocumentPreviewUrl: (docId) => `/api/orders/documents/${docId}/preview`,
  // Any PDF built on the phone (order blanks, a debt statement) as a JPEG, for "Save as image".
  pdfToImage: async (pdfBlob) => {
    const res = await fetch("/api/files/pdf-preview", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/pdf", "X-App-Version": APP_VERSION, ...(getCsrfToken() ? { "X-CSRF-Token": getCsrfToken() } : {}) },
      body: pdfBlob,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.blob();
  },
  getAccountingCount: () => request("/orders/accounting-count"),
  getAccountingAgent: () => request("/orders/accounting-agent"),
  // A signed PDF is binary, so it bypasses request()'s JSON handling.
  downloadOrderDocument: async (docId) => {
    const res = await fetch(`/api/orders/documents/${docId}/file`, { credentials: "include", headers: { "X-App-Version": APP_VERSION } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.blob();
  },
  getOrdersPendingCount: () => request("/orders/pending-count"),
  updateOrderItems: (id, items) => json(`/orders/${id}`, "PATCH", { items }),
  updateOrderStatus: (id, status) => json(`/orders/${id}`, "PATCH", { status }),
  updateOrder: (id, data) => json(`/orders/${id}`, "PATCH", data),
  setAccountingStatus: (id, status) => json(`/orders/${id}/accounting-status`, "POST", { status }),
  markAccountingSigned: (id, number) => json(`/orders/${id}/accounting-signed`, "POST", number ? { number } : {}),
  requestAccountingDocument: (id, paymentMethod) => json(`/orders/${id}/accounting-request`, "POST", { payment_method: paymentMethod }),
  approveOrderDiscount: (id) => request(`/orders/${id}/approve-discount`, { method: "POST" }),
  deleteOrder: (id) => request(`/orders/${id}`, { method: "DELETE" }),
  rejectOrderDiscount: (id) => request(`/orders/${id}/reject-discount`, { method: "POST" }),
  getCreditStatus: (customerId) => request(`/customers/${customerId}/credit-status`),
  getRecentOrders: (customerId) => request(`/customers/${customerId}/recent-orders`),
  getOrderDefaults: (customerId) => request(`/customers/${customerId}/order-defaults`),
  getCreditHistory: (customerId) => request(`/customers/${customerId}/credit-history`),
  setCreditLimit: (customerId, limit) => json(`/customers/${customerId}/credit-terms`, "PUT", { credit_limit_amd: limit }),
  approveOrderCredit: (id) => request(`/orders/${id}/approve-credit`, { method: "POST" }),
  rejectOrderCredit: (id) => request(`/orders/${id}/reject-credit`, { method: "POST" }),
  getErpCandidates: (id) => request(`/orders/${id}/erp-candidates`),
  linkOrderToErp: (id, erpOrderId) => json(`/orders/${id}/link-erp`, "POST", { erp_order_id: erpOrderId }),
  markOrderDeliveredWithoutRoute: (id) => request(`/orders/${id}/mark-delivered`, { method: "POST" }),

  // Warehouse (see server/src/routes/warehouse.js)
  getCashMeta: (params = {}) => request(`/cashflow/meta?${new URLSearchParams(params)}`, { fresh: true }),
  getCashSummary: (params = {}) => request(`/cashflow/summary?${new URLSearchParams(params)}`, { fresh: true }),
  getCashEntries: (params = {}) => request(`/cashflow/entries?${new URLSearchParams(params)}`, { fresh: true }),
  addCashEntry: (data) => json("/cashflow/entries", "POST", data),
  updateCashEntry: (id, data) => json(`/cashflow/entries/${id}`, "PUT", data),
  deleteCashEntry: (id) => request(`/cashflow/entries/${id}`, { method: "DELETE" }),
  getCashEntry: (id) => request(`/cashflow/entries/${id}`, { fresh: true }),
  requestCashChange: (id, body) => json(`/cashflow/entries/${id}/requests`, "POST", body),
  getCashRequests: () => request("/cashflow/requests", { fresh: true }),
  decideCashRequest: (id, decision) => json(`/cashflow/requests/${id}/${decision}`, "POST", {}),
  getCashCustomers: () => request("/cashflow/customers"),
  addCashAccount: (data) => json("/cashflow/accounts", "POST", data),
  addCashCategory: (data) => json("/cashflow/categories", "POST", data),
  // Bank statements (see server/src/routes/bankStatements.js)
  previewBankStatement: (file, accountId, mapping) => request("/cashflow/bank/preview", { method: "POST", body: bankForm(file, accountId, mapping) }),
  importBankStatement: (file, accountId, mapping) => request("/cashflow/bank/import", { method: "POST", body: bankForm(file, accountId, mapping) }),
  getBankLines: (params = {}) => request(`/cashflow/bank/lines?${new URLSearchParams(params)}`, { fresh: true }),
  addBankLine: (id, data) => json(`/cashflow/bank/lines/${id}/add`, "POST", data),
  ignoreBankLine: (id) => request(`/cashflow/bank/lines/${id}/ignore`, { method: "POST" }),
  reopenBankLine: (id) => request(`/cashflow/bank/lines/${id}/reopen`, { method: "POST" }),
  importCashWorkbook: (file) => {
    const form = new FormData();
    form.set("file", file);
    return request("/cashflow/import", { method: "POST", body: form });
  },
  // Staff (see server/src/routes/staff.js)
  getStaffAccess: () => request("/staff/access", { fresh: true }),
  getStaffPeople: () => request("/staff/people", { fresh: true }),
  getStaffCandidates: () => request("/staff/candidates", { fresh: true }),
  getStaffPayroll: (month) => request(`/staff/payroll?month=${month}`, { fresh: true }),
  linkSalaryPayment: (personId, entryId) => json(`/staff/people/${personId}/pay-keys`, "POST", { entry_id: entryId }),
  getStaffPay: (id, month) => request(`/staff/people/${id}/pay?month=${month}`, { fresh: true }),
  getStaffSettings: () => request("/staff/settings", { fresh: true }),
  saveStaffSettings: (data) => json("/staff/settings", "PUT", data),
  createStaffPerson: (data) => json("/staff/people", "POST", data),
  updateStaffPerson: (id, data) => json(`/staff/people/${id}`, "PUT", data),
  deleteStaffPerson: (id) => request(`/staff/people/${id}`, { method: "DELETE" }),
  markStaffDay: (id, day, data) => json(`/staff/people/${id}/days/${day}`, "PUT", data),
  addStaffItem: (id, data) => json(`/staff/people/${id}/items`, "POST", data),
  deleteStaffItem: (itemId) => request(`/staff/items/${itemId}`, { method: "DELETE" }),
  getWarehouseHome: () => request("/warehouse/home", { fresh: true }),
  getWarehousePackedList: () => request("/warehouse/packed-list", { fresh: true }),
  getDeliveryHome: () => request("/delivery/home", { fresh: true }),
  getWarehousePendingCount: () => request("/warehouse/pending-count"),
  getPickList: () => request("/warehouse/pick-list"),
  getStagingList: () => request("/warehouse/staging-list"),
  getInventory: (q = "", { brand = "", size = "", stock = "" } = {}) => {
    const qs = new URLSearchParams();
    if (q) qs.set("q", q);
    if (brand) qs.set("brand", brand);
    if (size) qs.set("size", size);
    if (stock) qs.set("stock", stock);
    const s = qs.toString();
    return request(`/warehouse/inventory${s ? `?${s}` : ""}`);
  },
  getVisitPriorities: () => request("/customers/visit-priorities"),
  getOpenVisit: (customerId) => request(`/checkins/open?customer_id=${customerId}`),
  endVisit: (checkinId) => request(`/checkins/${checkinId}/end`, { method: "POST" }),
  getScorecard: (week) => request(`/biz-reports/scorecard${week ? `?week=${week}` : ""}`),
  getUnpaidInvoices: (params = {}) => request(`/biz-reports/unpaid-invoices?${new URLSearchParams(params).toString()}`),
  getDeliverySpeed: (days) => request(`/biz-reports/delivery-speed?days=${days}`),
  getCustomerPipeline: () => request("/biz-reports/pipeline"),
  getReorderSuggestions: () => request("/warehouse/reorder-suggestions"),
  getInventoryBrands: () => request("/warehouse/inventory/brands"),
  getInventorySizes: () => request("/warehouse/inventory/sizes"),
  markOrderPacked: (id) => request(`/warehouse/orders/${id}/packed`, { method: "POST" }),
  bulkMarkOrdersPacked: (orderIds) => json("/warehouse/orders/bulk-packed", "POST", { order_ids: orderIds }),
  flagOrderStockIssue: (id, note) => json(`/warehouse/orders/${id}/stock-issue`, "POST", { note }),

  // Delivery routes (see server/src/routes/delivery.js)
  getDeliveryPendingCount: () => request("/delivery/pending-count"),
  listPackedOrders: () => request("/delivery/packed-orders"),
  listActiveStops: () => request("/delivery/active-stops"),
  releaseRouteStop: (routeId, orderId) => request(`/delivery/routes/${routeId}/stops/${orderId}`, { method: "DELETE" }),
  planRoute: (data) => json("/delivery/routes/plan", "POST", data),
  listDrivers: () => request("/delivery/drivers"),
  getRoute: (id) => request(`/delivery/routes/${id}`),
  getMyRoute: (date) => request(`/delivery/my-route${date ? `?date=${encodeURIComponent(date)}` : ""}`),
  reorderRouteStops: (id, orderIds) => json(`/delivery/routes/${id}/reorder`, "POST", { order_ids: orderIds }),
  confirmDelivery: (orderId, formData) => request(`/delivery/orders/${orderId}/confirm`, { method: "POST", body: formData }),
  failDelivery: (orderId) => request(`/delivery/orders/${orderId}/fail`, { method: "POST" }),
  getOrderDebtSnapshot: (orderId) => request(`/delivery/orders/${orderId}/debt-snapshot`),
  podSignatureUrl: (orderId) => `/api/delivery/pod/${orderId}/signature`,

  // Order rejection + accountant "Recorded" screen (see server/src/routes/orders.js)
  rejectOrder: (id, note) => json(`/orders/${id}/reject`, "POST", { note }),
  unconfirmOrder: (id) => json(`/orders/${id}/unconfirm`, "POST", {}),
  getRecordedList: (recorded, offset = 0) =>
    request(`/orders/recorded-list?recorded=${recorded ? "true" : "false"}&offset=${offset}`),
  getUnrecordedCount: () => request("/orders/unrecorded-count"),
  setOrderRecorded: (id, recorded) => json(`/orders/${id}/recorded`, "PATCH", { recorded }),
  createPaymentFromPod: (podRecordId) => json(`/delivery/pod-records/${podRecordId}/create-payment`, "POST"),

  createPayment: (data) => json("/payments", "POST", data),
  listPayments: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/payments${qs ? `?${qs}` : ""}`);
  },
  getPayment: (id) => request(`/payments/${id}`),
  getPaymentsPendingCount: () => request("/payments/pending-count"),
  getEligiblePaymentManagers: () => request("/payments/eligible-managers"),
  approvePayment: (id) => request(`/payments/${id}/approve`, { method: "POST" }),
  deletePayment: (id, reason) => json(`/payments/${id}`, "DELETE", { reason }),
  getDeletedPayments: () => request("/payments/deleted/list", { fresh: true }),
  rejectPayment: (id, reason) => json(`/payments/${id}/reject`, "POST", { reason }),
  returnPaymentToPending: (id, reason) => json(`/payments/${id}/return-to-pending`, "POST", { reason }),

  // Cash custody chain (see server/src/routes/cashHandoffs.js) -- the
  // hand-to-hand journey of the physical cash, layered on top of the
  // payment rows above.
  getHandoffAvailable: (asUserId) =>
    request(`/cash-handoffs/available${asUserId ? `?as_user_id=${asUserId}` : ""}`),
  getHandoffSenders: () => request("/cash-handoffs/senders"),
  listCashHandoffs: (offset = 0) => request(`/cash-handoffs?offset=${offset}`),
  getCashHandoff: (id) => request(`/cash-handoffs/${id}`),
  createCashHandoff: (data) => json("/cash-handoffs", "POST", data),
  confirmCashHandoff: (id) => request(`/cash-handoffs/${id}/confirm`, { method: "POST" }),
  rejectCashHandoff: (id, reason) => json(`/cash-handoffs/${id}/reject`, "POST", { reason }),

  getVapidPublicKey: () => request("/push/vapid-public-key"),
  subscribePush: (subscription) => json("/push", "POST", subscription),
  unsubscribePush: (endpoint) => json("/push", "DELETE", { endpoint }),

  getMyNotificationSettings: () => request("/notification-settings/mine"),
  setMyNotificationSetting: (notification_type, enabled) =>
    json("/notification-settings/mine", "PUT", { notification_type, enabled }),
  clearMyNotificationOverride: (type) => request(`/notification-settings/mine/${type}`, { method: "DELETE" }),
  getNotificationDefaults: () => request("/notification-settings"),
  setNotificationDefault: (role, notification_type, enabled) =>
    json("/notification-settings", "PUT", { role, notification_type, enabled }),

  listNotifications: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/notifications${qs ? `?${qs}` : ""}`);
  },
  getUnreadNotificationCount: () => request("/notifications/unread-count"),
  getNotificationDeliveryLog: () => request("/notifications/delivery-log"),
  markNotificationRead: (id) => request(`/notifications/${id}/read`, { method: "PATCH" }),
  markAllNotificationsRead: () => request("/notifications/read-all", { method: "PATCH" }),

  listCashExpenses: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/cash-expenses${qs ? `?${qs}` : ""}`);
  },
  createCashExpense: (data) => json("/cash-expenses", "POST", data),
  updateCashExpense: (id, data) => json(`/cash-expenses/${id}`, "PATCH", data),
  deleteCashExpense: (id) => request(`/cash-expenses/${id}`, { method: "DELETE" }),

  listReports: () => request("/reports"),
  getReportAccessMatrix: () => request("/reports/access"),
  setReportAccess: (report_key, role, enabled) =>
    json("/reports/access", "PUT", { report_key, role, enabled }),
  getNewCustomersReport: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/reports/new-customers${qs ? `?${qs}` : ""}`);
  },
  getCheckinsReport: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/reports/checkins${qs ? `?${qs}` : ""}`);
  },
  getBrandAvailabilityReport: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/reports/brand-availability${qs ? `?${qs}` : ""}`);
  },
  getPaymentsReport: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/reports/payments${qs ? `?${qs}` : ""}`);
  },
  getErpPaymentsReport: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/reports/erp-payments${qs ? `?${qs}` : ""}`);
  },
  getCashCustodyReport: () => request(`/reports/cash-custody`),
  getCashReconciliationReport: () => request(`/reports/cash-reconciliation`),
  getCustomerDebtReport: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/reports/customer-debt${qs ? `?${qs}` : ""}`);
  },
  getOrdersPipelineReport: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/reports/orders-pipeline${qs ? `?${qs}` : ""}`);
  },
  getSalesBudgetReport: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/reports/sales-budget${qs ? `?${qs}` : ""}`);
  },
  getBrandVolumeReport: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/reports/brand-volume${qs ? `?${qs}` : ""}`);
  },
  getDailyManagementReport: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/reports/daily-management${qs ? `?${qs}` : ""}`);
  },
  listGeneratedReports: () => request(`/reports/documents`),

  getPerfChannels: () => request("/team-performance/channels"),
  updatePerfChannelManager: (channelId, managerUserId) =>
    json(`/team-performance/channels/${channelId}`, "PATCH", { manager_user_id: managerUserId }),
  getPerfPlanForMonth: (month) => request(`/team-performance/plans?month=${month}`),
  getPerfPlan: (id) => request(`/team-performance/plans/${id}`),
  getPerfPlanHistory: (id) => request(`/team-performance/plans/${id}/history`),
  getPerfPlanAudit: (id) => request(`/team-performance/plans/${id}/audit`),
  createPerfPlan: (month, sourceMonth) => json("/team-performance/plans", "POST", { month, source_month: sourceMonth }),
  savePerfTargets: (planId, channelId, data) => json(`/team-performance/plans/${planId}/targets/${channelId}`, "PUT", data),
  addPerfComment: (planId, body, channelId) => json(`/team-performance/plans/${planId}/comments`, "POST", { body, channel_id: channelId }),
  submitPerfPlan: (planId) => json(`/team-performance/plans/${planId}/submit`, "POST", {}),
  approvePerfPlan: (planId) => json(`/team-performance/plans/${planId}/approve`, "POST", {}),
  rejectPerfPlan: (planId, reason) => json(`/team-performance/plans/${planId}/reject`, "POST", { reason }),
  revisePerfPlan: (planId, reason, targets) => json(`/team-performance/plans/${planId}/revise`, "POST", { reason, targets }),
  reopenPerfPlanAsDraft: (planId) => json(`/team-performance/plans/${planId}/reopen-as-draft`, "POST", {}),
  getPerfApprovals: () => request("/team-performance/approvals"),
  getPerfDashboard: (planId) => request(`/team-performance/plans/${planId}/dashboard`),
  getMyPerformance: (month) => request(`/team-performance/my-performance?month=${month}`),
  getPerfDrilldown: (planId, channelId, kpi) =>
    request(`/team-performance/plans/${planId}/channels/${channelId}/drilldown?kpi=${kpi}`),
  getPerfHistoryList: () => request("/team-performance/history"),
  closePerfMonth: (planId) => json(`/team-performance/plans/${planId}/close`, "POST", {}),
  getPerfDataQuality: () => request("/team-performance/data-quality"),
  getPerfBrandActualsSummary: () => request("/team-performance/brand-actuals-summary"),

  // Debt balances (see server/src/routes/debtBalances.js) -- read-only,
  // role-scoped server-side already.
  getDebtBalances: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/debt-balances${qs ? `?${qs}` : ""}`);
  },

  // Admin data-quality dashboard (see server/src/routes/dataQuality.js) --
  // admin-only server-side already.
  getDataQuality: () => request("/data-quality"),
  getSystemHealth: () => request("/system-health"),

  // Sales records (see server/src/routes/sales.js) -- read-only ERP order
  // history, role-scoped server-side already.
  getSales: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/sales${qs ? `?${qs}` : ""}`);
  },
  getSalesOrder: (erpCustomerId, orderId) =>
    request(`/sales/order?${new URLSearchParams({ erp_customer_id: erpCustomerId, order_id: orderId }).toString()}`),

  // Frontend error monitoring (see errorMonitoring.js) -- fire-and-forget,
  // the caller there never awaits or surfaces a failure from this.
  reportClientError: (report) => json("/client-errors", "POST", { ...report, user_agent: navigator.userAgent }),
  getClientErrorLog: (limit = 100) => request(`/client-errors?limit=${limit}`),

  // KAD OS link, supplier side (server/src/routes/appOrdersAdmin.js): app-order perks, account links, campaigns.
  getKadOsSettings: () => request("/app-orders/settings", { fresh: true }),
  saveKadOsSettings: (data) => json("/app-orders/settings", "PUT", data),
  linkKadOsAccount: (user_id, customer_id) => json("/app-orders/links", "POST", { user_id, customer_id }),
  createKadOsAccount: (customer_id) => json("/app-orders/accounts", "POST", { customer_id }),
  newKadOsAccountCode: (userId) => json(`/app-orders/accounts/${userId}/code`, "POST", {}),
  unlinkKadOsAccount: (userId) => request(`/app-orders/links/${userId}`, { method: "DELETE" }),
  listCampaigns: () => request("/app-orders/campaigns", { fresh: true }),
  createCampaign: (data) => json("/app-orders/campaigns", "POST", data),
  updateCampaign: (id, data) => json(`/app-orders/campaigns/${id}`, "PATCH", data),
  deleteCampaign: (id) => request(`/app-orders/campaigns/${id}`, { method: "DELETE" }),

  // Bonuses challenge templates/rounds admin (see server/src/routes/bonusChallenges.js)
  // -- canManageBonusChallenges (admin/ceo) server-side already.
  listChallengeTemplates: (status) => request(`/bonus-challenges/templates${status ? `?status=${status}` : ""}`),
  getChallengeTemplate: (id) => request(`/bonus-challenges/templates/${id}`),
  createChallengeTemplate: (data) => json("/bonus-challenges/templates", "POST", data),
  updateChallengeTemplate: (id, data) => json(`/bonus-challenges/templates/${id}`, "PATCH", data),
  publishChallengeTemplate: (id) => json(`/bonus-challenges/templates/${id}/publish`, "POST"),
  cancelChallengeTemplate: (id, reason) => json(`/bonus-challenges/templates/${id}/cancel`, "POST", { reason }),

  // Reward claim review/payout (see server/src/routes/bonusRewardClaims.js)
  // -- listing is role-scoped server-side already (a reviewer sees
  // everything, a plain user sees only their own).
  listBonusRewardClaims: (status) => request(`/bonus-reward-claims${status ? `?status=${status}` : ""}`),
  approveBonusRewardClaim: (id, expectedVersion) => json(`/bonus-reward-claims/${id}/approve`, "POST", { expected_version: expectedVersion }),
  rejectBonusRewardClaim: (id, reason, expectedVersion) =>
    json(`/bonus-reward-claims/${id}/reject`, "POST", { reason, expected_version: expectedVersion }),
  holdBonusRewardClaim: (id, reason, expectedVersion) => json(`/bonus-reward-claims/${id}/hold`, "POST", { reason, expected_version: expectedVersion }),
  payBonusRewardClaim: (id, paymentReference, expectedVersion) =>
    json(`/bonus-reward-claims/${id}/pay`, "POST", { payment_reference: paymentReference, expected_version: expectedVersion }),

  // Employee-facing "my Bonuses" summary (see server/src/routes/bonusSummary.js)
  // -- always scoped to the caller; 404s while bonuses_enabled is off.
  getBonusSummary: () => request("/bonus-summary"),
};
