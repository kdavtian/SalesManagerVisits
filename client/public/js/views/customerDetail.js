import { api } from "../api.js";
import { escapeHtml, formatDateTime, formatDistance } from "../util.js";
import { t } from "../i18n.js";

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

  const badgeClass = customer.visited_today ? "badge-success" : customer.visited_this_week ? "badge-info" : "badge-neutral";
  const badgeText = customer.visited_today ? t("visited_today") : customer.visited_this_week ? t("visited_this_week") : t("not_visited");

  container.innerHTML = `
    <div class="detail-header">
      <h1>${escapeHtml(customer.name)}</h1>
      <span class="badge ${badgeClass}">${badgeText}</span>
    </div>
    <div class="detail-facts">
      ${customer.category ? `<div>${escapeHtml(customer.category)}</div>` : ""}
      ${customer.phone ? `<div><a href="tel:${escapeHtml(customer.phone)}">${escapeHtml(customer.phone)}</a></div>` : ""}
      ${customer.address ? `<div>${escapeHtml(customer.address)}</div>` : ""}
      ${customer.notes ? `<div class="muted">${escapeHtml(customer.notes)}</div>` : ""}
    </div>
    <button class="btn btn-primary btn-block" id="checkin-btn">${t("check_in_here")}</button>

    <h2 class="section-title">${t("visit_history")}</h2>
    <div id="checkin-history" class="card-list"></div>
  `;

  container.querySelector("#checkin-btn").addEventListener("click", () => {
    navigate(`#/checkin/${customerId}`);
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
          <span class="badge ${ch.within_range ? "badge-success" : "badge-danger"}">
            ${ch.within_range ? t("location_verified") : `${t("location_mismatch_away")} (${formatDistance(ch.distance_meters)} ${t("away")})`}
          </span>
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
