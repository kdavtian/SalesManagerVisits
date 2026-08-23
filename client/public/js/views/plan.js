import { t } from "../i18n.js";

export function renderPlan(root) {
  root.innerHTML = `
    <div class="plan-view">
      <div class="plan-empty">
        <div class="plan-empty-icon">🗓️</div>
        <h1>${t("plan_coming_soon_title")}</h1>
        <p class="muted">${t("plan_coming_soon_body")}</p>
      </div>
    </div>
  `;
}
