// Part of the `api` object of ../api.js (docs/architecture-roadmap.md, step 8): joined back there with ...customersApi.
import { APP_VERSION } from "../version.js";
import { t } from "../i18n.js";
import { dropCachedCustomerLists, patchCachedCustomer, removeCachedCustomer } from "../listCache.js";
import { competitorNotDue, getCsrfToken, json, normalizeCustomer, rememberCompetitors, request } from "./core.js";

export const customersApi = {
  getCustomerRegions: () => request("/customers/regions"),
  getBrandStatusByCustomer: () => request("/customers/brand-status"),
  getBrandSummary: (params = {}) => request(`/customers/brand-summary${params.customer_id ? `?customer_id=${encodeURIComponent(params.customer_id)}` : ""}`),
  lookupTin: (tin) => request(`/customers/tin-lookup?tin=${encodeURIComponent(tin)}`),
  listCustomers: async (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    const rows = await request(`/customers${qs ? `?${qs}` : ""}`);
    const list = Array.isArray(rows) ? rows.map(normalizeCustomer) : rows;
    rememberCompetitors(list);
    const operationalQueue = params?.visited === "overdue" || params?.visited === "not_visited";
    return list.filter((c) => !(operationalQueue && c?.customer_tier === "competitor")).map(competitorNotDue);
  },
  getPotentialSummary: () => request("/customers/potential-summary", { fresh: true }),
  setCustomerPotential: (id, data) => json(`/customers/${id}/potential`, "PUT", data),
  getPotentialHistory: (id) => request(`/customers/${id}/potential-history`, { fresh: true }),
  resolveCounterfeit: (id, data) => json(`/customers/${id}/counterfeit-resolve`, "POST", data),
  createCustomer: async (data) => {
    const created = await json("/customers", "POST", data);
    await dropCachedCustomerLists();
    return normalizeCustomer(created);
  },
  getCustomer: async (id) => {
    const c = normalizeCustomer(await request(`/customers/${id}`));
    rememberCompetitors(c);
    return competitorNotDue(c);
  },
  getPinReview: () => request("/pin-review"),
  acceptPinReview: (customerId) => json(`/pin-review/${customerId}/accept`, "POST", {}),
  dismissPinReview: (customerId) => json(`/pin-review/${customerId}/dismiss`, "POST", {}),
  getCheckinSpots: (id) => request(`/customers/${id}/checkin-spots`),
  getCustomerProductPrices: (id) => request(`/customers/${id}/product-prices`),
  saveCustomerProductPrices: (id, prices) => json(`/customers/${id}/product-prices`, "PUT", { prices }),
  updateCustomer: async (id, data) => {
    const updated = await json(`/customers/${id}`, "PATCH", data);
    // Patch with what the server returned (falling back to what we sent) so
    // the Customers list is already right when the rep navigates back.
    await patchCachedCustomer(id, updated && typeof updated === "object" && !Array.isArray(updated) ? updated : data);
    return normalizeCustomer(updated);
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
  getReorderProfile: (id, from) => request(`/customers/${id}/reorder-profile${from ? `?from=${encodeURIComponent(from)}` : ""}`),
  placeReviews: (status = "pending") => json(`/places/reviews?status=${status}`),
  placeReviewsCount: () => json("/places/reviews/count"),
  placeReviewResolve: (id, body) => json(`/places/reviews/${id}/resolve`, "POST", body),
  placeCleanup: () => json("/places/cleanup"),
  placeCleanupApply: () => json("/places/cleanup/apply", "POST", {}),
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
  getCustomerPaymentsReceived: (customerId) => request(`/customers/${customerId}/payments-received`),
  getErpOrders: (customerId, scope = "recent") => request(`/customers/${customerId}/erp-orders?scope=${scope}`),
  getErpOrderDetail: (customerId, orderId) =>
    request(`/customers/${customerId}/erp-orders/${encodeURIComponent(orderId)}`),
  reverseGeocode: (lat, lng) => request(`/geocode/reverse?lat=${lat}&lng=${lng}`),
  searchAddress: (q) => request(`/geocode/search?q=${encodeURIComponent(q)}`),
  // One-page Armenian PDF of the customer's unpaid invoices (debt statement).
  buildDebtStatement: async (customerId) => {
    const res = await fetch(`/api/customers/${customerId}/debt-statement`, { credentials: "include", headers: { "X-App-Version": APP_VERSION } });
    if (!res.ok) {
      const err = await res.json().catch(() => null);
      throw new Error(err?.error || t("pdf_failed"));
    }
    return res.blob();
  },
  suggestCustomerNameNumber: (base) => request(`/customers/name-suggestion?${new URLSearchParams({ base })}`, { fresh: true }),
  getPotentialReasonMemory: () => request("/customers/potential-reason-memory", { fresh: true }),
  getCustomerDebtFlags: () => request("/customers/debt-flags"),
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
  getCreditStatus: (customerId) => request(`/customers/${customerId}/credit-status`),
  getRecentOrders: (customerId) => request(`/customers/${customerId}/recent-orders`),
  getOrderDefaults: (customerId) => request(`/customers/${customerId}/order-defaults`),
  getCreditHistory: (customerId) => request(`/customers/${customerId}/credit-history`),
  setCreditLimit: (customerId, limit) => json(`/customers/${customerId}/credit-terms`, "PUT", { credit_limit_amd: limit }),
  getVisitPriorities: () => request("/customers/visit-priorities"),
};
