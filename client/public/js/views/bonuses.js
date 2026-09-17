// Employee-facing "my Bonuses" screen (docs/bonuses-design.md, Phase 6):
// points/level, active challenge progress, and reward claim history --
// read-only, always scoped to the signed-in user (GET /api/bonus-summary).
// Matches the plain "detail-view" screen convention (notifications.js), not
// the admin card-list convention used in bonusChallengesAdmin.js.
import { api } from "../api.js";
import { escapeHtml, formatDateTime, formatAmd } from "../util.js";
import { t } from "../i18n.js";

const COLLECTIBLE_LABEL_KEY = {
  strawberry: "bonuses_strawberry",
  carrot: "bonuses_carrot",
  apple: "bonuses_apple",
  cherry: "bonuses_cherry",
  watermelon: "bonuses_watermelon",
};

const CLAIM_STATUS_KEY = {
  awaiting_validation: "bonuses_claim_status_awaiting_validation",
  approved: "bonuses_claim_status_approved",
  rejected: "bonuses_claim_status_rejected",
  on_hold: "bonuses_claim_status_on_hold",
  paid: "bonuses_claim_status_paid",
};
const CLAIM_STATUS_BADGE = { awaiting_validation: "badge-neutral", approved: "badge-info", on_hold: "badge-neutral", rejected: "badge-danger", paid: "badge-success" };

// component_progress (bonus_progress.component_progress) is keyed by
// metric name for single_metric/balanced_basket ("strawberry", "points",
// ...) or by "product:<targetId>" for product_sales, each value
// {confirmed_scaled, target_scaled[, label]} in whatever unit that
// component's target was defined in -- a plain percentage bar is enough
// here since the two scales (scale-2 collectibles/points vs. whole
// product-piece counts) aren't comparable numbers to show side by side.
function componentProgressHtml(componentProgress) {
  return Object.entries(componentProgress || {})
    .map(([key, c]) => {
      const label = COLLECTIBLE_LABEL_KEY[key]
        ? t(COLLECTIBLE_LABEL_KEY[key])
        : key === "points"
          ? t("bonuses_points_label")
          : escapeHtml(c.label || key);
      const pct = c.target_scaled ? Math.min(100, Math.round((c.confirmed_scaled / c.target_scaled) * 100)) : 0;
      return `
        <div class="bonuses-component-row">
          <div class="bonuses-component-label">${label}</div>
          <div class="progress-bar"><div class="progress-bar-fill" style="width:${pct}%"></div></div>
        </div>
      `;
    })
    .join("");
}

export async function renderBonuses(root, navigate) {
  root.innerHTML = `
    <div class="detail-view">
      <div class="detail-header">
        <button class="icon-btn" id="back-btn" aria-label="${t("back")}">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
        </button>
        <div class="detail-header-title"><h1>${t("bonuses_title")}</h1></div>
      </div>
      <div id="bonuses-content"><p class="loading-state" role="status">${t("loading")}</p></div>
    </div>
  `;
  const container = root.querySelector(".detail-view");
  container.querySelector("#back-btn").addEventListener("click", () => navigate("#/dashboard"));
  const contentEl = container.querySelector("#bonuses-content");

  let summary;
  try {
    summary = await api.getBonusSummary();
  } catch (err) {
    contentEl.innerHTML = `<p class="empty-state">${escapeHtml(err.message)}</p>`;
    return;
  }

  const collectibleCards = Object.entries(summary.collectibleCounts)
    .map(
      ([activity, count]) => `
    <div class="stat-card">
      <span class="stat-value">${count}</span>
      <span class="stat-label">${t(COLLECTIBLE_LABEL_KEY[activity])}</span>
    </div>
  `
    )
    .join("");

  const challengesHtml = summary.activeChallenges.length
    ? summary.activeChallenges
        .map(
          (c) => `
    <div class="card">
      <div class="user-row-top">
        <strong>${escapeHtml(c.title)}</strong>
        <span class="badge ${c.overall_status === "target_reached" ? "badge-success" : "badge-neutral"}">${
            c.overall_status === "target_reached" ? "✓" : t("bonuses_active_challenges")
          }</span>
      </div>
      ${componentProgressHtml(c.component_progress)}
    </div>
  `
        )
        .join("")
    : `<p class="empty-state">${t("bonuses_no_active_challenges")}</p>`;

  const claimsHtml = summary.claims.length
    ? summary.claims
        .map(
          (claim) => `
    <div class="card user-row">
      <div class="user-row-top">
        <strong>${formatAmd(Number(claim.amount_amd))}</strong>
        <span class="badge ${CLAIM_STATUS_BADGE[claim.status] ?? "badge-neutral"}">${t(CLAIM_STATUS_KEY[claim.status] ?? claim.status)}</span>
      </div>
      <div class="user-row-meta">
        <span class="muted">${formatDateTime(claim.created_at)}</span>
      </div>
    </div>
  `
        )
        .join("")
    : `<p class="empty-state">${t("bonuses_no_claims")}</p>`;

  contentEl.innerHTML = `
    <div class="dashboard-grid">
      <div class="card progress-card">
        <span class="progress-label">${t("bonuses_points_label")}</span>
        <div class="progress-main">
          <span class="progress-fraction">${summary.pointsTotal}</span>
          <div class="progress-side">
            <div class="progress-side-row">${t(summary.level.labelKey ?? "bonus_level_1")}</div>
            <div class="progress-side-row muted">
              ${summary.level.pointsToNextLevel != null ? `${summary.level.pointsToNextLevel} ${t("bonuses_next_level")}` : t("bonuses_max_level")}
            </div>
          </div>
        </div>
      </div>

      <div>
        <h2 class="section-title section-title-tight">${t("bonuses_title")}</h2>
        <div class="quick-actions-grid">${collectibleCards}</div>
      </div>

      <div>
        <h2 class="section-title section-title-tight">${t("bonuses_active_challenges")}</h2>
        <div class="card-list">${challengesHtml}</div>
      </div>

      <div>
        <h2 class="section-title section-title-tight">${t("bonuses_reward_claims")}</h2>
        <div class="card-list">${claimsHtml}</div>
      </div>
    </div>
  `;
}
