import { api } from "../api.js";
import { escapeHtml, formatDistance, formatRelative, formatAmd, getCurrentPosition, haversineMeters, categoryLabel } from "../util.js";
import { state } from "../state.js";
import { t } from "../i18n.js";
import { icons } from "../icons.js";
import { applyPaymentBadge, applyUnrecordedBadge, applyWarehouseBadge, applyDeliveryBadge } from "../app.js";
import { QUICK_ACTIONS, QUICK_ACTION_ROUTE, visibleQuickActionIds } from "../quickActions.js";
import { loadWithCache } from "../listCache.js";

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
  qa_company_dashboard: () => `<span class="quick-action-icon quick-action-icon-company">${icons.dashboard}</span>`,
  qa_sales: () => `<span class="quick-action-icon quick-action-icon-sales">${icons.trendUp}</span>`,
  qa_bonuses: () => `<span class="quick-action-icon quick-action-icon-bonuses">${icons.gift}</span>`,
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

// CEO/admin home tab, replacing the "Recent activity" section removed for
// those roles (see the role check further down) -- a tap-through glance at
// today's MTD Sales-vs-Plan and Collected, from the same leaderboard
// Company Dashboard's own Overview reads (see GET /api/sales-performance,
// now returning plan_amd instead of the old unreliable budget_amd).
function companyDashboardPreviewHtml(planPreview) {
  if (!Array.isArray(planPreview) || !planPreview.length) return "";
  const totals = planPreview.reduce(
    (sum, r) => ({
      sales: sum.sales + (Number(r.sales_amd) || 0),
      plan: sum.plan + (Number(r.plan_amd) || 0),
      collected: sum.collected + (Number(r.collected_amd) || 0),
    }),
    { sales: 0, plan: 0, collected: 0 }
  );
  const pct = totals.plan > 0 ? Math.min(100, Math.round((totals.sales / totals.plan) * 100)) : 0;
  return `
    <button type="button" class="card report-drill-card" id="company-dashboard-preview-card">
      <div class="section-heading-row">
        <h2 class="section-title section-title-inline">${t("company_dashboard_title")}</h2>
        <span class="chevron">&#8250;</span>
      </div>
      <div class="perf-bar-main">
        <span class="perf-bar-actual">${formatAmd(Math.round(totals.sales))}</span>
        <span class="muted"> / ${formatAmd(Math.round(totals.plan))}${totals.plan ? ` (${pct}%)` : ""}</span>
      </div>
      <div class="progress-bar"><div class="progress-bar-fill" style="width:${pct}%"></div></div>
      <p class="muted" style="margin:8px 0 0;">${t("company_dashboard_collected_label")}: ${formatAmd(Math.round(totals.collected))}</p>
    </button>
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

  // Stale-while-revalidate: a returning user has almost certainly seen
  // this exact screen recently, so paint whatever was cached from last
  // time immediately (see listCache.js) and repaint with the live network
  // response the moment it lands, instead of sitting on the loading state
  // above for an entire round trip every single time the app opens.
  try {
    await loadWithCache(
      `dashboard-summary:${state.user.id}`,
      async () => {
        const isCeoOrAdmin =
          state.user.role === "admin" || state.user.role === "ceo" || state.user.role === "operations_director";
        const isSalesManager = state.user.role === "sales_manager";
        const [summary, customers, trends, settings, planPreview, myPlan] = await Promise.all([
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
          isCeoOrAdmin ? Promise.resolve([]) : api.listCustomers(state.user.role === "sales_manager" ? { assigned_manager_id: state.user.id } : {}),
          api.dashboardTrends(),
          api.getSettings(),
          // Company Dashboard preview card (ceo/admin only, see paint()
          // below) -- same MTD leaderboard Company Dashboard's own Overview
          // reads (now plan_amd, not the old unreliable budget_amd). A
          // failure here shouldn't break the rest of the home tab, so it
          // degrades to no preview card instead of a load error.
          isCeoOrAdmin ? api.getSalesPerformanceLeaderboard("mtd").catch(() => null) : Promise.resolve(null),
          // Today's actual planned stops (route_plans.js's own "Plan Day"
          // source of truth, GET /visit-plans/mine) -- distinct from the
          // "next visit" card above, which only ever suggests one nearest/
          // overdue customer out of the whole assigned book, not the set of
          // customers actually scheduled for today. sales_manager only:
          // visit plans are a field-rep concept, not one delivery_manager/
          // sales_director/accountant currently have a UI for setting.
          isSalesManager ? api.getMyVisitPlan().catch(() => null) : Promise.resolve(null),
        ]);
        return { summary, customers, trends, settings, planPreview, myPlan };
      },
      (data) => paint(data)
    );
  } catch (err) {
    container.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    return;
  }

  function paint({ summary, customers, trends, settings, planPreview, myPlan }) {
  const totals = summary.totals;
  const remaining = Math.max(0, totals.total_customers - totals.visited_today);
  // "Here's your field plan for today" only means something to someone who
  // actually has a personal field plan -- a sales_manager (and, loosely, a
  // delivery_manager). Office/management roles (admin/ceo/sales_director/
  // accountant) see company-wide data here, not a plan of their own, so the
  // line read as wrong for them.
  const isManagementRole = !["sales_manager", "delivery_manager"].includes(state.user.role);

  container.innerHTML = `
    <div class="dashboard-grid">
    <div class="greeting-row">
      <div>
        <h1>${greeting()}, ${escapeHtml(state.user.name.split(" ")[0])}</h1>
        ${isManagementRole ? "" : `<p class="muted">${t("dashboard_subtitle")}</p>`}
      </div>
    </div>

    ${
      state.user.role === "admin" || state.user.role === "ceo" || state.user.role === "operations_director"
        ? ""
        : `<div id="next-visit-slot" aria-live="polite">
      <div class="card next-visit-card next-visit-loading"><p class="loading-state" role="status">${t("loading")}</p></div>
    </div>`
    }

    ${state.user.role === "sales_manager" ? `<div id="today-plan-slot"></div>` : ""}

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

    <div>
    <h2 class="section-title section-title-tight">${t("quick_actions")}</h2>
    <div class="quick-actions-grid">
      ${quickActionsHtml(
        visibleQuickActionIds(state.user.role, settings.quick_action_visibility).filter(
          (id) => id !== "qa_bonuses" || settings.bonuses_enabled
        )
      )}
    </div>
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
        ? `<div>
           <div class="section-heading-row">
             <h2 class="section-title section-title-inline">${t("points_leaderboard")}</h2>
             <span class="muted leaderboard-prize-hint">${escapeHtml(settings.incentive_message || t("points_leaderboard_prize_hint"))}</span>
           </div>
           <div class="card-list" id="points-leaderboard"></div>
           </div>`
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

    ${
      // CEO/admin already have the full company-wide feed one tap away
      // (the Activity tab shows them the same seesAll-scoped checkins this
      // section pulls its own rows from -- see GET /dashboard's
      // recentActivityQuery), so this was just a smaller, more limited
      // duplicate of a screen they already have. Every other role keeps
      // it: for them it's a quick "did my last few check-ins register OK"
      // glance, not a shrunk copy of something else on their home tab.
      ["ceo", "operations_director", "admin"].includes(state.user.role)
        ? companyDashboardPreviewHtml(planPreview)
        : `<div>
          <div class="section-heading-row">
            <h2 class="section-title section-title-inline">${t("recent_activity")}</h2>
            <button class="link-btn" id="view-all-activity">${t("view_all")}</button>
          </div>
          <div class="card-list" id="recent-activity"></div>
          </div>`
    }
    </div>
  `;

  container.querySelector("#view-all-activity")?.addEventListener("click", () => navigate("#/activity"));
  container.querySelector("#company-dashboard-preview-card")?.addEventListener("click", () => navigate("#/company-dashboard"));
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
  if (activityEl) {
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
  }

  const nextVisitSlot = container.querySelector("#next-visit-slot");
  if (nextVisitSlot) renderNextVisit(nextVisitSlot, customers, navigate);

  const todayPlanSlot = container.querySelector("#today-plan-slot");
  if (todayPlanSlot) renderTodayPlan(todayPlanSlot, myPlan, customers, navigate);
  }
}

// Today's actual planned stops (see the myPlan fetch above), cross-
// referenced against the already-fetched, already-scoped `customers` list
// for name/visited/overdue -- no second network round trip just to get
// display fields for ids the plan already gave us. `plan` is null both
// when nothing was ever planned for today and when the fetch itself
// failed (caught above), so both render the same empty state rather than
// distinguishing "no plan" from "couldn't load the plan" -- neither is
// actionable from this card.
function renderTodayPlan(slot, plan, customers, navigate) {
  const customerIds = plan?.customer_ids ?? [];
  if (!customerIds.length) {
    slot.innerHTML = "";
    return;
  }
  const byId = new Map(customers.map((c) => [c.id, c]));
  const stops = customerIds.map((id) => byId.get(id)).filter(Boolean);
  const visitedCount = stops.filter((c) => c.visited_today).length;

  // Collapsed by default -- this sits right under the single-customer
  // "next visit" card, so showing the whole list open by default would
  // just duplicate that card's job and push everything else down the
  // page. Tapping the header expands it into the full checklist below,
  // with a tick for each stop already checked in today vs. not yet.
  let expanded = false;

  function paint() {
    slot.innerHTML = `
      <div class="card today-plan-card">
        <button type="button" class="today-plan-header" aria-expanded="${expanded}" aria-controls="today-plan-list">
          <span>${t("today_plan")}</span>
          <span class="today-plan-header-right">
            <span class="muted">${visitedCount}/${stops.length}</span>
            ${expanded ? icons.chevronUp : icons.chevronDown}
          </span>
        </button>
        <div class="today-plan-list" id="today-plan-list" ${expanded ? "" : "hidden"}>
          ${stops
            .map(
              (c) => `
            <button type="button" class="today-plan-row" data-customer-id="${c.id}">
              <span class="today-plan-tick ${c.visited_today ? "today-plan-tick-done" : ""}" aria-hidden="true">${c.visited_today ? icons.checkCircle : ""}</span>
              <span class="today-plan-name">${escapeHtml(c.name)}</span>
              ${c.visited_today ? `<span class="muted">${t("stat_visited_today")}</span>` : c.overdue ? `<span class="dot dot-danger" aria-hidden="true"></span>` : ""}
            </button>
          `
            )
            .join("")}
        </div>
      </div>
    `;
    slot.querySelector(".today-plan-header").addEventListener("click", () => {
      expanded = !expanded;
      paint();
    });
    slot.querySelectorAll(".today-plan-row").forEach((row) => {
      row.addEventListener("click", () => navigate(`#/customers/${row.dataset.customerId}`));
    });
  }
  paint();
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
