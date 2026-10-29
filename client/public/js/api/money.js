// Part of the `api` object of ../api.js (docs/architecture-roadmap.md, step 8): joined back there with ...moneyApi.
import { bankForm, json, request } from "./core.js";

export const moneyApi = {
  expenses: () => request("/expenses", { fresh: true }),
  expensesRunNow: () => json("/expenses/run-now", "POST", {}),
  expensesDismiss: (id) => json(`/expenses/alerts/${id}/dismiss`, "POST", {}),
  antiFraud: () => request("/anti-fraud", { fresh: true }),
  antiFraudRunNow: () => json("/anti-fraud/run-now", "POST", {}),
  antiFraudVerdict: (id, status, note) => json(`/anti-fraud/alerts/${id}`, "PATCH", { status, note }),
  antiFraudSpotCheck: (id, status, note) => json(`/anti-fraud/spot-checks/${id}`, "PATCH", { status, note }),
  antiFraudSettings: (patch) => json("/anti-fraud/settings", "PUT", patch),
  // Warehouse (see server/src/orders/routes/warehouse.js)
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
  // Bank statements (see server/src/money/routes/bankStatements.js)
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
  // Cash custody chain (see server/src/money/routes/cashHandoffs.js) -- the
  // hand-to-hand journey of the physical cash, layered on top of the
  // payment rows above.
  getHandoffAvailable: (asUserId) =>
    request(`/cash-handoffs/available${asUserId ? `?as_user_id=${asUserId}` : ""}`),
  getHandoffSenders: () => request("/cash-handoffs/senders"),
  listCashHandoffs: (offset = 0) => request(`/cash-handoffs?offset=${offset}`),
  getCashHandoff: (id) => request(`/cash-handoffs/${id}`),
  createCashHandoff: (data) => json("/cash-handoffs", "POST", data),
  // body: { counted_amd, note } -- what the receiver counted; a different amount needs a note (document flow, 1.453.0)
  confirmCashHandoff: (id, body = {}) => json(`/cash-handoffs/${id}/confirm`, "POST", body),
  listCashSheets: () => request("/cash-sheets"),
  markCashSheetRecorded: (id, recorded = true) => json(`/cash-sheets/${id}/recorded`, "POST", { recorded }),
  rejectCashHandoff: (id, reason) => json(`/cash-handoffs/${id}/reject`, "POST", { reason }),
  listCashExpenses: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/cash-expenses${qs ? `?${qs}` : ""}`);
  },
  createCashExpense: (data) => json("/cash-expenses", "POST", data),
  updateCashExpense: (id, data) => json(`/cash-expenses/${id}`, "PATCH", data),
  deleteCashExpense: (id) => request(`/cash-expenses/${id}`, { method: "DELETE" }),
  // Debt balances (see server/src/money/routes/debtBalances.js) -- read-only,
  // role-scoped server-side already.
  getDebtBalances: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/debt-balances${qs ? `?${qs}` : ""}`);
  },
};
