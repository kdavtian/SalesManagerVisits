import { api } from "../api.js";
import { activateCombobox, activateDialog, escapeHtml, formatDateTime, formatDistance, formatAmd, formatPhoneDisplay, normalizePhone, openNavigation, tierSelectorHtml, activateTierSelector, tierBadgeHtml, categorySelectorHtml, activateCategorySelector, categoryLabel, customerListIconHtml, REGION_LIST, YEREVAN_DISTRICTS, SALES_CHANNELS, channelDisplayLabel } from "../util.js";
import { t } from "../i18n.js";
import { icons } from "../icons.js";
import { canEditDirectly, canReassignCustomers, canAssignErpCustomerId, isAdmin, seesFinancialExports } from "../state.js";
import { openVisitDetailSheet, openPhotoLightbox } from "../visitDetail.js";
import { visitStatusBadge } from "./customers.js";
import { fetchCustomerSocial, saveCustomerSocial, socialFieldsHtml, collectSocialPayload } from "../customerSocialProfiles.js";

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

  // Same derivation the Customers list uses, imported rather than re-derived
  // here -- this page previously computed its own near-but-not-quite-equal
  // version (it had no "exempt" or "on-track" concept at all, so a
  // never-visited customer on an exempt channel was still labelled).
  const statusBadge = visitStatusBadge(customer);

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

  const idCategoryLine = [
    customer.erp_customer_id ? `${t("customer_id_label")}: ${escapeHtml(customer.erp_customer_id)}` : "",
    customer.category ? escapeHtml(categoryLabel(customer.category)) : "",
  ]
    .filter(Boolean)
    .join(" &middot; ");

  // The edit-type actions live as icon buttons directly on this row, not
  // tucked behind a "•••" overflow menu -- that menu used to hold four
  // separate entry points (reassign manager / link ERP ID / payment
  // settings / edit customer), which is also why they're merged down to
  // two taps here: "Account settings" (manager/ERP-ID/payment, whichever
  // this viewer is allowed to touch) and "Edit" (core fields, plus contact
  // & social profiles as a section of the same sheet). The one-tap
  // external links (Instagram/Facebook/email/website, injected by
  // customerSocialProfiles.js) stay alongside them -- those just hand off
  // to another app and cost nothing to keep in the open.
  const hasAccountSettings = canReassignCustomers() || canAssignErpCustomerId(customer) || seesFinancialExports();

  container.innerHTML = `
    <div class="detail-header customer-detail-header">
      <div class="customer-detail-header-main">
        <button class="icon-btn" id="back-btn" aria-label="${t("back")}">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
        </button>
        <div class="detail-header-icon">${customerListIconHtml(customer)}</div>
        <div class="detail-header-title">
          <h1 id="customer-detail-name" tabindex="0" role="button" aria-label="${t("tap_to_show_full_name")}">${escapeHtml(customer.name)}</h1>
          <!-- Nested inside the same title column (not a sibling of it) so
               this row starts at the name's own left edge, immediately
               under it -- not under the avatar, and not the full header
               width. -->
          <div class="detail-header-status-row">
            ${idCategoryLine ? `<span class="muted detail-header-subtitle">${idCategoryLine}</span>` : ""}
            ${tierBadgeHtml(customer.customer_tier)}
            ${statusBadge ? `<span class="badge ${statusBadge.cls}">${t(statusBadge.labelKey)}</span>` : ""}
          </div>
        </div>
      </div>
    </div>

    <div class="card detail-facts-card">
      <!-- One toolbar row: social/contact links (Instagram/Facebook/email/
           website) on the left, Account settings + Edit on the right.
           customerSocialProfiles.js finds the left slot by its own class and
           fills it in -- left empty (zero width, so space-between still pins
           the right group to the edge) for any customer with no profiles
           linked yet. -->
      <div class="detail-facts-card-actions">
        <span class="detail-facts-card-actions-social customer-social-section"></span>
        <div class="detail-facts-card-actions-primary">
          ${
            hasAccountSettings
              ? `<button type="button" class="icon-btn" id="account-settings-btn" aria-label="${t("account_settings")}" title="${t("account_settings")}">${icons.settings}</button>`
              : ""
          }
          <button type="button" class="icon-btn" id="edit-customer-btn" aria-label="${t("edit_customer")}" title="${t("edit_customer")}">${icons.pencil}</button>
        </div>
      </div>
      ${
        customer.region || customer.address
          ? `<div class="detail-fact"><span class="detail-fact-icon">${icons.pin}</span><span>${[customer.region, customer.subregion, customer.address].filter(Boolean).map(escapeHtml).join(" &middot; ")}</span></div>`
          : ""
      }
      ${customer.phone ? `<div class="detail-fact"><span class="detail-fact-icon">${icons.phone}</span><a href="tel:${escapeHtml(customer.phone)}">${escapeHtml(formatPhoneDisplay(customer.phone))}</a></div>` : ""}
      ${
        customer.sales_channel || customer.assigned_manager_name
          ? `<div class="detail-fact"><span class="detail-fact-icon">${icons.box}</span><span>${[customer.sales_channel ? channelDisplayLabel(customer.sales_channel) : "", customer.assigned_manager_name].filter(Boolean).map(escapeHtml).join(" &middot; ")}</span></div>`
          : ""
      }
      <div class="detail-fact"><span class="detail-fact-icon">${icons.repeat}</span><span>${t("visit_every_prefix")}${customer.visit_frequency_days}${t("visit_every_suffix")}</span></div>
      <div class="detail-fact"><span class="detail-fact-icon">${icons.wallet}</span><span>${t(customer.payment_method === "cash" ? "payment_method_cash" : "payment_method_invoice")} &middot; ${t("credit_term_days_label")}: ${customer.credit_term_days}</span></div>
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
      <!-- No "Call" button here on purpose: it pushed this row onto a second
           line at 390px, and the phone number in the facts card above is
           already a tel: link, so the action was a duplicate of it. -->
      <button type="button" class="action-btn" id="navigate-btn">
        <span>${icons.compass}</span>${t("navigate")}
      </button>
      ${customer.erp_synced_at ? `<button class="action-btn" id="order-history-btn"><span>${icons.box}</span>${t("order_history_short")}</button>` : ""}
      <button type="button" class="action-btn" id="new-order-btn">
        <span>${icons.cart}</span>${t("new_order")}
      </button>
      <button type="button" class="action-btn" id="customer-photos-btn">
        <span><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="10" r="1.5"/><path d="M21 16l-5.5-5.5a1.5 1.5 0 0 0-2.1 0L5 19"/></svg></span>${t("customer_photos")}
      </button>
    </div>

    <h2 class="section-title" id="visit-history-anchor">${t("visit_history")}</h2>
    <div id="checkin-history" class="card-list"></div>
  `;

  container.querySelector("#checkin-btn").addEventListener("click", () => {
    navigate(`#/checkin/${customerId}`);
  });
  container.querySelector("#navigate-btn").addEventListener("click", () => {
    openNavigation(customer.lat, customer.lng, {
      onShowOnMap: () => navigate(`#/map?customer=${customerId}`),
    });
  });
  container.querySelector("#back-btn").addEventListener("click", () => navigate.goBack("#/customers"));
  // Long names truncate with an ellipsis by default (see .detail-header-title
  // h1); tapping reveals the full name by letting it wrap instead of adding
  // a tooltip/sheet nobody would think to open.
  container.querySelector("#customer-detail-name").addEventListener("click", (e) => {
    e.currentTarget.classList.toggle("customer-detail-name-expanded");
  });
  container.querySelector("#new-order-btn").addEventListener("click", () => {
    navigate(`#/orders/new/${customerId}`);
  });
  container.querySelector("#edit-customer-btn").addEventListener("click", () => {
    openEditSheet(customer, navigate, () => renderCustomerDetail(root, navigate, customerId));
  });
  container.querySelector("#account-settings-btn")?.addEventListener("click", () => {
    openAccountSettingsSheet(customer, () => renderCustomerDetail(root, navigate, customerId));
  });
  container.querySelector("#customer-photos-btn").addEventListener("click", () => openCustomerPhotoGallery(customerId));
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

// Item 8 -- one consolidated "Account settings" sheet standing in for what
// used to be three separate overflow-menu entries (Assigned manager / ERP
// customer ID / Payment settings). Each section below only renders for a
// viewer who's actually allowed to touch it (same gates the three old
// buttons used), so this can render with anywhere from one section to all
// three.
//
// IMPORTANT: this still issues UP TO THREE separate PATCH /customers/:id
// calls on Save, one per section that's present -- never one combined call.
// The server's PATCH handler authorizes a request by asking "is every field
// in this body one this role may touch as a group" (canReassignCustomers
// for region/subregion/sales_channel/assigned_manager_id as a set,
// seesFinancialExports for payment_method/credit_term_days as a set,
// canAssignErpCustomerId for erp_customer_id alone) -- a request mixing
// fields from more than one of those groups falls through to an
// admin-only check instead, which would 403 a sales_director who is
// legitimately allowed to reassign but isn't an admin. Keeping the field
// groups in separate requests is what makes each section's own permission
// gate the one that actually applies.
async function openAccountSettingsSheet(customer, onDone) {
  const showReassign = canReassignCustomers();
  const showErp = canAssignErpCustomerId(customer);
  const showPayment = seesFinancialExports();

  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `
    <div class="sheet">
      <h2>${t("account_settings")}</h2>
      <form id="account-settings-form">
        ${
          showReassign
            ? `<p class="proposed-changes-label">${t("assigned_manager")}</p>
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
               </label>`
            : ""
        }
        ${
          showErp
            ? `<p class="proposed-changes-label">${t("erp_customer_id")}</p>
               <label class="erp-suggest-wrap"><span class="visually-hidden">${t("erp_customer_id")}</span>
                 <input type="text" name="erp_customer_id" value="${escapeHtml(customer.erp_customer_id ?? "")}" id="erp-customer-input" autocomplete="off" />
                 <div class="erp-suggest-list" id="erp-suggest-list" hidden></div>
               </label>`
            : ""
        }
        ${
          showPayment
            ? `<p class="proposed-changes-label">${t("payment_settings")}</p>
               <label>${t("payment_method_label")}
                 <select name="payment_method">
                   <option value="invoice" ${customer.payment_method !== "cash" ? "selected" : ""}>${t("payment_method_invoice")}</option>
                   <option value="cash" ${customer.payment_method === "cash" ? "selected" : ""}>${t("payment_method_cash")}</option>
                 </select>
               </label>
               <label>${t("credit_term_days_label")}
                 <input type="number" name="credit_term_days" min="1" step="1" value="${customer.credit_term_days ?? 45}" />
               </label>`
            : ""
        }
        <p class="form-error" id="account-settings-error" hidden></p>
        <div class="sheet-actions">
          <button type="button" class="btn" id="cancel-account-settings">${t("cancel")}</button>
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
  overlay.querySelector("#cancel-account-settings").addEventListener("click", close);
  overlay.addEventListener("click", (e) => e.target === overlay && close());

  if (showReassign) {
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
      .listAssignableManagers()
      .then((users) => {
        managerSelect.innerHTML =
          `<option value="">${t("unassigned")}</option>` +
          users
            .map((u) => {
              const label = u.role === "sales_director" ? `${u.name} (${t("role_sales_director")})` : u.name;
              return `<option value="${u.id}" ${u.id === customer.assigned_manager_id ? "selected" : ""}>${escapeHtml(label)}</option>`;
            })
            .join("");
      })
      .catch(() => {});
  }

  if (showErp) {
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
  }

  const form = overlay.querySelector("#account-settings-form");
  const errorEl = overlay.querySelector("#account-settings-error");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = new FormData(form);
    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = t("saving");

    // Each section below touches a disjoint set of columns and is its own
    // PATCH, so one section failing (e.g. a duplicate ERP ID) never rolls
    // back another's already-committed write -- but Promise.all used to
    // reject the whole submit the instant any one call failed, leaving the
    // sheet open on its original (pre-save) data with nothing but a small
    // error line to say why. That made a *successful* reassignment (region/
    // sales channel/manager) look like it silently didn't save whenever a
    // different section on the same form failed. allSettled + always
    // refreshing the page behind the sheet means whatever did commit is
    // visible immediately, and only the failed section blocks the sheet
    // from closing.
    const sections = [];
    if (showReassign) {
      sections.push({
        label: t("assigned_manager"),
        promise: api.updateCustomer(customer.id, {
          region: data.get("region") || null,
          subregion: data.get("subregion") || null,
          sales_channel: data.get("sales_channel") || null,
          assigned_manager_id: data.get("assigned_manager_id") ? Number(data.get("assigned_manager_id")) : null,
        }),
      });
    }
    if (showErp) {
      const erpInput = overlay.querySelector("#erp-customer-input");
      sections.push({
        label: t("erp_customer_id"),
        promise: api.updateCustomer(customer.id, { erp_customer_id: erpInput.value.trim() || null }),
      });
    }
    if (showPayment) {
      sections.push({
        label: t("payment_settings"),
        promise: api.updateCustomer(customer.id, {
          payment_method: data.get("payment_method"),
          // A stored credit_term_days of 0 would otherwise round-trip back
          // into the number input's value, which fails its own min="1"
          // client-side validation and silently blocks the whole submit --
          // clamp it here instead of trusting whatever was last stored.
          credit_term_days: Math.max(1, Number(data.get("credit_term_days")) || 45),
        }),
      });
    }

    const results = await Promise.allSettled(sections.map((s) => s.promise));
    const failures = results
      .map((r, i) => (r.status === "rejected" ? `${sections[i].label}: ${r.reason.message}` : null))
      .filter(Boolean);

    // Refresh the page underneath regardless -- some or all sections may
    // have committed even if others failed.
    onDone();

    if (failures.length) {
      errorEl.textContent = failures.join(" · ");
      errorEl.hidden = false;
      submitBtn.disabled = false;
      submitBtn.textContent = t("save");
    } else {
      close();
    }
  });
}

// Every photo captured at check-ins for this customer, most recent visit
// first -- a simple grid that opens into the same full-screen lightbox the
// per-visit detail sheet uses, rather than building a second viewer.
async function openCustomerPhotoGallery(customerId) {
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `
    <div class="sheet">
      <h2>${t("customer_photos")}</h2>
      <div id="customer-photo-gallery-body"><p class="loading-state" role="status">${t("loading")}</p></div>
    </div>
  `;
  document.body.appendChild(overlay);
  activateDialog(overlay);
  overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());

  const body = overlay.querySelector("#customer-photo-gallery-body");
  let checkins;
  try {
    ({ rows: checkins } = await api.listCheckins({ customer_id: customerId }));
  } catch (err) {
    body.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    return;
  }

  // listCheckins already returns rows newest-first, so flattening in order
  // keeps the gallery most-recent-first without a separate sort pass.
  const photos = [];
  for (const ch of checkins) {
    for (const photo of ch.photos ?? []) photos.push({ id: photo.id, timestamp: ch.timestamp });
  }

  if (!photos.length) {
    body.innerHTML = `<p class="empty-state">${t("no_photos_yet")}</p>`;
    return;
  }

  const urls = photos.map((p) => api.checkinPhotoByIdUrl(p.id));
  body.innerHTML = `
    <div class="checkin-photo-grid">
      ${photos
        .map(
          (p, i) => `
        <div class="checkin-photo-wrap">
          <img class="checkin-photo" data-photo-index="${i}" src="${urls[i]}" alt="${t("photo_optional")}" loading="lazy" />
        </div>`
        )
        .join("")}
    </div>
  `;
  body.querySelectorAll(".checkin-photo").forEach((img) => {
    img.addEventListener("click", () => openPhotoLightbox(urls, Number(img.dataset.photoIndex)));
  });
}

// Item 8 -- the core customer-fields form, merged with the "Edit contact &
// social profiles" sheet (a very recent addition) as one section at the
// bottom of the same form/sheet, rather than two separate entry points.
// That section only appears once the social data has loaded AND says this
// viewer may edit it (fetchCustomerSocial's can_edit) -- it's fetched here,
// independently of customerSocialProfiles.js's own decoration of the
// header's one-tap links, so this sheet can open immediately without
// waiting on that module's timing.
async function openEditSheet(customer, navigate, onDone) {
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
          // A phone field with nothing saved yet starts pre-filled with the
          // country code -- one less thing for a manager to type on every
          // new customer -- but an already-saved number is shown formatted
          // as-is, not silently rewritten under them.
          const rawValue = f.name === "phone" && !customer[f.name] ? "+374 " : customer[f.name] ?? "";
          const value = escapeHtml(f.name === "phone" && customer[f.name] ? formatPhoneDisplay(customer[f.name]) : rawValue);
          if (f.type === "textarea") {
            return `<label>${t(f.labelKey)}<textarea name="${f.name}" rows="2">${value}</textarea></label>`;
          }
          return `<label>${t(f.labelKey)}<input type="${f.type}" name="${f.name}" value="${value}" /></label>`;
        }).join("")}
        <div id="edit-social-section"></div>
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

  let socialData = null;
  fetchCustomerSocial(customer.id)
    .then((data) => {
      if (!overlay.isConnected || !data.can_edit) return;
      socialData = data;
      overlay.querySelector("#edit-social-section").innerHTML = socialFieldsHtml(data);
    })
    .catch(() => {});

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
    try {
      await api.deleteCustomer(customer.id);
      close();
      navigate("#/customers");
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  });

  const form = overlay.querySelector("#edit-customer-form");
  const errorEl = overlay.querySelector("#edit-customer-error");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = new FormData(form);
    const changes = { customer_tier: data.get("customer_tier") };
    for (const f of fields) {
      const raw = data.get(f.name);
      if (f.name === "phone") {
        // Bare "+374" (just the pre-filled prefix, nothing typed after it)
        // means the manager left it empty -- save null, not a phone number
        // that's only a country code.
        const digits = normalizePhone(raw);
        changes.phone = digits.length > 3 ? `+${digits}` : null;
      } else {
        changes[f.name] = f.type === "number" ? Number(raw) : raw;
      }
    }

    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    try {
      const calls = [canEditDirectly() ? api.updateCustomer(customer.id, changes) : api.createEditRequest(customer.id, changes)];
      // The social section only exists once fetchCustomerSocial resolved
      // with can_edit -- if the sheet was submitted before that finished
      // (or the viewer isn't allowed to edit it at all), there's nothing
      // to save here, same as before this merge.
      if (socialData) calls.push(saveCustomerSocial(customer.id, collectSocialPayload(form)));
      await Promise.all(calls);
      close();
      onDone();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
      submitBtn.disabled = false;
    }
  });
}
