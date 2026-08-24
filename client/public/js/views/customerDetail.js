import { api } from "../api.js";
import { activateCombobox, activateDialog, escapeHtml, formatDateTime, formatDistance, formatAmd, openNavigation, CATEGORY_OPTIONS } from "../util.js";
import { t } from "../i18n.js";
import { icons } from "../icons.js";
import { canEditDirectly, isAdmin } from "../state.js";

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

const BRAND_GROUP_LABEL_KEY = {
  castrol: "brand_group_castrol",
  lotos: "brand_group_lotos",
  royal: "brand_group_royal",
  competitors: "brand_group_competitors",
};

// New rows write `outcomes`/`brand_status`; rows from before the
// multi-outcome change only have the old singular `outcome`/`brands_found`.
function checkinOutcomeLabels(ch) {
  const outcomes = ch.outcomes?.length ? ch.outcomes : ch.outcome ? [ch.outcome] : [];
  return outcomes.map((o) => t(`outcome_${o}`));
}

function checkinBrandTags(ch) {
  if (ch.brand_status && Object.keys(ch.brand_status).length) {
    const tags = [];
    for (const [brand, values] of Object.entries(ch.brand_status)) {
      for (const v of values) {
        if (brand === "competitors") {
          tags.push(t(`competitor_${v}`));
        } else {
          tags.push(`${t(BRAND_GROUP_LABEL_KEY[brand])}: ${t(`brand_status_${v}`)}`);
        }
      }
    }
    return tags;
  }
  return (ch.brands_found ?? []).map((b) => t(`brand_${b}`));
}

const EDIT_FIELDS = [
  { name: "name", labelKey: "name", type: "text" },
  { name: "category", labelKey: "category", type: "select" },
  { name: "phone", labelKey: "phone", type: "tel" },
  { name: "address", labelKey: "address", type: "text" },
  { name: "visit_frequency_days", labelKey: "visit_frequency", type: "number" },
  { name: "notes", labelKey: "notes", type: "textarea" },
  { name: "tin", labelKey: "tin", type: "text" },
  // Internal ERP linking field — admin-only, not something a manager/director
  // should propose via the edit-request flow.
  { name: "erp_customer_id", labelKey: "erp_customer_id", type: "text", adminOnly: true },
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
    ? `${t("customer_id_label")}: ${escapeHtml(customer.erp_customer_id)}${customer.category ? ` · ${escapeHtml(customer.category)}` : ""}`
    : customer.category
    ? escapeHtml(customer.category)
    : "";

  container.innerHTML = `
    <div class="detail-header">
      <div class="detail-header-icon">${icons.store}</div>
      <div class="detail-header-title">
        <h1>${escapeHtml(customer.name)}</h1>
        ${idCategoryLine ? `<div class="muted detail-header-subtitle">${idCategoryLine}</div>` : ""}
        <div class="detail-header-status-row">
          <span class="badge ${badgeClass}">${badgeText}</span>
          ${customer.last_visit_at ? `<span class="muted detail-header-last-visit">${formatDateTime(customer.last_visit_at)}</span>` : ""}
        </div>
      </div>
      <div class="detail-header-actions">
        <button class="icon-btn" id="edit-customer-btn" aria-label="${t("edit")}">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>
        </button>
      </div>
    </div>

    <div class="card detail-facts-card">
      ${customer.address ? `<div class="detail-fact"><span class="detail-fact-icon">${icons.pin}</span><span>${escapeHtml(customer.address)}</span></div>` : ""}
      ${customer.phone ? `<div class="detail-fact"><span class="detail-fact-icon">${icons.phone}</span><a href="tel:${escapeHtml(customer.phone)}">${escapeHtml(customer.phone)}</a></div>` : ""}
      ${customer.category ? `<div class="detail-fact"><span class="detail-fact-icon">${icons.tag}</span><span>${escapeHtml(customer.category)}</span></div>` : ""}
      <div class="detail-fact"><span class="detail-fact-icon">${icons.repeat}</span><span>${t("visit_every_prefix")}${customer.visit_frequency_days}${t("visit_every_suffix")}</span></div>
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
        <span>${icons.pin}</span>${t("check_in")}
      </button>
      <button type="button" class="action-btn" id="navigate-btn">
        <span>${icons.compass}</span>${t("navigate")}
      </button>
      ${customer.phone ? `<a class="action-btn" href="tel:${escapeHtml(customer.phone)}"><span>${icons.phone}</span>${t("call")}</a>` : ""}
      <button class="action-btn" id="scroll-history-btn"><span>${icons.history}</span>${t("visit_history_short")}</button>
      ${customer.erp_synced_at ? `<button class="action-btn" id="order-history-btn"><span>${icons.box}</span>${t("order_history_short")}</button>` : ""}
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
  container.querySelector("#scroll-history-btn").addEventListener("click", () => {
    container.querySelector("#visit-history-anchor").scrollIntoView({ behavior: "smooth" });
  });
  container.querySelector("#edit-customer-btn").addEventListener("click", () => {
    openEditSheet(customer, navigate, () => renderCustomerDetail(root, navigate, customerId));
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
    historyEl.innerHTML = checkins
      .map(
        (ch) => `
        <div class="card checkin-card">
          <div class="checkin-card-header">
            <strong>${escapeHtml(ch.user_name)}</strong>
            <span class="muted">${formatDateTime(ch.timestamp)}</span>
          </div>
          <div class="checkin-card-badges">
            <span class="badge ${ch.within_range ? "badge-success" : "badge-danger"}">
              ${ch.within_range ? t("location_verified") : `${t("location_mismatch_away")} (${formatDistance(ch.distance_meters)} ${t("away")})`}
            </span>
            ${checkinOutcomeLabels(ch)
              .map((label) => `<span class="badge badge-neutral">${escapeHtml(label)}</span>`)
              .join("")}
          </div>
          ${
            checkinBrandTags(ch).length
              ? `<div class="brand-tags">${checkinBrandTags(ch).map((tag) => `<span class="brand-tag">${escapeHtml(tag)}</span>`).join("")}</div>`
              : ""
          }
          ${ch.note ? `<p class="checkin-note">${escapeHtml(ch.note)}</p>` : ""}
          ${
            ch.photo_path
              ? `<div class="checkin-photo-wrap">
                  <img class="checkin-photo" src="${api.checkinPhotoUrl(ch.id)}" alt="${t("photo_optional")}" loading="lazy" />
                  ${isAdmin() ? `<button class="photo-delete-btn" data-checkin-id="${ch.id}" aria-label="${t("delete_photo")}">&times;</button>` : ""}
                </div>`
              : ""
          }
        </div>
      `
      )
      .join("");

    historyEl.querySelectorAll(".photo-delete-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm(t("confirm_delete_photo"))) return;
        await api.deleteCheckinPhoto(btn.dataset.checkinId);
        renderCustomerDetail(root, navigate, customerId);
      });
    });
  }
}

function renderErpCard(customer, erpOrders) {
  if (!customer.erp_synced_at) return "";

  const debt = Number(customer.erp_debt_amd) || 0;
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

function openEditSheet(customer, navigate, onDone) {
  const fields = EDIT_FIELDS.filter((f) => !f.adminOnly || isAdmin());
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `
    <div class="sheet">
      <h2>${canEditDirectly() ? t("edit_customer") : t("request_edit")}</h2>
      <form id="edit-customer-form">
        ${fields.map((f) => {
          const value = escapeHtml(customer[f.name] ?? "");
          if (f.type === "textarea") {
            return `<label>${t(f.labelKey)}<textarea name="${f.name}" rows="2">${value}</textarea></label>`;
          }
          if (f.type === "select") {
            return `<label>${t(f.labelKey)}
              <select name="${f.name}">
                <option value="">${t("category_placeholder")}</option>
                ${CATEGORY_OPTIONS.map(
                  (c) => `<option value="${escapeHtml(c)}" ${customer[f.name] === c ? "selected" : ""}>${escapeHtml(c)}</option>`
                ).join("")}
              </select>
            </label>`;
          }
          if (f.name === "erp_customer_id") {
            return `<label class="erp-suggest-wrap">${t(f.labelKey)}
              <input type="text" name="${f.name}" value="${value}" id="erp-customer-input" autocomplete="off" />
              <div class="erp-suggest-list" id="erp-suggest-list" hidden></div>
            </label>`;
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

  const erpInput = overlay.querySelector("#erp-customer-input");
  const erpSuggestList = overlay.querySelector("#erp-suggest-list");
  if (erpInput) {
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
        ? erpOptions.filter(
            (r) => (r.customer_name || "").toLowerCase().includes(q) || r.erp_customer_id.includes(q)
          )
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

  const form = overlay.querySelector("#edit-customer-form");
  const errorEl = overlay.querySelector("#edit-customer-error");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = new FormData(form);
    const changes = {};
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
