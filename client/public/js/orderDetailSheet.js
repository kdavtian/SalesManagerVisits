// The full order-detail sheet (status, line items, timeline, and every
// role-gated action: confirm/reject, edit, discount approval, mark
// delivered, delete). Originally lived only inside views/orders.js's list
// closure; extracted so other screens that know an order id -- the Activity
// tab's "Order placed" outcome row, for one -- can open the exact same
// sheet without re-implementing it.
import { api } from "./api.js";
import { escapeHtml, formatAmd, activateDialog, formatDateTime, customerNameLinkHtml, activateCustomerNameLinks } from "./util.js";
import { t } from "./i18n.js";
import { icons } from "./icons.js";
import { state } from "./state.js";
import { getProductCatalog } from "./productCatalog.js";
import { searchProducts, debounce } from "./productSearch.js";
import { compareProducts } from "./productSort.js";
import { openAccountingDocSheet, accountingDocLabel, ACCOUNTING_STATUS_BADGE } from "./accountingDocSheet.js";

// v3 5-state machine (see migrations/051_warehouse_delivery_v3.sql):
// draft -> submitted -> confirmed -> packed_stock_out -> delivered, every
// exception looping back to draft. `iconTint` picks the shared
// .list-row-icon-* tint variant (see styles.css) so a list row's leading
// icon color always matches its trailing status badge's color family.
export const STATUS_META = {
  draft: { key: "order_status_draft", cls: "badge-warning", iconTint: "warning" },
  submitted: { key: "order_status_submitted", cls: "badge-neutral", iconTint: "neutral" },
  confirmed: { key: "order_status_confirmed", cls: "badge-success", iconTint: "success" },
  packed_stock_out: { key: "order_status_packed_stock_out", cls: "badge-info", iconTint: "info" },
  delivered: { key: "order_status_delivered", cls: "badge-success", iconTint: "success" },
};

// Payment-method chip: cash = yellow, invoice = blue (same everywhere).
export function paymentMethodBadgeHtml(method) {
  if (!method) return "";
  const cash = method === "cash";
  return `<span class="badge ${cash ? "badge-warning" : "badge-info"}">${t(cash ? "payment_method_cash" : "payment_method_invoice")}</span>`;
}

const APPROVAL_META = {
  pending: { key: "approval_status_pending", cls: "badge-warning" },
  approved: { key: "approval_status_approved", cls: "badge-success" },
  rejected: { key: "approval_status_rejected", cls: "badge-danger" },
};

// Fulfillment status changes (packed_stock_out/delivered) go through the
// dedicated Warehouse and Delivery screens (see views/warehouse.js and
// views/deliveryRoute.js), which collect the required extra data (pick
// confirmation, route stop, signature). This sheet only drives confirm and
// director-reject.
const SELF_APPROVING_ROLES = new Set(["ceo", "operations_director", "admin"]);
const sortProducts = (list) => [...list].sort(compareProducts);
const DISCOUNT_APPROVER_ROLES = new Set(["admin", "sales_director", "ceo", "operations_director"]);
// Who reviews a freshly-submitted order -- mirrors canConfirmOrders in the
// server's roles.js.
const CONFIRM_ROLES = new Set(["admin", "sales_director", "ceo", "operations_director"]);
// Who can move a packed order straight to delivered without a planned
// route -- mirrors canMarkDeliveredWithoutRoute in the server's roles.js.
// Exists because the driver (delivery_manager) role isn't currently using
// the app to complete routes through the normal signature-capturing flow
// (see views/deliveryRoute.js), which otherwise leaves a routed order with
// no way back into view.
const MARK_DELIVERED_ROLES = new Set(["delivery_manager", "sales_director", "accountant", "ceo", "operations_director", "admin"]);

// Full created -> submitted -> confirmed -> packed -> delivered timeline
// (server/src/routes/orders.js's order_status_history, populated at every
// real transition -- see migration 070). A draft-exception loop (rejected/
// stock-issue/delivery-failure) shows up here too since it's a real status
// change, not something to hide -- it's exactly the kind of thing this was
// asked to make visible.
const ACCOUNTING_ELIGIBLE = new Set(["confirmed", "packed_stock_out", "delivered"]);

// Where the order stands with accounting (Lily): which document, its
// status, the created document numbers, or what went wrong.
function accountingSectionHtml(order) {
  if (!order.accounting_status) return "";
  const docs = Array.isArray(order.accounting_documents) ? order.accounting_documents : [];
  const err = order.accounting_error;
  return `
    <h3 class="list-group-heading">${t("acc_section_title")}</h3>
    <p><span class="badge badge-neutral">${accountingDocLabel(order.accounting_doc_type === "waybill" ? "cash" : "invoice")}</span>
      <span class="badge ${ACCOUNTING_STATUS_BADGE[order.accounting_status] ?? "badge-neutral"}">${t(`acc_status_${order.accounting_status}`)}</span></p>
    ${docs
      .map(
        (d) =>
          `<p class="muted">№ ${escapeHtml(d.hc_doc_number)}${d.brand ? ` · ${escapeHtml(d.brand)}` : ""} · ${escapeHtml(d.date)}${
            d.einvoicing?.status ? ` · ${t(`acc_einv_${d.einvoicing.status}`)}` : ""
          }</p>`
      )
      .join("")}
    ${err ? `<p class="form-error">${escapeHtml(err.message || err.code)}</p>` : ""}`;
}

// Plain-language "what happens next" for statuses that wait on someone else.
// Shown with the matching timeline step instead of as a huge disabled button.
const WAITING_HINT = { confirmed: "confirmed_awaiting_warehouse", packed_stock_out: "packed_awaiting_route" };

function orderTimelineHtml(history, currentStatus) {
  if (!history?.length) return "";
  const lastIdx = history.map((h) => h.new_status).lastIndexOf(currentStatus);
  return `
    <h3 class="list-group-heading">${t("order_timeline_title")}</h3>
    <div class="order-timeline">
      ${history
        .map((h, idx) => {
          const meta = STATUS_META[h.new_status];
          const hint = idx === lastIdx && WAITING_HINT[currentStatus] ? `<span class="order-step-hint">${t(WAITING_HINT[currentStatus])}</span>` : "";
          const label = meta ? t(meta.key) : escapeHtml(h.new_status);
          return `
        <div class="order-timeline-step">
          <span class="order-timeline-dot ${meta ? meta.cls : "badge-neutral"}"></span>
          <div class="order-timeline-body">
            <strong>${label}</strong>
            <span class="order-line-meta">${formatDateTime(h.changed_at)}${h.changed_by_name ? ` · ${escapeHtml(h.changed_by_name)}` : ""}${h.reason ? ` · ${escapeHtml(h.reason)}` : ""}</span>
            ${hint}
          </div>
        </div>`;
        })
        .join("")}
    </div>`;
}

// A manager's order can mix e.g. Lotos 5W-30 1L and Royal 5W-30 1L -- the
// brand line (small, muted) keeps those from reading as duplicate rows.
// Unit price sits in the same small font next to the quantity, sum stays
// bold, so a multi-line order still fits on one screen.
function orderLineHtml(i) {
  return `
    <div class="order-line-row">
      ${i.brand ? `<span class="order-line-brand">${escapeHtml(i.brand)}</span>` : ""}
      <div class="order-line-top">
        <span class="order-line-name">${escapeHtml(i.product_name)}${i.size ? ` · ${escapeHtml(i.size)}` : ""}</span>
        <strong class="text-amount">${formatAmd(Number(i.line_total_amd))}</strong>
      </div>
      <span class="order-line-meta">${formatAmd(Number(i.unit_price_amd))} &times; ${Number(i.quantity)}</span>
    </div>`;
}

function notifyOrdersChanged() {
  window.dispatchEvent(new Event("orders-changed"));
}

// `onChanged` is called after any action that alters the order (confirm,
// reject, submit, edit, mark delivered, delete) -- callers with their own
// list to refresh (views/orders.js) pass their `load()`; callers with
// nothing to refresh (a read-mostly detail popup opened from elsewhere)
// can omit it. `orders-changed` still fires globally either way, for the
// nav badge and other passive listeners.
// `navigate` is the app router's own navigate(hash) (see app.js) -- tapping
// the customer name inside the sheet closes it and routes there. Falls back
// to setting location.hash directly for a caller that doesn't have one handy.
export async function openOrderDetailSheet(orderId, { onChanged, navigate } = {}) {
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `<div class="sheet"><p class="loading-state" role="status">${t("loading")}</p></div>`;
  document.body.appendChild(overlay);
  activateDialog(overlay);
  overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());

  let order;
  try {
    order = await api.getOrder(orderId);
  } catch (err) {
    overlay.querySelector(".sheet").innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    return;
  }

  renderView(order);

  function renderView(order) {
    const meta = STATUS_META[order.status] ?? STATUS_META.submitted;
    const isOwnerOrAdmin = order.user_id === state.user.id || state.user.role === "admin";
    // A director/admin reviewing a fresh order gets confirm/reject/edit;
    // the rep who placed it (or an admin) can still edit it too while
    // it's waiting on that review.
    const canReviewSubmitted = CONFIRM_ROLES.has(state.user.role) && order.status === "submitted";
    // A draft is editable too (server/src/routes/orders.js's PATCH /:id
    // already accepted this -- this button just never offered it), owner/
    // admin only since canReviewSubmitted is always false for a draft (a
    // director has nothing to review yet).
    const canEditThisOrder = (order.status === "submitted" || order.status === "draft") && (isOwnerOrAdmin || canReviewSubmitted);
    const discountAmd = Number(order.discount_amd) || 0;
    const discountPct = Number(order.discount_pct) || 0;
    const hasDiscount = discountAmd > 0 || discountPct > 0;
    const approvalMeta = APPROVAL_META[order.approval_status];
    // A pending or rejected discount blocks fulfillment server-side too --
    // don't offer a forward-status button that would just 409.
    const canApproveDiscount = DISCOUNT_APPROVER_ROLES.has(state.user.role) && order.approval_status === "pending";

    overlay.querySelector(".sheet").innerHTML = `
      <button type="button" class="sheet-close-x" data-action="close-sheet" aria-label="${t("close")}">${icons.close}</button>
      <div class="order-detail-ids">
        <span>${t("customer_id_label")}: ${escapeHtml(order.erp_customer_id || String(order.customer_id))}</span>
        ${order.order_code ? `<span>${t("order_id_label")}: ${escapeHtml(order.order_code)}</span>` : ""}
      </div>
      <h2 class="order-detail-customer">${customerNameLinkHtml(order.customer_name, order.customer_id)}</h2>
      <p><span class="badge ${meta.cls}">${t(meta.key)}</span>${
      order.payment_method ? ` ${paymentMethodBadgeHtml(order.payment_method)}` : ""
    }${
      hasDiscount && approvalMeta ? ` <span class="badge ${approvalMeta.cls}">${t(approvalMeta.key)}</span>` : ""
    }</p>
      <div class="card-list" style="margin:12px 0;">
        ${order.items.map((i) => orderLineHtml(i)).join("")}
      </div>
      ${
        hasDiscount
          ? `<p class="muted">${t("price_change_label")}: ${discountAmd > 0 ? formatAmd(discountAmd) : `${discountPct}%`}</p>`
          : ""
      }
      <p>${t("total")}: <span class="text-amount">${formatAmd(Number(order.total_amd))}</span></p>
      ${order.note ? `<p class="muted">${escapeHtml(order.note)}</p>` : ""}
      ${accountingSectionHtml(order)}
      ${orderTimelineHtml(order.history, order.status)}
      <p class="form-error" id="order-detail-error" hidden></p>
      <div class="sheet-actions" id="order-detail-actions" style="flex-wrap:wrap;"></div>
    `;

    const actionsEl = overlay.querySelector("#order-detail-actions");
    const errorEl = overlay.querySelector("#order-detail-error");

    activateCustomerNameLinks(overlay, (hash) => {
      overlay.remove();
      if (navigate) navigate(hash);
      else location.hash = hash;
    });

    const buttons = [];
    if (order.status === "draft" && isOwnerOrAdmin) {
      if (order.draft_reason) {
        buttons.push({ label: `${t("draft_reason_label")}: ${order.draft_reason}`, action: "noop", cls: "btn", disabledDisplay: true });
      }
      buttons.push({ label: t("submit_order"), action: "submit-order", cls: "btn btn-primary" });
    }
    if (canApproveDiscount) {
      buttons.push({ label: t("approve_price_change"), action: "approve-discount", cls: "btn btn-primary" });
      buttons.push({ label: t("reject_price_change"), action: "reject-discount", cls: "btn btn-danger" });
    }
    if (canReviewSubmitted) {
      buttons.push({ label: t("confirm_order"), status: "confirmed", cls: "btn btn-primary" });
      buttons.push({ label: t("reject_order"), action: "reject-order", cls: "btn btn-danger" });
    }
    if (CONFIRM_ROLES.has(state.user.role) && ACCOUNTING_ELIGIBLE.has(order.status) && ["pending", "needs_attention", null].includes(order.accounting_status ?? null)) {
      buttons.push({
        label: order.accounting_status === "needs_attention" ? t("acc_send_again") : order.accounting_status === "pending" ? t("acc_change_document") : t("acc_send_to_accounting"),
        action: "accounting-document",
        cls: "btn",
      });
    }
    if (CONFIRM_ROLES.has(state.user.role) && ["waybill_created", "partially_created", "exported_unsigned"].includes(order.accounting_status)) {
      buttons.push({ label: t("acc_mark_signed"), action: "accounting-signed", cls: "btn" });
    }
    if (order.status === "packed_stock_out") {
      // No route/signature required here -- see canMarkDeliveredWithoutRoute
      // in server/src/roles.js for why this manual override exists.
      if (MARK_DELIVERED_ROLES.has(state.user.role)) {
        buttons.push({ label: t("mark_delivered_no_route"), action: "mark-delivered", cls: "btn btn-primary" });
      }
    }
    if (canEditThisOrder) {
      buttons.push({ label: t("edit_order"), action: "edit-order", cls: "btn" });
    }
    // Permanent delete (distinct from a director's reject, which keeps
    // the order as a record back at draft) -- admin only, for a
    // duplicate or mistaken order.
    if (state.user.role === "admin") {
      buttons.push({ label: t("delete_order"), action: "delete-order", cls: "btn btn-danger" });
    }

    actionsEl.innerHTML = buttons
      .map(
        (b) =>
          `<button type="button" class="${b.cls}" ${b.disabledDisplay ? "disabled" : ""} ${
            b.action ? `data-action="${b.action}"` : `data-status="${b.status}"`
          }>${b.label}</button>`
      )
      .join("") || `<button type="button" class="btn" id="order-detail-close">${t("done")}</button>`;

    actionsEl.querySelector("#order-detail-close")?.addEventListener("click", () => overlay.remove());
    overlay.querySelector('[data-action="close-sheet"]')?.addEventListener("click", () => overlay.remove());
    actionsEl.querySelectorAll("[data-status]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        actionsEl.querySelectorAll("button").forEach((b) => (b.disabled = true));
        try {
          const updatedOrder = await api.updateOrderStatus(orderId, btn.dataset.status);
          if (btn.dataset.status === "confirmed") window.dispatchEvent(new Event("warehouse-changed"));
          overlay.remove();
          // Confirmed: offer the waybill / invoice right away, on top of
          // the screen the director is already looking at.
          if (btn.dataset.status === "confirmed") {
            await openAccountingDocSheet({ id: orderId, payment_method: updatedOrder?.payment_method ?? order.payment_method });
          }
          notifyOrdersChanged();
          onChanged?.();
        } catch (err) {
          errorEl.textContent = err.message;
          errorEl.hidden = false;
          actionsEl.querySelectorAll("button").forEach((b) => (b.disabled = false));
        }
      });
    });
    actionsEl.querySelectorAll("[data-action]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (btn.dataset.action === "edit-order") {
          renderEditMode(order);
          return;
        }
        if (btn.dataset.action === "accounting-signed") {
          if (!confirm(t("acc_confirm_signed"))) return;
          try {
            await api.markAccountingSigned(orderId);
            renderView(await api.getOrder(orderId));
            notifyOrdersChanged();
            onChanged?.();
          } catch (err) {
            errorEl.textContent = err.message;
            errorEl.hidden = false;
          }
          return;
        }
        if (btn.dataset.action === "accounting-document") {
          overlay.remove();
          await openAccountingDocSheet(order);
          notifyOrdersChanged();
          onChanged?.();
          return;
        }
        if (btn.dataset.action === "delete-order" && !confirm(t("confirm_delete_order"))) return;
        if (btn.dataset.action === "mark-delivered" && !confirm(t("confirm_mark_delivered_no_route"))) return;
        if (btn.dataset.action === "reject-order") {
          if (!confirm(t("confirm_reject_order"))) return;
          const note = prompt(t("reject_order_note_prompt")) || "";
          actionsEl.querySelectorAll("button").forEach((b) => (b.disabled = true));
          try {
            await api.rejectOrder(orderId, note.trim());
            overlay.remove();
            notifyOrdersChanged();
            onChanged?.();
          } catch (err) {
            errorEl.textContent = err.message;
            errorEl.hidden = false;
            actionsEl.querySelectorAll("button").forEach((b) => (b.disabled = false));
          }
          return;
        }
        if (btn.dataset.action === "submit-order" && !order.erp_customer_id) {
          const erpId = prompt(t("erp_customer_id_required"));
          if (!erpId || !erpId.trim()) return;
          actionsEl.querySelectorAll("button").forEach((b) => (b.disabled = true));
          try {
            await api.submitOrder(orderId, erpId.trim());
            overlay.remove();
            notifyOrdersChanged();
            onChanged?.();
          } catch (err) {
            errorEl.textContent = err.message;
            errorEl.hidden = false;
            actionsEl.querySelectorAll("button").forEach((b) => (b.disabled = false));
          }
          return;
        }
        actionsEl.querySelectorAll("button").forEach((b) => (b.disabled = true));
        try {
          if (btn.dataset.action === "approve-discount") await api.approveOrderDiscount(orderId);
          else if (btn.dataset.action === "reject-discount") await api.rejectOrderDiscount(orderId);
          else if (btn.dataset.action === "submit-order") await api.submitOrder(orderId);
          else if (btn.dataset.action === "mark-delivered") {
            await api.markOrderDeliveredWithoutRoute(orderId);
            window.dispatchEvent(new Event("delivery-changed"));
          } else await api.deleteOrder(orderId);
          overlay.remove();
          notifyOrdersChanged();
          onChanged?.();
        } catch (err) {
          errorEl.textContent = err.message;
          errorEl.hidden = false;
          actionsEl.querySelectorAll("button").forEach((b) => (b.disabled = false));
        }
      });
    });
  }

  // A lightweight in-place editor for a still-"submitted" order: adjust
  // each line's quantity, drop a line entirely, add a product, and switch the
  // price change between percent and a flat AMD amount.
  //
  // The sheet is built ONCE and then updated in place: the lines list, the
  // total and the product results are re-rendered individually. (It used to
  // rebuild the whole sheet on every tap and every search keystroke, which
  // was slow, dropped the keyboard focus and reset the scroll position.)
  function renderEditMode(order) {
    const lines = order.items.map((i) => ({ ...i }));
    let discountType = Number(order.discount_amd) > 0 ? "amd" : "pct";
    let discountValue = discountType === "amd" ? Number(order.discount_amd) : Number(order.discount_pct);
    // ceo/operations director/admin approve price changes themselves, so
    // the "request ... needs director approval" wording only applies to
    // everyone else.
    const selfApproves = SELF_APPROVING_ROLES.has(state.user.role);
    let productCatalog = null;
    let catalogLoading = false;
    let addProductQuery = "";

    const subtotal = () => lines.reduce((sum, l) => sum + Number(l.unit_price_amd) * Number(l.quantity), 0);
    const total = () => {
      const sub = subtotal();
      return discountType === "amd" ? Math.max(0, sub - discountValue) : sub * (1 - discountValue / 100);
    };

    // Two zones: a scrolling body (lines + add-product list) and a footer
    // (price change, total, buttons) that stays pinned to the bottom, also
    // while the add-product list is open.
    overlay.querySelector(".sheet").innerHTML = `
     <div class="edit-sheet" id="edit-sheet">
      <div class="edit-sheet-scroll">
      <h2>${t("edit_order")}</h2>
      <div class="card-list" id="edit-order-lines" style="margin:12px 0;"></div>
      <button type="button" class="btn btn-block" id="edit-add-product-btn" aria-expanded="false">${t("add_product_to_order")}</button>
      <div id="edit-add-product-panel" hidden>
        <div class="edit-add-toolbar">
          <input type="search" id="edit-add-product-search" placeholder="${t("add_product_search_placeholder")}" aria-label="${t("add_product_search_placeholder")}" autocomplete="off" />
          <div class="edit-brand-chips" id="edit-brand-chips" role="group"></div>
        </div>
        <div class="card-list edit-add-results" id="edit-add-product-results"></div>
      </div>
      </div>
      <div class="edit-sheet-footer">
      <div class="edit-price-change">
        <span class="edit-price-label">${t(selfApproves ? "discount_pct_label" : "request_price_change")}</span>
        <div class="edit-price-controls">
          <input type="number" id="edit-discount-input" min="0" step="1" value="${discountValue || 0}" inputmode="numeric" aria-label="${t(selfApproves ? "discount_pct_label" : "request_price_change")}" />
          <div class="unit-toggle" id="edit-discount-type" role="group" aria-label="${t("discount_pct_label")}">
            <button type="button" data-type="pct" aria-pressed="${discountType === "pct"}">${t("discount_type_pct")}</button>
            <button type="button" data-type="amd" aria-pressed="${discountType === "amd"}">${t("discount_type_amd")}</button>
          </div>
        </div>
      </div>
      ${selfApproves ? "" : `<p class="muted price-change-hint">${t("price_change_hint")}</p>`}
      <p>${t("total")}: <span id="edit-order-total" class="text-amount"></span></p>
      <p class="form-error" id="order-detail-error" hidden></p>
      <div class="sheet-actions">
        <button type="button" class="btn" id="edit-order-cancel">${t("cancel_edit")}</button>
        <button type="button" class="btn btn-primary" id="edit-order-save">${t("save_changes")}</button>
      </div>
      </div>
     </div>
    `;

    const linesEl = overlay.querySelector("#edit-order-lines");
    const totalEl = overlay.querySelector("#edit-order-total");
    const panelEl = overlay.querySelector("#edit-add-product-panel");
    const searchEl = overlay.querySelector("#edit-add-product-search");
    const sheetEl = overlay.querySelector("#edit-sheet");
    const brandChipsEl = overlay.querySelector("#edit-brand-chips");
    let activeBrand = null; // null = all brands
    const resultsEl = overlay.querySelector("#edit-add-product-results");
    const addBtn = overlay.querySelector("#edit-add-product-btn");
    const errorEl = overlay.querySelector("#order-detail-error");

    const updateTotal = () => {
      totalEl.textContent = formatAmd(total());
    };

    function renderLines() {
      linesEl.innerHTML = lines
        .map(
          (l, i) => `
        <div class="order-product-row order-edit-row" data-line-index="${i}">
          <div class="order-product-info">
            <strong>${escapeHtml(l.product_name)}${l.size ? ` · ${escapeHtml(l.size)}` : ""}</strong>
            <span class="muted">${[l.brand, formatAmd(Number(l.unit_price_amd))].filter(Boolean).map(escapeHtml).join(" · ")}</span>
          </div>
          <div class="order-edit-controls">
            <div class="order-qty-stepper">
              <button type="button" class="icon-btn" data-action="dec" aria-label="${t("decrease")}">&minus;</button>
              <span>${l.quantity}</span>
              <button type="button" class="icon-btn" data-action="inc" aria-label="${t("increase")}">&plus;</button>
            </div>
            <button type="button" class="icon-btn icon-btn-danger order-remove-btn" data-action="remove" aria-label="${t("remove_item")}" title="${t("remove_item")}">${icons.trash}</button>
          </div>
        </div>`
        )
        .join("");
      updateTotal();
    }

    // One delegated listener for every line control (no per-row listeners to
    // rebuild on each change).
    linesEl.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-action]");
      const row = btn?.closest("[data-line-index]");
      if (!btn || !row) return;
      const i = Number(row.dataset.lineIndex);
      if (btn.dataset.action === "inc") lines[i].quantity += 1;
      else if (btn.dataset.action === "dec") {
        if (lines[i].quantity > 1) lines[i].quantity -= 1;
      } else if (btn.dataset.action === "remove") lines.splice(i, 1);
      renderLines();
      if (!panelEl.hidden) renderResults();
    });

    // --- add-product panel ---------------------------------------------
    function renderResults() {
      if (catalogLoading) {
        resultsEl.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
        return;
      }
      // Every product of the chosen brand (or all), not a truncated top-30;
      // rows use content-visibility so a long list still scrolls smoothly.
      const pool = activeBrand ? (productCatalog || []).filter((p) => (p.brand || "") === activeBrand) : productCatalog || [];
      const matches = sortProducts(searchProducts(pool, addProductQuery));
      const qtyInOrder = new Map(lines.map((l) => [l.product_id, l.quantity]));
      resultsEl.innerHTML =
        matches
          .map((p) => {
            const inOrder = qtyInOrder.get(p.id);
            return `
          <div class="order-product-row order-add-row" data-add-product-id="${p.id}">
            <div class="order-product-info">
              <strong>${escapeHtml(p.name)}</strong>
              <span class="muted">${[p.brand, p.unit].filter(Boolean).map(escapeHtml).join(" · ")} ${formatAmd(Number(p.unit_price_amd))}</span>
            </div>
            ${inOrder ? `<span class="badge badge-success">×${inOrder}</span>` : ""}
            <button type="button" class="btn btn-sm" data-action="add-product">${t("add")}</button>
          </div>`;
          })
          .join("") || `<p class="empty-state">${t("no_products_found")}</p>`;
    }

    function renderBrandChips() {
      const brands = [...new Set((productCatalog || []).map((p) => p.brand || "").filter(Boolean))];
      brandChipsEl.innerHTML = [null, ...brands]
        .map((b) => `<button type="button" class="edit-brand-chip" data-brand="${b == null ? "" : escapeHtml(b)}" aria-pressed="${b === activeBrand}">${b == null ? t("all_brands") : escapeHtml(b)}</button>`)
        .join("");
    }
    brandChipsEl.addEventListener("click", (e) => {
      const chip = e.target.closest("[data-brand]");
      if (!chip) return;
      activeBrand = chip.dataset.brand || null;
      brandChipsEl.querySelectorAll("[data-brand]").forEach((c) => c.setAttribute("aria-pressed", String((c.dataset.brand || null) === activeBrand)));
      renderResults();
    });

    resultsEl.addEventListener("click", (e) => {
      const btn = e.target.closest('[data-action="add-product"]');
      const row = btn?.closest("[data-add-product-id]");
      if (!btn || !row) return;
      const product = (productCatalog || []).find((p) => p.id === Number(row.dataset.addProductId));
      if (!product) return;
      const existing = lines.find((l) => l.product_id === product.id);
      if (existing) existing.quantity += 1;
      else
        lines.push({
          product_id: product.id,
          product_name: product.name,
          brand: product.brand || null,
          unit_price_amd: Number(product.unit_price_amd),
          quantity: 1,
        });
      renderLines();
      renderResults();
    });

    // Typing only re-renders the (at most 30) results -- never the sheet --
    // and waits for a short pause so a fast typist does not trigger a
    // re-filter per letter.
    searchEl.addEventListener(
      "input",
      debounce(() => {
        addProductQuery = searchEl.value;
        renderResults();
      }, 150)
    );

    addBtn.addEventListener("click", async () => {
      panelEl.hidden = !panelEl.hidden;
      sheetEl.classList.toggle("adding", !panelEl.hidden);
      // While picking products the order lines fold away (the list gets the
      // room); the button turns into "Done" to bring them back.
      addBtn.textContent = panelEl.hidden ? t("add_product_to_order") : t("done");
      addBtn.setAttribute("aria-expanded", String(!panelEl.hidden));
      if (panelEl.hidden) return;
      if (!productCatalog) {
        catalogLoading = true;
        renderResults();
        try {
          productCatalog = await getProductCatalog();
        } catch {
          productCatalog = [];
        }
        catalogLoading = false;
        renderBrandChips();
      }
      renderResults();
      searchEl.focus({ preventScroll: true });
    });

    // --- price change ----------------------------------------------------
    overlay.querySelector("#edit-discount-input").addEventListener("input", (e) => {
      const n = Number(e.target.value);
      discountValue = Number.isFinite(n) && n > 0 ? n : 0;
      updateTotal();
    });
    overlay.querySelectorAll("#edit-discount-type [data-type]").forEach((btn) => {
      btn.addEventListener("click", () => {
        discountType = btn.dataset.type;
        overlay.querySelectorAll("#edit-discount-type [data-type]").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
        updateTotal();
      });
    });

    overlay.querySelector("#edit-order-cancel").addEventListener("click", () => renderView(order));
    overlay.querySelector("#edit-order-save").addEventListener("click", async () => {
      if (!lines.length) {
        errorEl.textContent = t("no_products_found");
        errorEl.hidden = false;
        return;
      }
      const saveBtn = overlay.querySelector("#edit-order-save");
      saveBtn.disabled = true;
      saveBtn.textContent = t("saving");
      try {
        const updated = await api.updateOrder(orderId, {
          items: lines.map((l) => ({
            product_id: l.product_id,
            product_name: l.product_name,
            brand: l.brand,
            unit_price_amd: l.unit_price_amd,
            quantity: l.quantity,
          })),
          discount_pct: discountType === "pct" ? discountValue : 0,
          discount_amd: discountType === "amd" ? discountValue : 0,
        });
        notifyOrdersChanged();
        renderView(updated);
        onChanged?.();
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.hidden = false;
        saveBtn.disabled = false;
        saveBtn.textContent = t("save_changes");
      }
    });

    renderLines();
  }
}
