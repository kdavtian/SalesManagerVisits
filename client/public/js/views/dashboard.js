import { api } from "../api.js";
import { escapeHtml, formatRelative, formatDistance } from "../util.js";
import { state } from "../state.js";

export async function renderDashboard(root, navigate) {
  root.innerHTML = `<div class="dashboard-view"><p class="muted">Loading…</p></div>`;
  const container = root.querySelector(".dashboard-view");

  let summary;
  try {
    summary = await api.dashboardSummary();
  } catch (err) {
    container.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    return;
  }

  const t = summary.totals;

  container.innerHTML = `
    <h1>${state.user.role === "admin" ? "Dashboard" : "My Activity"}</h1>
    <div class="stat-grid">
      <div class="stat-card"><span class="stat-value">${t.total_customers}</span><span class="stat-label">Customers</span></div>
      <div class="stat-card"><span class="stat-value">${t.visited_today}</span><span class="stat-label">Visited today</span></div>
      <div class="stat-card"><span class="stat-value">${t.visited_this_week}</span><span class="stat-label">Visited this week</span></div>
      <div class="stat-card"><span class="stat-value">${t.checkins_this_week}</span><span class="stat-label">Check-ins this week</span></div>
    </div>

    ${
      summary.by_manager
        ? `
      <h2 class="section-title">By manager (this week)</h2>
      <div class="card-list">
        ${summary.by_manager
          .map(
            (m) => `
          <div class="card manager-row">
            <strong>${escapeHtml(m.user_name)}</strong>
            <span class="muted">${m.checkins_this_week} check-ins · ${m.customers_visited_this_week} customers</span>
          </div>
        `
          )
          .join("") || '<p class="muted">No managers yet.</p>'}
      </div>
    `
        : ""
    }

    <h2 class="section-title">Recent activity</h2>
    <div class="card-list" id="recent-activity"></div>
  `;

  const activityEl = container.querySelector("#recent-activity");
  if (!summary.recent_activity.length) {
    activityEl.innerHTML = `<p class="muted">No check-ins yet.</p>`;
  } else {
    activityEl.innerHTML = summary.recent_activity
      .map(
        (a) => `
        <button class="card activity-row" data-customer-id="${a.customer_id}">
          <div class="activity-row-main">
            <strong>${escapeHtml(a.customer_name)}</strong>
            <span class="muted">${escapeHtml(a.user_name)} · ${formatRelative(a.timestamp)}</span>
          </div>
          <span class="card-trailing">
            <span class="badge ${a.within_range ? "badge-success" : "badge-danger"}">
              ${a.within_range ? "Verified" : `${formatDistance(a.distance_meters)} off`}
            </span>
            <span class="chevron">&#8250;</span>
          </span>
        </button>
      `
      )
      .join("");

    activityEl.querySelectorAll(".activity-row").forEach((el) => {
      el.addEventListener("click", () => navigate(`#/customers/${el.dataset.customerId}`));
    });
  }
}
