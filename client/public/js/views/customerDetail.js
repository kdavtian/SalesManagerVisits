import { api } from "../api.js";
import { escapeHtml, formatDateTime, formatDistance } from "../util.js";
import { t } from "../i18n.js";
import { canEditDirectly, isAdmin } from "../state.js";

function formatAmd(value) {
  if (value == null) return "";
  return `${Number(value).toLocaleString()} ${t("amd")}`;
}

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

function navigationUrl(lat, lng, name) {
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  return isIOS
    ? `https://maps.apple.com/?daddr=${lat},${lng}&q=${encodeURIComponent(name)}`
    : `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
}

const EDIT_FIELDS = [
  { name: "name", labelKey: "name", type: "text" },
  { name: "category", labelKey: "category", type: "text" },
  { name: "phone", labelKey: "phone", type: "tel" },
  { name: "address", labelKey: "address", type: "text" },
  { name: "visit_frequency_days", labelKey: "visit_frequency", type: "number" },
  { name: "notes", labelKey: "notes", type: "textarea" },
  // Internal ERP linking field — admin-only, not something a manager/director
  // should propose via the edit-request flow.
  { name: "erp_customer_id", labelKey: "erp_customer_id", type: "text", adminOnly: true },
];

export async function renderCustomerDetail(root, navigate, customerId) {
  root.innerHTML = `<div class="detail-view"><p class="muted">…</p></div>`;
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

  container.innerHTML = `
    <div class="detail-header">
      <div class="detail-header-icon">🏪</div>
      <div class="detail-header-title">
        <h1>${escapeHtml(customer.name)}</h1>
        <span class="badge ${badgeClass}">${badgeText}</span>
      </div>
      <div class="detail-header-actions">
        <button class="icon-btn" id="edit-customer-btn" aria-label="${t("edit")}">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>
        </button>
        ${
          isAdmin()
            ? `<button class="icon-btn icon-btn-danger" id="delete-customer-btn" aria-label="${t("delete")}">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6"/></svg>
        </button>`
            : ""
        }
      </div>
    </div>

    <div class="card detail-facts-card">
      ${customer.address ? `<div class="detail-fact">📍 ${escapeHtml(customer.address)}</div>` : ""}
      ${customer.phone ? `<div class="detail-fact">📞 <a href="tel:${escapeHtml(customer.phone)}">${escapeHtml(customer.phone)}</a></div>` : ""}
      ${customer.category ? `<div class="detail-fact">🏷️ ${escapeHtml(customer.category)}</div>` : ""}
      <div class="detail-fact">🔁 ${t("visit_frequency")}: ${t("every")} ${customer.visit_frequency_days} ${t("days")}</div>
      ${customer.notes ? `<div class="detail-fact muted">📝 ${escapeHtml(customer.notes)}</div>` : ""}
    </div>

    <div id="pending-request-slot"></div>

    ${renderErpCard(customer, erpOrders)}

    <div class="card next-visit-card">
      <div class="next-visit-header"><span>${t("next_visit")}</span></div>
      <div class="next-visit-due">${nextVisitHtml}</div>
    </div>

    <div class="detail-actions-grid">
      <button class="action-btn action-btn-primary" id="checkin-btn">
        <span>📍</span>${t("check_in")}
      </button>
      <a class="action-btn" href="${navigationUrl(customer.lat, customer.lng, customer.name)}" target="_blank" rel="noopener">
        <span>🧭</span>${t("navigate")}
      </a>
      ${customer.phone ? `<a class="action-btn" href="tel:${escapeHtml(customer.phone)}"><span>📞</span>${t("call")}</a>` : ""}
      <button class="action-btn" id="scroll-history-btn"><span>🕘</span>${t("visit_history")}</button>
    </div>

    <h2 class="section-title" id="visit-history-anchor">${t("visit_history")}</h2>
    <div id="checkin-history" class="card-list"></div>
  `;

  container.querySelector("#checkin-btn").addEventListener("click", () => {
    navigate(`#/checkin/${customerId}`);
  });
  container.querySelector("#scroll-history-btn").addEventListener("click", () => {
    container.querySelector("#visit-history-anchor").scrollIntoView({ behavior: "smooth" });
  });
  container.querySelector("#edit-customer-btn").addEventListener("click", () => {
    openEditSheet(customer, () => renderCustomerDetail(root, navigate, customerId));
  });
  container.querySelector("#delete-customer-btn")?.addEventListener("click", async () => {
    if (!confirm(t("confirm_delete_customer"))) return;
    await api.deleteCustomer(customerId);
    navigate("#/customers");
  });

  renderPendingRequest(container.querySelector("#pending-request-slot"), pendingRequests[0], () =>
    renderCustomerDetail(root, navigate, customerId)
  );

  container.querySelectorAll(".erp-order-row").forEach((row) => {
    row.addEventListener("click", () => openOrderDetailSheet(customerId, row.dataset.orderId));
  });
  container.querySelector("#show-all-orders-btn")?.addEventListener("click", () => {
    navigate(`#/customers/${customerId}/orders`);
  });

  const historyEl = container.querySelector("#checkin-history");
  if (!checkins.length) {
    historyEl.innerHTML = `<p class="muted">${t("no_visits_yet")}</p>`;
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
            ${ch.outcome ? `<span class="badge badge-neutral">${escapeHtml(t(`outcome_${ch.outcome}`))}</span>` : ""}
          </div>
          ${
            ch.brands_found?.length
              ? `<div class="brand-tags">${ch.brands_found.map((b) => `<span class="brand-tag">${escapeHtml(t(`brand_${b}`))}</span>`).join("")}</div>`
              : ""
          }
          ${ch.note ? `<p class="checkin-note">${escapeHtml(ch.note)}</p>` : ""}
          ${
            ch.photo_path
              ? `<div class="checkin-photo-wrap">
                  <img class="checkin-photo" src="${api.checkinPhotoUrl(ch.id)}" alt="Check-in photo" loading="lazy" />
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
  const orders = Array.isArray(erpOrders) ? erpOrders : [];

  return `
    <div class="card erp-card">
      <div class="erp-card-header">
        <span>${t("erp_data")}</span>
        ${customer.erp_assigned_sales_rep ? `<span>${t("erp_assigned_rep")}: ${escapeHtml(customer.erp_assigned_sales_rep)}</span>` : ""}
      </div>
      ${
        customer.erp_aging_bucket === "Data error - review"
          ? `<div class="erp-debt-row">
               <span class="erp-debt-amount">${t("erp_debt_unknown")}</span>
               <span class="badge badge-danger">${t("aging_data_error")}</span>
             </div>
             <div class="muted">${t("erp_debt_data_error_note")}</div>`
          : debt > 0
          ? `<div class="erp-debt-row">
               <span class="erp-debt-amount">${formatAmd(debt)}</span>
               <span class="badge ${agingClass}">${escapeHtml(t(AGING_LABEL_KEY[customer.erp_aging_bucket] || "") || customer.erp_aging_bucket)}</span>
             </div>
             ${customer.erp_last_payment_date ? `<div class="muted">${t("erp_last_payment")}: ${escapeHtml(String(customer.erp_last_payment_date).slice(0, 10))}</div>` : ""}`
          : `<div class="muted">${t("erp_no_debt")}</div>`
      }
      ${
        orders.length
          ? `<p class="proposed-changes-label">${t("erp_recent_orders")}</p>
             ${orders
               .slice(0, 5)
               .map(
                 (o) => `
               <div class="erp-order-row" data-order-id="${escapeHtml(o.order_id)}" role="button" tabindex="0">
                 <span>${escapeHtml(String(o.order_date).slice(0, 10))}</span>
                 <span class="erp-order-id">${escapeHtml(o.order_id)}</span>
                 <span>${formatAmd(o.total_amd)}</span>
               </div>`
               )
               .join("")}
             <button class="btn btn-block erp-show-all-btn" id="show-all-orders-btn">${t("show_all_orders")}</button>`
          : ""
      }
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
  overlay.innerHTML = `<div class="sheet"><p class="muted">…</p></div>`;
  document.body.appendChild(overlay);
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
          <span>${formatAmd(l.revenue_amd)}</span>
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

function openEditSheet(customer, onDone) {
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
    </div>
  `;
  document.body.appendChild(overlay);

  function close() {
    overlay.remove();
  }
  overlay.querySelector("#cancel-edit-customer").addEventListener("click", close);
  overlay.addEventListener("click", (e) => e.target === overlay && close());

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
    erpSuggestList.addEventListener("mousedown", (e) => {
      const item = e.target.closest(".erp-suggest-item");
      if (!item) return;
      erpInput.value = item.dataset.id;
      erpSuggestList.hidden = true;
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
