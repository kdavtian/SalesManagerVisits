// Customer card > the ERP (Excel) numbers card (moved out of customerDetail.js with the refactor tool, docs/architecture-roadmap.md
// step 6).
import { escapeHtml, formatAmd, formatDayMonth, labelColon, parseDateOnly } from "../../util.js";
import { t } from "../../i18n.js";
import { dueChipHtml } from "../../debtChip.js";
import { icons } from "../../icons.js";

export function renderErpCard(customer, erpOrders) {
  if (!customer.erp_synced_at) return customer.erp_customer_id && customer.erp_last_order_date ? renderErpOrdersOnlyCard(customer, erpOrders) : "";

  const debt = Number(customer.erp_debt_amd) || 0;
  const collectedSinceSync = Number(customer.collected_since_sync_amd) || 0;
  const estimatedDebt = customer.estimated_debt_amd != null ? Number(customer.estimated_debt_amd) : null;
  const isDataError = customer.erp_aging_bucket === "Data error - review";
  const orders = Array.isArray(erpOrders) ? erpOrders : [];

  const now = new Date();
  const salesThisMonth = orders
    .filter((o) => {
      // order_date is a plain calendar date (no time) -- parseDateOnly avoids
      // the UTC-midnight-parsing bug that shifted an order into the wrong
      // month near a month boundary for a viewer behind UTC.
      const d = parseDateOnly(o.order_date);
      return d && d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
    })
    .reduce((sum, o) => sum + Number(o.total_amd), 0);
  // customer.erp_last_order_date is unbounded (a plain MAX(order_date), see
  // GET /customers/:id) -- unlike orders[0], which only reflects the
  // "recent" (last 3 months) scope this page's own order list fetches for
  // the "Sales this month" tile above. Without it, a customer whose last
  // order predates that window showed "-" here despite having order
  // history, just not within it. orders[0] is still the fallback for an
  // older cached customer object (offline/stale listCache) that hasn't
  // picked up the new field yet.
  // Same style as the Last visit tile ("12 Oct 2026" / "12 Հկտ 2026").
  const dayMonthYear = (value) => {
    const d = parseDateOnly(value);
    return d ? formatDayMonth(d, { year: true }) : null;
  };
  const lastOrderDate = customer.erp_last_order_date
    ? dayMonthYear(customer.erp_last_order_date)
    : orders[0]
      ? dayMonthYear(orders[0].order_date)
      : null;

  return statTilesHtml({
    customer,
    salesThisMonth,
    debtText: isDataError ? t("erp_debt_unknown") : formatAmd(debt),
    // Red only while some unpaid invoice is past its due date (FIFO, credit term deducted -- the
    // same rule as the chip, the reports and the tasks), or the data is broken. A 0 balance is fine.
    debtDanger: isDataError || (debt > 0 && (customer.debt_summary?.oldest_due_days ?? 0) > 0),
    // A return the customer is owed but Excel has not booked yet (migration 143): shown at once, it lowers the debt once the accountant records it.
    debtSub: [
      !isDataError && collectedSinceSync > 0 ? `${t("estimated_remaining")}${labelColon()}${formatAmd(estimatedDebt)}` : "",
      returnCreditText(customer),
    ]
      .filter(Boolean)
      .join(" · "),
    // Days past (or until) the due date of the oldest unpaid invoice, credit term deducted.
    debtChip: !isDataError && debt > 0 ? dueChipHtml(customer.debt_summary?.oldest_due_days) : "",
    lastOrderDate,
  });
}

// The four stat tiles under the customer's facts. Each is a button: Sales ->
// the customer's orders, Outstanding debt -> payments received, Last order ->
// that order's details, Last visit -> that visit's details (handlers are
// attached in renderCustomerDetail through data-stat).
export function statTilesHtml({ customer, salesThisMonth, debtText, debtDanger, debtSub = "", debtChip = "", lastOrderDate }) {
  const tile = (stat, icon, value, label, { danger = false, sub = "", disabled = false, chip = "" } = {}) => `
      <button type="button" class="detail-stat-tile detail-stat-tile-btn ${danger ? "detail-stat-danger" : ""}" data-stat="${stat}" ${disabled ? "disabled" : ""}>
        ${chip ? `<span class="detail-stat-chip">${chip}</span>` : ""}
        <span class="detail-stat-icon">${icon}</span>
        <span class="detail-stat-value">${value}</span>
        <span class="detail-stat-label">${label}</span>
        ${sub ? `<span class="detail-stat-sublabel">${sub}</span>` : ""}
      </button>`;
  return `
    <div class="detail-stat-grid">
      ${tile("sales", icons.cart, formatAmd(salesThisMonth), t("sales_this_month"))}
      ${tile("debt", icons.payment, debtText, t("outstanding_debt"), { danger: debtDanger, sub: [debtSub, lastPaymentLine(customer)].filter(Boolean).join("<br />"), chip: debtChip })}
      ${tile("last-order", icons.box, lastOrderDate ? escapeHtml(lastOrderDate) : "—", t("last_order"), { disabled: !lastOrderDate })}
      ${
        // A customer that is never visited (10001, 10002 ...: KF/CAS/CVO/PCO/OEM channels): "Last visit" means nothing there, so the tile shows
        // the last payment, date and amount, and opens the payments (owner, 2026-10-27).
        customer.requires_visit === false
          ? tile("last-payment", icons.payment, lastPaymentDate(customer) ?? "—", t("last_payment"), {
              disabled: !lastPaymentDate(customer),
              sub: customer.last_payment?.amount_amd ? formatAmd(customer.last_payment.amount_amd) : "",
            })
          : tile("last-visit", icons.clock, customer.last_visit_at ? formatDayMonth(new Date(customer.last_visit_at), { year: true }) : "—", t("last_visit"), { disabled: !customer.last_visit_at })
      }
    </div>
  `;
}

// "Last payment: 24 Oct 2026 · 199,700" under the debt (owner, 2026-10-27): payment habit next to the debt on every card. A customer that is
// never visited already shows it in its own tile, so not twice.
export function lastPaymentLine(customer) {
  if (customer.requires_visit === false) return "";
  const date = lastPaymentDate(customer);
  if (!date) return "";
  const amount = customer.last_payment?.amount_amd ? ` · ${formatAmd(customer.last_payment.amount_amd)}` : "";
  return `${t("last_payment")}${labelColon()}${escapeHtml(date)}${amount}`;
}

export function lastPaymentDate(customer) {
  const d = parseDateOnly(customer.last_payment?.date ?? customer.erp_last_payment_date);
  return d ? formatDayMonth(d, { year: true }) : null;
}

export const returnCreditText = (customer) => (Number(customer.pending_return_credit?.amd) > 0 ? `${t("rt_credit_pending")}${labelColon()}${formatAmd(customer.pending_return_credit.amd)}` : "");

// Same four tiles as the full card. With no debt-summary row the ERP sync
// found no current debt for this customer (its customers[] list always
// includes anyone who owes), so the debt tile reads 0.
export function renderErpOrdersOnlyCard(customer, erpOrders) {
  const orders = Array.isArray(erpOrders) ? erpOrders : [];
  const now = new Date();
  const salesThisMonth = orders
    .filter((o) => {
      const d = parseDateOnly(o.order_date);
      return d && d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
    })
    .reduce((sum, o) => sum + Number(o.total_amd), 0);
  const lastOrderDate = parseDateOnly(customer.erp_last_order_date) ? formatDayMonth(parseDateOnly(customer.erp_last_order_date), { year: true }) : null;
  return statTilesHtml({ customer, salesThisMonth, debtText: formatAmd(0), debtDanger: false, debtSub: returnCreditText(customer), lastOrderDate });
}
