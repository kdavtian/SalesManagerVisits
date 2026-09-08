import { api } from "../api.js";
import { escapeHtml, formatDistance, formatRelative, getCurrentPosition, haversineMeters, categoryLabel } from "../util.js";
import { state } from "../state.js";
import { t } from "../i18n.js";
import { icons } from "../icons.js";
import { applyPaymentBadge, applyUnrecordedBadge, applyWarehouseBadge, applyDeliveryBadge } from "../app.js";
import { QUICK_ACTIONS, visibleQuickActionIds } from "../quickActions.js";

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

// The icon (and, for two tiles, a count badge) is the only thing that
// differs between tiles -- label and DOM id both fall straight out of the
// action's id, so the markup itself is written once. Which of these render
// is decided by visibleQuickActionIds() in ../quickActions.js: the admin's
// per-role override if one exists, otherwise that tile's shipped defaults.
// Each tile gets its own background color (grouped by purpose -- field
// work / money / fulfillment / analytics -- so tiles in the same family
// read as related while still being individually distinguishable) so a
// user can spot the right tile by color alone instead of reading every
// label. See .quick-action-icon-* in styles.css.
const QUICK_ACTION_ICON = {
  qa_check_in: () => `<span class="quick-action-icon quick-action-icon-checkin">${icons.mapPinCheck}</span>`,
  qa_plan_route: () => `<span class="quick-action-icon quick-action-icon-route">${icons.planDay}</span>`,
  qa_add_customer: () => `<span class="quick-action-icon quick-action-icon-accent">${icons.mapPinPlus}</span>`,
  qa_payments: () =>
    `<span class="quick-action-icon quick-action-icon-payments">${icons.payment}<span class="nav-badge count-badge" id="qa-payments-badge" hidden></span></span>`,
  qa_cash_expense: () => `<span class="quick-action-icon quick-action-icon-cash">${icons.wallet}</span>`,
  qa_pricelist: () => `<span class="quick-action-icon quick-action-icon-pricelist">${icons.tag}</span>`,
  qa_warehouse: () =>
    `<span class="quick-action-icon quick-action-icon-warehouse">${icons.box}<span class="nav-badge count-badge" id="qa-warehouse-badge" hidden></span></span>`,
  qa_delivery: () =>
    `<span class="quick-action-icon quick-action-icon-delivery">${icons.truck}<span class="nav-badge count-badge" id="qa-delivery-badge" hidden></span></span>`,
  qa_recorded: () =>
    `<span class="quick-action-icon quick-action-icon-recorded">${icons.clock}<span class="nav-badge count-badge" id="unrecorded-badge" hidden></span></span>`,
  qa_team_performance: () => `<span class="quick-action-icon quick-action-icon-team">${icons.target}</span>`,
  qa_reports: () => `<span class="quick-action-icon quick-action-icon-reports">${icons.chart}</span>`,
  qa_debt_balances: () => `<span class="quick-action-icon quick-action-icon-debt">${icons.wallet}</span>`,
  qa_company_dashboard: () => `<span class="quick-action-icon quick-action-icon-company">${icons.chart}</span>`,
};

const QUICK_ACTION_ROUTE = {
  qa_check_in: "#/map",
  qa_plan_route: "#/route-plans",
  qa_add_customer: "#/map?add=1",
  qa_payments: "#/payments",
  qa_cash_expense: "#/expenses",
  qa_pricelist: "#/pricelist",
  qa_warehouse: "#/warehouse",
  qa_delivery: "#/delivery",
  qa_recorded: "#/recorded",
  qa_team_performance: "#/team-performance",
  qa_reports: "#/reports",
  qa_debt_balances: "#/debt-balances",
  qa_company_dashboard: "#/company-dashboard",
};

// #qa-check-in etc. -- the DOM ids predate this refactor and other modules
// (plus the UI verification suite) select on them, so they are derived from
// the action id rather than changed.
function quickActionDomId(id) {
  return id.replace(/_/g, "-");
}

function quickActionsHtml(ids) {
  return QUICK_ACTIONS.filter((a) => ids.includes(a.id))
    .map(
      (a) => `<button type="button" class="quick-action" id="${quickActionDomId(a.id)}">
        ${QUICK_ACTION_ICON[a.id]()}
        <span>${t(a.id)}</span>
      </button>`
    )
    .join("");
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

  let summary, customers, trends, settings;
  try {
    [summary, customers, trends, settings] = await Promise.all([
      api.dashboardSummary(),
      // The result here only ever feeds renderNextVisit below, and only
      // for the roles that card is actually rendered for (not admin/ceo --
      // see the nextVisitSlot markup further down). GET /customers runs
      // 4 correlated subqueries per row and returns every customer in the
      // company with no filter, so this was the single most expensive part
      // of opening the dashboard for no benefit on an admin/ceo login, and
      // (for a sales_manager, this app's most common daily user) scoped
      // down to what "next visit" actually means for that role -- their
      // own assigned book, not the whole company's.
      state.user.role === "admin" || state.user.role === "ceo"
        ? Promise.resolve([])
        : api.listCustomers(state.user.role === "sales_manager" ? { assigned_manager_id: state.user.id } : {}),
      api.dashboardTrends(),
      api.getSettings(),
    ]);
  } catch (err) {
    container.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    return;
  }

  const totals = summary.totals;
  const remaining = Math.max(0, totals.total_customers - totals.visited_today);
  // "Here's your field plan for today" only means something to someone who
  // actually has a personal field plan -- a sales_manager (and, loosely, a
  // delivery_manager). Office/management roles (admin/ceo/sales_director/
  // accountant) see company-wide data here, not a plan of their own, so the
  // line read as wrong for them.
  const isManagementRole = !["sales_manager", "delivery_manager"].includes(state.user.role);

  container.innerHTML = `
    <div class="greeting-row">
      <div>
        <h1>${greeting()}, ${escapeHtml(state.user.name.split(" ")[0])}</h1>
        ${isManagementRole ? "" : `<p class="muted">${t("dashboard_subtitle")}</p>`}
      </div>
    </div>

    ${
      state.user.role === "admin" || state.user.role === "ceo"
        ? ""
        : `<div id="next-visit-slot" aria-live="polite">
      <div class="card next-visit-card next-visit-loading"><p class="loading-state" role="status">${t("loading")}</p></div>
    </div>`
    }

    <div class="card progress-card" id="progress-card" ${
      // Only made tappable when there's actually a by-manager section to
      // reveal (see summary.by_manager?.length gating below) -- a
      // sales_manager's own progress card has nothing to expand, so it
      // stays a plain static card, not a dead-looking button.
      summary.by_manager?.length ? `role="button" tabindex="0" aria-expanded="false" aria-controls="by-manager-section" aria-label="${t("toggle_by_manager_aria")}"` : ""
    }>
      <span class="progress-label">${t("today_progress")}</span>
      <div class="progress-main">
        <!-- A running week-to-date total, not just today's numbers -- on
             Monday this is just Monday's planned-vs-visited, but by Friday
             it's the sum of every planned/visited count from Monday
             through Friday (see computeWeekProgress in dashboard.js on the
             server). planned_to_date only counts approved plans, so it can
             legitimately be 0 (nobody's planned this week yet). -->
        <span class="progress-fraction">${totals.visited_to_date}<span class="progress-fraction-total">/${totals.planned_to_date}</span></span>
        <div class="progress-side">
          <div class="progress-side-row"><span class="dot dot-success"></span>${totals.visited_today} ${t("stat_visited_today")}</div>
          <div class="progress-side-row"><span class="dot dot-warning"></span>${remaining} ${t("stat_remaining")}</div>
          <div class="progress-side-row"><span class="dot dot-danger"></span>${totals.overdue} ${t("stat_overdue")}</div>
        </div>
      </div>
      <div class="progress-bar"><div class="progress-bar-fill" style="width:${totals.planned_to_date ? Math.round((totals.visited_to_date / totals.planned_to_date) * 100) : 0}%"></div></div>
      ${summary.by_manager?.length ? `<span class="progress-card-chevron" aria-hidden="true">${icons.chevronDown}</span>` : ""}
    </div>

    ${
      // by_manager is only ever non-null for the roles that see company-wide
      // data (director/admin/ceo/accountant) -- a sales_manager gets null
      // here and never sees this section, since the single progress card
      // above is already their own. Hidden by default (grid-template-rows
      // 0fr -- see .by-manager-collapse) and revealed by tapping the
      // progress card above; each row further expands in place into that
      // one manager's own progress-card numbers for a quick glance, and
      // carries a "View full performance" link into Team Performance
      // pre-scoped to that manager for the real drill-down.
      summary.by_manager?.length
        ? `<div class="by-manager-collapse" id="by-manager-section">
             <div class="by-manager-collapse-inner">
               <h2 class="section-title">${t("by_manager_week")}</h2>
               <div class="card-list" id="by-manager-list">
                 ${summary.by_manager
                   .map(
                     (m) => `
                   <details class="manager-drill-row">
                     <summary>
                       <span class="manager-drill-name">${escapeHtml(m.user_name)}</span>
                       <span class="muted">${m.checkins_this_week} ${t("qa_check_in")} · ${m.customers_visited_this_week} ${t("stat_visited_today")}</span>
                     </summary>
                     <div class="manager-drill-detail">
                       <div class="progress-side-row"><span class="dot dot-success"></span>${m.visited_today} ${t("stat_visited_today")}</div>
                       <div class="progress-side-row"><span class="dot dot-warning"></span>${Math.max(0, m.total_customers - m.visited_today)} ${t("stat_remaining")}</div>
                       <div class="progress-side-row"><span class="dot dot-danger"></span>${m.overdue} ${t("stat_overdue")}</div>
                       <div class="progress-side-row">${m.total_customers} ${t("total")}</div>
                       <button type="button" class="link-btn manager-drill-view-btn" data-view-manager="${m.user_id}">${t("view_full_performance")}</button>
                     </div>
                   </details>`
                   )
                   .join("")}
               </div>
             </div>
           </div>`
        : ""
    }

    <h2 class="section-title section-title-tight">${t("quick_actions")}</h2>
    <div class="quick-actions-grid">
      ${quickActionsHtml(visibleQuickActionIds(state.user.role, settings.quick_action_visibility))}
    </div>

    ${
      // Points are a sales-rep competition (see the leaderboard's role
      // filter server-side) -- everyone else was being shown a permanent
      // "0 points" card for a contest they aren't in.
      state.user.role === "sales_manager"
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
             <span class="muted leaderboard-prize-hint">${escapeHtml(settings.incentive_message || t("points_leaderboard_prize_hint"))}</span>
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
  // Every tile is optional now (an admin can hide any of them for any role),
  // so this wires whichever ones actually rendered rather than assuming a
  // fixed set exists.
  for (const [id, route] of Object.entries(QUICK_ACTION_ROUTE)) {
    container.querySelector(`#${quickActionDomId(id)}`)?.addEventListener("click", () => navigate(route));
  }
  applyPaymentBadge();
  applyUnrecordedBadge();
  applyWarehouseBadge();
  applyDeliveryBadge();

  const progressCard = container.querySelector("#progress-card");
  const byManagerSection = container.querySelector("#by-manager-section");
  if (progressCard && byManagerSection) {
    const toggleByManager = () => {
      const expanded = progressCard.getAttribute("aria-expanded") === "true";
      progressCard.setAttribute("aria-expanded", String(!expanded));
      byManagerSection.classList.toggle("expanded", !expanded);
    };
    progressCard.addEventListener("click", toggleByManager);
    progressCard.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggleByManager();
      }
    });
  }
  container.querySelectorAll("[data-view-manager]").forEach((btn) => {
    btn.addEventListener("click", () => navigate(`#/team-performance?manager=${encodeURIComponent(btn.dataset.viewManager)}`));
  });

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
