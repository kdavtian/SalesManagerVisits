// The full order-detail sheet (status, line items, timeline, and every
// role-gated action: confirm/reject, edit, discount approval, mark
// delivered, delete). Originally lived only inside views/orders.js's list
// closure; extracted so other screens that know an order id -- the Activity
// tab's "Order placed" outcome row, for one -- can open the exact same
// sheet without re-implementing it.
import { api } from "./api.js";
import { escapeHtml, formatAmd, activateDialog, formatDateTime, customerNameLinkHtml, activateCustomerNameLinks } from "./util.js";
import { t } from "./i18n.js";
import { state } from "./state.js";
import { getProductCatalog } from "./productCatalog.js";

// v3 5-state machine (see migrations/051_warehouse_delivery_v3.sql):
// draft -> submitted -> confirmed -> packed_stock_out -> delivered, every
// exception looping back to draft. `iconTint` picks the shared
// .list-row-icon-* tint variant (see styles.css) so a list row's leading
// icon color always matches its trailing status badge's color family.
export const STATUS_META = {
  draft: { key: "order_status_draft", cls: "badge-warning", iconTint: "warning" },
  submitted: { key: "order_status_submitted", cls: "badge-neutral", iconTint: "neutral" },
  confirmed: { key: "order_status_confirmed", cls: "badge-info", iconTint: "info" },
  packed_stock_out: { key: "order_status_packed_stock_out", cls: "badge-info", iconTint: "info" },
  delivered: { key: "order_status_delivered", cls: "badge-success", iconTint: "success" },
};

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
const DISCOUNT_APPROVER_ROLES = new Set(["admin", "sales_director", "ceo"]);
// Who reviews a freshly-submitted order -- mirrors canConfirmOrders in the
// server's roles.js.
const CONFIRM_ROLES = new Set(["admin", "sales_director", "ceo"]);
// Who can move a packed order straight to delivered without a planned
// route -- mirrors canMarkDeliveredWithoutRoute in the server's roles.js.
// Exists because the driver (delivery_manager) role isn't currently using
// the app to complete routes through the normal signature-capturing flow
// (see views/deliveryRoute.js), which otherwise leaves a routed order with
// no way back into view.
const MARK_DELIVERED_ROLES = new Set(["delivery_manager", "sales_director", "accountant", "ceo", "admin"]);

// Full created -> submitted -> confirmed -> packed -> delivered timeline
// (server/src/routes/orders.js's order_status_history, populated at every
// real transition -- see migration 070). A draft-exception loop (rejected/
// stock-issue/delivery-failure) shows up here too since it's a real status
// change, not something to hide -- it's exactly the kind of thing this was
// asked to make visible.
function orderTimelineHtml(history) {
  if (!history?.length) return "";
  return `
    <h3 class="list-group-heading">${t("order_timeline_title")}</h3>
    <div class="order-timeline">
      ${history
        .map((h) => {
          const meta = STATUS_META[h.new_status];
          const label = meta ? t(meta.key) : escapeHtml(h.new_status);
          return `
        <div class="order-timeline-step">
          <span class="order-timeline-dot ${meta ? meta.cls : "badge-neutral"}"></span>
          <div class="order-timeline-body">
            <strong>${label}</strong>
            <span class="order-line-meta">${formatDateTime(h.changed_at)}${h.changed_by_name ? ` · ${escapeHtml(h.changed_by_name)}` : ""}${h.reason ? ` · ${escapeHtml(h.reason)}` : ""}</span>
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
      <div class="order-detail-ids">
        <span>${t("customer_id_label")}: ${escapeHtml(order.erp_customer_id || String(order.customer_id))}</span>
        ${order.order_code ? `<span>${t("order_id_label")}: ${escapeHtml(order.order_code)}</span>` : ""}
      </div>
      <h2>${customerNameLinkHtml(order.customer_name, order.customer_id)}</h2>
      <p><span class="badge ${meta.cls}">${t(meta.key)}</span>${
      order.payment_method ? ` <span class="badge badge-neutral">${t(order.payment_method === "cash" ? "payment_method_cash" : "payment_method_invoice")}</span>` : ""
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
      ${orderTimelineHtml(order.history)}
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
    if (order.status === "confirmed") {
      buttons.push({ label: t("confirmed_awaiting_warehouse"), action: "noop", cls: "btn", disabledDisplay: true });
    }
    if (order.status === "packed_stock_out") {
      buttons.push({ label: t("packed_awaiting_route"), action: "noop", cls: "btn", disabledDisplay: true });
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
    actionsEl.querySelectorAll("[data-status]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        actionsEl.querySelectorAll("button").forEach((b) => (b.disabled = true));
        try {
          await api.updateOrderStatus(orderId, btn.dataset.status);
          if (btn.dataset.status === "confirmed") window.dispatchEvent(new Event("warehouse-changed"));
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
    actionsEl.querySelectorAll("[data-action]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (btn.dataset.action === "edit-order") {
          renderEditMode(order);
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
  // each line's quantity, drop a line entirely, and switch the discount
  // between percent and a flat AMD amount -- not a full re-browse of the
  // catalog (that's what creating a fresh order is for), just fixing a
  // mistake or a customer's last-minute change before it moves on.
  function renderEditMode(order) {
    const lines = order.items.map((i) => ({ ...i }));
    let discountType = Number(order.discount_amd) > 0 ? "amd" : "pct";
    let discountValue = discountType === "amd" ? Number(order.discount_amd) : Number(order.discount_pct);
    // Lets whoever is allowed into edit mode (the rep, or a director/ceo/
    // admin reviewing it) drop in a product that wasn't originally
    // ordered -- fetched lazily since most edits never touch it.
    let showAddProduct = false;
    let productCatalog = null;
    let addProductQuery = "";

    function subtotal() {
      return lines.reduce((sum, l) => sum + Number(l.unit_price_amd) * Number(l.quantity), 0);
    }
    function total() {
      const sub = subtotal();
      return discountType === "amd" ? Math.max(0, sub - discountValue) : sub * (1 - discountValue / 100);
    }

    function paint() {
      overlay.querySelector(".sheet").innerHTML = `
        <h2>${t("edit_order")}</h2>
        <div class="card-list" id="edit-order-lines" style="margin:12px 0;"></div>
        <button type="button" class="btn btn-block" id="edit-add-product-btn">${t("add_product_to_order")}</button>
        <div id="edit-add-product-panel" ${showAddProduct ? "" : "hidden"}></div>
        <div class="order-discount-row">
          <label for="edit-discount-input">${t("request_price_change")}</label>
          <input type="number" id="edit-discount-input" min="0" step="1" value="${discountValue || 0}" inputmode="numeric" />
          <div class="segmented" id="edit-discount-type">
            <button type="button" class="chip ${discountType === "pct" ? "chip-active" : ""}" data-type="pct">${t("discount_type_pct")}</button>
            <button type="button" class="chip ${discountType === "amd" ? "chip-active" : ""}" data-type="amd">${t("discount_type_amd")}</button>
          </div>
        </div>
        <p class="muted price-change-hint">${t("price_change_hint")}</p>
        <p>${t("total")}: <span id="edit-order-total" class="text-amount">${formatAmd(total())}</span></p>
        <p class="form-error" id="order-detail-error" hidden></p>
        <div class="sheet-actions">
          <button type="button" class="btn" id="edit-order-cancel">${t("cancel_edit")}</button>
          <button type="button" class="btn btn-primary" id="edit-order-save">${t("save_changes")}</button>
        </div>
      `;

      const linesEl = overlay.querySelector("#edit-order-lines");
      linesEl.innerHTML = lines
        .map(
          (l, i) => `
        <div class="order-product-row" data-line-index="${i}">
          <div class="order-product-info">
            <strong>${escapeHtml(l.product_name)}${l.size ? ` · ${escapeHtml(l.size)}` : ""}</strong>
            <span class="muted">${[l.brand, formatAmd(Number(l.unit_price_amd))].filter(Boolean).map(escapeHtml).join(" · ")}</span>
          </div>
          <div class="order-qty-stepper">
            <button type="button" class="icon-btn" data-action="dec" aria-label="${t("decrease")}">&minus;</button>
            <span>${l.quantity}</span>
            <button type="button" class="icon-btn" data-action="inc" aria-label="${t("increase")}">&plus;</button>
          </div>
          <button type="button" class="btn-link btn-link-danger" data-action="remove">${t("remove_item")}</button>
        </div>`
        )
        .join("");

      linesEl.querySelectorAll("[data-line-index]").forEach((row) => {
        const i = Number(row.dataset.lineIndex);
        row.querySelector('[data-action="inc"]').addEventListener("click", () => {
          lines[i].quantity += 1;
          paint();
        });
        row.querySelector('[data-action="dec"]').addEventListener("click", () => {
          if (lines[i].quantity > 1) lines[i].quantity -= 1;
          paint();
        });
        row.querySelector('[data-action="remove"]').addEventListener("click", () => {
          lines.splice(i, 1);
          paint();
        });
      });

      overlay.querySelector("#edit-add-product-btn").addEventListener("click", async () => {
        showAddProduct = !showAddProduct;
        if (showAddProduct && !productCatalog) {
          try {
            productCatalog = await getProductCatalog();
          } catch {
            productCatalog = [];
          }
        }
        paint();
      });

      const addPanel = overlay.querySelector("#edit-add-product-panel");
      if (showAddProduct) {
        const matches = (productCatalog || []).filter((p) => {
          const q = addProductQuery.trim().toLowerCase();
          if (!q) return true;
          return [p.name, p.brand, p.family].some((v) => v && v.toLowerCase().includes(q));
        });
        addPanel.innerHTML = `
          <input type="search" id="edit-add-product-search" placeholder="${t("add_product_search_placeholder")}" value="${escapeHtml(addProductQuery)}" style="margin-bottom:8px;" />
          <div class="card-list">
            ${matches
              .slice(0, 30)
              .map(
                (p) => `
              <div class="order-product-row" data-add-product-id="${p.id}">
                <div class="order-product-info">
                  <strong>${escapeHtml(p.name)}</strong>
                  <span class="muted">${[p.brand, p.unit].filter(Boolean).map(escapeHtml).join(" · ")} ${formatAmd(Number(p.unit_price_amd))}</span>
                </div>
                <button type="button" class="btn btn-sm" data-action="add-product">${t("add")}</button>
              </div>`
              )
              .join("") || `<p class="empty-state">${t("no_products_found")}</p>`}
          </div>
        `;
        const searchInput = addPanel.querySelector("#edit-add-product-search");
        searchInput.addEventListener("input", () => {
          addProductQuery = searchInput.value;
          paint();
          overlay.querySelector("#edit-add-product-search")?.focus();
        });
        addPanel.querySelectorAll("[data-add-product-id]").forEach((row) => {
          const product = matches.find((p) => p.id === Number(row.dataset.addProductId));
          row.querySelector('[data-action="add-product"]').addEventListener("click", () => {
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
            paint();
          });
        });
      }

      overlay.querySelector("#edit-discount-input").addEventListener("input", (e) => {
        const n = Number(e.target.value);
        discountValue = Number.isFinite(n) && n > 0 ? n : 0;
        overlay.querySelector("#edit-order-total").textContent = formatAmd(total());
      });
      overlay.querySelectorAll("#edit-discount-type [data-type]").forEach((btn) => {
        btn.addEventListener("click", () => {
          discountType = btn.dataset.type;
          paint();
        });
      });

      overlay.querySelector("#edit-order-cancel").addEventListener("click", () => renderView(order));
      overlay.querySelector("#edit-order-save").addEventListener("click", async () => {
        const errorEl = overlay.querySelector("#order-detail-error");
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
    }

    paint();
  }
}
