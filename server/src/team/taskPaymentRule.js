// How big a payment must be to close a "collect the debt" task (owner, 2026-11-08): at least MIN(20,000 AMD, the debt balance before it).
// A 1 AMD payment must not close the task, make Vaghinak create a new one next night, or count as a collected task in the scorecard; a customer
// who owes 5,000 closes it by paying the 5,000. Used by the app's own payment events (taskAutoComplete.js) and, as a sum of the payments
// since the task was made, by the workbook's cashflow rules (money/debtCollectionTasks.js).
export const MIN_TASK_PAYMENT_AMD = 20000;

// debtBefore: what the customer owed before the payment(s); unknown or zero -> the plain limit
export function taskPaymentThreshold(debtBefore) {
  const debt = Number(debtBefore);
  return debt > 0 ? Math.min(MIN_TASK_PAYMENT_AMD, debt) : MIN_TASK_PAYMENT_AMD;
}

export function paymentCountsForTask(amount, debtBefore) {
  return Number(amount) >= taskPaymentThreshold(debtBefore) - 0.5; // whole AMD: half a dram of rounding is not a reason to refuse
}
