import { api } from "../api.js";
import { escapeHtml } from "../util.js";
import { t } from "../i18n.js";

function formatAmd(value) {
  if (value == null) return "";
  return `${Number(value).toLocaleString()} ${t("amd")}`;
}

export async function renderCustomerOrders(root, navigate, customerId) {
  root.innerHTML = `<div class="detail-view"><p class="muted">…</p></div>`;
  const container = root.querySelector(".detail-view");

  let customer, orders;
  try {
    [customer, orders] = await Promise.all([api.getCustomer(customerId), api.getErpOrders(customerId, "all")]);
  } catch (err) {
    container.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    return;
  }

  container.innerHTML = `
    <div class="detail-header">
      <button class="icon-btn" id="back-btn" aria-label="${t("cancel")}">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
      </button>
      <div class="detail-header-title">
        <h1>${t("all_orders")}</h1>
        <span class="badge badge-neutral">${escapeHtml(customer.name)}</span>
      </div>
    </div>
    <div class="card-list" id="orders-list"></div>
  `;

  container.querySelector("#back-btn").addEventListener("click", () => {
    navigate(`#/customers/${customerId}`);
  });

  const listEl = container.querySelector("#orders-list");
  if (!orders.length) {
    listEl.innerHTML = `<p class="muted">${t("no_orders_found")}</p>`;
  } else {
    listEl.innerHTML = `
      <div class="card erp-card">
        ${orders
          .map(
            (o) => `
          <div class="erp-order-row" data-order-id="${escapeHtml(o.order_id)}" role="button" tabindex="0">
            <span>${escapeHtml(String(o.order_date).slice(0, 10))}</span>
            <span class="erp-order-id">${escapeHtml(o.order_id)}</span>
            <span>${formatAmd(o.total_amd)}</span>
          </div>`
          )
          .join("")}
      </div>
    `;
    listEl.querySelectorAll(".erp-order-row").forEach((row) => {
      row.addEventListener("click", async () => {
        const { openOrderDetailSheet } = await import("./customerDetail.js");
        openOrderDetailSheet(customerId, row.dataset.orderId);
      });
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          row.click();
        }
      });
    });
  }
}
