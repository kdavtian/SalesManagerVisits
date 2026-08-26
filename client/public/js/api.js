async function request(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    credentials: "include",
    ...options,
  });

  if (res.status === 204) return null;

  const isJson = res.headers.get("content-type")?.includes("application/json");
  const body = isJson ? await res.json() : null;

  if (!res.ok) {
    throw new Error(body?.error || `Request failed (${res.status})`);
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

  getCustomerRegions: () => request("/customers/regions"),
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
  createUser: (data) => json("/users", "POST", data),
  resetUserPassword: (id, password) => json(`/users/${id}/password`, "PATCH", { password }),
  deleteUser: (id) => request(`/users/${id}`, { method: "DELETE" }),

  getSettings: () => request("/settings"),
  updateSettings: (data) => json("/settings", "PATCH", data),

  getMySalesPerformance: () => request("/sales-performance/me"),
  getSalesPerformanceTeam: () => request("/sales-performance"),

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
  saveVisitPlanRule: (dayOfWeek, areas, userId) =>
    json(`/visit-plans/rules/${dayOfWeek}`, "PUT", { areas, user_id: userId }),

  listProducts: (q = "") => request(`/products${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  listAllProducts: () => request("/products/all"),
  createProduct: (data) => json("/products", "POST", data),
  updateProduct: (id, data) => json(`/products/${id}`, "PATCH", data),
  deleteProduct: (id) => request(`/products/${id}`, { method: "DELETE" }),
  resyncProduct: (id) => request(`/products/${id}/resync`, { method: "POST" }),

  createOrder: (data) => json("/orders", "POST", data),
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

  listCashExpenses: () => request("/cash-expenses"),
  createCashExpense: (data) => json("/cash-expenses", "POST", data),
  updateCashExpense: (id, data) => json(`/cash-expenses/${id}`, "PATCH", data),
  deleteCashExpense: (id) => request(`/cash-expenses/${id}`, { method: "DELETE" }),
};
