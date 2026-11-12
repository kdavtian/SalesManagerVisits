// Part of the `api` object of ../api.js (docs/architecture-roadmap.md, step 8): joined back there with ...reportsApi.
import { getCsrfToken, json, request } from "./core.js";
import { APP_VERSION } from "../version.js";

export const reportsApi = {
  // The Pivot report (admin and CEO): sources, results, filter values, saved views, Excel / PDF files
  pivotSources: () => request("/pivot/sources"),
  pivotRun: (spec) => json("/pivot/run", "POST", { spec }),
  pivotValues: (spec, field, q = "", bucket = null) => json("/pivot/values", "POST", { spec, field, q, bucket }),
  pivotViews: () => request("/pivot/views", { fresh: true }),
  pivotSaveView: (data) => json("/pivot/views", "POST", data),
  pivotUpdateView: (id, data) => json(`/pivot/views/${id}`, "PATCH", data),
  pivotDeleteView: (id) => json(`/pivot/views/${id}`, "DELETE", {}),
  pivotExport: async (payload) => {
    const res = await fetch("/api/pivot/export", {
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
  getVolumeReport: (params) => request(`/volume-report?${new URLSearchParams(params).toString()}`),
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
  dashboardSummary: () => request("/dashboard/summary"),
  dashboardKpis: () => request("/dashboard/kpis"),
  dashboardToday: () => request("/dashboard/today"),
  dashboardTrends: () => request("/dashboard/trends"),
  getRepProgress: (period) => request(`/dashboard/rep-progress?period=${encodeURIComponent(period)}`),
  closeOutMonth: (month) => json("/dashboard/points/close-out", "POST", { month }),
  listMonthlyCloseouts: (month) => request(`/dashboard/points/closeouts${month ? `?month=${month}` : ""}`),
  getMySalesPerformance: () => request("/sales-performance/me"),
  getSalesPerformanceLeaderboard: (period = "ytd") => request(`/sales-performance/?period=${period}`),
  getScorecard: (week) => request(`/biz-reports/scorecard${week ? `?week=${week}` : ""}`),
  getUnpaidInvoices: (params = {}) => request(`/biz-reports/unpaid-invoices?${new URLSearchParams(params).toString()}`),
  getDeliverySpeed: (days) => request(`/biz-reports/delivery-speed?days=${days}`),
  getCustomerPipeline: () => request("/biz-reports/pipeline"),
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
  getProductWishesReport: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/reports/product-wishes${qs ? `?${qs}` : ""}`);
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
  // the sales directions and their rules (admin panel, owner 2026-11-12)
  listSalesChannels: ({ counts = false } = {}) => request(`/sales-channels${counts ? "?counts=1" : ""}`),
  createSalesChannel: (data) => json("/sales-channels", "POST", data),
  updateSalesChannel: (id, data) => json(`/sales-channels/${id}`, "PATCH", data),
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
  // Sales records (see server/src/reports/routes/sales.js) -- read-only ERP order
  // history, role-scoped server-side already.
  getSales: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/sales${qs ? `?${qs}` : ""}`);
  },
  getSalesOrder: (erpCustomerId, orderId) =>
    request(`/sales/order?${new URLSearchParams({ erp_customer_id: erpCustomerId, order_id: orderId }).toString()}`),
};
