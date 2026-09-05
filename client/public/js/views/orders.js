import { api } from "../api.js";
import { escapeHtml, formatAmd, activateDialog } from "../util.js";
import { t, getLang } from "../i18n.js";
import { state } from "../state.js";
import { icons } from "../icons.js";
import { ORDER_STATUS_ICONS } from "../ordersSearchEnhancements.js";

// v3 5-state machine (see migrations/051_warehouse_delivery_v3.sql):
// draft -> submitted -> confirmed -> packed_stock_out -> delivered, every
// exception looping back to draft. `iconTint` picks the shared
// .list-row-icon-* tint variant (see styles.css) so the row's leading
// icon color always matches its trailing status badge's color family.
const STATUS_META = {
  draft: { key: "order_status_draft", cls: "badge-warning", iconTint: "warning" },
  submitted: { key: "order_status_submitted", cls: "badge-neutral", iconTint: "neutral" },
  confirmed: { key: "order_status_confirmed", cls: "badge-info", iconTint: "info" },
  packed_stock_out: { key: "order_status_packed_stock_out", cls: "badge-info", iconTint: "info" },
  delivered: { key: "order_status_delivered", cls: "badge-success", iconTint: "success" },
};

const STATUS_FILTERS = ["", "draft", "submitted", "confirmed", "packed_stock_out", "delivered"];

// Fulfillment status changes (packed_stock_out/delivered) go through the
// dedicated Warehouse and Delivery screens (see views/warehouse.js and
// views/deliveryRoute.js), which collect the required extra data (pick
// confirmation, route stop, signature). This view only drives confirm and
// director-reject.
const DISCOUNT_APPROVER_ROLES = new Set(["admin", "sales_director", "ceo"]);
// Who reviews a freshly-submitted order -- mirrors canConfirmOrders in the
// server's roles.js.
const CONFIRM_ROLES = new Set(["admin", "sales_director", "ceo"]);
const APPROVAL_META = {
  pending: { key: "approval_status_pending", cls: "badge-warning" },
  approved: { key: "approval_status_approved", cls: "badge-success" },
  rejected: { key: "approval_status_rejected", cls: "badge-danger" },
};

function formatDate(value) {
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// Local calendar-day key an order's created_at falls into -- grouping is by
// the viewer's own day boundary, not UTC, so an order placed at 11pm
// doesn't jump to "tomorrow" in the list.
function orderDateKey(value) {
  const d = new Date(value);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function formatOrderDateHeading(value) {
  const d = new Date(value);
  const month = d.toLocaleDateString(getLang() === "hy" ? "hy" : "en", { month: "short" });
  return `${d.getDate()} ${month}`;
}

function formatLiters(value) {
  const n = Number(value) || 0;
  // Whole liters show as-is; fractional totals (e.g. half-liter items) keep
  // one decimal so 4.5L doesn't silently round away.
  return Number.isInteger(n) ? `${n}L` : `${n.toFixed(1)}L`;
}

export async function renderOrders(root, navigate) {
  root.innerHTML = `
    <div class="detail-view">
      <div class="list-header-row">
        <h1>${t("orders_title")}</h1>
        <button type="button" class="icon-btn" id="orders-new-btn" aria-label="${t("create_order")}">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>
        </button>
      </div>
      <div class="order-status-filter-row" id="order-status-filters"></div>
      <div class="list-toolbar">
        <input type="search" id="order-search" placeholder="${t("search")}" aria-label="${t("search")}" />
        <button type="button" class="icon-btn" id="order-filter-btn" aria-label="${t("filter")}" aria-haspopup="menu" aria-expanded="false" aria-controls="order-filter-menu">${icons.filter}</button>
        <div id="order-filter-menu" class="dropdown-menu" role="menu" hidden></div>
      </div>
      <div class="card-list" id="orders-list"><p class="loading-state" role="status">${t("loading")}</p></div>
    </div>
  `;

  const filterRow = root.querySelector("#order-status-filters");
  filterRow.innerHTML = STATUS_FILTERS.map(
    (s) => `<button class="map-filter-chip ${s === "" ? "chip-active" : ""}" data-status="${s}" aria-pressed="${s === "" ? "true" : "false"}">${s ? t(STATUS_META[s].key) : t("all_statuses")}</button>`
  ).join("");

  const listEl = root.querySelector("#orders-list");
  const searchInput = root.querySelector("#order-search");
  const filterBtn = root.querySelector("#order-filter-btn");
  const filterMenu = root.querySelector("#order-filter-menu");

  let activeStatus = "";
  let channelFilter = "";
  let orders = [];
  let hasMore = false;
  let loadingMore = false;

  function renderFilterMenu() {
    const channels = [...new Set(orders.map((o) => o.sales_channel).filter(Boolean))].sort();
    filterMenu.innerHTML = `
      <button role="menuitemradio" aria-checked="${channelFilter === ""}" data-channel="">${t("all_channels")}</button>
      ${channels
        .map((c) => `<button role="menuitemradio" aria-checked="${c === channelFilter}" data-channel="${escapeHtml(c)}">${escapeHtml(c)}</button>`)
        .join("")}
    `;
    filterMenu.querySelectorAll("[data-channel]").forEach((btn) => {
      btn.addEventListener("click", () => {
        channelFilter = btn.dataset.channel;
        filterMenu.hidden = true;
        filterBtn.setAttribute("aria-expanded", "false");
        paint();
      });
    });
  }

  filterBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const willShow = filterMenu.hidden;
    if (willShow) renderFilterMenu();
    filterMenu.hidden = !willShow;
    filterBtn.setAttribute("aria-expanded", String(willShow));
  });
  root.addEventListener("click", () => {
    filterMenu.hidden = true;
    filterBtn.setAttribute("aria-expanded", "false");
  });

  async function load() {
    listEl.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
    try {
      const params = activeStatus ? { status: activeStatus } : {};
      const result = await api.listOrders(params);
      orders = result.rows;
      hasMore = result.has_more;
    } catch (err) {
      listEl.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
      return;
    }
    paint();
  }

  async function loadMore() {
    if (loadingMore || !hasMore) return;
    loadingMore = true;
    const btn = listEl.querySelector("#orders-load-more");
    if (btn) btn.disabled = true;
    try {
      const params = activeStatus ? { status: activeStatus } : {};
      params.offset = orders.length;
      const result = await api.listOrders(params);
      orders = orders.concat(result.rows);
      hasMore = result.has_more;
    } finally {
      loadingMore = false;
    }
    paint();
  }

  function paint() {
    const search = searchInput.value.trim().toLowerCase();
    let filtered = orders;
    if (channelFilter) filtered = filtered.filter((o) => o.sales_channel === channelFilter);
    if (search) {
      filtered = filtered.filter((o) => {
        const haystack = [o.customer_name, o.order_code, o.user_name, o.sales_channel, formatDate(o.created_at)]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return haystack.includes(search);
      });
    }

    if (!filtered.length) {
      listEl.innerHTML = `<p class="empty-state">${t("no_orders_found")}</p>`;
      return;
    }

    // Grouped by the order's own calendar day (not the whole filtered
    // list's range) -- each day's header row totals just that day's
    // orders: amount, liters (see server's total_liters, computed from
    // catalog-linked lines only), and order count.
    let lastDateKey = null;
    listEl.innerHTML = filtered
      .map((o) => {
        const meta = STATUS_META[o.status] ?? STATUS_META.submitted;
        const dateKey = orderDateKey(o.created_at);
        let dateHeading = "";
        if (dateKey !== lastDateKey) {
          lastDateKey = dateKey;
          const dayOrders = filtered.filter((x) => orderDateKey(x.created_at) === dateKey);
          const dayTotal = dayOrders.reduce((sum, x) => sum + Number(x.total_amd), 0);
          const dayLiters = dayOrders.reduce((sum, x) => sum + Number(x.total_liters || 0), 0);
          dateHeading = `
            <div class="order-date-heading">
              <span class="order-date-heading-label">${formatOrderDateHeading(o.created_at)}</span>
              <span class="order-date-heading-stats">${formatAmd(dayTotal)} | ${formatLiters(dayLiters)} | ${dayOrders.length} ${t("orders_count_label")}</span>
            </div>`;
        }
        return `${dateHeading}
        <button class="card list-row" data-order-id="${o.id}">
          <span class="list-row-icon list-row-icon-${meta.iconTint}" aria-hidden="true">${ORDER_STATUS_ICONS[o.status] ?? ""}</span>
          <div class="list-row-body">
            <div class="list-row-top">
              <strong>${escapeHtml(o.customer_name)}</strong>
              <span class="list-row-trailing-text">${formatAmd(Number(o.total_amd))}</span>
            </div>
            <div class="muted list-row-meta">${o.order_code ? `${escapeHtml(o.order_code)} · ` : ""}${escapeHtml(o.user_name)} · ${formatDate(o.created_at)}</div>
            <div class="list-row-bottom">
              <span class="badge ${meta.cls}">${t(meta.key)}</span>
            </div>
          </div>
          <span class="chevron">&#8250;</span>
        </button>
      `;
      })
      .join("");

    // Loading more only makes sense against the unfiltered server order --
    // once a client-side search or channel filter narrows what's shown,
    // there's no "next page" of that search to fetch, only of the whole
    // list.
    if (hasMore && !search && !channelFilter) {
      listEl.insertAdjacentHTML("beforeend", `<button type="button" class="btn btn-block" id="orders-load-more">${t("load_more")}</button>`);
      listEl.querySelector("#orders-load-more").addEventListener("click", loadMore);
    }

    listEl.querySelectorAll("[data-order-id]").forEach((row) => {
      row.addEventListener("click", () => openOrderDetail(Number(row.dataset.orderId)));
    });
  }

  filterRow.querySelectorAll("[data-status]").forEach((btn) => {
    btn.addEventListener("click", () => {
      filterRow.querySelectorAll("[data-status]").forEach((b) => {
        b.setAttribute("aria-pressed", "false");
        b.classList.remove("chip-active");
      });
      btn.setAttribute("aria-pressed", "true");
      btn.classList.add("chip-active");
      activeStatus = btn.dataset.status;
      load();
    });
  });
  searchInput.addEventListener("input", paint);
  root.querySelector("#orders-new-btn").addEventListener("click", openCustomerPicker);

  // Orders always belong to a customer -- picking one here just forwards
  // into the same order-creation screen the customer detail page's "New
  // order" button uses, so there's one order-creation flow, not two.
  function openCustomerPicker() {
    const overlay = document.createElement("div");
    overlay.className = "sheet-overlay";
    overlay.innerHTML = `
      <div class="sheet">
        <h2>${t("select_customer")}</h2>
        <input type="search" id="order-customer-search" placeholder="${t("search_customers")}" aria-label="${t("search_customers")}" autofocus />
        <div class="card-list" id="order-customer-results" style="margin:12px 0; height:45vh; overflow-y:auto;"></div>
        <div class="sheet-actions">
          <button type="button" class="btn" id="order-customer-cancel">${t("cancel")}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    activateDialog(overlay);
    overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());
    overlay.querySelector("#order-customer-cancel").addEventListener("click", () => overlay.remove());

    const searchEl = overlay.querySelector("#order-customer-search");
    const resultsEl = overlay.querySelector("#order-customer-results");
    let searchSeq = 0;

    async function search(query) {
      const seq = ++searchSeq;
      resultsEl.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
      let results;
      try {
        results = await api.listCustomers(query ? { search: query } : {});
      } catch (err) {
        if (seq === searchSeq) resultsEl.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
        return;
      }
      if (seq !== searchSeq) return;
      if (!results.length) {
        resultsEl.innerHTML = `<p class="empty-state">${t("no_customers_found")}</p>`;
        return;
      }
      resultsEl.innerHTML = results
        .slice(0, 30)
        .map((c) => `<button type="button" class="card" style="text-align:left; width:100%;" data-customer-id="${c.id}">${escapeHtml(c.name)}</button>`)
        .join("");
      resultsEl.querySelectorAll("[data-customer-id]").forEach((btn) => {
        btn.addEventListener("click", () => {
          overlay.remove();
          navigate(`#/orders/new/${btn.dataset.customerId}`);
        });
      });
    }

    let debounceTimer = null;
    searchEl.addEventListener("input", () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => search(searchEl.value.trim()), 200);
    });
    search("");
  }

  // Any successful mutation here can change how many orders are waiting on
  // a director's review -- let the nav badge (in app.js) know right away
  // instead of waiting for its next poll.
  function notifyOrdersChanged() {
    window.dispatchEvent(new Event("orders-changed"));
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
          <span class="order-line-name">${escapeHtml(i.product_name)}</span>
          <strong>${formatAmd(Number(i.line_total_amd))}</strong>
        </div>
        <span class="order-line-meta">${formatAmd(Number(i.unit_price_amd))} &times; ${Number(i.quantity)}</span>
      </div>`;
  }

  async function openOrderDetail(orderId) {
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
      const canEditThisOrder = order.status === "submitted" && (isOwnerOrAdmin || canReviewSubmitted);
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
        <h2>${escapeHtml(order.customer_name)}</h2>
        <p><span class="badge ${meta.cls}">${t(meta.key)}</span>${
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
        <p><strong>${t("total")}: ${formatAmd(Number(order.total_amd))}</strong></p>
        ${order.note ? `<p class="muted">${escapeHtml(order.note)}</p>` : ""}
        <p class="form-error" id="order-detail-error" hidden></p>
        <div class="sheet-actions" id="order-detail-actions" style="flex-wrap:wrap;"></div>
      `;

      const actionsEl = overlay.querySelector("#order-detail-actions");
      const errorEl = overlay.querySelector("#order-detail-error");

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
            overlay.remove();
            notifyOrdersChanged();
            load();
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
          if (btn.dataset.action === "reject-order") {
            if (!confirm(t("confirm_reject_order"))) return;
            const note = prompt(t("reject_order_note_prompt")) || "";
            actionsEl.querySelectorAll("button").forEach((b) => (b.disabled = true));
            try {
              await api.rejectOrder(orderId, note.trim());
              overlay.remove();
              notifyOrdersChanged();
              load();
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
              load();
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
            else await api.deleteOrder(orderId);
            overlay.remove();
            notifyOrdersChanged();
            load();
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
          <p><strong>${t("total")}: <span id="edit-order-total">${formatAmd(total())}</span></strong></p>
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
              <strong>${escapeHtml(l.product_name)}</strong>
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
              productCatalog = await api.listProducts();
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
            load();
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

  load();
}
