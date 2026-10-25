// "Is this payment in the Excel?" -- the workbook's cashflow has a row for the same customer, the same amount, within 5 days of the payment
// (the same window as the "unrecorded" figure on Debt balances). A payment younger than 3 days is not called missing yet.
// Shared by the Payments page (routes/payments.js) and the anti-fraud watch (antiFraud.js). `p` is the alias of payments.
export const EXCEL_GRACE_DAYS = 3;
export const EXCEL_MATCH_DAYS = 5;
export const PAYMENT_DAY = "((p.payment_date AT TIME ZONE 'Asia/Yerevan')::date)";
export const IN_EXCEL_SQL = `(p.approved_from_erp OR (p.erp_customer_id_snapshot IS NOT NULL AND EXISTS (
    SELECT 1 FROM erp_cashflow_lines cf WHERE cf.erp_customer_id = p.erp_customer_id_snapshot AND cf.amount_amd > 0
      AND ROUND(cf.amount_amd) = ROUND(p.amount_amd) AND cf.cashflow_date BETWEEN ${PAYMENT_DAY} - ${EXCEL_MATCH_DAYS} AND ${PAYMENT_DAY} + ${EXCEL_MATCH_DAYS})))`;
export const DAYS_OLD_SQL = `((now() AT TIME ZONE 'Asia/Yerevan')::date - ${PAYMENT_DAY})`;
