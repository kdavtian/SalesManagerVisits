// Part of the `api` object of ../api.js (docs/architecture-roadmap.md, step 8): joined back there with ...ordersApi.
import { APP_VERSION } from "../version.js";
import { t } from "../i18n.js";
import { getCsrfToken, json, request } from "./core.js";

export const ordersApi = {
  // Order returns and cancellations (see server/src/orders/orderReturns.js)
  listReturns: (params = {}) => request(`/returns?${new URLSearchParams(params)}`, { fresh: true }),
  getReturnable: (orderId) => request(`/returns/order/${orderId}/returnable`, { fresh: true }),
  getReturnCounts: () => request("/returns/counts", { fresh: true }),
  requestReturn: (data) => json("/returns", "POST", data),
  approveReturn: (id, note) => json(`/returns/${id}/approve`, "POST", { note }),
  rejectReturn: (id, note) => json(`/returns/${id}/reject`, "POST", { note }),
  receiveReturn: (id, items) => json(`/returns/${id}/receive`, "POST", { items }),
  recordReturn: (id) => request(`/returns/${id}/recorded`, { method: "POST" }),
  priceCheckOrder: (body) => json("/orders/price-check", "POST", body),
  getArrivalSettings: () => request("/delivery/arrival-settings", { fresh: true }),
  saveArrivalSettings: (data) => json("/delivery/arrival-settings", "PUT", data),
  arrivalPing: (lat, lng, accuracy) => json("/delivery/arrival", "POST", { lat, lng, accuracy }),
  arrivalDeliver: (customerId) => json("/delivery/arrival/deliver", "POST", { customer_id: customerId }),
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
  createOrder: (data) => json("/orders", "POST", data),
  submitOrder: (id, erpCustomerId) => json(`/orders/${id}/submit`, "POST", erpCustomerId ? { erp_customer_id: erpCustomerId } : {}),
  listOrders: (params = {}, options = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/orders${qs ? `?${qs}` : ""}`, options);
  },
  getOrder: (id) => request(`/orders/${id}`),
  listOrderDocuments: (id) => request(`/orders/${id}/documents`),
  orderDocumentUrl: (docId) => `/api/orders/documents/${docId}/file`,
  orderDocumentPreviewUrl: (docId) => `/api/orders/documents/${docId}/preview`,
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
  approveOrderCredit: (id) => request(`/orders/${id}/approve-credit`, { method: "POST" }),
  rejectOrderCredit: (id) => request(`/orders/${id}/reject-credit`, { method: "POST" }),
  getErpCandidates: (id) => request(`/orders/${id}/erp-candidates`),
  linkOrderToErp: (id, erpOrderId) => json(`/orders/${id}/link-erp`, "POST", { erp_order_id: erpOrderId }),
  markOrderDeliveredWithoutRoute: (id) => request(`/orders/${id}/mark-delivered`, { method: "POST" }),
  getWarehouseHome: () => request("/warehouse/home", { fresh: true }),
  getWarehousePackedList: () => request("/warehouse/packed-list", { fresh: true }),
  getDeliveryHome: () => request("/delivery/home", { fresh: true }),
  // Stock count (Գույքագրում, server/src/orders/stockCount.js)
  getStockCountDay: (day) => request(`/stock-count/day${day ? `?day=${day}` : ""}`, { fresh: true }),
  saveStockCount: (productId, qty, note) => json(`/stock-count/items/${productId}`, "PUT", { qty, note }),
  clearStockCount: (productId) => request(`/stock-count/items/${productId}`, { method: "DELETE" }),
  finishStockCountDay: () => json("/stock-count/finish", "POST", {}),
  getStockCountMonth: (month) => request(`/stock-count/month${month ? `?month=${month}` : ""}`, { fresh: true }),
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
  getReorderSuggestions: () => request("/warehouse/reorder-suggestions"),
  getInventoryBrands: () => request("/warehouse/inventory/brands"),
  getInventorySizes: () => request("/warehouse/inventory/sizes"),
  markOrderPacked: (id) => request(`/warehouse/orders/${id}/packed`, { method: "POST" }),
  bulkMarkOrdersPacked: (orderIds) => json("/warehouse/orders/bulk-packed", "POST", { order_ids: orderIds }),
  flagOrderStockIssue: (id, note) => json(`/warehouse/orders/${id}/stock-issue`, "POST", { note }),
  // Delivery routes (see server/src/orders/routes/delivery.js)
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
  // Order rejection + accountant "Recorded" screen (see server/src/orders/routes/orders.js)
  rejectOrder: (id, note) => json(`/orders/${id}/reject`, "POST", { note }),
  unconfirmOrder: (id) => json(`/orders/${id}/unconfirm`, "POST", {}),
  getRecordedList: (recorded, offset = 0) =>
    request(`/orders/recorded-list?recorded=${recorded ? "true" : "false"}&offset=${offset}`),
  getUnrecordedCount: () => request("/orders/unrecorded-count"),
  setOrderRecorded: (id, recorded) => json(`/orders/${id}/recorded`, "PATCH", { recorded }),
  createPaymentFromPod: (podRecordId) => json(`/delivery/pod-records/${podRecordId}/create-payment`, "POST"),
  addWish: (body) => json("/wishes", "POST", body),
  listWishes: (customerId) => request(`/wishes?customer_id=${encodeURIComponent(customerId)}`),
  // KAD OS link, supplier side (server/src/orders/routes/appOrdersAdmin.js): app-order perks, account links, campaigns.
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
};
