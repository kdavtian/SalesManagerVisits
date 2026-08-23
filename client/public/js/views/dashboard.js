import { api } from "../api.js";
import { escapeHtml, formatRelative, formatDistance } from "../util.js";
import { state } from "../state.js";
import { t } from "../i18n.js";

export async function renderDashboard(root, navigate) {
  root.innerHTML = `<div class="dashboard-view"><p class="muted">…</p></div>`;
  const container = root.querySelector(".dashboard-view");

  let summary;
  try {
    summary = await api.dashboardSummary();
  } catch (err) {
    container.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    return;
  }

  const totals = summary.totals;

  container.innerHTML = `
    <h1>${state.user.role === "admin" ? t("dashboard_title") : t("my_activity_title")}</h1>
    <div class="stat-grid">
      <div class="stat-card"><span class="stat-value">${totals.total_customers}</span><span class="stat-label">${t("stat_customers")}</span></div>
      <div class="stat-card"><span class="stat-value">${totals.visited_today}</span><span class="stat-label">${t("stat_visited_today")}</span></div>
      <div class="stat-card"><span class="stat-value">${totals.visited_this_week}</span><span class="stat-label">${t("stat_visited_week")}</span></div>
      <div class="stat-card"><span class="stat-value">${totals.checkins_this_week}</span><span class="stat-label">${t("stat_checkins_week")}</span></div>
    </div>

    ${
      summary.by_manager
        ? `
      <h2 class="section-title">${t("by_manager_week")}</h2>
      <div class="card-list">
        ${summary.by_manager
          .map(
            (m) => `
          <div class="card manager-row">
            <strong>${escapeHtml(m.user_name)}</strong>
            <span class="muted">${m.checkins_this_week} · ${m.customers_visited_this_week}</span>
          </div>
        `
          )
          .join("") || `<p class="muted">${t("no_managers_yet")}</p>`}
      </div>
    `
        : ""
    }

    <h2 class="section-title">${t("recent_activity")}</h2>
    <div class="card-list" id="recent-activity"></div>
  `;

  const activityEl = container.querySelector("#recent-activity");
  if (!summary.recent_activity.length) {
    activityEl.innerHTML = `<p class="muted">${t("no_checkins_yet")}</p>`;
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
              ${a.within_range ? t("verified") : `${formatDistance(a.distance_meters)} ${t("off")}`}
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
