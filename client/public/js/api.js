import { APP_VERSION } from "./version.js";

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

async function request(path, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  if (method !== "GET") {
    getCache.clear();
  } else if (CACHEABLE_BASE_PATHS.has(path.split("?")[0])) {
    const cached = getCache.get(path);
    if (cached && cached.expires > Date.now()) return cached.promise;
    const promise = doRequest(path, options);
    getCache.set(path, { expires: Date.now() + GET_CACHE_TTL_MS, promise });
    promise.catch(() => getCache.delete(path));
    return promise;
  }
  return doRequest(path, options);
}

async function doRequest(path, options) {
  const res = await fetch(`/api${path}`, {
    credentials: "include",
    ...options,
    headers: { "X-App-Version": APP_VERSION, ...options.headers },
  });

  if (res.status === 204) return null;

  const isJson = res.headers.get("content-type")?.includes("application/json");
  const body = isJson ? await res.json() : null;

  if (!res.ok) {
    const err = new Error(body?.message || body?.error || `Request failed (${res.status})`);
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
  listCustomers: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/customers${qs ? `?${qs}` : ""}`);
  },
  createCustomer: (data) => json("/customers", "POST", data),
  getCustomer: (id) => request(`/customers/${id}`),
  updateCustomer: (id, data) => json(`/customers/${id}`, "PATCH", data),
  deleteCustomer: (id) => request(`/customers/${id}`, { method: "DELETE" }),
  customerCheckins: (id) => request(`/customers/${id}/checkins`),
  customerPlannedVisits: (id) => request(`/customers/${id}/planned-visits`),
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

  listUsers: () => request("/users"),
  listPlannableUsers: () => request("/users/plannable"),
  listAssignableManagers: () => request("/users/assignable-managers"),
  createUser: (data) => json("/users", "POST", data),
  updateUser: (id, data) => json(`/users/${id}`, "PATCH", data),
  resetUserPassword: (id, password) => json(`/users/${id}/password`, "PATCH", { password }),
  deleteUser: (id) => request(`/users/${id}`, { method: "DELETE" }),

  getSettings: () => request("/settings"),
  updateSettings: (data) => json("/settings", "PATCH", data),

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
  reviewVisitPlan: (id, action) => json(`/visit-plans/${id}`, "PATCH", { action }),
  getVisitPlanRules: (userId) => request(`/visit-plans/rules${userId ? `?user_id=${userId}` : ""}`),
  saveVisitPlanRule: (dayOfWeek, areas, userId, customerIds) =>
    json(`/visit-plans/rules/${dayOfWeek}`, "PUT", { areas, user_id: userId, customer_ids: customerIds }),
  getRoutePlansOverview: () => request("/visit-plans/rules/overview"),

  listProducts: (q = "") => request(`/products${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  listAllProducts: () => request("/products/all"),
  createProduct: (data) => json("/products", "POST", data),
  updateProduct: (id, data) => json(`/products/${id}`, "PATCH", data),
  deleteProduct: (id) => request(`/products/${id}`, { method: "DELETE" }),
  resyncProduct: (id) => request(`/products/${id}/resync`, { method: "POST" }),
  listProductPromos: (id) => request(`/products/${id}/promos`),
  createProductPromo: (id, data) => json(`/products/${id}/promos`, "POST", data),
  deleteProductPromo: (id, promoId) => request(`/products/${id}/promos/${promoId}`, { method: "DELETE" }),
  getProductPriceHistory: (id) => request(`/products/${id}/price-history`),
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
  createRouteDistribution: (data) => json("/route-distribution", "POST", data),
  updateRouteDistribution: (id, data) => json(`/route-distribution/${id}`, "PATCH", data),
  deleteRouteDistribution: (id) => request(`/route-distribution/${id}`, { method: "DELETE" }),

  createOrder: (data) => json("/orders", "POST", data),
  submitOrder: (id, erpCustomerId) => json(`/orders/${id}/submit`, "POST", erpCustomerId ? { erp_customer_id: erpCustomerId } : {}),
  listOrders: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/orders${qs ? `?${qs}` : ""}`);
  },
  getOrder: (id) => request(`/orders/${id}`),
  getOrdersPendingCount: () => request("/orders/pending-count"),
  updateOrderItems: (id, items) => json(`/orders/${id}`, "PATCH", { items }),
  updateOrderStatus: (id, status) => json(`/orders/${id}`, "PATCH", { status }),
  updateOrder: (id, data) => json(`/orders/${id}`, "PATCH", data),
  approveOrderDiscount: (id) => request(`/orders/${id}/approve-discount`, { method: "POST" }),
  deleteOrder: (id) => request(`/orders/${id}`, { method: "DELETE" }),
  rejectOrderDiscount: (id) => request(`/orders/${id}/reject-discount`, { method: "POST" }),
  markOrderDeliveredWithoutRoute: (id) => request(`/orders/${id}/mark-delivered`, { method: "POST" }),

  // Warehouse (see server/src/routes/warehouse.js)
  getWarehousePendingCount: () => request("/warehouse/pending-count"),
  getPickList: () => request("/warehouse/pick-list"),
  getStagingList: () => request("/warehouse/staging-list"),
  getInventory: (q = "", brand = "") => {
    const qs = new URLSearchParams();
    if (q) qs.set("q", q);
    if (brand) qs.set("brand", brand);
    const s = qs.toString();
    return request(`/warehouse/inventory${s ? `?${s}` : ""}`);
  },
  getInventoryBrands: () => request("/warehouse/inventory/brands"),
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
  getRecordedList: (recorded) => request(`/orders/recorded-list?recorded=${recorded ? "true" : "false"}`),
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
  markNotificationRead: (id) => request(`/notifications/${id}/read`, { method: "PATCH" }),
  markAllNotificationsRead: () => request("/notifications/read-all", { method: "PATCH" }),

  listCashExpenses: () => request("/cash-expenses"),
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
  getCustomerDebtReport: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/reports/customer-debt${qs ? `?${qs}` : ""}`);
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
  getDebtBalances: () => request("/debt-balances"),
};
