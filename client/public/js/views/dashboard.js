import { api } from "../api.js";
import { escapeHtml, formatDistance, formatRelative, getCurrentPosition, haversineMeters } from "../util.js";
import { state } from "../state.js";
import { t } from "../i18n.js";
import { icons } from "../icons.js";

function greeting() {
  const hour = new Date().getHours();
  if (hour < 12) return t("greeting_morning");
  if (hour < 18) return t("greeting_afternoon");
  return t("greeting_evening");
}

export async function renderDashboard(root, navigate) {
  root.innerHTML = `<div class="dashboard-view"><p class="loading-state" role="status">${t("loading")}</p></div>`;
  const container = root.querySelector(".dashboard-view");

  let summary, customers;
  try {
    [summary, customers] = await Promise.all([api.dashboardSummary(), api.listCustomers()]);
  } catch (err) {
    container.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    return;
  }

  const totals = summary.totals;
  const remaining = Math.max(0, totals.total_customers - totals.visited_today);

  container.innerHTML = `
    <div class="greeting-row">
      <div>
        <h1>${greeting()}, ${escapeHtml(state.user.name.split(" ")[0])}</h1>
        <p class="muted">${t("dashboard_subtitle")}</p>
      </div>
    </div>

    <div class="card progress-card">
      <span class="progress-label">${t("today_progress")}</span>
      <div class="progress-main">
        <span class="progress-fraction">${totals.visited_today}<span class="progress-fraction-total">/${totals.total_customers}</span></span>
        <div class="progress-side">
          <div class="progress-side-row"><span class="dot dot-success"></span>${totals.visited_today} ${t("stat_visited_today")}</div>
          <div class="progress-side-row"><span class="dot dot-warning"></span>${remaining} ${t("stat_remaining")}</div>
          <div class="progress-side-row"><span class="dot dot-danger"></span>${totals.overdue} ${t("stat_overdue")}</div>
        </div>
      </div>
      <div class="progress-bar"><div class="progress-bar-fill" style="width:${totals.total_customers ? Math.round((totals.visited_today / totals.total_customers) * 100) : 0}%"></div></div>
    </div>

    ${
      state.user.role !== "admin"
        ? `<div class="card points-card">
            <div class="points-card-main">
              <span class="progress-label">${t("points_this_month")}</span>
              <span class="points-value">${summary.my_points.total_points}</span>
            </div>
            <div class="points-breakdown muted">
              ${summary.my_points.visit_points} ${t("points_from_visits")} · ${summary.my_points.photo_points} ${t("points_from_photos")}
            </div>
          </div>`
        : ""
    }

    ${
      summary.points_leaderboard?.length
        ? `<h2 class="section-title">${t("points_leaderboard")}</h2>
           <div class="card-list" id="points-leaderboard"></div>`
        : ""
    }

    <div id="next-visit-slot"></div>

    <h2 class="section-title">${t("todays_summary")}</h2>
    <div class="stat-grid stat-grid-alerts">
      <div class="stat-card"><span class="stat-value">${totals.rejected_today}</span><span class="stat-label">${t("stat_rejected_today")}</span></div>
      <div class="stat-card"><span class="stat-value">${totals.overdue}</span><span class="stat-label">${t("stat_overdue")}</span></div>
    </div>

    <div class="section-heading-row">
      <h2 class="section-title section-title-inline">${t("recent_activity")}</h2>
      <button class="link-btn" id="view-all-activity">${t("view_all")}</button>
    </div>
    <div class="card-list" id="recent-activity"></div>

    <h2 class="section-title">${t("quick_actions")}</h2>
    <div class="quick-actions-grid">
      <button class="quick-action" id="qa-check-in">
        <span class="quick-action-icon">${icons.pin}</span>
        <span>${t("qa_check_in")}</span>
      </button>
      <button class="quick-action" id="qa-plan-route">
        <span class="quick-action-icon">${icons.planDay}</span>
        <span>${t("qa_plan_route")}</span>
      </button>
      <button class="quick-action" id="qa-reports">
        <span class="quick-action-icon">${icons.chart}</span>
        <span>${t("qa_reports")}</span>
      </button>
      <button class="quick-action" id="qa-add-customer">
        <span class="quick-action-icon quick-action-icon-accent">${icons.plus}</span>
        <span>${t("qa_add_customer")}</span>
      </button>
    </div>
  `;

  container.querySelector("#view-all-activity").addEventListener("click", () => navigate("#/activity"));
  container.querySelector("#qa-check-in").addEventListener("click", () => navigate("#/map"));
  container.querySelector("#qa-plan-route").addEventListener("click", () => navigate("#/map?plan=1"));
  container.querySelector("#qa-reports").addEventListener("click", () => navigate("#/activity"));
  container.querySelector("#qa-add-customer").addEventListener("click", () => navigate("#/map?add=1"));

  const leaderboardEl = container.querySelector("#points-leaderboard");
  if (leaderboardEl && summary.points_leaderboard?.length) {
    leaderboardEl.innerHTML = summary.points_leaderboard
      .slice(0, 5)
      .map(
        (p, i) => `
        <div class="card leaderboard-row">
          <span class="leaderboard-rank">${i === 0 ? "🏆" : `#${i + 1}`}</span>
          <span class="leaderboard-name">${escapeHtml(p.user_name)}</span>
          <span class="leaderboard-points">${p.total_points} ${t("points_short")}</span>
        </div>
      `
      )
      .join("");
  }

  const activityEl = container.querySelector("#recent-activity");
  const recent = summary.recent_activity.slice(0, 3);
  if (!recent.length) {
    activityEl.innerHTML = `<p class="empty-state">${t("no_checkins_yet")}</p>`;
  } else {
    activityEl.innerHTML = recent
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

  renderNextVisit(container.querySelector("#next-visit-slot"), customers, navigate);
}

async function renderNextVisit(slot, customers, navigate) {
  const candidates = customers.filter((c) => !c.visited_today);
  if (!candidates.length) return;

  candidates.sort((a, b) => (b.overdue ? 1 : 0) - (a.overdue ? 1 : 0));
  let next = candidates[0];
  let distanceText = "";

  try {
    const pos = await getCurrentPosition({ timeout: 4000 });
    let nearest = null;
    let nearestDist = Infinity;
    for (const c of candidates) {
      const d = haversineMeters(pos.coords.latitude, pos.coords.longitude, c.lat, c.lng);
      if (d < nearestDist) {
        nearestDist = d;
        nearest = c;
      }
    }
    if (nearest) {
      next = nearest;
      distanceText = formatDistance(nearestDist);
    }
  } catch {
    // No location available — fall back to the overdue/first candidate above.
  }

  slot.innerHTML = `
    <div class="card next-visit-card">
      <div class="next-visit-header">
        <span>${t("next_visit")}</span>
        <span class="chevron">&#8250;</span>
      </div>
      <div class="next-visit-body">
        <div class="next-visit-icon">${icons.store}</div>
        <div class="next-visit-info">
          <strong>${escapeHtml(next.name)}</strong>
          ${next.category ? `<span class="muted">${escapeHtml(next.category)}</span>` : ""}
          ${distanceText ? `<span class="muted inline-icon-text">${icons.pin} ${distanceText}</span>` : ""}
        </div>
      </div>
      <div class="next-visit-actions">
        <button class="btn btn-primary" id="next-visit-checkin">${t("check_in")}</button>
        <button class="btn" id="next-visit-details">${t("view_customer")}</button>
      </div>
    </div>
  `;
  slot.querySelector("#next-visit-checkin").addEventListener("click", () => navigate(`#/checkin/${next.id}`));
  slot.querySelector("#next-visit-details").addEventListener("click", () => navigate(`#/customers/${next.id}`));
  slot.querySelector(".next-visit-header").addEventListener("click", () => navigate(`#/customers/${next.id}`));
}
