import { api } from "../api.js";
import { escapeHtml, formatDateTime, formatDistance } from "../util.js";
import { t } from "../i18n.js";

function navigationUrl(lat, lng, name) {
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  return isIOS
    ? `https://maps.apple.com/?daddr=${lat},${lng}&q=${encodeURIComponent(name)}`
    : `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
}

export async function renderCustomerDetail(root, navigate, customerId) {
  root.innerHTML = `<div class="detail-view"><p class="muted">…</p></div>`;
  const container = root.querySelector(".detail-view");

  let customer, checkins;
  try {
    [customer, checkins] = await Promise.all([
      api.getCustomer(customerId),
      api.customerCheckins(customerId),
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
    </div>

    <div class="card detail-facts-card">
      ${customer.address ? `<div class="detail-fact">📍 ${escapeHtml(customer.address)}</div>` : ""}
      ${customer.phone ? `<div class="detail-fact">📞 <a href="tel:${escapeHtml(customer.phone)}">${escapeHtml(customer.phone)}</a></div>` : ""}
      ${customer.category ? `<div class="detail-fact">🏷️ ${escapeHtml(customer.category)}</div>` : ""}
      <div class="detail-fact">🔁 ${t("visit_frequency")}: ${t("every")} ${customer.visit_frequency_days} ${t("days")}</div>
      ${customer.notes ? `<div class="detail-fact muted">📝 ${escapeHtml(customer.notes)}</div>` : ""}
    </div>

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
          ${ch.photo_path ? `<img class="checkin-photo" src="${api.checkinPhotoUrl(ch.id)}" alt="Check-in photo" loading="lazy" />` : ""}
        </div>
      `
      )
      .join("");
  }
}
