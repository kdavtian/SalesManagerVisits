// Customer card > payments received, order detail and the pending change request (moved out of customerDetail.js with the refactor
// tool, docs/architecture-roadmap.md step 6).
import { api } from "../../api.js";
import { dockSheet } from "../../dockSheet.js";
import { reorderHash } from "../../reorder.js";
import { activateDialog, erpLineDiscountRowHtml, escapeHtml, formatAmd, formatDateDMY, leaveSheetTo } from "../../util.js";
import { t } from "../../i18n.js";
import { icons } from "../../icons.js";
import { canReviewCustomerEdits, state } from "../../state.js";
import { seesAmountPapers } from "../../shared/roles.js";
import { openFileReadySheet } from "../../fileReadySheet.js";
import { loadWithCache } from "../../listCache.js";
import { allOrdersSource, orderDetailSource, paymentsSource } from "../../customerCardData.js";
import { dueChipHtml, partialChipHtml, unpaidRowClass } from "../../debtChip.js";

// Long lists (payments, orders, photos) paint this many rows first and the rest on "Show more": 1,000 rows at once froze a phone.
export const FIRST_ROWS = 40;

// Payments received from this customer: the Excel Cashflow ("Oil order" rows)
// plus payments recorded in the app (pending / approved), newest first.
// Opens at once from the last copy kept on this phone and corrects itself when the fresh list lands (owner, 2026-10-26: "it loads every
// time user taps"); only the first rows are drawn until "Show more", so a customer with hundreds of payments does not freeze the sheet.
// Rows grouped by calendar year, newest first (owner, 2026-11-07): a header row with the year and the whole year's subtotal goes in front of
// each year's first row. `rows` = what is drawn (maybe only the first page); `all` = every row, for the subtotal.
function withYearHeaders(rows, all, dateOf, amountOf, rowHtml) {
  const totals = new Map();
  for (const r of all) {
    const y = String(dateOf(r) || "").slice(0, 4);
    totals.set(y, (totals.get(y) || 0) + (Number(amountOf(r)) || 0));
  }
  let year = null;
  return rows
    .map((r, i) => {
      const y = String(dateOf(r) || "").slice(0, 4);
      const head = y !== year ? `<div class="payments-received-row pr-year-row"><strong>${escapeHtml(y || "—")}</strong><span></span><strong class="text-amount">${formatAmd(totals.get(y) || 0)}</strong></div>` : "";
      year = y;
      return head + rowHtml(r, i);
    })
    .join("");
}

export async function openPaymentsReceivedSheet(customer) {
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `<div class="sheet"><button type="button" class="icon-btn sheet-close-x" data-action="close-sheet" aria-label="${t("close")}">${icons.close}</button><p class="loading-state" role="status">${t("loading")}</p></div>`;
  document.body.appendChild(overlay);
  dockSheet(overlay, `customer-payments:${customer.id}`);
  activateDialog(overlay);
  overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());
  overlay.querySelector('[data-action="close-sheet"]').addEventListener("click", () => overlay.remove());

  const sourceBadge = (r) =>
    r.source === "excel"
      ? `<span class="badge badge-neutral">${t("payments_source_excel")}</span>`
      : `<span class="badge ${r.status === "approved" ? "badge-success" : "badge-warning"}">${t("payments_source_app")} · ${t(r.status === "approved" ? "payment_status_approved" : "payment_status_pending")}</span>`;
  let shown = FIRST_ROWS;
  let lastJson = "";
  const render = (data) => {
    const visible = data.rows.slice(0, shown);
    const hidden = data.rows.length - visible.length;
    overlay.querySelector(".sheet").innerHTML = `
    <button type="button" class="icon-btn sheet-close-x" data-action="close-sheet" aria-label="${t("close")}">${icons.close}</button>
    <h2>${t("payments_received_title")}</h2>
    <p class="muted">${escapeHtml(customer.name)}</p>
    ${
      data.rows.length
        ? `<div class="card erp-card payments-received-list">
            ${withYearHeaders(
              visible,
              data.rows,
              (r) => r.date,
              (r) => r.amount_amd,
              (r) => `<div class="payments-received-row${r.source === "excel" ? "" : " payments-received-row-app"}">
                  <span class="payments-received-date">${escapeHtml(formatDateDMY(r.date))}</span>
                  ${sourceBadge(r)}
                  <strong class="text-amount">${formatAmd(r.amount_amd)}</strong>
                </div>`
            )}
            ${hidden > 0 ? `<button type="button" class="btn btn-block" data-action="show-more-payments">${t("show_more_n").replace("{n}", hidden)}</button>` : ""}
            <div class="payments-received-row payments-received-total"><span>${t("total")}</span><span></span><strong class="text-amount">${formatAmd(data.total_amd)}</strong></div>
          </div>`
        : `<p class="empty-state">${t("payments_received_empty")}</p>`
    }
    <p class="form-error" id="debt-statement-error" hidden></p>
    <div class="sheet-actions">
      ${Number(customer.live_debt?.debt_amd ?? customer.erp_debt_amd) > 0 && seesAmountPapers(state.user.role) ? `<button type="button" class="btn" data-action="debt-statement">${t("debt_statement_button")}</button>` : ""}
      <button type="button" class="btn" data-action="close-sheet">${t("done")}</button>
    </div>`;
    overlay.querySelectorAll('[data-action="close-sheet"]').forEach((b) => b.addEventListener("click", () => overlay.remove()));
    overlay.querySelector('[data-action="show-more-payments"]')?.addEventListener("click", () => {
      shown = data.rows.length;
      render(data);
    });
    // Debt statement: the unpaid invoices on one page, ready to send to the customer.
    const statementBtn = overlay.querySelector('[data-action="debt-statement"]');
    statementBtn?.addEventListener("click", async () => {
      const errorEl = overlay.querySelector("#debt-statement-error");
      errorEl.hidden = true;
      statementBtn.disabled = true;
      statementBtn.textContent = t("debt_statement_creating");
      try {
        const blob = await api.buildDebtStatement(customer.id);
        openFileReadySheet(blob, `Debt-statement-${customer.erp_customer_id || customer.id}.pdf`);
      } catch (err) {
        errorEl.textContent = err.message || t("pdf_failed");
        errorEl.hidden = false;
      } finally {
        statementBtn.disabled = false;
        statementBtn.textContent = t("debt_statement_button");
      }
    });
  };
  const source = paymentsSource(customer.id);
  try {
    await loadWithCache(source.key, source.fetch, (data) => {
      if (!overlay.isConnected) return;
      const json = JSON.stringify(data);
      if (json === lastJson) return;
      lastJson = json;
      render(data);
    });
  } catch (err) {
    overlay.querySelector(".sheet").innerHTML = `<button type="button" class="icon-btn sheet-close-x" data-action="close-sheet" aria-label="${t("close")}">${icons.close}</button><p class="form-error">${escapeHtml(err.message)}</p>`;
    overlay.querySelector('[data-action="close-sheet"]').addEventListener("click", () => overlay.remove());
  }
}

// The customer's Excel orders as a sheet beside the card (owner, 2026-11-03: the "Sales this month" tile opens a right-hand sheet like the
// payments do, not a page): newest first, unpaid ones marked, a tap opens the order. Same opening-from-the-saved-copy and "Show more" as
// the payments sheet; any failure shows its message with a Retry (never a loading line that does not end).
export async function openOrdersSheet(customer) {
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  const closeX = `<button type="button" class="icon-btn sheet-close-x" data-action="close-sheet" aria-label="${t("close")}">${icons.close}</button>`;
  overlay.innerHTML = `<div class="sheet">${closeX}<p class="loading-state" role="status">${t("loading")}</p></div>`;
  document.body.appendChild(overlay);
  dockSheet(overlay, `customer-orders:${customer.id}`);
  activateDialog(overlay);
  overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());
  const sheet = overlay.querySelector(".sheet");
  const bindClose = () => sheet.querySelectorAll('[data-action="close-sheet"]').forEach((b) => b.addEventListener("click", () => overlay.remove()));
  bindClose();

  let shown = FIRST_ROWS;
  let lastJson = "";
  const render = (orders) => {
    const visible = orders.slice(0, shown);
    const hidden = orders.length - visible.length;
    const total = orders.reduce((sum, o) => sum + Number(o.total_amd || 0), 0);
    sheet.innerHTML = `
      ${closeX}
      <h2>${t("all_orders")}</h2>
      <p class="muted">${escapeHtml(customer.name)}</p>
      ${
        orders.length
          ? `<div class="card erp-card payments-received-list">
              ${withYearHeaders(
                visible,
                orders,
                (o) => o.order_date,
                (o) => o.total_amd,
                (o, i) => `<button type="button" class="orders-sheet-row ${unpaidRowClass(o)}" data-order-index="${i}">
                    <span class="payments-received-date">${escapeHtml(formatDateDMY(o.order_date))}</span>
                    <span class="orders-sheet-code">${escapeHtml(o.order_id)}</span>
                    <strong class="text-amount">${formatAmd(o.total_amd)}</strong>
                    ${Number(o.unpaid_amd) > 0 ? `<span class="orders-sheet-chips">${partialChipHtml(o)} ${dueChipHtml(o.due_days)}</span>` : ""}
                  </button>`
              )}
              ${hidden > 0 ? `<button type="button" class="btn btn-block" data-action="show-more-orders">${t("show_more_n").replace("{n}", hidden)}</button>` : ""}
              <div class="payments-received-row payments-received-total"><span>${t("total")}</span><span></span><strong class="text-amount">${formatAmd(total)}</strong></div>
            </div>`
          : `<p class="empty-state">${t("no_orders_found")}</p>`
      }
      <div class="sheet-actions"><button type="button" class="btn" data-action="close-sheet">${t("done")}</button></div>`;
    bindClose();
    sheet.querySelector('[data-action="show-more-orders"]')?.addEventListener("click", () => {
      shown = orders.length;
      render(orders);
    });
    sheet.querySelectorAll("[data-order-index]").forEach((row) =>
      row.addEventListener("click", () => {
        const order = orders[Number(row.dataset.orderIndex)];
        openOrderDetailSheet(customer.id, order.order_id, order);
      })
    );
  };
  const source = allOrdersSource(customer.id);
  const load = async () => {
    try {
      await loadWithCache(source.key, source.fetch, (orders) => {
        if (!overlay.isConnected) return;
        const json = JSON.stringify(orders);
        if (json === lastJson) return;
        lastJson = json;
        render(orders);
      });
    } catch (err) {
      sheet.innerHTML = `${closeX}<p class="form-error">${escapeHtml(err.message)}</p><div class="sheet-actions"><button type="button" class="btn btn-primary" data-action="retry-orders">${t("retry")}</button></div>`;
      bindClose();
      sheet.querySelector('[data-action="retry-orders"]').addEventListener("click", () => {
        sheet.innerHTML = `${closeX}<p class="loading-state" role="status">${t("loading")}</p>`;
        bindClose();
        load();
      });
    }
  };
  load();
}

export function groupLinesByBrand(lines) {
  const byBrand = new Map();
  for (const line of lines) {
    const brand = line.brand || t("erp_brand_unspecified");
    if (!byBrand.has(brand)) byBrand.set(brand, []);
    byBrand.get(brand).push(line);
  }
  return byBrand;
}

// preview: the order's row from the list the card already holds (id, date, total), so the sheet shows its header at once and only the
// product lines wait for the network (or for the copy kept from last time).
export async function openOrderDetailSheet(customerId, orderId, preview = null) {
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  document.body.appendChild(overlay);
  dockSheet(overlay, `erp-order:${orderId}`);
  activateDialog(overlay);
  overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());
  const closeX = `<button type="button" class="icon-btn" data-action="close-order-detail" aria-label="${t("close")}">${icons.close}</button>`;
  const headHtml = (id, date, total) => `
    <div class="order-detail-header">
      <h2>${escapeHtml(id)}</h2>
      ${closeX}
    </div>
    <div class="order-detail-meta">
      <span>${escapeHtml(String(date ?? "").slice(0, 10))}</span>
      <span class="erp-debt-amount">${formatAmd(total)}</span>
    </div>`;
  const bindClose = () => overlay.querySelectorAll('[data-action="close-order-detail"]').forEach((b) => b.addEventListener("click", () => overlay.remove()));
  overlay.innerHTML = `<div class="sheet">${preview ? headHtml(preview.order_id, preview.order_date, preview.total_amd) : closeX}<p class="loading-state" role="status">${t("loading")}</p></div>`;
  bindClose();

  const render = (detail) => {
    if (!overlay.isConnected) return;
    const byBrand = groupLinesByBrand(detail.lines);
    const brandSections = [...byBrand.entries()]
      .map(
        ([brand, lines]) => `
      <p class="proposed-changes-label">${escapeHtml(brand)}</p>
      ${lines
        .map(
          (l) => `
        <div class="erp-line-row">
          <span>${escapeHtml(l.product_name || "")}${l.size_l ? ` ${escapeHtml(String(l.size_l))}L` : ""}</span>
          <span class="muted">${escapeHtml(String(l.qty ?? ""))}pcs</span>
          <span>${formatAmd(l.unit_price_amd)}</span>
        </div>
        ${erpLineDiscountRowHtml(l)}`
        )
        .join("")}`
      )
      .join("");
    overlay.querySelector(".sheet").innerHTML = `
    ${headHtml(detail.order_id, detail.order_date, detail.total_amd)}
    ${brandSections}
    <div class="sheet-actions"><button type="button" class="btn btn-primary" id="reorder-erp-order">${t("reorder_btn")}</button></div>
  `;
    bindClose();
    overlay.querySelector("#reorder-erp-order").addEventListener("click", () => {
      leaveSheetTo(overlay, (h) => (location.hash = h), reorderHash(customerId, `erp:${orderId}`));
    });
  };
  const source = orderDetailSource(customerId, orderId);
  let lastJson = "";
  try {
    await loadWithCache(source.key, source.fetch, (detail) => {
      const json = JSON.stringify(detail);
      if (json === lastJson) return;
      lastJson = json;
      render(detail);
    });
  } catch (err) {
    if (overlay.isConnected) {
      overlay.querySelector(".sheet").innerHTML = `${closeX}<p class="form-error">${escapeHtml(err.message)}</p>`;
      bindClose();
    }
  }
}

export function renderPendingRequest(slot, request, onDone) {
  if (!request) {
    slot.innerHTML = "";
    return;
  }

  if (canReviewCustomerEdits()) {
    const changesList = Object.entries(request.changes)
      .map(([field, value]) => `<div class="proposed-change"><strong>${escapeHtml(t(field))}</strong>: ${request.current && field in request.current ? `<span class="muted">${escapeHtml(String(request.current[field] ?? "–"))}</span> &rarr; ` : ""}${escapeHtml(String(value))}</div>`)
      .join("");
    slot.innerHTML = `
      <div class="card pending-request-card">
        <div class="pending-request-header">
          <span class="badge badge-accent">${t("review")}</span>
          <span class="muted">${t("requested_by")} ${escapeHtml(request.requested_by_name)}</span>
        </div>
        <p class="proposed-changes-label">${t("proposed_changes")}</p>
        ${changesList}
        <div class="sheet-actions">
          <button class="btn" id="reject-request-btn">${t("reject")}</button>
          <button class="btn btn-primary" id="approve-request-btn">${t("approve")}</button>
        </div>
      </div>
    `;
    slot.querySelector("#approve-request-btn").addEventListener("click", async () => {
      await api.reviewEditRequest(request.id, "approve");
      window.dispatchEvent(new Event("edit-requests-changed"));
      onDone();
    });
    slot.querySelector("#reject-request-btn").addEventListener("click", async () => {
      await api.reviewEditRequest(request.id, "reject");
      window.dispatchEvent(new Event("edit-requests-changed"));
      onDone();
    });
  } else {
    slot.innerHTML = `
      <div class="card pending-request-card pending-request-card-quiet">
        <span class="badge badge-neutral">${t("pending_edit_request")}</span>
      </div>
    `;
  }
}
