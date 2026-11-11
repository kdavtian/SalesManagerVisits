// Part of the `api` object of ../api.js (docs/architecture-roadmap.md, step 8): joined back there with ...productsApi.
import { APP_VERSION } from "../version.js";
import { t } from "../i18n.js";
import { getCsrfToken, json, request } from "./core.js";

export const productsApi = {
  getFrequentProducts: () => request("/products/frequent"),
  listProducts: (q = "") => request(`/products${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  listAllProducts: () => request("/products/all"),
  getProductSyncDiagnostics: () => request("/products/sync-diagnostics"),
  getProductDuplicates: () => request("/products/duplicates"),
  createProduct: (data) => json("/products", "POST", data),
  // Purchases (server/src/products/routes/purchases.js)
  listPurchases: (params = {}) => request(`/purchases?${new URLSearchParams(Object.entries(params).filter(([, v]) => v)).toString()}`, { fresh: true }),
  getPurchase: (id) => request(`/purchases/${id}`, { fresh: true }),
  getExcelPurchase: (invoiceNo, date) => request(`/purchases/excel-invoice?${new URLSearchParams({ invoice_no: invoiceNo, date }).toString()}`, { fresh: true }),
  savePurchase: (id, data) => json(id ? `/purchases/${id}` : "/purchases", id ? "PUT" : "POST", data),
  deletePurchase: (id) => request(`/purchases/${id}`, { method: "DELETE" }),
  listSuppliers: () => request("/purchases/suppliers", { fresh: true }),
  getPurchasesStatus: () => request("/purchases/status", { fresh: true }),
  getPurchaseHistory: (ids, exclude = {}) => request(`/purchases/product-history?${new URLSearchParams({ ids: ids.join(","), ...(exclude.no && exclude.date ? { exclude_no: exclude.no, exclude_date: exclude.date } : {}) }).toString()}`, { fresh: true }),
  importPurchasesExcel: (file) => {
    const form = new FormData();
    form.set("file", file);
    return request("/purchases/import-excel", { method: "POST", body: form });
  },
  updateProduct: (id, data) => json(`/products/${id}`, "PATCH", data),
  deleteProduct: (id) => request(`/products/${id}`, { method: "DELETE" }),
  resyncProduct: (id) => request(`/products/${id}/resync`, { method: "POST" }),
  listProductPromos: (id) => request(`/products/${id}/promos`),
  createProductPromo: (id, data) => json(`/products/${id}/promos`, "POST", data),
  deleteProductPromo: (id, promoId) => request(`/products/${id}/promos/${promoId}`, { method: "DELETE" }),
  getProductHoldingOrders: (id) => request(`/products/${id}/holding-orders`, { fresh: true }),
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
  // { w: 160 | 320 | 800 } a resized copy; { v } the stored file name, so a changed photo gets a new address (the photo is cached a year)
  productImageUrl: (id, { w, v } = {}) => `/api/products/${id}/image${w || v ? `?${new URLSearchParams({ ...(w ? { w } : {}), ...(v ? { v } : {}) })}` : ""}`,
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
};
