import { api } from "../api.js";
import { escapeHtml, formatDateTime, formatDistance } from "../util.js";

export async function renderCustomerDetail(root, navigate, customerId) {
  root.innerHTML = `<div class="detail-view"><p class="muted">Loading…</p></div>`;
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

  container.innerHTML = `
    <div class="detail-header">
      <h1>${escapeHtml(customer.name)}</h1>
      <span class="badge ${customer.visited_this_week ? "badge-success" : "badge-neutral"}">
        ${customer.visited_this_week ? "Visited this week" : "Not visited"}
      </span>
    </div>
    <div class="detail-facts">
      ${customer.category ? `<div>${escapeHtml(customer.category)}</div>` : ""}
      ${customer.phone ? `<div><a href="tel:${escapeHtml(customer.phone)}">${escapeHtml(customer.phone)}</a></div>` : ""}
      ${customer.address ? `<div>${escapeHtml(customer.address)}</div>` : ""}
      ${customer.notes ? `<div class="muted">${escapeHtml(customer.notes)}</div>` : ""}
    </div>
    <button class="btn btn-primary btn-block" id="checkin-btn">Check In Here</button>

    <h2 class="section-title">Visit history</h2>
    <div id="checkin-history" class="card-list"></div>
  `;

  container.querySelector("#checkin-btn").addEventListener("click", () => {
    navigate(`#/checkin/${customerId}`);
  });

  const historyEl = container.querySelector("#checkin-history");
  if (!checkins.length) {
    historyEl.innerHTML = `<p class="muted">No visits recorded yet.</p>`;
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
            ${ch.within_range ? "Location verified" : `Mismatch (${formatDistance(ch.distance_meters)} away)`}
          </span>
          ${ch.note ? `<p class="checkin-note">${escapeHtml(ch.note)}</p>` : ""}
          ${ch.photo_path ? `<img class="checkin-photo" src="${api.checkinPhotoUrl(ch.id)}" alt="Check-in photo" loading="lazy" />` : ""}
        </div>
      `
      )
      .join("");
  }
}
