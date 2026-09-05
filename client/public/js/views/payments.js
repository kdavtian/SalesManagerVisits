import { api } from "../api.js";
import { escapeHtml, formatAmd, formatDateTime, activateDialog } from "../util.js";
import { t } from "../i18n.js";
import { state } from "../state.js";
import { icons } from "../icons.js";

// Mirrors server/src/roles.js -- kept local since the client has no shared
// roles module (every other list/detail view in this app does the same,
// see orders.js's FULFILLMENT_ROLES/CONFIRM_ROLES consts).
const REVIEW_ROLES = new Set(["admin", "ceo", "accountant"]);
const SUBMIT_FOR_OTHERS_ROLES = new Set(["admin", "ceo", "accountant", "sales_director"]);
function seesAllPayments(role) {
  return role !== "sales_manager";
}

const STATUS_META = {
  pending: { key: "payment_status_pending", cls: "badge-warning" },
  approved: { key: "payment_status_approved", cls: "badge-success" },
  rejected: { key: "payment_status_rejected", cls: "badge-danger" },
};

const QUICK_FILTERS = ["", "pending", "approved", "rejected", "today", "this_month"];
const QUICK_FILTER_KEY = {
  "": "all_statuses",
  pending: "filter_pending",
  approved: "filter_approved",
  rejected: "filter_rejected",
  today: "filter_today",
  this_month: "filter_this_month",
};

function monthLabel(iso) {
  return new Date(iso).toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

function formatDateInput(date) {
  const d = date instanceof Date ? date : new Date(date);
  return d.toISOString().slice(0, 10);
}

function notifyPaymentsChanged() {
  window.dispatchEvent(new Event("payments-changed"));
}

export async function renderPayments(root, navigate, focusPaymentId, initialQuery) {
  // A payment-detail sheet is appended to document.body, not to `root`, so
  // it survives a normal view re-render -- and this view can be re-entered
  // via a hash change alone (e.g. tapping a payment push notification while
  // a *different* payment's detail sheet is already open, since both are
  // just `#/payments/:id`). Without this, that leaves two stacked overlays
  // instead of replacing one.
  document.querySelectorAll(".sheet-overlay").forEach((el) => el.remove());

  const canSeeAll = seesAllPayments(state.user.role);
  const canReview = REVIEW_ROLES.has(state.user.role);

  root.innerHTML = `
    <div class="detail-view">
      <div class="list-header-row">
        <h1>${t("payments_title")}</h1>
        <button type="button" class="icon-btn" id="payments-new-btn" aria-label="${t("add_payment")}">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>
        </button>
      </div>
      <p class="muted" id="payments-pending-summary" hidden></p>
      <div class="order-status-filter-row" id="payment-quick-filters"></div>
      <div class="order-status-filter-row" id="payment-active-filters" hidden></div>
      <div class="list-toolbar">
        <input type="search" id="payment-search" placeholder="${t("search_payments")}" aria-label="${t("search_payments")}" />
        <button type="button" class="icon-btn" id="payment-filter-btn" aria-label="${t("filter")}" aria-haspopup="menu" aria-expanded="false" aria-controls="payment-filter-menu">${icons.filter}</button>
        <div id="payment-filter-menu" class="dropdown-menu" role="menu" hidden></div>
      </div>
      <div class="card-list" id="payments-list"><p class="loading-state" role="status">${t("loading")}</p></div>
    </div>
  `;

  const summaryEl = root.querySelector("#payments-pending-summary");
  const filterRow = root.querySelector("#payment-quick-filters");
  const activeFiltersRow = root.querySelector("#payment-active-filters");
  const listEl = root.querySelector("#payments-list");
  const searchInput = root.querySelector("#payment-search");
  const filterBtn = root.querySelector("#payment-filter-btn");
  const filterMenu = root.querySelector("#payment-filter-menu");

  const initialStatusFilter = ["pending", "approved", "rejected"].includes(initialQuery?.get("status")) ? initialQuery.get("status") : "";
  filterRow.innerHTML = QUICK_FILTERS.map(
    (f) => `<button class="map-filter-chip ${f === initialStatusFilter ? "chip-active" : ""}" data-filter="${f}" aria-pressed="${f === initialStatusFilter ? "true" : "false"}">${t(QUICK_FILTER_KEY[f])}</button>`
  ).join("");

  let activeFilter = initialStatusFilter;
  let channelFilter = initialQuery?.get("sales_channel") || "";
  let managerFilter = initialQuery?.get("sales_manager_id") || "";
  let sort = canSeeAll ? "" : "date";
  let payments = [];
  let hasMore = false;
  let loadingMore = false;
  let searchDebounce = null;

  async function refreshPendingSummary() {
    try {
      const { count } = await api.getPaymentsPendingCount();
      if (count > 0) {
        summaryEl.textContent = t("payments_pending_summary").replace("{n}", count);
        summaryEl.hidden = false;
      } else {
        summaryEl.hidden = true;
      }
    } catch {
      summaryEl.hidden = true;
    }
  }

  function buildParams(extra = {}) {
    const params = { ...extra };
    if (sort) params.sort = sort;
    if (channelFilter) params.sales_channel = channelFilter;
    if (managerFilter) params.sales_manager_id = managerFilter;
    if (activeFilter === "pending" || activeFilter === "approved" || activeFilter === "rejected") {
      params.status = activeFilter;
    } else if (activeFilter === "today") {
      params.from = formatDateInput(new Date());
      params.to = formatDateInput(new Date());
    } else if (activeFilter === "this_month") {
      params.month = new Date().toISOString().slice(0, 7);
    }
    const q = searchInput.value.trim();
    if (q) params.q = q;
    return params;
  }

  // channelFilter/managerFilter can arrive from a Reports drill-down link
  // with no UI element that set them (see app.js's #/payments route
  // passing along the query string) -- without this, a manager landing
  // here from a report would be stuck silently filtered with no way back
  // except re-navigating. Channel needs no lookup (it's already the
  // display string); manager only has an id, so its name is read off
  // whatever's already loaded rather than firing an extra request for it.
  function paintActiveFilters() {
    const chips = [];
    if (channelFilter) chips.push({ label: channelFilter, clear: () => (channelFilter = "") });
    if (managerFilter) {
      const managerName = payments.find((p) => String(p.sales_manager_id) === String(managerFilter))?.sales_manager_name_snapshot;
      chips.push({ label: managerName || t("payment_manager_label"), clear: () => (managerFilter = "") });
    }
    if (!chips.length) {
      activeFiltersRow.hidden = true;
      activeFiltersRow.innerHTML = "";
      return;
    }
    activeFiltersRow.hidden = false;
    activeFiltersRow.innerHTML = chips
      .map((c, i) => `<button type="button" class="map-filter-chip chip-active" data-clear-filter="${i}">${escapeHtml(c.label)} &times;</button>`)
      .join("");
    activeFiltersRow.querySelectorAll("[data-clear-filter]").forEach((btn) => {
      btn.addEventListener("click", () => {
        chips[Number(btn.dataset.clearFilter)].clear();
        load();
      });
    });
  }

  async function load() {
    listEl.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
    try {
      const result = await api.listPayments(buildParams());
      payments = result.rows;
      hasMore = result.has_more;
    } catch (err) {
      listEl.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
      return;
    }
    paintActiveFilters();
    paint();
  }

  async function loadMore() {
    if (loadingMore || !hasMore) return;
    loadingMore = true;
    const btn = listEl.querySelector("#payments-load-more");
    if (btn) btn.disabled = true;
    try {
      const result = await api.listPayments(buildParams({ offset: payments.length }));
      payments = payments.concat(result.rows);
      hasMore = result.has_more;
    } finally {
      loadingMore = false;
    }
    paint();
  }

  function renderFilterMenu() {
    const channels = [...new Set(payments.map((p) => p.sales_channel).filter(Boolean))].sort();
    filterMenu.innerHTML = `
      <button role="menuitemradio" aria-checked="${channelFilter === ""}" data-channel="">${t("all_channels")}</button>
      ${channels.map((c) => `<button role="menuitemradio" aria-checked="${c === channelFilter}" data-channel="${escapeHtml(c)}">${escapeHtml(c)}</button>`).join("")}
      ${
        canSeeAll
          ? `<hr />
      <button role="menuitemradio" aria-checked="${sort === "date"}" data-sort="date">${t("sort_by_date")}</button>
      <button role="menuitemradio" aria-checked="${sort === ""}" data-sort="">${t("sort_by_channel")}</button>`
          : ""
      }
    `;
    filterMenu.querySelectorAll("[data-channel]").forEach((btn) => {
      btn.addEventListener("click", () => {
        channelFilter = btn.dataset.channel;
        filterMenu.hidden = true;
        filterBtn.setAttribute("aria-expanded", "false");
        load();
      });
    });
    filterMenu.querySelectorAll("[data-sort]").forEach((btn) => {
      btn.addEventListener("click", () => {
        sort = btn.dataset.sort;
        filterMenu.hidden = true;
        filterBtn.setAttribute("aria-expanded", "false");
        load();
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

  filterRow.querySelectorAll("[data-filter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      filterRow.querySelectorAll("[data-filter]").forEach((b) => {
        b.setAttribute("aria-pressed", "false");
        b.classList.remove("chip-active");
      });
      btn.setAttribute("aria-pressed", "true");
      btn.classList.add("chip-active");
      activeFilter = btn.dataset.filter;
      load();
    });
  });

  searchInput.addEventListener("input", () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(load, 300);
  });

  function paymentRowHtml(p) {
    const meta = STATUS_META[p.status] ?? STATUS_META.pending;
    return `
      <div class="card list-row" data-payment-id="${p.id}">
        <button class="payment-row-main" data-payment-id="${p.id}">
          <div class="list-row-top">
            <strong>${escapeHtml(p.customer_name_snapshot)}</strong>
            <span class="list-row-trailing-text">${formatAmd(Number(p.amount_amd))}</span>
          </div>
          <div class="muted list-row-meta">
            ${p.erp_customer_id_snapshot ? `${t("customer_id_label")}: ${escapeHtml(p.erp_customer_id_snapshot)} · ` : ""}${escapeHtml(p.sales_manager_name_snapshot)}${p.sales_channel ? ` · ${escapeHtml(p.sales_channel)}` : ""} · ${formatDateTime(p.payment_date)}
          </div>
          <div class="list-row-bottom">
            <span class="badge ${meta.cls}">${t(meta.key)}</span>
          </div>
        </button>
        ${
          p.status === "pending" && canReview
            ? `<button type="button" class="btn btn-primary btn-sm payment-approve-btn" data-approve-id="${p.id}">${t("approve")}</button>`
            : ""
        }
      </div>
    `;
  }

  function paint() {
    if (!payments.length) {
      listEl.innerHTML = `<p class="empty-state">${
        canReview ? t("no_payments_pending_accountant") : t("no_payments_yet_manager")
      }</p>`;
      return;
    }

    if (sort === "date" || !canSeeAll) {
      // Simple newest-first grouped by month.
      const groups = [];
      let currentMonth = null;
      for (const p of payments) {
        const label = monthLabel(p.payment_date);
        if (label !== currentMonth) {
          groups.push({ label, rows: [] });
          currentMonth = label;
        }
        groups[groups.length - 1].rows.push(p);
      }
      listEl.innerHTML = groups
        .map((g) => `<h3 class="list-group-heading">${g.label}</h3>${g.rows.map(paymentRowHtml).join("")}`)
        .join("");
    } else {
      // Channel-then-date (server order) -- group by channel instead of month.
      const groups = [];
      let currentChannel = null;
      for (const p of payments) {
        const label = p.sales_channel || t("all_channels");
        if (label !== currentChannel) {
          groups.push({ label, rows: [] });
          currentChannel = label;
        }
        groups[groups.length - 1].rows.push(p);
      }
      listEl.innerHTML = groups
        .map((g) => `<h3 class="list-group-heading">${escapeHtml(g.label)}</h3>${g.rows.map(paymentRowHtml).join("")}`)
        .join("");
    }

    if (hasMore) {
      listEl.insertAdjacentHTML("beforeend", `<button type="button" class="btn btn-block" id="payments-load-more">${t("load_more")}</button>`);
      listEl.querySelector("#payments-load-more").addEventListener("click", loadMore);
    }

    listEl.querySelectorAll(".payment-row-main").forEach((row) => {
      row.addEventListener("click", () => openPaymentDetail(Number(row.dataset.paymentId)));
    });
    listEl.querySelectorAll(".payment-approve-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        quickApprove(Number(btn.dataset.approveId), btn);
      });
    });
  }

  async function quickApprove(paymentId, btn) {
    if (!confirm(t("confirm_approve_payment"))) return;
    btn.disabled = true;
    try {
      await api.approvePayment(paymentId);
      notifyPaymentsChanged();
      refreshPendingSummary();
      load();
    } catch (err) {
      alert(err.message);
      btn.disabled = false;
    }
  }

  root.querySelector("#payments-new-btn").addEventListener("click", () => openAddPaymentSheet());

  async function openPaymentDetail(paymentId) {
    const overlay = document.createElement("div");
    overlay.className = "sheet-overlay";
    overlay.innerHTML = `<div class="sheet"><p class="loading-state" role="status">${t("loading")}</p></div>`;
    document.body.appendChild(overlay);
    activateDialog(overlay);
    overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());

    let payment;
    try {
      payment = await api.getPayment(paymentId);
    } catch (err) {
      overlay.querySelector(".sheet").innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
      return;
    }
    renderDetail(payment);

    function renderDetail(p) {
      const meta = STATUS_META[p.status] ?? STATUS_META.pending;
      overlay.querySelector(".sheet").innerHTML = `
        <h2>${t("payment_detail_title")}</h2>
        <p><span class="badge ${meta.cls}">${t(meta.key)}</span></p>
        <div class="card-list" style="margin:12px 0;">
          <div class="order-line-row">
            <div class="order-line-top"><span class="order-line-name">${escapeHtml(p.customer_name_snapshot)}</span><strong>${formatAmd(Number(p.amount_amd))}</strong></div>
            <span class="order-line-meta">${p.erp_customer_id_snapshot ? `${t("customer_id_label")}: ${escapeHtml(p.erp_customer_id_snapshot)} · ` : ""}${formatDateTime(p.payment_date)}</span>
          </div>
        </div>
        <p class="muted">${t("payment_manager_label")}: ${escapeHtml(p.sales_manager_name_snapshot)}${p.sales_channel ? ` · ${escapeHtml(p.sales_channel)}` : ""}</p>
        ${p.note ? `<p class="muted">${escapeHtml(p.note)}</p>` : ""}
        ${p.rejection_reason ? `<p class="form-error" style="position:static;">${escapeHtml(p.rejection_reason)}</p>` : ""}
        <h3 class="list-group-heading">${t("payment_history_title")}</h3>
        <div class="card-list" style="margin:8px 0 12px;">
          ${p.history
            .map(
              (h) => `
            <div class="order-line-row">
              <span class="order-line-meta">${formatDateTime(h.changed_at)} · ${escapeHtml(h.changed_by_name || "")}${h.reason ? ` · ${escapeHtml(h.reason)}` : ""}</span>
            </div>`
            )
            .join("")}
        </div>
        <p class="form-error" id="payment-detail-error" hidden></p>
        <div class="sheet-actions" id="payment-detail-actions" style="flex-wrap:wrap;"></div>
      `;

      const actionsEl = overlay.querySelector("#payment-detail-actions");
      const errorEl = overlay.querySelector("#payment-detail-error");
      const buttons = [];
      if (p.status === "pending" && canReview) {
        buttons.push({ label: t("approve_payment"), action: "approve", cls: "btn btn-primary" });
        buttons.push({ label: t("reject_payment"), action: "reject", cls: "btn btn-danger" });
      } else if (p.status !== "pending" && canReview) {
        buttons.push({ label: t("return_to_pending"), action: "return", cls: "btn" });
      }
      buttons.push({ label: t("done"), action: "close", cls: "btn" });

      actionsEl.innerHTML = buttons
        .map((b) => `<button type="button" class="${b.cls}" data-action="${b.action}">${b.label}</button>`)
        .join("");

      actionsEl.querySelectorAll("[data-action]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const action = btn.dataset.action;
          if (action === "close") {
            overlay.remove();
            return;
          }
          if (action === "approve") {
            if (!confirm(t("confirm_approve_payment"))) return;
            actionsEl.querySelectorAll("button").forEach((b) => (b.disabled = true));
            try {
              const updated = await api.approvePayment(p.id);
              notifyPaymentsChanged();
              refreshPendingSummary();
              load();
              payment = await api.getPayment(p.id);
              renderDetail(payment);
            } catch (err) {
              errorEl.textContent = err.message;
              errorEl.hidden = false;
              actionsEl.querySelectorAll("button").forEach((b) => (b.disabled = false));
            }
            return;
          }
          if (action === "reject" || action === "return") {
            const reason = prompt(action === "reject" ? t("reject_payment_reason_label") : t("return_to_pending_reason_label"));
            if (!reason || !reason.trim()) return;
            actionsEl.querySelectorAll("button").forEach((b) => (b.disabled = true));
            try {
              if (action === "reject") await api.rejectPayment(p.id, reason.trim());
              else await api.returnPaymentToPending(p.id, reason.trim());
              notifyPaymentsChanged();
              refreshPendingSummary();
              load();
              payment = await api.getPayment(p.id);
              renderDetail(payment);
            } catch (err) {
              errorEl.textContent = err.message;
              errorEl.hidden = false;
              actionsEl.querySelectorAll("button").forEach((b) => (b.disabled = false));
            }
          }
        });
      });
    }
  }

  function openAddPaymentSheet() {
    const overlay = document.createElement("div");
    overlay.className = "sheet-overlay";
    document.body.appendChild(overlay);
    activateDialog(overlay);
    overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());

    let selectedCustomer = null;
    let selectedManager = SUBMIT_FOR_OTHERS_ROLES.has(state.user.role) ? null : { id: state.user.id, name: state.user.name, position: state.user.position };
    let managers = null;
    let pendingSubmit = null; // holds payload while a duplicate-warning confirm is showing

    async function ensureManagers() {
      if (managers || !SUBMIT_FOR_OTHERS_ROLES.has(state.user.role)) return;
      try {
        managers = await api.getEligiblePaymentManagers();
      } catch {
        managers = [];
      }
    }

    function paintForm() {
      overlay.innerHTML = `
        <div class="sheet">
          <h2>${t("add_payment")}</h2>
          <form id="payment-add-form">
          <label>${t("select_customer")}
            <button type="button" class="btn btn-block" id="payment-pick-customer" style="text-align:left;">
              ${selectedCustomer ? escapeHtml(selectedCustomer.name) : t("select_customer")}
            </button>
          </label>
          ${
            SUBMIT_FOR_OTHERS_ROLES.has(state.user.role)
              ? `<label for="payment-manager-select">${t("payment_manager_label")}
              <select id="payment-manager-select">
                <option value="">—</option>
              </select>
            </label>`
              : `<label>${t("payment_manager_label")}
              <p class="muted">${escapeHtml(state.user.name)}${state.user.position ? ` · ${escapeHtml(state.user.position)}` : ""}</p>
            </label>`
          }
          <label for="payment-amount-input">${t("payment_amount_amd")}
            <input type="number" id="payment-amount-input" min="1" step="1" inputmode="numeric" />
          </label>
          <label for="payment-date-input">${t("payment_date_label")}
            <input type="date" id="payment-date-input" value="${formatDateInput(new Date())}" />
          </label>
          <label for="payment-note-input">${t("payment_note_label")}
            <textarea id="payment-note-input" rows="2"></textarea>
          </label>
          <p class="form-error" id="payment-add-error" hidden></p>
          <div class="sheet-actions">
            <button type="button" class="btn" id="payment-add-cancel">${t("cancel")}</button>
            <button type="submit" class="btn btn-primary" id="payment-add-submit">${t("submit_payment")}</button>
          </div>
          </form>
        </div>
      `;

      overlay.querySelector("#payment-add-cancel").addEventListener("click", () => overlay.remove());
      overlay.querySelector("#payment-pick-customer").addEventListener("click", openCustomerPicker);

      const managerSelect = overlay.querySelector("#payment-manager-select");
      if (managerSelect) {
        ensureManagers().then(() => {
          managerSelect.innerHTML =
            `<option value="">—</option>` +
            (managers || [])
              .map((m) => `<option value="${m.id}" ${selectedManager?.id === m.id ? "selected" : ""}>${escapeHtml(m.name)}${m.position ? ` · ${escapeHtml(m.position)}` : ""}</option>`)
              .join("");
        });
        managerSelect.addEventListener("change", () => {
          selectedManager = (managers || []).find((m) => m.id === Number(managerSelect.value)) || null;
        });
      }

      overlay.querySelector("#payment-add-form").addEventListener("submit", (e) => {
        e.preventDefault();
        submit(false);
      });
    }

    function openCustomerPicker() {
      const picker = document.createElement("div");
      picker.className = "sheet-overlay";
      picker.innerHTML = `
        <div class="sheet">
          <h2>${t("select_customer")}</h2>
          <input type="search" id="payment-customer-search" placeholder="${t("search_customers")}" aria-label="${t("search_customers")}" autofocus />
          <div class="card-list" id="payment-customer-results" style="margin:12px 0; height:45vh; overflow-y:auto;"></div>
          <div class="sheet-actions">
            <button type="button" class="btn" id="payment-customer-cancel">${t("cancel")}</button>
          </div>
        </div>
      `;
      document.body.appendChild(picker);
      activateDialog(picker);
      picker.addEventListener("click", (e) => e.target === picker && picker.remove());
      picker.querySelector("#payment-customer-cancel").addEventListener("click", () => picker.remove());

      const searchEl = picker.querySelector("#payment-customer-search");
      const resultsEl = picker.querySelector("#payment-customer-results");
      let seq = 0;

      async function search(query) {
        const mySeq = ++seq;
        resultsEl.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
        let results;
        try {
          results = await api.listCustomers(query ? { search: query } : {});
        } catch (err) {
          if (mySeq === seq) resultsEl.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
          return;
        }
        if (mySeq !== seq) return;
        if (!results.length) {
          resultsEl.innerHTML = `<p class="empty-state">${t("no_customers_found")}</p>`;
          return;
        }
        resultsEl.innerHTML = results
          .slice(0, 30)
          .map(
            (c) => `
          <button type="button" class="card" style="text-align:left; width:100%;" data-customer-id="${c.id}">
            <strong>${escapeHtml(c.name)}</strong>
            ${c.erp_customer_id ? `<div class="muted">${t("customer_id_label")}: ${escapeHtml(c.erp_customer_id)}</div>` : ""}
          </button>`
          )
          .join("");
        resultsEl.querySelectorAll("[data-customer-id]").forEach((btn) => {
          btn.addEventListener("click", () => {
            const customer = results.find((c) => c.id === Number(btn.dataset.customerId));
            selectedCustomer = customer;
            picker.remove();
            paintForm();
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

    async function submit(confirmDuplicate) {
      const errorEl = overlay.querySelector("#payment-add-error");
      errorEl.hidden = true;
      if (!selectedCustomer) {
        errorEl.textContent = t("payment_customer_required");
        errorEl.hidden = false;
        return;
      }
      const amount = Number(overlay.querySelector("#payment-amount-input").value);
      if (!Number.isFinite(amount) || amount <= 0) {
        errorEl.textContent = t("payment_amount_required");
        errorEl.hidden = false;
        return;
      }
      if (SUBMIT_FOR_OTHERS_ROLES.has(state.user.role) && !selectedManager) {
        errorEl.textContent = t("payment_manager_required");
        errorEl.hidden = false;
        return;
      }
      const submitBtn = overlay.querySelector("#payment-add-submit");
      submitBtn.disabled = true;

      const payload = {
        customer_id: selectedCustomer.id,
        amount_amd: amount,
        payment_date: overlay.querySelector("#payment-date-input").value || formatDateInput(new Date()),
        note: overlay.querySelector("#payment-note-input").value.trim() || undefined,
        client_ref: pendingSubmit?.client_ref || `${state.user.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        confirm_duplicate: confirmDuplicate,
      };
      if (SUBMIT_FOR_OTHERS_ROLES.has(state.user.role) && selectedManager) {
        payload.sales_manager_id = selectedManager.id;
      }
      pendingSubmit = payload;

      try {
        await api.createPayment(payload);
        overlay.remove();
        notifyPaymentsChanged();
        refreshPendingSummary();
        load();
      } catch (err) {
        if (err.status === 409 && err.body?.error === "duplicate_warning") {
          if (confirm(`${t("duplicate_payment_warning")}\n${t("duplicate_payment_warning_body")}`)) {
            submit(true);
            return;
          }
          submitBtn.disabled = false;
          return;
        }
        errorEl.textContent = err.message;
        errorEl.hidden = false;
        submitBtn.disabled = false;
      }
    }

    paintForm();
  }

  load();
  refreshPendingSummary();

  if (focusPaymentId) openPaymentDetail(Number(focusPaymentId));
}
