import { api } from "../api.js";
import { escapeHtml, formatDateDMY, formatAmd, groupDigits } from "../util.js";
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
      // release 3c: a delivered app order is Paid / Partly paid / Unpaid by the live debt (the oldest orders are paid first)
      api
        .getAppOrdersPaid(customerId)
        .then((paid) => {
          for (const [id, p] of Object.entries(paid.orders ?? {})) {
            const row = appEl.querySelector(`[data-app-order="${id}"]`);
            if (!row || row.querySelector(".erp-order-due, .erp-order-partial")) continue;
            const chip =
              Number(p.unpaid_amd) <= 0
                ? `<span class="due-chip due-chip-ok">${t("app_order_paid")}</span>`
                : Number(p.unpaid_amd) < Number(p.total_amd)
                  ? `${dueChipHtml(p.due_days)} <span class="muted">${formatAmd(Number(p.unpaid_amd))}</span>`
                  : dueChipHtml(p.due_days);
            row.insertAdjacentHTML("beforeend", `<div class="erp-order-due">${chip}</div>`);
          }
        })
        .catch(() => {});
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
      // say why: no Excel ID linked, or none of that ID's orders in the Excel (owner, 2026-11-07, customer 10255)
      listEl.innerHTML = `<p class="empty-state">${t("no_orders_found")}</p><p class="muted empty-state-why">${escapeHtml(
        customer.erp_customer_id ? t("no_orders_for_erp_id").replace("{id}", customer.erp_customer_id) : t("no_orders_no_erp_id")
      )}</p>`;
      return;
    }
    const subtotal = orders.reduce((sum, o) => sum + Number(o.total_amd || 0), 0);
    // The part of the debt older than the Excel order history: the opening balance (paper era).
    const openingUnpaid = Number(customer.debt_summary?.opening_unpaid_amd) || 0;
    const openingDueDays = customer.debt_summary?.opening_due_days ?? null;
    const visible = orders.slice(0, shown);
    const hidden = orders.length - visible.length;
    // Grouped by year, newest first, each year with its subtotal (owner, 2026-11-07); a row shows date, order, items, liters, brands, amount.
    const byYear = new Map();
    orders.forEach((o, i) => {
      const year = String(o.order_date || "").slice(0, 4) || "—";
      if (!byYear.has(year)) byYear.set(year, { year, rows: [], amount: 0, liters: 0, count: 0 });
      const g = byYear.get(year);
      g.amount += Number(o.total_amd) || 0;
      g.liters += Number(o.liters) || 0;
      g.count += 1;
      if (i < shown) g.rows.push([o, i]);
    });
    const num = (n) => groupDigits(Math.round(Number(n) || 0));
    const liters = (n) => `${groupDigits(Math.round((Number(n) || 0) * 10) / 10)} L`;
    const brandsHtml = (list) =>
      (Array.isArray(list) ? list : []).map((b) => `<span class="co-brand">${escapeHtml(b)}</span>`).join("");
    const rowHtml = (o, i) => {
      const chips = [partialChipHtml(o), Number(o.unpaid_amd) > 0 ? dueChipHtml(o.due_days) : ""].filter(Boolean).join(" ");
      return `
          <div class="erp-order-row co-row ${unpaidRowClass(o)}" data-order-index="${i}" data-order-id="${escapeHtml(o.order_id)}" role="button" tabindex="0">
            <span class="co-date">${escapeHtml(formatDateDMY(o.order_date))}</span>
            <span class="co-id erp-order-id">${escapeHtml(o.order_id)}</span>
            <span class="co-items">${num(o.items_qty)} ${t("co_pcs")}</span>
            <span class="co-liters">${liters(o.liters)}</span>
            <span class="co-brands">${brandsHtml(o.brands)}</span>
            <span class="co-amount">${formatAmd(o.total_amd)}</span>
            ${chips ? `<span class="co-chips">${chips}</span>` : ""}
          </div>`;
    };
    listEl.innerHTML = `
      <div class="card erp-card co-card">
        <div class="co-row co-head" aria-hidden="true">
          <span class="co-date">${t("co_col_date")}</span><span class="co-id">${t("co_col_order")}</span><span class="co-items">${t("co_col_items")}</span>
          <span class="co-liters">${t("co_col_liters")}</span><span class="co-brands">${t("co_col_brands")}</span><span class="co-amount">${t("co_col_amount")}</span>
        </div>
        ${[...byYear.values()]
          .map(
            (g) => `
          <div class="co-year">
            <strong class="co-year-label">${escapeHtml(g.year)}</strong>
            <span class="co-year-facts muted">${g.count} ${t(g.count === 1 ? "co_orders_one" : "co_orders")} · ${liters(g.liters)}</span>
            <strong class="co-year-amount">${formatAmd(g.amount)}</strong>
          </div>
          ${g.rows.map(([o, i]) => rowHtml(o, i)).join("")}`
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

  // Any failure -- the request, or drawing the answer -- ends in a message with Retry, never in a loading line that stays for ever
  // (owner, 2026-11-03: the order history of one customer "loads for ever").
  const showError = (err) => {
    if (!listEl.isConnected) return;
    listEl.innerHTML = `<p class="form-error">${escapeHtml(err?.message || String(err))}</p><button type="button" class="btn" id="orders-retry">${t("retry")}</button>`;
    listEl.querySelector("#orders-retry").addEventListener("click", () => renderCustomerOrders(root, navigate, customerId));
  };
  const source = allOrdersSource(customerId);
  try {
    await loadWithCache(source.key, source.fetch, (orders) => {
      const json = JSON.stringify(orders);
      if (json === lastJson) return;
      lastJson = json;
      render(orders).catch(showError);
    });
  } catch (err) {
    showError(err);
  }
}
