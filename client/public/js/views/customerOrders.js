import { api } from "../api.js";
import { escapeHtml, formatDateDMY, formatAmd } from "../util.js";
import { t } from "../i18n.js";
import { dueChipHtml, unpaidRowClass, partialChipHtml } from "../debtChip.js";
import { loadWithCache } from "../listCache.js";
import { allOrdersSource } from "../customerCardData.js";

// The first rows painted before "Show more": a customer can have 1,000+ orders and drawing them all at once froze the page.
const FIRST_ROWS = 60;

export async function renderCustomerOrders(root, navigate, customerId) {
  root.innerHTML = `<div class="detail-view"><p class="loading-state" role="status">${t("loading")}</p></div>`;
  const container = root.querySelector(".detail-view");

  // The page opens from the last copy kept on this phone and corrects itself when the fresh list lands; the (small) customer record
  // is fetched alongside, so the heading never waits for the 100 KB order list.
  const customerPromise = api.getCustomer(customerId);
  customerPromise.catch(() => {});

  container.innerHTML = `
    <div class="detail-header">
      <button class="icon-btn" id="back-btn" aria-label="${t("back")}">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
      </button>
      <div class="detail-header-title">
        <h1>${t("all_orders")}</h1>
        <span class="badge badge-neutral" id="orders-customer-name" hidden></span>
      </div>
    </div>
    <div class="card-list card-list-spaced" id="orders-list"><p class="loading-state" role="status">${t("loading")}</p></div>
  `;

  // Back = one step back in history (the customer card, restored from the back stack), never a new
  // forward navigation to it -- that left the orders page one more Back away.
  container.querySelector("#back-btn").addEventListener("click", () => navigate.goBack(`#/customers/${customerId}`));

  const listEl = container.querySelector("#orders-list");
  const nameEl = container.querySelector("#orders-customer-name");
  customerPromise.then((customer) => {
    nameEl.textContent = customer.name;
    nameEl.hidden = false;
  }).catch(() => {});

  let shown = FIRST_ROWS;
  let lastJson = "";
  const render = async (orders) => {
    let customer;
    try {
      customer = await customerPromise;
    } catch (err) {
      listEl.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
      return;
    }
    if (!listEl.isConnected) return;
    if (!orders.length) {
      listEl.innerHTML = `<p class="empty-state">${t("no_orders_found")}</p>`;
      return;
    }
    const subtotal = orders.reduce((sum, o) => sum + Number(o.total_amd || 0), 0);
    // The part of the debt older than the Excel order history: the opening balance (paper era).
    const openingUnpaid = Number(customer.debt_summary?.opening_unpaid_amd) || 0;
    const openingDueDays = customer.debt_summary?.opening_due_days ?? null;
    const visible = orders.slice(0, shown);
    const hidden = orders.length - visible.length;
    listEl.innerHTML = `
      <div class="card erp-card">
        ${visible
          .map(
            (o, i) => `
          <div class="erp-order-row ${unpaidRowClass(o)}" data-order-index="${i}" data-order-id="${escapeHtml(o.order_id)}" role="button" tabindex="0">
            <span>${escapeHtml(formatDateDMY(o.order_date))}</span>
            <span class="erp-order-id">${escapeHtml(o.order_id)}</span>
            <span>${formatAmd(o.total_amd)}</span>
            ${partialChipHtml(o) ? `<div class="erp-order-partial">${partialChipHtml(o)}</div>` : ""}
            ${Number(o.unpaid_amd) > 0 ? `<div class="erp-order-due">${dueChipHtml(o.due_days)}</div>` : ""}
          </div>`
          )
          .join("")}
        ${hidden > 0 ? `<button type="button" class="btn btn-block" id="more-orders-btn">${t("show_more_n").replace("{n}", hidden)}</button>` : ""}
        ${
          openingUnpaid > 0
            ? `<div class="erp-order-row erp-order-opening unpaid-row ${openingDueDays != null && openingDueDays > 0 ? "unpaid-row-overdue" : "unpaid-row-due"}">
                 <span>${escapeHtml(formatDateDMY("2025-05-01"))}</span>
                 <span class="erp-order-id">${t("opening_balance_label")}</span>
                 <span>${formatAmd(openingUnpaid)}</span>
                 <div class="erp-order-due">${dueChipHtml(openingDueDays)}</div>
               </div>`
            : ""
        }
        <div class="erp-order-row erp-order-subtotal-row">
          <span></span>
          <span class="erp-order-subtotal-label">${t("orders_subtotal")}</span>
          <span>${formatAmd(subtotal)}</span>
        </div>
      </div>
    `;
    listEl.querySelector("#more-orders-btn")?.addEventListener("click", () => {
      shown = orders.length;
      render(orders);
    });
    const { openOrderDetailSheet } = await import("./customerDetail.js");
    listEl.querySelectorAll(".erp-order-row[data-order-index]").forEach((row) => {
      row.addEventListener("click", () => openOrderDetailSheet(customerId, row.dataset.orderId, orders[Number(row.dataset.orderIndex)]));
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          row.click();
        }
      });
    });
  };

  const source = allOrdersSource(customerId);
  try {
    await loadWithCache(source.key, source.fetch, (orders) => {
      const json = JSON.stringify(orders);
      if (json === lastJson) return;
      lastJson = json;
      render(orders);
    });
  } catch (err) {
    listEl.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
  }
}
