import { api } from "../api.js";
import { activateCombobox, activateDialog, escapeHtml, formatDateTime, formatDistance, formatAmd, openNavigation, tierSelectorHtml, activateTierSelector, tierBadgeHtml, categorySelectorHtml, activateCategorySelector, categoryLabel, REGION_LIST, YEREVAN_DISTRICTS, SALES_CHANNELS } from "../util.js";
import { t } from "../i18n.js";
import { icons } from "../icons.js";
import { canEditDirectly, canReassignCustomers, canAssignErpCustomerId, isAdmin, seesFinancialExports } from "../state.js";
import { openVisitDetailSheet } from "../visitDetail.js";

const AGING_BADGE = {
  "0-7 days": "badge-success",
  "8-14 days": "badge-info",
  "15-30 days": "badge-warning",
  "30+ days": "badge-danger",
  "No payment found": "badge-neutral",
  "Data error - review": "badge-neutral",
};

const AGING_LABEL_KEY = {
  "0-7 days": "aging_0_7",
  "8-14 days": "aging_8_14",
  "15-30 days": "aging_15_30",
  "30+ days": "aging_30_plus",
  "No payment found": "aging_no_payment",
  "Data error - review": "aging_data_error",
};

const EDIT_FIELDS = [
  { name: "name", labelKey: "name", type: "text" },
  { name: "category", labelKey: "category", type: "select" },
  { name: "phone", labelKey: "phone", type: "tel" },
  { name: "address", labelKey: "address", type: "text" },
  { name: "visit_frequency_days", labelKey: "visit_frequency", type: "number" },
  { name: "notes", labelKey: "notes", type: "textarea" },
  { name: "tin", labelKey: "tin", type: "text" },
];

export async function renderCustomerDetail(root, navigate, customerId) {
  root.innerHTML = `<div class="detail-view"><p class="loading-state" role="status">${t("loading")}</p></div>`;
  const container = root.querySelector(".detail-view");

  let customer, checkins, pendingRequests, erpOrders;
  try {
    [customer, checkins, pendingRequests, erpOrders] = await Promise.all([
      api.getCustomer(customerId),
      api.customerCheckins(customerId),
      api.listEditRequests({ customer_id: customerId, status: "pending" }),
      api.getErpOrders(customerId, "recent"),
    ]);
  } catch (err) {
    container.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    return;
  }

  let badgeClass = "badge-neutral";
  let badgeText = t("not_visited");
  if (customer.visited_today) {
    badgeClass = "badge-success";
    badgeText = t("visited_today");
  } else if (customer.overdue) {
    badgeClass = "badge-danger";
    badgeText = t("filter_overdue");
  } else if (customer.visited_this_week) {
    badgeClass = "badge-info";
    badgeText = t("visited_this_week");
  }

  let nextVisitHtml = "";
  if (customer.overdue) {
    nextVisitHtml = `<span class="badge badge-danger">${t("filter_overdue")}</span>`;
  } else if (customer.last_visit_at) {
    const next = new Date(customer.last_visit_at);
    next.setDate(next.getDate() + customer.visit_frequency_days);
    nextVisitHtml = `<span class="muted">${t("next_due")}: ${formatDateTime(next.toISOString())}</span>`;
  } else {
    nextVisitHtml = `<span class="muted">${t("never_visited")}</span>`;
  }

  const idCategoryLine = customer.erp_customer_id
    ? `${t("customer_id_label")}: ${escapeHtml(customer.erp_customer_id)}${customer.category ? ` · ${escapeHtml(categoryLabel(customer.category))}` : ""}`
    : customer.category
    ? escapeHtml(categoryLabel(customer.category))
    : "";

  container.innerHTML = `
    <div class="detail-header">
      <button class="icon-btn" id="back-btn" aria-label="${t("back")}">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
      </button>
      <div class="detail-header-icon">${icons.store}</div>
      <div class="detail-header-title">
        <h1>${escapeHtml(customer.name)}</h1>
        ${idCategoryLine ? `<div class="muted detail-header-subtitle">${idCategoryLine}</div>` : ""}
        <div class="detail-header-status-row">
          ${tierBadgeHtml(customer.customer_tier)}
          <span class="badge ${badgeClass}">${badgeText}</span>
        </div>
      </div>
      <div class="detail-header-actions">
        ${
          canReassignCustomers()
            ? `<button class="icon-btn" id="reassign-customer-btn" aria-label="${t("assigned_manager")}">
                 <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3"/><path d="M3 20v-1.25A5.75 5.75 0 0 1 8.75 13h.5A5.75 5.75 0 0 1 15 18.75V20"/><circle cx="17.5" cy="8.5" r="2.5"/><path d="M15.5 13.6c.6-.25 1.25-.38 1.9-.38A4.6 4.6 0 0 1 22 17.82V20"/></svg>
               </button>`
            : ""
        }
        ${
          canAssignErpCustomerId(customer)
            ? `<button class="icon-btn" id="assign-erp-btn" aria-label="${t("erp_customer_id")}">
                 <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M3.5 9.5h17"/><path d="M7 13.5h4"/></svg>
               </button>`
            : ""
        }
        ${
          seesFinancialExports()
            ? `<button class="icon-btn" id="credit-term-btn" aria-label="${t("credit_term_days")}">
                 <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg>
               </button>`
            : ""
        }
        <button class="icon-btn" id="edit-customer-btn" aria-label="${t("edit")}">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>
        </button>
      </div>
    </div>

    <div class="card detail-facts-card">
      ${
        customer.region || customer.address
          ? `<div class="detail-fact"><span class="detail-fact-icon">${icons.pin}</span><span>${[customer.region, customer.subregion, customer.address].filter(Boolean).map(escapeHtml).join(" &middot; ")}</span></div>`
          : ""
      }
      ${customer.phone ? `<div class="detail-fact"><span class="detail-fact-icon">${icons.phone}</span><a href="tel:${escapeHtml(customer.phone)}">${escapeHtml(customer.phone)}</a></div>` : ""}
      ${
        customer.sales_channel || customer.assigned_manager_name
          ? `<div class="detail-fact"><span class="detail-fact-icon">${icons.box}</span><span>${[customer.sales_channel, customer.assigned_manager_name].filter(Boolean).map(escapeHtml).join(" &middot; ")}</span></div>`
          : ""
      }
      <div class="detail-fact"><span class="detail-fact-icon">${icons.repeat}</span><span>${t("visit_every_prefix")}${customer.visit_frequency_days}${t("visit_every_suffix")}</span></div>
      ${
        seesFinancialExports()
          ? `<div class="detail-fact"><span class="detail-fact-icon">${icons.clock}</span><span>${t("credit_term_days")}: ${customer.credit_term_days}</span></div>`
          : ""
      }
      ${customer.last_visit_at ? `<div class="detail-fact"><span class="detail-fact-icon">${icons.clock}</span><span>${t("last_visit")}: ${formatDateTime(customer.last_visit_at)}</span></div>` : ""}
      ${customer.notes ? `<div class="detail-fact muted"><span class="detail-fact-icon">${icons.note}</span><span>${escapeHtml(customer.notes)}</span></div>` : ""}
    </div>

    <div id="pending-request-slot"></div>

    ${renderErpCard(customer, erpOrders)}

    <div class="card next-visit-card">
      <div class="next-visit-header"><span>${t("next_visit")}</span></div>
      <div class="next-visit-due">${nextVisitHtml}</div>
    </div>

    <div class="detail-actions-grid">
      <button class="action-btn action-btn-primary" id="checkin-btn">
        <span>${icons.mapPinCheck}</span>${t("check_in")}
      </button>
      ${customer.phone ? `<a class="action-btn" href="tel:${escapeHtml(customer.phone)}"><span>${icons.phone}</span>${t("call")}</a>` : ""}
      <button type="button" class="action-btn" id="navigate-btn">
        <span>${icons.compass}</span>${t("navigate")}
      </button>
      ${customer.erp_synced_at ? `<button class="action-btn" id="order-history-btn"><span>${icons.box}</span>${t("order_history_short")}</button>` : ""}
      <button type="button" class="action-btn" id="new-order-btn">
        <span>${icons.cart}</span>${t("new_order")}
      </button>
    </div>

    <h2 class="section-title" id="visit-history-anchor">${t("visit_history")}</h2>
    <div id="checkin-history" class="card-list"></div>
  `;

  container.querySelector("#checkin-btn").addEventListener("click", () => {
    navigate(`#/checkin/${customerId}`);
  });
  container.querySelector("#navigate-btn").addEventListener("click", () => {
    openNavigation(customer.lat, customer.lng);
  });
  container.querySelector("#back-btn").addEventListener("click", () => navigate.goBack("#/customers"));
  container.querySelector("#new-order-btn").addEventListener("click", () => {
    navigate(`#/orders/new/${customerId}`);
  });
  container.querySelector("#edit-customer-btn").addEventListener("click", () => {
    openEditSheet(customer, navigate, () => renderCustomerDetail(root, navigate, customerId));
  });
  container.querySelector("#reassign-customer-btn")?.addEventListener("click", () => {
    openReassignSheet(customer, () => renderCustomerDetail(root, navigate, customerId));
  });
  container.querySelector("#credit-term-btn")?.addEventListener("click", () => {
    openCreditTermSheet(customer, () => renderCustomerDetail(root, navigate, customerId));
  });
  container.querySelector("#assign-erp-btn")?.addEventListener("click", () => {
    openAssignErpIdSheet(customer, () => renderCustomerDetail(root, navigate, customerId));
  });
  container.querySelector("#order-history-btn")?.addEventListener("click", () => {
    navigate(`#/customers/${customerId}/orders`);
  });

  renderPendingRequest(container.querySelector("#pending-request-slot"), pendingRequests[0], () =>
    renderCustomerDetail(root, navigate, customerId)
  );

  const historyEl = container.querySelector("#checkin-history");
  if (!checkins.length) {
    historyEl.innerHTML = `<p class="empty-state">${t("no_visits_yet")}</p>`;
  } else {
    // A compact, tappable row per visit -- the full detail (badges, brand
    // tags, note, photos) used to be rendered inline for every single visit
    // at once, which made a customer with a long history nearly unusable to
    // scroll through. Tapping a row opens everything in its own sheet.
    historyEl.innerHTML = checkins
      .map(
        (ch, i) => `
        <button type="button" class="card checkin-row" data-checkin-index="${i}">
          <div class="checkin-row-main">
            <strong>${escapeHtml(ch.user_name)}</strong>
            <span class="muted">${formatDateTime(ch.timestamp)}</span>
          </div>
          <span class="card-trailing">
            <span class="badge ${ch.within_range ? "badge-success" : "badge-danger"}">
              ${ch.within_range ? t("location_verified") : t("location_mismatch_away")}
            </span>
            ${ch.photos?.length ? `<span class="checkin-row-photo-count">📷 ${ch.photos.length}</span>` : ""}
            <span class="chevron">&#8250;</span>
          </span>
        </button>
      `
      )
      .join("");

    historyEl.querySelectorAll("[data-checkin-index]").forEach((btn) => {
      btn.addEventListener("click", () => {
        openVisitDetailSheet(checkins[Number(btn.dataset.checkinIndex)], () =>
          renderCustomerDetail(root, navigate, customerId)
        );
      });
    });
  }
}

function renderErpCard(customer, erpOrders) {
  if (!customer.erp_synced_at) return "";

  const debt = Number(customer.erp_debt_amd) || 0;
  const collectedSinceSync = Number(customer.collected_since_sync_amd) || 0;
  const estimatedDebt = customer.estimated_debt_amd != null ? Number(customer.estimated_debt_amd) : null;
  const agingClass = AGING_BADGE[customer.erp_aging_bucket] || "badge-neutral";
  const isDataError = customer.erp_aging_bucket === "Data error - review";
  const orders = Array.isArray(erpOrders) ? erpOrders : [];

  const now = new Date();
  const salesThisMonth = orders
    .filter((o) => {
      const d = new Date(o.order_date);
      return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
    })
    .reduce((sum, o) => sum + Number(o.total_amd), 0);
  // erpOrders is already sorted order_date DESC by the API, so [0] is the
  // most recent order within the "recent" (last 3 months) scope this page
  // fetches -- good enough for a summary tile without a separate request.
  const lastOrderDate = orders[0] ? new Date(orders[0].order_date).toLocaleDateString() : null;

  return `
    <div class="detail-stat-grid">
      <div class="detail-stat-tile">
        <span class="detail-stat-icon">${icons.cart}</span>
        <span class="detail-stat-value">${formatAmd(salesThisMonth)}</span>
        <span class="detail-stat-label">${t("sales_this_month")}</span>
      </div>
      <div class="detail-stat-tile ${isDataError ? "detail-stat-danger" : agingClass === "badge-danger" ? "detail-stat-danger" : ""}">
        <span class="detail-stat-icon">${icons.payment}</span>
        <span class="detail-stat-value">${isDataError ? t("erp_debt_unknown") : formatAmd(debt)}</span>
        <span class="detail-stat-label">${t("outstanding_debt")}</span>
        ${
          !isDataError && collectedSinceSync > 0
            ? `<span class="detail-stat-sublabel">${t("estimated_remaining")}: ${formatAmd(estimatedDebt)}</span>`
            : ""
        }
      </div>
      <div class="detail-stat-tile">
        <span class="detail-stat-icon">${icons.box}</span>
        <span class="detail-stat-value">${lastOrderDate ? escapeHtml(lastOrderDate) : "—"}</span>
        <span class="detail-stat-label">${t("last_order")}</span>
      </div>
      <div class="detail-stat-tile">
        <span class="detail-stat-icon">${icons.clock}</span>
        <span class="detail-stat-value">${customer.last_visit_at ? new Date(customer.last_visit_at).toLocaleDateString() : "—"}</span>
        <span class="detail-stat-label">${t("last_visit")}</span>
      </div>
    </div>
  `;
}

function groupLinesByBrand(lines) {
  const byBrand = new Map();
  for (const line of lines) {
    const brand = line.brand || t("erp_brand_unspecified");
    if (!byBrand.has(brand)) byBrand.set(brand, []);
    byBrand.get(brand).push(line);
  }
  return byBrand;
}

export async function openOrderDetailSheet(customerId, orderId) {
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `<div class="sheet"><p class="loading-state" role="status">${t("loading")}</p></div>`;
  document.body.appendChild(overlay);
  activateDialog(overlay);
  overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());

  let detail;
  try {
    detail = await api.getErpOrderDetail(customerId, orderId);
  } catch (err) {
    overlay.querySelector(".sheet").innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    return;
  }

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
        </div>`
        )
        .join("")}`
    )
    .join("");

  overlay.querySelector(".sheet").innerHTML = `
    <div class="order-detail-header">
      <h2>${escapeHtml(detail.order_id)}</h2>
      <button class="icon-btn" id="close-order-detail" aria-label="${t("cancel")}">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>
    </div>
    <div class="order-detail-meta">
      <span>${escapeHtml(String(detail.order_date).slice(0, 10))}</span>
      <span class="erp-debt-amount">${formatAmd(detail.total_amd)}</span>
    </div>
    ${brandSections}
  `;
  overlay.querySelector("#close-order-detail").addEventListener("click", () => overlay.remove());
}

function renderPendingRequest(slot, request, onDone) {
  if (!request) {
    slot.innerHTML = "";
    return;
  }

  if (isAdmin()) {
    const changesList = Object.entries(request.changes)
      .map(([field, value]) => `<div class="proposed-change"><strong>${escapeHtml(t(field))}</strong>: ${escapeHtml(String(value))}</div>`)
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
      onDone();
    });
    slot.querySelector("#reject-request-btn").addEventListener("click", async () => {
      await api.reviewEditRequest(request.id, "reject");
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

// Per-customer credit term in days, used by the "Orders Due for Payment"
// aging view (defaults to 45 -- see migrations/050_warehouse_delivery.sql).
// Its own small sheet, same pattern as ERP linking below -- a
// finance/collections setting, edited directly by whoever can see
// financial exports (server-gated by seesPaymentAging).
async function openCreditTermSheet(customer, onDone) {
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `
    <div class="sheet">
      <h2>${t("credit_term_days")}</h2>
      <form id="credit-term-form">
        <label>${t("credit_term_days")}
          <input type="number" name="credit_term_days" min="1" step="1" value="${customer.credit_term_days}" inputmode="numeric" />
        </label>
        <p class="form-error" id="credit-term-error" hidden></p>
        <div class="sheet-actions">
          <button type="button" class="btn" id="cancel-credit-term">${t("cancel")}</button>
          <button type="submit" class="btn btn-primary">${t("save")}</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(overlay);
  activateDialog(overlay);

  function close() {
    overlay.remove();
  }
  overlay.querySelector("#cancel-credit-term").addEventListener("click", close);
  overlay.addEventListener("click", (e) => e.target === overlay && close());

  overlay.querySelector("#credit-term-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const errorEl = overlay.querySelector("#credit-term-error");
    const days = Number(new FormData(e.target).get("credit_term_days"));
    if (!Number.isInteger(days) || days <= 0) {
      errorEl.textContent = t("credit_term_invalid");
      errorEl.hidden = false;
      return;
    }
    const submitBtn = e.target.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    try {
      await api.updateCustomer(customer.id, { credit_term_days: days });
      close();
      onDone();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
      submitBtn.disabled = false;
    }
  });
}

// Linking a customer to its ERP record -- its own small sheet, separate
// from the general edit-request flow (server allows it per
// canAssignErpCustomerId: accountant/CEO/admin for any customer, a manager
// or director only for one they created themselves).
async function openAssignErpIdSheet(customer, onDone) {
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `
    <div class="sheet">
      <h2>${t("erp_customer_id")}</h2>
      <form id="assign-erp-form">
        <label class="erp-suggest-wrap">${t("erp_customer_id")}
          <input type="text" name="erp_customer_id" value="${escapeHtml(customer.erp_customer_id ?? "")}" id="erp-customer-input" autocomplete="off" />
          <div class="erp-suggest-list" id="erp-suggest-list" hidden></div>
        </label>
        <p class="form-error" id="assign-erp-error" hidden></p>
        <div class="sheet-actions">
          <button type="button" class="btn" id="cancel-assign-erp">${t("cancel")}</button>
          <button type="submit" class="btn btn-primary">${t("save")}</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(overlay);
  activateDialog(overlay);

  function close() {
    overlay.remove();
  }
  overlay.querySelector("#cancel-assign-erp").addEventListener("click", close);
  overlay.addEventListener("click", (e) => e.target === overlay && close());

  const erpInput = overlay.querySelector("#erp-customer-input");
  const erpSuggestList = overlay.querySelector("#erp-suggest-list");
  let erpOptions = [];
  api
    .getUnlinkedErpCustomers()
    .then((results) => {
      // Sort A-Z by name client-side too -- relying only on the server's
      // ORDER BY isn't enough since the browser's own native datalist
      // (what this replaces) silently ignored it; keep the sort explicit
      // and visible here so it can't regress the same way again.
      erpOptions = [...results].sort((a, b) =>
        (a.customer_name || "").localeCompare(b.customer_name || "", undefined, { sensitivity: "base" })
      );
    })
    .catch(() => {});

  function renderSuggestions(query) {
    const q = query.trim().toLowerCase();
    const matches = q
      ? erpOptions.filter((r) => (r.customer_name || "").toLowerCase().includes(q) || r.erp_customer_id.includes(q))
      : erpOptions;
    if (!matches.length) {
      erpSuggestList.hidden = true;
      erpSuggestList.innerHTML = "";
      return;
    }
    erpSuggestList.innerHTML = matches
      .slice(0, 30)
      .map(
        (r) => `
      <div class="erp-suggest-item" data-id="${escapeHtml(r.erp_customer_id)}">
        <span>${escapeHtml(r.customer_name || r.erp_customer_id)}</span>
        ${r.debt_amd > 0 ? `<span class="muted">${formatAmd(r.debt_amd)}</span>` : ""}
      </div>`
      )
      .join("");
    erpSuggestList.hidden = false;
  }

  erpInput.addEventListener("focus", () => renderSuggestions(erpInput.value));
  erpInput.addEventListener("input", () => renderSuggestions(erpInput.value));
  erpInput.addEventListener("blur", () => {
    // A delay, not immediate hide, so the suggestion's own click handler
    // (mousedown fires first, but click needs the element still present)
    // gets a chance to run before the list disappears.
    setTimeout(() => (erpSuggestList.hidden = true), 150);
  });
  activateCombobox(erpInput, erpSuggestList, (item) => {
    erpInput.value = item.dataset.id;
  });

  const form = overlay.querySelector("#assign-erp-form");
  const errorEl = overlay.querySelector("#assign-erp-error");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    try {
      await api.updateCustomer(customer.id, { erp_customer_id: erpInput.value.trim() || null });
      close();
      onDone();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
      submitBtn.disabled = false;
    }
  });
}

// Region/subregion/sales channel/assigned manager -- a director/ceo/admin
// can change these directly (server allows it per canReassignCustomers),
// separate from the regular edit sheet below which still goes through the
// edit-request approval flow for everyone but admin.
async function openReassignSheet(customer, onDone) {
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `
    <div class="sheet">
      <h2>${t("assigned_manager")}</h2>
      <form id="reassign-form">
        <label>${t("region")}
          <select name="region" id="reassign-region">
            <option value="">${t("select_placeholder")}</option>
            ${REGION_LIST.map(
              (r) => `<option value="${escapeHtml(r)}" ${r === customer.region ? "selected" : ""}>${escapeHtml(r)}</option>`
            ).join("")}
          </select>
        </label>
        <label id="reassign-subregion-wrap">${t("subregion")}<input name="subregion" id="reassign-subregion" value="${escapeHtml(customer.subregion ?? "")}" /></label>
        <label>${t("sales_channel")}
          <select name="sales_channel">
            <option value="">${t("select_placeholder")}</option>
            ${SALES_CHANNELS.map(
              (c) => `<option value="${escapeHtml(c)}" ${c === customer.sales_channel ? "selected" : ""}>${escapeHtml(c)}</option>`
            ).join("")}
          </select>
        </label>
        <label>${t("assigned_manager")}
          <select name="assigned_manager_id" id="reassign-manager">
            <option value="">${t("unassigned")}</option>
          </select>
        </label>
        <p class="form-error" id="reassign-error" hidden></p>
        <div class="sheet-actions">
          <button type="button" class="btn" id="cancel-reassign">${t("cancel")}</button>
          <button type="submit" class="btn btn-primary">${t("save")}</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(overlay);
  activateDialog(overlay);

  function close() {
    overlay.remove();
  }
  overlay.querySelector("#cancel-reassign").addEventListener("click", close);
  overlay.addEventListener("click", (e) => e.target === overlay && close());

  const regionSelect = overlay.querySelector("#reassign-region");
  const subregionWrap = overlay.querySelector("#reassign-subregion-wrap");
  function renderSubregionField(region, value) {
    if (region === "Yerevan") {
      subregionWrap.innerHTML = `${t("subregion")}
        <select name="subregion" id="reassign-subregion">
          <option value="">${t("select_placeholder")}</option>
          ${YEREVAN_DISTRICTS.map(
            (d) => `<option value="${escapeHtml(d)}" ${d === value ? "selected" : ""}>${escapeHtml(d)}</option>`
          ).join("")}
        </select>`;
    } else {
      subregionWrap.innerHTML = `${t("subregion")}<input name="subregion" id="reassign-subregion" value="${escapeHtml(value ?? "")}" />`;
    }
  }
  if (customer.region === "Yerevan") renderSubregionField("Yerevan", customer.subregion);
  regionSelect.addEventListener("change", () => renderSubregionField(regionSelect.value, ""));

  const managerSelect = overlay.querySelector("#reassign-manager");
  api
    .listPlannableUsers()
    .then((users) => {
      managerSelect.innerHTML =
        `<option value="">${t("unassigned")}</option>` +
        users
          .map((u) => `<option value="${u.id}" ${u.id === customer.assigned_manager_id ? "selected" : ""}>${escapeHtml(u.name)}</option>`)
          .join("");
    })
    .catch(() => {});

  const form = overlay.querySelector("#reassign-form");
  const errorEl = overlay.querySelector("#reassign-error");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = new FormData(form);
    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = t("saving");
    try {
      await api.updateCustomer(customer.id, {
        region: data.get("region") || null,
        subregion: data.get("subregion") || null,
        sales_channel: data.get("sales_channel") || null,
        assigned_manager_id: data.get("assigned_manager_id") ? Number(data.get("assigned_manager_id")) : null,
      });
      close();
      onDone();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
      submitBtn.disabled = false;
      submitBtn.textContent = t("save");
    }
  });
}

function openEditSheet(customer, navigate, onDone) {
  const fields = EDIT_FIELDS;
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `
    <div class="sheet">
      <h2>${canEditDirectly() ? t("edit_customer") : t("request_edit")}</h2>
      <form id="edit-customer-form">
        ${tierSelectorHtml(customer.customer_tier || "potential")}
        ${categorySelectorHtml(customer.category || "")}
        ${fields.filter((f) => f.type !== "select").map((f) => {
          const value = escapeHtml(customer[f.name] ?? "");
          if (f.type === "textarea") {
            return `<label>${t(f.labelKey)}<textarea name="${f.name}" rows="2">${value}</textarea></label>`;
          }
          return `<label>${t(f.labelKey)}<input type="${f.type}" name="${f.name}" value="${value}" /></label>`;
        }).join("")}
        <p class="form-error" id="edit-customer-error" hidden></p>
        <div class="sheet-actions">
          <button type="button" class="btn" id="cancel-edit-customer">${t("cancel")}</button>
          <button type="submit" class="btn btn-primary">${canEditDirectly() ? t("save") : t("submit_request")}</button>
        </div>
      </form>
      <div class="edit-sheet-danger-zone">
        <button type="button" class="btn-link" id="change-location-btn">${icons.pin}${t("change_location")}</button>
        ${
          isAdmin()
            ? `<button type="button" class="btn-link btn-link-danger" id="delete-customer-btn">${icons.warning}${t("delete_customer")}</button>`
            : ""
        }
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  activateDialog(overlay);
  activateTierSelector(overlay);
  activateCategorySelector(overlay);

  function close() {
    overlay.remove();
  }
  overlay.querySelector("#cancel-edit-customer").addEventListener("click", close);
  overlay.addEventListener("click", (e) => e.target === overlay && close());
  overlay.querySelector("#change-location-btn").addEventListener("click", () => {
    close();
    navigate(`#/map?relocate=${customer.id}`);
  });
  overlay.querySelector("#delete-customer-btn")?.addEventListener("click", async () => {
    if (!confirm(t("confirm_delete_customer"))) return;
    await api.deleteCustomer(customer.id);
    close();
    navigate("#/customers");
  });

  const form = overlay.querySelector("#edit-customer-form");
  const errorEl = overlay.querySelector("#edit-customer-error");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = new FormData(form);
    const changes = { customer_tier: data.get("customer_tier") };
    for (const f of fields) {
      const raw = data.get(f.name);
      changes[f.name] = f.type === "number" ? Number(raw) : raw;
    }

    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    try {
      if (canEditDirectly()) {
        await api.updateCustomer(customer.id, changes);
      } else {
        await api.createEditRequest(customer.id, changes);
      }
      close();
      onDone();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
      submitBtn.disabled = false;
    }
  });
}
