import { api } from "../api.js";
import { escapeHtml, formatDateDMY, formatAmd } from "../util.js";
import { t } from "../i18n.js";
import { dueChipHtml, unpaidRowClass, partialChipHtml } from "../debtChip.js";
import { loadWithCache } from "../listCache.js";
import { allOrdersSource } from "../customerCardData.js";
import { orderStatusMeta, openOrderDetailSheet as openAppOrderSheet } from "../orderDetailSheet.js";

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
    <div id="app-orders"></div>
    <div class="card-list card-list-spaced" id="orders-list"><p class="loading-state" role="status">${t("loading")}</p></div>
  `;

  // Back = one step back in history (the customer card, restored from the back stack), never a new
  // forward navigation to it -- that left the orders page one more Back away.
  container.querySelector("#back-btn").addEventListener("click", () => navigate.goBack(`#/customers/${customerId}`));

  const listEl = container.querySelector("#orders-list");

  // Orders placed in the app (drafts too) that Excel does not have yet (owner, 2026-10-27): on top, with their status, so the list is complete
  // from the moment an order is placed. Once the accountant enters it in Excel it is matched and shows only once, in the Excel list below.
  const appEl = container.querySelector("#app-orders");
  api
    .listOrders({ customer_id: customerId }, { fresh: true })
    .then((r) => {
      const open = (r.rows ?? []).filter((o) => !o.erp_matched_order_id && !o.cancelled_at && !o.delivered_from_erp);
      if (!open.length || !appEl.isConnected) return;
      appEl.innerHTML = `
        <div class="sales-heading-with-hint">
          <h2 class="section-title section-title-tight">${t("app_orders_title")}</h2>
          <button type="button" class="settings-hint-icon" id="app-orders-hint" aria-label="${t("more_info")}" aria-expanded="false">!</button>
        </div>
        <p class="muted app-orders-hint" id="app-orders-hint-text" hidden>${t("app_orders_hint")}</p>
        <div class="card erp-card">
          ${open
            .map((o) => {
              const meta = orderStatusMeta(o);
              return `<div class="erp-order-row app-order-row" data-app-order="${o.id}" role="button" tabindex="0">
                <span>${escapeHtml(formatDateDMY(o.created_at))}</span>
                <span class="erp-order-id">${escapeHtml(o.order_code || `#${o.id}`)} <span class="badge ${meta.cls}">${t(meta.key)}</span></span>
                <span>${formatAmd(o.total_amd)}</span>
              </div>`;
            })
            .join("")}
        </div>`;
      const hint = appEl.querySelector("#app-orders-hint");
      hint.addEventListener("click", () => {
        const open = hint.getAttribute("aria-expanded") === "true";
        hint.setAttribute("aria-expanded", String(!open));
        appEl.querySelector("#app-orders-hint-text").hidden = open;
      });
      appEl.querySelectorAll("[data-app-order]").forEach((row) => {
        const go = () => openAppOrderSheet(Number(row.dataset.appOrder), { navigate });
        row.addEventListener("click", go);
        row.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), go()));
      });
    })
    .catch(() => {});
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
