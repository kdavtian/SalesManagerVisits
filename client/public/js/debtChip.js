// "Due: 71 days" chips and the unpaid-order highlight. Payments clear the oldest invoices first
// (FIFO, computed on the server: unpaid_amd / due_days on every order, see server/src/debtAge.js);
// the credit term is already deducted from due_days: > 0 = that many days overdue, <= 0 = due in
// that many days.
import { t } from "./i18n.js";
import { formatAmd, labelColon } from "./util.js";

export function dueChipHtml(dueDays, { extraClass = "" } = {}) {
  if (dueDays == null) return "";
  const days = Math.abs(dueDays);
  let text;
  let cls;
  if (dueDays > 0) {
    text = `${t("debt_due_overdue_prefix")}${days}${t("debt_days_suffix")}`;
    cls = "due-chip-overdue";
  } else {
    cls = "due-chip-soon";
    text = dueDays === 0 ? t("debt_due_today") : `${t("debt_due_in_prefix")}${days}${t("debt_days_suffix")}`;
  }
  return `<span class="due-chip ${cls} ${extraClass}">${text}</span>`;
}

// Row highlight: red = past its due date, amber = unpaid but still within the credit term.
export function unpaidRowClass(order) {
  if (!(Number(order?.unpaid_amd) > 0) || order.due_days == null) return "";
  return order.due_days > 0 ? "unpaid-row unpaid-row-overdue" : "unpaid-row unpaid-row-due";
}

// How much of an order is still owed when it is only partly paid (null when fully unpaid).
export function partialChipHtml(order) {
  if (!(Number(order?.unpaid_amd) > 0) || order.due_days == null) return "";
  if (Number(order.unpaid_amd) >= Number(order.total_amd) - 1) return "";
  return `<span class="due-chip due-chip-amount">${t("debt_unpaid_amount")}${labelColon()}${formatAmd(order.unpaid_amd)}</span>`;
}
