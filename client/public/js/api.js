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

async function request(path, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  if (method !== "GET") {
    getCache.clear();
    prefetched.clear();
    return doRequest(path, options);
  }
  const hit = prefetched.get(path);
  if (hit) {
    prefetched.delete(path);
    if (hit.expires > Date.now()) return hit.promise;
  }
  if (CACHEABLE_BASE_PATHS.has(path.split("?")[0])) {
    const cached = getCache.get(path);
    if (cached && cached.expires > Date.now()) return cached.promise;
    const promise = doRequest(path, options);
    getCache.set(path, { expires: Date.now() + GET_CACHE_TTL_MS, promise });
    promise.catch(() => getCache.delete(path));
    return promise;
  }
  return doRequest(path, options);
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
  const res = await fetch(`/api${path}`, {
    credentials: "include",
    ...options,
    headers: {
      ...(jsonBody ? { "Content-Type": "application/json" } : {}),
      "X-App-Version": APP_VERSION,
      ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
      ...options.headers,
    },
  });

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
  createCustomer: async (data) => {
    const created = await json("/customers", "POST", data);
    await dropCachedCustomerLists();
    return created;
  },
  getCustomer: (id) => request(`/customers/${id}`),
  getCustomerProductPrices: (id) => request(`/customers/${id}/product-prices`),
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
  customerCheckins: (id) => request(`/customers/${id}/checkins`),
  customerPlannedVisits: (id) => request(`/customers/${id}/planned-visits`),
  getVisitSchedule: (id) => request(`/customers/${id}/visit-schedule`),
  getMapFacts: (id) => request(`/customers/${id}/map-facts`),
  getMapFactsBatch: (ids) => request(`/customers/map-facts?ids=${ids.join(",")}`),
  customerOrderedProducts: (id) => request(`/customers/${id}/ordered-products`),

  createCheckin: (formData) =>
    request("/checkins", { method: "POST", body: formData }),
  listCheckins: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/checkins${qs ? `?${qs}` : ""}`);
  },
  checkinPhotoByIdUrl: (photoId) => `/api/checkins/photos/${photoId}`,
  deleteCheckinPhotoById: (photoId) => request(`/checkins/photos/${photoId}`, { method: "DELETE" }),

  dashboardSummary: () => request("/dashboard/summary"),
  dashboardTrends: () => request("/dashboard/trends"),
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
  deleteUser: (id) => request(`/users/${id}`, { method: "DELETE" }),
  getUserDeletionReport: (id) => request(`/users/${id}/deletion-report`),
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

  createEditRequest: (customerId, changes, note) =>
    json("/edit-requests", "POST", { customer_id: customerId, changes, note }),
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
  saveVisitPlanRule: (dayOfWeek, areas, userId, customerIds) =>
    json(`/visit-plans/rules/${dayOfWeek}`, "PUT", { areas, user_id: userId, customer_ids: customerIds }),
  getRoutePlansOverview: () => request("/visit-plans/rules/overview"),
  getRoutePlanCustomers: (userId) => request(`/visit-plans/rules/customers${userId ? `?user_id=${userId}` : ""}`),

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
  lookupRouteDistribution: (region, subregion) => {
    const qs = new URLSearchParams({ region, ...(subregion ? { subregion } : {}) }).toString();
    return request(`/route-distribution/lookup?${qs}`);
  },
  bulkRouteDistribution: (items) => json("/route-distribution/bulk", "PUT", { items }),
  createRouteDistribution: (data) => json("/route-distribution", "POST", data),
  updateRouteDistribution: (id, data) => json(`/route-distribution/${id}`, "PATCH", data),
  deleteRouteDistribution: (id) => request(`/route-distribution/${id}`, { method: "DELETE" }),

  listTaskAssignees: () => request("/tasks/assignees"),
  listTasks: (params = {}) => request(`/tasks?${new URLSearchParams(params).toString()}`),
  getTask: (id) => request(`/tasks/${id}`),
  createTask: (data) => json("/tasks", "POST", data),
  updateTask: (id, data) => json(`/tasks/${id}`, "PATCH", data),
  completeTask: (id, note, extra = {}) => json(`/tasks/${id}/complete`, "POST", { ...(note ? { note } : {}), ...extra }),
  reopenTask: (id) => json(`/tasks/${id}/reopen`, "POST", {}),
  setTaskItemDone: (id, itemId, done) => json(`/tasks/${id}/items/${itemId}`, "POST", { done }),
  getTaskCustomerFlags: () => request("/tasks/customer-flags"),
  createOrder: (data) => json("/orders", "POST", data),
  submitOrder: (id, erpCustomerId) => json(`/orders/${id}/submit`, "POST", erpCustomerId ? { erp_customer_id: erpCustomerId } : {}),
  listOrders: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/orders${qs ? `?${qs}` : ""}`);
  },
  getOrder: (id) => request(`/orders/${id}`),
  listOrderDocuments: (id) => request(`/orders/${id}/documents`),
  listCustomerDocuments: (id) => request(`/customers/${id}/documents`),
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
  getCreditHistory: (customerId) => request(`/customers/${customerId}/credit-history`),
  setCreditLimit: (customerId, limit) => json(`/customers/${customerId}/credit-terms`, "PUT", { credit_limit_amd: limit }),
  approveOrderCredit: (id) => request(`/orders/${id}/approve-credit`, { method: "POST" }),
  rejectOrderCredit: (id) => request(`/orders/${id}/reject-credit`, { method: "POST" }),
  getErpCandidates: (id) => request(`/orders/${id}/erp-candidates`),
  linkOrderToErp: (id, erpOrderId) => json(`/orders/${id}/link-erp`, "POST", { erp_order_id: erpOrderId }),
  markOrderDeliveredWithoutRoute: (id) => request(`/orders/${id}/mark-delivered`, { method: "POST" }),

  // Warehouse (see server/src/routes/warehouse.js)
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
