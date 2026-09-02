import { api } from "../api.js";
import { escapeHtml, formatDistance, formatRelative, getCurrentPosition, haversineMeters, categoryLabel } from "../util.js";
import { state } from "../state.js";
import { t } from "../i18n.js";
import { icons } from "../icons.js";

// A dependency-free CSS bar chart -- this app has no charting library, and
// 30 bars is simple enough not to need one. Each bar's height is relative
// to the busiest day in the window, not an absolute scale, so a quiet
// period still reads as a legible shape instead of 30 near-flat slivers.
function trendChartHtml(daily) {
  const max = Math.max(1, ...daily.map((d) => d.visits));
  const bars = daily
    .map((d) => {
      const heightPct = Math.round((d.visits / max) * 100);
      const label = new Date(`${d.day}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
      return `<div class="trend-bar" style="height:${Math.max(heightPct, d.visits > 0 ? 4 : 0)}%" title="${label}: ${d.visits}"></div>`;
    })
    .join("");
  return `<div class="trend-chart" role="img" aria-label="${t("visit_trends")}">${bars}</div>`;
}

function comparisonCardHtml(label, current, previous, sublabel) {
  current = Number(current);
  previous = Number(previous);
  const delta = previous > 0 ? Math.round(((current - previous) / previous) * 100) : current > 0 ? 100 : 0;
  const trendCls = delta > 0 ? "trend-up" : delta < 0 ? "trend-down" : "trend-flat";
  const arrow = delta > 0 ? "&#8593;" : delta < 0 ? "&#8595;" : "&#8226;";
  return `
    <div class="stat-card">
      <span class="stat-value">${current}</span>
      <span class="stat-label">${label}</span>
      <span class="stat-sublabel ${trendCls}">${arrow} ${Math.abs(delta)}% ${sublabel}</span>
    </div>
  `;
}

function greeting() {
  const hour = new Date().getHours();
  if (hour < 12) return t("greeting_morning");
  if (hour < 18) return t("greeting_afternoon");
  return t("greeting_evening");
}

export async function renderDashboard(root, navigate) {
  root.innerHTML = `<div class="dashboard-view"><p class="loading-state" role="status">${t("loading")}</p></div>`;
  const container = root.querySelector(".dashboard-view");

  let summary, customers, trends;
  try {
    [summary, customers, trends] = await Promise.all([api.dashboardSummary(), api.listCustomers(), api.dashboardTrends()]);
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

    ${
      state.user.role === "admin" || state.user.role === "ceo"
        ? ""
        : `<div id="next-visit-slot" aria-live="polite">
      <div class="card next-visit-card next-visit-loading"><p class="loading-state" role="status">${t("loading")}</p></div>
    </div>`
    }

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

    <h2 class="section-title">${t("quick_actions")}</h2>
    <div class="quick-actions-grid">
      <button type="button" class="quick-action" id="qa-check-in">
        <span class="quick-action-icon quick-action-icon-checkin">${icons.mapPinCheck}</span>
        <span>${t("qa_check_in")}</span>
      </button>
      <button type="button" class="quick-action" id="qa-plan-route">
        <span class="quick-action-icon">${icons.planDay}</span>
        <span>${t("qa_plan_route")}</span>
      </button>
      <button type="button" class="quick-action" id="qa-reports">
        <span class="quick-action-icon">${icons.chart}</span>
        <span>${t("qa_reports")}</span>
      </button>
      <button type="button" class="quick-action" id="qa-add-customer">
        <span class="quick-action-icon quick-action-icon-accent">${icons.mapPinPlus}</span>
        <span>${t("qa_add_customer")}</span>
      </button>
      <button type="button" class="quick-action" id="qa-cash-expense">
        <span class="quick-action-icon">${icons.wallet}</span>
        <span>${t("qa_cash_expense")}</span>
      </button>
      ${
        ["admin", "ceo", "sales_director", "accountant", "sales_manager"].includes(state.user.role)
          ? `<button type="button" class="quick-action" id="qa-team-performance">
        <span class="quick-action-icon">${icons.target}</span>
        <span>${t("qa_team_performance")}</span>
      </button>`
          : ""
      }
    </div>

    ${
      state.user.role !== "admin"
        ? `<div class="card points-card">
            <div class="points-card-main">
              <span class="progress-label">🏆 ${t("points_this_month")}</span>
              <span class="points-value">${summary.my_points.total_points}</span>
            </div>
            <div class="points-breakdown muted">
              ${summary.my_points.visit_points} ${t("points_from_visits")} · ${summary.my_points.photo_points} ${t("points_from_photos")} · ${summary.my_points.customer_points} ${t("points_from_customers")}
            </div>
          </div>`
        : ""
    }

    ${
      summary.points_leaderboard?.length
        ? `<div class="section-heading-row">
             <h2 class="section-title section-title-inline">${t("points_leaderboard")}</h2>
             <span class="muted leaderboard-prize-hint">${t("points_leaderboard_prize_hint")}</span>
           </div>
           <div class="card-list" id="points-leaderboard"></div>`
        : ""
    }

    <details class="dashboard-insights">
      <summary>${t("performance_insights")}</summary>

    <h2 class="section-title">${t("visit_trends")}</h2>
    <div class="card trend-chart-card">
      ${trendChartHtml(trends.daily)}
    </div>
    <div class="stat-grid">
      ${comparisonCardHtml(t("this_week"), trends.comparison.this_week, trends.comparison.last_week, t("vs_last_week"))}
      ${comparisonCardHtml(t("this_month"), trends.comparison.this_month, trends.comparison.last_month, t("vs_last_month"))}
    </div>
    </details>

    <div class="section-heading-row">
      <h2 class="section-title section-title-inline">${t("recent_activity")}</h2>
      <button class="link-btn" id="view-all-activity">${t("view_all")}</button>
    </div>
    <div class="card-list" id="recent-activity"></div>

  `;

  container.querySelector("#view-all-activity").addEventListener("click", () => navigate("#/activity"));
  container.querySelector("#qa-check-in").addEventListener("click", () => navigate("#/map"));
  container.querySelector("#qa-plan-route").addEventListener("click", () => navigate("#/route-plans"));
  container.querySelector("#qa-reports").addEventListener("click", () => navigate("#/reports"));
  container.querySelector("#qa-add-customer").addEventListener("click", () => navigate("#/map?add=1"));
  container.querySelector("#qa-cash-expense").addEventListener("click", () => navigate("#/expenses"));
  container.querySelector("#qa-team-performance")?.addEventListener("click", () => navigate("#/team-performance"));

  const leaderboardEl = container.querySelector("#points-leaderboard");
  if (leaderboardEl && summary.points_leaderboard?.length) {
    const board = summary.points_leaderboard;
    const myIndex = board.findIndex((p) => p.user_id === state.user.id);
    // Top 5 always show; if the current user isn't in it, their own row is
    // appended below a divider so nobody has to wonder where they stand --
    // "seeing the leaderboard but not knowing your own rank" is not
    // motivating, it's just noise.
    const top = board.slice(0, 5);
    const mine = myIndex >= 5 ? board[myIndex] : null;
    const rowHtml = (p, rank) => `
        <div class="card leaderboard-row ${p.user_id === state.user.id ? "leaderboard-row-mine" : ""}">
          <span class="leaderboard-rank">${rank === 0 ? "🏆" : `#${rank + 1}`}</span>
          <span class="leaderboard-name">${escapeHtml(p.user_name)}</span>
          <span class="leaderboard-points">${p.total_points} ${t("points_short")}</span>
        </div>
      `;
    leaderboardEl.innerHTML =
      top.map((p, i) => rowHtml(p, i)).join("") +
      (mine ? `<div class="leaderboard-divider muted">${t("points_your_rank")}</div>${rowHtml(mine, myIndex)}` : "");
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

  const nextVisitSlot = container.querySelector("#next-visit-slot");
  if (nextVisitSlot) renderNextVisit(nextVisitSlot, customers, navigate);
}

async function renderNextVisit(slot, customers, navigate) {
  const candidates = customers.filter((c) => !c.visited_today);
  if (!candidates.length) {
    slot.innerHTML = "";
    return;
  }

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
          ${next.category ? `<span class="muted">${escapeHtml(categoryLabel(next.category))}</span>` : ""}
          ${distanceText ? `<span class="muted inline-icon-text">${icons.pin} ${distanceText}</span>` : ""}
        </div>
      </div>
      <div class="next-visit-actions">
        <button class="btn btn-primary" id="next-visit-checkin"><span>${icons.mapPinCheck}</span>${t("check_in")}</button>
        <button class="btn" id="next-visit-details">${t("view_customer")}</button>
      </div>
    </div>
  `;
  slot.querySelector("#next-visit-checkin").addEventListener("click", () => navigate(`#/checkin/${next.id}`));
  slot.querySelector("#next-visit-details").addEventListener("click", () => navigate(`#/customers/${next.id}`));
  slot.querySelector(".next-visit-header").addEventListener("click", () => navigate(`#/customers/${next.id}`));
}
