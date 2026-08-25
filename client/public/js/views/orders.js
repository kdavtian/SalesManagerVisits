import { api } from "../api.js";
import { escapeHtml, formatAmd, activateDialog } from "../util.js";
import { t } from "../i18n.js";
import { state } from "../state.js";

const STATUS_META = {
  submitted: { key: "order_status_submitted", cls: "badge-neutral" },
  confirmed: { key: "order_status_confirmed", cls: "badge-info" },
  packed: { key: "order_status_packed", cls: "badge-info" },
  delivered: { key: "order_status_delivered", cls: "badge-success" },
  cancelled: { key: "order_status_cancelled", cls: "badge-danger" },
};

const STATUS_FILTERS = ["", "submitted", "confirmed", "packed", "delivered", "cancelled"];

const FULFILLMENT_ROLES = new Set(["warehouse_manager", "delivery_manager", "admin"]);
const DISCOUNT_APPROVER_ROLES = new Set(["admin", "sales_director"]);
const APPROVAL_META = {
  pending: { key: "approval_status_pending", cls: "badge-warning" },
  approved: { key: "approval_status_approved", cls: "badge-success" },
  rejected: { key: "approval_status_rejected", cls: "badge-danger" },
};
const NEXT_STATUS = {
  submitted: ["confirmed", "cancelled"],
  confirmed: ["packed", "cancelled"],
  packed: ["delivered", "cancelled"],
  delivered: [],
  cancelled: [],
};

function formatDate(value) {
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export async function renderOrders(root, navigate) {
  root.innerHTML = `
    <div class="detail-view">
      <h1>${t("orders_title")}</h1>
      <div class="order-status-filter-row" id="order-status-filters"></div>
      <div class="list-toolbar"><input type="search" id="order-search" placeholder="${t("search_customers")}" /></div>
      <div class="card-list" id="orders-list"><p class="loading-state" role="status">${t("loading")}</p></div>
    </div>
  `;

  const filterRow = root.querySelector("#order-status-filters");
  filterRow.innerHTML = STATUS_FILTERS.map(
    (s) => `<button class="map-filter-chip ${s === "" ? "chip-active" : ""}" data-status="${s}" aria-pressed="${s === "" ? "true" : "false"}">${s ? t(STATUS_META[s].key) : t("all_statuses")}</button>`
  ).join("");

  const listEl = root.querySelector("#orders-list");
  const searchInput = root.querySelector("#order-search");

  let activeStatus = "";
  let orders = [];
  let hasMore = false;
  let loadingMore = false;

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
    const filtered = search ? orders.filter((o) => o.customer_name.toLowerCase().includes(search)) : orders;

    if (!filtered.length) {
      listEl.innerHTML = `<p class="empty-state">${t("no_orders_found")}</p>`;
      return;
    }

    listEl.innerHTML = filtered
      .map((o) => {
        const meta = STATUS_META[o.status] ?? STATUS_META.submitted;
        return `
        <button class="card activity-row-rich" data-order-id="${o.id}">
          <div class="activity-row-body">
            <div class="activity-row-top">
              <strong>${escapeHtml(o.customer_name)}</strong>
              <span class="activity-row-trailing">${formatAmd(Number(o.total_amd))}</span>
            </div>
            <div class="muted activity-row-meta">${escapeHtml(o.user_name)} · ${formatDate(o.created_at)}</div>
            <div class="activity-row-bottom">
              <span class="badge ${meta.cls}">${t(meta.key)}</span>
            </div>
          </div>
          <span class="chevron">&#8250;</span>
        </button>
      `;
      })
      .join("");

    // Loading more only makes sense against the unfiltered server order --
    // once a client-side search narrows what's shown, there's no
    // "next page" of that search to fetch, only of the whole list.
    if (hasMore && !search) {
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

    const meta = STATUS_META[order.status] ?? STATUS_META.submitted;
    const isOwnerOrAdmin = order.user_id === state.user.id || state.user.role === "admin";
    const canFulfill = FULFILLMENT_ROLES.has(state.user.role);
    const hasDiscount = Number(order.discount_pct) > 0;
    const approvalMeta = APPROVAL_META[order.approval_status];
    // A pending or rejected discount blocks fulfillment server-side too --
    // don't offer a forward-status button that would just 409.
    const blockedByApproval = order.approval_status === "pending" || order.approval_status === "rejected";
    const nextOptions = NEXT_STATUS[order.status] ?? [];
    const canApproveDiscount = DISCOUNT_APPROVER_ROLES.has(state.user.role) && order.approval_status === "pending";

    overlay.querySelector(".sheet").innerHTML = `
      <h2>${escapeHtml(order.customer_name)}</h2>
      <p><span class="badge ${meta.cls}">${t(meta.key)}</span>${
      hasDiscount && approvalMeta ? ` <span class="badge ${approvalMeta.cls}">${t(approvalMeta.key)}</span>` : ""
    }</p>
      <div class="card-list" style="margin:12px 0;">
        ${order.items
          .map(
            (i) => `
          <div class="erp-order-row" style="grid-template-columns:1fr auto auto;">
            <span>${escapeHtml(i.product_name)}</span>
            <span class="muted">&times;${Number(i.quantity)}</span>
            <span>${formatAmd(Number(i.line_total_amd))}</span>
          </div>`
          )
          .join("")}
      </div>
      ${hasDiscount ? `<p class="muted">${t("discount_label")}: ${Number(order.discount_pct)}%</p>` : ""}
      <p><strong>${t("total")}: ${formatAmd(Number(order.total_amd))}</strong></p>
      ${order.note ? `<p class="muted">${escapeHtml(order.note)}</p>` : ""}
      <p class="form-error" id="order-detail-error" hidden></p>
      <div class="sheet-actions" id="order-detail-actions" style="flex-wrap:wrap;"></div>
    `;

    const actionsEl = overlay.querySelector("#order-detail-actions");
    const errorEl = overlay.querySelector("#order-detail-error");

    const buttons = [];
    if (canApproveDiscount) {
      buttons.push({ label: t("approve_discount"), action: "approve-discount", cls: "btn btn-primary" });
      buttons.push({ label: t("reject_discount"), action: "reject-discount", cls: "btn btn-danger" });
    }
    if (canFulfill && !blockedByApproval) {
      for (const next of nextOptions) {
        if (next === "cancelled") continue;
        buttons.push({ label: t(STATUS_META[next].key), status: next, cls: "btn btn-primary" });
      }
    }
    if (nextOptions.includes("cancelled") && (isOwnerOrAdmin || canFulfill)) {
      buttons.push({ label: t("cancel_order"), status: "cancelled", cls: "btn btn-danger" });
    }

    actionsEl.innerHTML = buttons
      .map((b) => `<button type="button" class="${b.cls}" ${b.action ? `data-action="${b.action}"` : `data-status="${b.status}"`}>${b.label}</button>`)
      .join("") || `<button type="button" class="btn" id="order-detail-close">${t("done")}</button>`;

    actionsEl.querySelector("#order-detail-close")?.addEventListener("click", () => overlay.remove());
    actionsEl.querySelectorAll("[data-status]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (btn.dataset.status === "cancelled" && !confirm(t("confirm_cancel_order"))) return;
        actionsEl.querySelectorAll("button").forEach((b) => (b.disabled = true));
        try {
          await api.updateOrderStatus(orderId, btn.dataset.status);
          overlay.remove();
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
        actionsEl.querySelectorAll("button").forEach((b) => (b.disabled = true));
        try {
          if (btn.dataset.action === "approve-discount") await api.approveOrderDiscount(orderId);
          else await api.rejectOrderDiscount(orderId);
          overlay.remove();
          load();
        } catch (err) {
          errorEl.textContent = err.message;
          errorEl.hidden = false;
          actionsEl.querySelectorAll("button").forEach((b) => (b.disabled = false));
        }
      });
    });
  }

  load();
}
