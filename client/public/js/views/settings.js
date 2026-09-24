import { api } from "../api.js";
import { t, getLang, setLang } from "../i18n.js";
import { getTheme, setTheme } from "../theme.js";
import { getPerfMode, setPerfMode } from "../perfMode.js";
import { state, isAdmin, canPlanForOthers, seesFinancialExports, canManageProducts, isPerfCeo } from "../state.js";
import { renderTeamSection, renderPlanApprovalsSection, renderEditRequestsSection, renderProductsSection, renderPointsCloseoutSection, renderCompanyProfileSection, renderRouteDistributionSection, renderSalesChannelOwnersSection, renderQuickActionVisibilitySection, renderDataQualitySection, renderNotificationDeliveryLogSection, renderClientErrorLogSection } from "./admin.js";
import { renderBonusChallengesSection, renderBonusRewardClaimsSection } from "./bonusChallengesAdmin.js";
import { escapeHtml, compressImage, activateDialog, attachSwipeToDismiss, formatPhoneDisplay, normalizePhone } from "../util.js";
import { getQueue, onQueueChange, flushQueue, getLastSyncedAt } from "../offlineQueue.js";
import { getPushSubscriptionState, enablePushNotifications, disablePushNotifications } from "../pushNotifications.js";
import { checkForUpdateManually } from "../updateBanner.js";
import { APP_VERSION } from "../version.js";
import { refreshProductCatalog } from "../productCatalog.js";
import { isStrongDevice, getMapTileCacheEnabled, setMapTileCacheEnabled } from "../mapPrefs.js";

const ICON = {
  camera: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8a2 2 0 0 1 2-2h1.5l1-1.5h7l1 1.5H18a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><circle cx="12" cy="13" r="3.5"/></svg>`,
  appearance: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a9 9 0 1 0 9 9c0-.46-.04-.92-.1-1.36A5.4 5.4 0 0 1 12 3Z"/></svg>`,
  language: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>`,
  cloud: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M7 18a4.5 4.5 0 0 1-.6-8.96A5.5 5.5 0 0 1 17.2 8.1 4 4 0 0 1 17 16H7Z"/></svg>`,
  clock: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg>`,
  refresh: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 15.3-6.4L21 8M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.3 6.4L3 16M3 21v-5h5"/></svg>`,
  database: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5.5" rx="8" ry="3"/><path d="M4 5.5V18c0 1.66 3.58 3 8 3s8-1.34 8-3V5.5M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3"/></svg>`,
  gps: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>`,
  calendar: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="4.5" width="17" height="16" rx="2.5"/><path d="M3.5 9.5h17M8 3v3M16 3v3"/></svg>`,
  lock: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/></svg>`,
  shield: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/><path d="m9 12 2 2 4-4"/></svg>`,
  info: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 8v.01"/></svg>`,
  chevron: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>`,
  bell: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 4.5 1.5 6 1.5 6h-15S6 12.5 6 8Z"/><path d="M10 20a2 2 0 0 0 4 0"/></svg>`,
  book: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5v-15Z"/><path d="M4 18a2.5 2.5 0 0 1 2.5-2.5H20"/></svg>`,
  team: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3"/><path d="M3 20v-1.25A5.75 5.75 0 0 1 8.75 13h.5A5.75 5.75 0 0 1 15 18.75V20"/><circle cx="17.5" cy="8.5" r="2.5"/><path d="M15.5 13.6c.6-.25 1.25-.38 1.9-.38A4.6 4.6 0 0 1 22 17.82V20"/></svg>`,
  chart: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20V10M11 20V4M18 20v-7"/></svg>`,
  phone: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M7.2 3.5 10 7.8 8.2 10a15.5 15.5 0 0 0 5.8 5.8l2.2-1.8 4.3 2.8-.8 3.2c-.2.8-1 1.3-1.8 1.2A18 18 0 0 1 2.8 6.1C2.7 5.3 3.2 4.5 4 4.3z"/></svg>`,
  bolt: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M13 3 5 13.5h5.5L11 21l8-10.5h-5.5z"/></svg>`,
};

// User guide PDF: update GUIDE_VERSION (and re-export docs/kad-motors-guide-hy.pdf
// via the tutorial-generation flow used to build it) whenever a UI change is
// significant enough that the screenshots/steps in the guide would mislead a
// rep -- a new nav pattern, a changed order-creation flow, moved buttons,
// etc. A copy-fix or color tweak doesn't need a re-export.
const GUIDE_VERSION = "1.19.1";

// `color` picks a badge tint for the row's icon, iOS-Settings style (each
// row's icon sits in a colored rounded-square, not just a plain glyph) --
// one of the ICON_COLORS keys below. Reused across rows freely, same as
// iOS itself reuses a handful of system colors across many settings.
// hintBtnId: renders a small inline "!" button right next to the label
// (instead of a separate detached hint icon floating below the whole
// card) -- pairs with a hidden <p> the caller places wherever makes sense
// and toggles via wireHintToggle(hintBtnId, hintTextId).
function settingsRow({ icon, label, value, id, interactive = true, color = "gray", hintBtnId, hintTextId }) {
  const tag = interactive ? "button" : "div";
  return `
    <${tag} ${interactive ? 'type="button"' : ""} class="settings-list-row" ${id ? `id="${id}"` : ""}>
      <span class="settings-row-icon settings-row-icon-${color}">${icon}</span>
      <span class="settings-row-label">
        ${label}
        ${hintBtnId ? `<span role="button" tabindex="0" class="settings-inline-hint-icon" id="${hintBtnId}" aria-expanded="false" aria-controls="${hintTextId}" aria-label="${t("more_info")}">!</span>` : ""}
      </span>
      ${value !== undefined ? `<span class="settings-row-value muted">${value}</span>` : ""}
      ${interactive ? `<span class="settings-row-chevron">${ICON.chevron}</span>` : ""}
    </${tag}>
  `;
}

function settingsToggleRow({ icon, label, value, id, checked, resetId, color = "gray", hintBtnId, hintTextId }) {
  return `
    <div class="settings-list-row settings-toggle-row">
      <span class="settings-row-icon settings-row-icon-${color}">${icon}</span>
      <span class="settings-row-label">
        ${label}
        ${hintBtnId ? `<span role="button" tabindex="0" class="settings-inline-hint-icon" id="${hintBtnId}" aria-expanded="false" aria-controls="${hintTextId}" aria-label="${t("more_info")}">!</span>` : ""}
        ${resetId ? `<button type="button" class="settings-reset-link" id="${resetId}">${t("reset_to_default")}</button>` : ""}
      </span>
      <span class="settings-row-value muted">${value}</span>
      <button type="button" class="toggle-switch" id="${id}" role="switch" aria-checked="${checked}" aria-label="${label}">
        <span class="toggle-thumb"></span>
      </button>
    </div>
  `;
}

function formatStorageMb(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export async function renderSettings(root, onLogout, onLanguageChange) {
  const admin = isAdmin();
  // A director/CEO can plan for their reps, so they also need to be able to
  // approve those reps' self-authored plans -- not just a superadmin
  // account. Kept separate from the strict admin-only section below.
  const canApprovePlans = canPlanForOthers();
  const canExportFinancials = seesFinancialExports();
  // Mirrors server/src/roles.js's canManageBonusChallenges (admin/ceo) --
  // broader than plain admin, so kept as its own flag rather than folded
  // into the admin-gated block below.
  const canManageChallenges = isPerfCeo();
  // Mirrors canApproveBonusRewards (admin/ceo/accountant) OR
  // canRecordBonusPayouts (admin/accountant) -- the union of who needs to
  // see the reward-claims review list at all, a strictly larger set than
  // canManageChallenges (an accountant reviews/pays claims but never
  // designs a challenge).
  const canReviewBonusRewards = admin || canManageChallenges || state.user?.role === "accountant";
  const hasAdminWorkspace = admin || canApprovePlans || canExportFinancials || canManageChallenges || canReviewBonusRewards;

  root.innerHTML = `
    <div class="settings-view">
      <h1>${t("settings_title")}</h1>

      ${
        hasAdminWorkspace
          ? `<div class="settings-workspace-tabs" role="tablist" aria-label="${t("settings_title")}">
              <button type="button" class="settings-workspace-tab settings-workspace-tab-active" id="settings-personal-tab" role="tab" aria-selected="true" aria-controls="settings-personal-panel">${t("personal_settings")}</button>
              <button type="button" class="settings-workspace-tab" id="settings-admin-tab" role="tab" aria-selected="false" aria-controls="settings-admin-panel" tabindex="-1">${t("admin_workspace")}</button>
            </div>`
          : ""
      }

      <section id="settings-personal-panel" ${hasAdminWorkspace ? 'role="tabpanel" aria-labelledby="settings-personal-tab"' : ""}>

      <div class="card profile-card">
        <div class="profile-avatar-wrap">
          <div class="profile-avatar" id="profile-avatar">${escapeHtml(state.user.name.slice(0, 1).toUpperCase())}</div>
          <input type="file" id="avatar-input" accept="image/*" class="visually-hidden" />
          <button type="button" class="profile-avatar-badge" id="avatar-btn" aria-label="${t("change_photo")}">${ICON.camera}</button>
        </div>
        <div class="profile-info">
          <strong>${escapeHtml(state.user.name)}</strong>
          <span class="muted">${t(`role_${state.user.role}`)}${state.user.position ? ` · ${escapeHtml(state.user.position)}` : ""}</span>
          <span class="muted">${escapeHtml(state.user.email)}</span>
          ${state.user.has_avatar ? `<button type="button" class="settings-reset-link" id="avatar-remove-btn">${t("remove_avatar")}</button>` : ""}
        </div>
      </div>

      ${
        // Per explicit request: removed entirely for sales_manager (a
        // sales_director still sees their own performance card).
        state.user.role === "sales_director" ? `<div id="sales-performance-slot"></div>` : ""
      }

      <h2 class="section-title">${t("contact_info")}</h2>
      <div class="card settings-list">
        ${settingsRow({ icon: ICON.phone, label: t("phone"), value: state.user.phone ? escapeHtml(formatPhoneDisplay(state.user.phone)) : t("not_set"), id: "row-phone", color: "green" })}
      </div>

      <h2 class="section-title">${t("preferences")}</h2>
      <div class="card settings-list">
        ${settingsToggleRow({ icon: ICON.appearance, label: t("appearance"), value: getTheme() === "dark" ? t("dark") : t("light"), id: "toggle-appearance", checked: getTheme() === "dark", color: "indigo" })}
        ${settingsToggleRow({ icon: ICON.language, label: t("language"), value: getLang() === "hy" ? t("armenian") : t("english"), id: "toggle-language", checked: getLang() === "hy", color: "blue" })}
        ${settingsToggleRow({ icon: ICON.bolt, label: t("efficiency_mode"), value: getPerfMode() === "efficiency" ? t("toggle_on") : t("toggle_off"), id: "toggle-perf-mode", checked: getPerfMode() === "efficiency", color: "orange", hintBtnId: "efficiency-mode-hint-btn", hintTextId: "efficiency-mode-hint-text" })}
      </div>
      <!-- The "!" icon sits right on the Efficiency mode row itself (see
           settingsToggleRow's hintBtnId) instead of floating disconnected
           below the whole card -- this paragraph is just where the
           revealed text lands once tapped. -->
      <p class="muted settings-hint" id="efficiency-mode-hint-text" hidden>${t("efficiency_mode_hint")}</p>
      <div class="card settings-list">
        <div class="settings-list-row settings-toggle-row settings-expandable-row" id="push-notifications-row">
          <span class="settings-row-icon settings-row-icon-red">${ICON.bell}</span>
          <span class="settings-row-label">${t("push_notifications")}</span>
          <span class="settings-row-value muted">…</span>
          <button type="button" class="toggle-switch" id="toggle-push-notifications" role="switch" aria-checked="false" aria-label="${t("push_notifications")}">
            <span class="toggle-thumb"></span>
          </button>
          <button type="button" class="settings-row-chevron settings-expand-btn" id="notification-prefs-expand-btn" aria-expanded="false" aria-controls="notification-prefs-list" aria-label="${t("notification_preferences_title")}">${ICON.chevron}</button>
        </div>
        <div class="settings-list settings-expandable-content" id="notification-prefs-list" hidden>
          <p class="loading-state" role="status">${t("loading")}</p>
        </div>
      </div>

      <h2 class="section-title">${t("data_sync")}</h2>
      <div class="card settings-list">
        ${settingsRow({ icon: ICON.cloud, label: t("sync_status"), value: `<span id="sync-status-value"></span>`, interactive: false, color: "teal" })}
        ${settingsRow({ icon: ICON.clock, label: t("last_sync"), value: `<span id="last-sync-value"></span>`, interactive: false, color: "gray" })}
        ${settingsRow({ icon: ICON.refresh, label: t("refresh_data"), id: "row-refresh", color: "green" })}
        ${settingsRow({ icon: ICON.refresh, label: t("refresh_product_catalog"), id: "row-refresh-catalog", color: "green" })}
        ${settingsRow({ icon: ICON.database, label: t("offline_storage"), value: `<span id="storage-value">…</span>`, interactive: false, color: "purple" })}
        ${
          isStrongDevice()
            ? settingsToggleRow({ icon: ICON.database, label: t("map_tile_cache"), value: getMapTileCacheEnabled() ? t("toggle_on") : t("toggle_off"), id: "toggle-map-tile-cache", checked: getMapTileCacheEnabled(), color: "purple" })
            : ""
        }
      </div>
      ${isStrongDevice() ? `<p class="muted settings-hint">${t("map_tile_cache_hint")}</p>` : ""}
      <p class="settings-hint sync-needs-attention-hint" id="sync-needs-attention-hint" role="status" hidden></p>

      <h2 class="section-title">${t("security")}</h2>
      <div class="card settings-list">
        ${settingsRow({ icon: ICON.lock, label: t("change_password"), id: "row-change-password", color: "gray" })}
        ${settingsRow({ icon: ICON.shield, label: t("session_management"), id: "row-sessions", color: "green" })}
      </div>

      <h2 class="section-title">${t("about")}</h2>
      <div class="card settings-list">
        ${settingsRow({ icon: ICON.info, label: t("about_app"), value: `${t("version")} ${APP_VERSION}`, interactive: false, color: "blue" })}
        ${settingsRow({ icon: ICON.book, label: t("user_guide"), value: "PDF", id: "row-user-guide", color: "orange", hintBtnId: "user-guide-hint-btn", hintTextId: "user-guide-hint-text" })}
        ${settingsRow({ icon: ICON.refresh, label: t("check_for_updates"), value: `<span id="check-updates-value"></span>`, id: "row-check-updates", color: "teal" })}
      </div>
      <!-- The "!" icon sits right on the User guide row itself (see
           settingsRow's hintBtnId) instead of floating disconnected below
           the whole card -- this paragraph is just where the revealed text
           lands once tapped. -->
      <p class="muted settings-hint" id="user-guide-hint-text" hidden>${t("user_guide_hint").replace("{v}", GUIDE_VERSION)}</p>

      <button class="btn btn-block btn-danger settings-logout" id="settings-logout">${t("log_out")}</button>
      </section>

      <section id="settings-admin-panel" role="tabpanel" aria-labelledby="settings-admin-tab" hidden>
      <div class="settings-admin-layout">
      <div class="settings-admin-left">

      ${
        admin
          ? `
        <h2 class="section-title">${t("admin_group_team_roles")}</h2>
        <div class="card settings-list">
          ${settingsRow({ icon: ICON.team, label: t("team_management"), id: "row-team-management", color: "blue" })}
          ${settingsRow({ icon: ICON.bell, label: t("notification_defaults_title"), id: "row-notification-defaults", color: "red" })}
        </div>
      `
          : ""
      }

      ${
        canManageChallenges || canReviewBonusRewards
          ? `
        <h2 class="section-title">${t("bonuses_title")}</h2>
        ${
          admin
            ? `
          <div class="card settings-list-group">
            <div class="settings-list-group-item">
              ${settingsToggleRow({ icon: ICON.bolt, label: t("bonuses_enabled_label"), value: "", id: "toggle-bonuses-enabled", checked: false, color: "orange" })}
            </div>
            <form id="incentive-message-form" class="settings-list-group-item">
              <label>
                <span class="settings-form-label">${ICON.gps}${t("incentive_message_label")}</span>
                <input type="text" name="message" maxlength="200" placeholder="${t("points_leaderboard_prize_hint")}" />
              </label>
              <p class="muted radius-help">${t("incentive_message_help")}</p>
              <p class="form-success" id="incentive-message-success" role="status" hidden>${t("saved")}</p>
              <button type="submit" class="btn btn-primary">${t("save")}</button>
            </form>
          </div>
        `
            : ""
        }
        <div class="card settings-list">
          ${canManageChallenges ? settingsRow({ icon: ICON.bolt, label: t("bonuses_admin_challenges"), id: "row-bonus-challenges", color: "orange" }) : ""}
          ${canReviewBonusRewards ? settingsRow({ icon: ICON.chart, label: t("bonuses_reward_claims"), id: "row-bonus-reward-claims", color: "green" }) : ""}
          ${admin ? settingsRow({ icon: ICON.chart, label: t("points_closeout_title"), id: "row-points-closeout", color: "teal" }) : ""}
        </div>
      `
          : ""
      }

      ${
        admin
          ? `
        <h2 class="section-title">${t("admin_group_app_config")}</h2>
        <div class="card settings-list-group">
          <form id="radius-form" class="settings-list-group-item">
            <label>
              <span class="settings-form-label">${ICON.gps}${t("gps_verification_settings")}</span>
              <input type="number" name="radius" min="10" max="5000" required />
            </label>
            <p class="muted radius-help">${t("checkin_radius_help")}</p>
            <p class="form-success" id="radius-success" role="status" hidden>${t("saved")}</p>
            <button type="submit" class="btn btn-primary">${t("save")}</button>
          </form>
          <form id="visit-frequency-form" class="settings-list-group-item">
            <label>
              <span class="settings-form-label">${ICON.calendar}${t("default_visit_frequency")}</span>
              <input type="number" name="days" min="1" max="365" required />
            </label>
            <p class="muted radius-help">${t("default_visit_frequency_help")}</p>
            <p class="form-success" id="visit-frequency-success" role="status" hidden>${t("saved")}</p>
            <button type="submit" class="btn btn-primary">${t("save")}</button>
          </form>
        </div>

        <h2 class="section-title">${t("security")}</h2>
        <div class="card settings-list-group">
          <form id="calculator-pin-form" class="settings-list-group-item">
            <label>
              <span class="settings-form-label">${ICON.lock}${t("calculator_pin_label")}</span>
              <input type="text" inputmode="numeric" pattern="\\d{4,8}" name="pin" placeholder="${t("calculator_pin_placeholder")}" autocomplete="off" />
            </label>
            <p class="muted radius-help" id="calculator-pin-status">${t("calculator_pin_help")}</p>
            <p class="form-success" id="calculator-pin-success" role="status" hidden>${t("saved")}</p>
            <button type="submit" class="btn btn-primary">${t("save")}</button>
          </form>
          <div class="settings-list-group-item">
            ${settingsToggleRow({ icon: ICON.lock, label: t("calculator_mode_label"), value: "", id: "toggle-calculator-mode", checked: false, color: "gray" })}
            <p class="muted radius-help" id="calculator-mode-help">${t("calculator_mode_help_off")}</p>
          </div>
          <div class="settings-list-group-item">
            <p class="muted radius-help">${t("emergency_disconnect_help")}</p>
            <p class="form-success" id="emergency-disconnect-success" role="status" hidden>${t("emergency_disconnect_lifted")}</p>
            <button type="button" class="btn btn-danger" id="emergency-disconnect-btn">${t("emergency_disconnect_button")}</button>
          </div>
        </div>
        <div class="card settings-list">
          ${settingsRow({ icon: ICON.shield, label: t("session_management"), id: "row-admin-sessions", color: "green" })}
        </div>
      `
          : ""
      }

      ${
        admin || canManageProducts() || canApprovePlans || canExportFinancials
          ? `
        <h2 class="section-title">${t("admin_group_data_integrations")}</h2>
        ${
          admin
            ? `<div class="card settings-list">
          ${settingsRow({ icon: ICON.chart, label: t("reports_management"), id: "row-reports-management", color: "green" })}
          ${settingsRow({ icon: ICON.database, label: t("route_distribution_title"), id: "row-route-distribution", color: "purple" })}
          ${settingsRow({ icon: ICON.database, label: t("sales_channel_owners_title"), id: "row-sales-channel-owners", color: "purple" })}
          ${settingsRow({ icon: ICON.chart, label: t("quick_action_visibility_title"), id: "row-quick-actions", color: "indigo" })}
          ${settingsRow({ icon: ICON.chart, label: t("data_quality_title"), id: "row-data-quality", color: "red" })}
          ${settingsRow({ icon: ICON.database, label: t("notification_delivery_log_title"), id: "row-notification-delivery-log", color: "teal" })}
          ${settingsRow({ icon: ICON.database, label: t("client_error_log_title"), id: "row-client-error-log", color: "gray" })}
        </div>`
            : ""
        }
        ${
          canManageProducts()
            ? `<div class="card settings-list">
          ${settingsRow({ icon: ICON.database, label: t("product_catalog"), id: "row-product-catalog", color: "purple" })}
          ${settingsRow({ icon: ICON.chart, label: t("company_profile"), id: "row-company-profile", color: "teal" })}
        </div>`
            : ""
        }
        ${
          canApprovePlans
            ? `<h3 class="settings-subsection-title">${t("plan_approvals")}</h3>
          <div id="plan-approvals-slot"></div>`
            : ""
        }
        ${
          admin
            ? `<h3 class="settings-subsection-title">${t("edit_requests_title")}</h3>
          <div id="edit-requests-slot"></div>`
            : ""
        }
        ${
          canExportFinancials
            ? `<h3 class="settings-subsection-title">${t("financial_exports")}</h3>
          <div class="card settings-list">
          <a class="settings-list-row" href="/api/exports/payments.csv">
            <span class="settings-row-label">${t("export_payments")}</span>
          </a>
          <a class="settings-list-row" href="/api/exports/debt.csv">
            <span class="settings-row-label">${t("export_debt")}</span>
          </a>
          <a class="settings-list-row" href="/api/exports/orders.csv">
            <span class="settings-row-label">${t("export_orders")}</span>
          </a>
        </div>`
            : ""
        }
      `
          : ""
      }
      </div>
      <!-- Desktop only (see .settings-section-pane in styles.css): the
           right-hand pane openAdminSection() below renders a clicked
           section's content into, instead of the full-screen modal
           openAdminSectionOverlay opens at mobile widths. Empty/hidden
           until a section is selected. -->
      <div class="settings-section-pane" id="settings-section-pane" hidden></div>
      </div>
      </section>
    </div>
  `;

  if (hasAdminWorkspace) {
    const tabs = [root.querySelector("#settings-personal-tab"), root.querySelector("#settings-admin-tab")];
    const panels = [root.querySelector("#settings-personal-panel"), root.querySelector("#settings-admin-panel")];
    function selectWorkspace(index, moveFocus = false) {
      tabs.forEach((tab, tabIndex) => {
        const selected = tabIndex === index;
        tab.classList.toggle("settings-workspace-tab-active", selected);
        tab.setAttribute("aria-selected", String(selected));
        tab.tabIndex = selected ? 0 : -1;
        panels[tabIndex].hidden = !selected;
      });
      if (moveFocus) tabs[index].focus();
    }
    tabs.forEach((tab, index) => {
      tab.addEventListener("click", () => selectWorkspace(index));
      tab.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        selectWorkspace((index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length, true);
      });
    });
  }

  // --- Avatar ---
  const avatarEl = root.querySelector("#profile-avatar");
  const avatarInput = root.querySelector("#avatar-input");

  function paintAvatar() {
    if (state.user.has_avatar) {
      avatarEl.innerHTML = `<img src="${api.myAvatarUrl()}" alt="" />`;
    } else {
      avatarEl.textContent = state.user.name.slice(0, 1).toUpperCase();
    }
  }
  paintAvatar();

  // --- Sales performance ---
  const perfSlot = root.querySelector("#sales-performance-slot");
  if (perfSlot) loadSalesPerformance(perfSlot, state.user.role);

  // --- Notification preferences ---
  loadNotificationPreferences(root.querySelector("#notification-prefs-list"));

  root.querySelector("#avatar-btn").addEventListener("click", () => avatarInput.click());
  avatarInput.addEventListener("change", async () => {
    const file = avatarInput.files[0];
    if (!file) return;
    try {
      const compressed = await compressImage(file, { maxDimension: 400, quality: 0.8 });
      const form = new FormData();
      form.set("avatar", compressed, "avatar.jpg");
      await api.uploadMyAvatar(form);
      state.user.has_avatar = true;
      renderSettings(root, onLogout, onLanguageChange);
    } catch (err) {
      alert(err.message);
    }
  });

  root.querySelector("#avatar-remove-btn")?.addEventListener("click", async () => {
    try {
      await api.deleteMyAvatar();
      state.user.has_avatar = false;
      renderSettings(root, onLogout, onLanguageChange);
    } catch (err) {
      alert(err.message);
    }
  });

  // --- Preferences ---
  root.querySelector("#toggle-appearance").addEventListener("click", () => {
    setTheme(getTheme() === "dark" ? "light" : "dark");
    renderSettings(root, onLogout, onLanguageChange);
  });
  root.querySelector("#toggle-language").addEventListener("click", () => {
    setLang(getLang() === "hy" ? "en" : "hy");
    onLanguageChange();
  });
  root.querySelector("#toggle-perf-mode").addEventListener("click", () => {
    setPerfMode(getPerfMode() === "efficiency" ? "performance" : "efficiency");
    renderSettings(root, onLogout, onLanguageChange);
  });

  // Hint text collapsed behind a tappable inline "!" icon next to its row's
  // own label (see styles.css's .settings-inline-hint-icon) -- toggles the
  // paired paragraph's hidden state. A <span role="button"> rather than a
  // real <button>, since the "User guide" row it sits inside is itself an
  // interactive <button> and a nested button is invalid HTML -- so this
  // wires both click and Enter/Space, and always stops the event from also
  // triggering the row's own click handler (e.g. opening the guide PDF).
  function wireHintToggle(btnId, textId) {
    const btn = root.querySelector(`#${btnId}`);
    const textEl = root.querySelector(`#${textId}`);
    function toggle(event) {
      event.stopPropagation();
      const expanded = btn.getAttribute("aria-expanded") === "true";
      btn.setAttribute("aria-expanded", String(!expanded));
      textEl.hidden = expanded;
    }
    btn.addEventListener("click", toggle);
    btn.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggle(event);
      }
    });
  }
  wireHintToggle("efficiency-mode-hint-btn", "efficiency-mode-hint-text");
  wireHintToggle("user-guide-hint-btn", "user-guide-hint-text");

  // --- Push notifications ---
  const pushToggle = root.querySelector("#toggle-push-notifications");
  const pushToggleRow = pushToggle.closest(".settings-list-row");
  const pushToggleValue = pushToggleRow.querySelector(".settings-row-value");

  function paintPushToggle(subscribed) {
    pushToggle.setAttribute("aria-checked", String(subscribed));
    pushToggleValue.textContent = subscribed ? t("toggle_on") : t("toggle_off");
  }

  getPushSubscriptionState().then((s) => {
    if (!s.supported) {
      pushToggleRow.hidden = true;
      return;
    }
    paintPushToggle(s.subscribed);
  });

  pushToggle.addEventListener("click", async () => {
    const currentlyOn = pushToggle.getAttribute("aria-checked") === "true";
    pushToggle.disabled = true;
    try {
      if (currentlyOn) {
        await disablePushNotifications();
        paintPushToggle(false);
      } else {
        await enablePushNotifications();
        paintPushToggle(true);
      }
    } catch (err) {
      alert(err.message);
    } finally {
      pushToggle.disabled = false;
    }
  });

  // Notification preferences now nest inside the Push notifications row
  // itself (a chevron expand toggle), instead of a separate section
  // further down the page.
  const notifPrefsExpandBtn = root.querySelector("#notification-prefs-expand-btn");
  const notifPrefsList = root.querySelector("#notification-prefs-list");
  notifPrefsExpandBtn.addEventListener("click", () => {
    const expanded = notifPrefsExpandBtn.getAttribute("aria-expanded") === "true";
    notifPrefsExpandBtn.setAttribute("aria-expanded", String(!expanded));
    notifPrefsList.hidden = expanded;
  });

  // --- Data & Sync ---
  const syncStatusValue = root.querySelector("#sync-status-value");
  const lastSyncValue = root.querySelector("#last-sync-value");
  const storageValue = root.querySelector("#storage-value");
  const needsAttentionHint = root.querySelector("#sync-needs-attention-hint");

  function paintSyncStatus() {
    const queue = getQueue();
    const pending = queue.length;
    const stuck = queue.filter((e) => e.needsAttention);
    syncStatusValue.textContent = stuck.length
      ? `${stuck.length} ${t("sync_status_needs_attention")}`
      : pending
        ? `${pending} ${t("sync_status_pending")}`
        : t("sync_status_synced");
    const lastSyncedAt = getLastSyncedAt();
    lastSyncValue.textContent = lastSyncedAt
      ? new Date(lastSyncedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
      : t("never_synced");
    // Stopped auto-retrying (see offlineQueue.js's NEEDS_ATTENTION_THRESHOLD)
    // -- surface the actual last error so the rep isn't just told "stuck"
    // with no idea why, and knows Refresh data below will try again.
    if (stuck.length) {
      needsAttentionHint.hidden = false;
      needsAttentionHint.textContent = t("sync_needs_attention_detail").replace("{error}", stuck[0].lastError || "?");
    } else {
      needsAttentionHint.hidden = true;
    }
  }
  paintSyncStatus();
  const unsubscribeQueue = onQueueChange(paintSyncStatus);

  root.querySelector("#row-refresh").addEventListener("click", async (e) => {
    const row = e.currentTarget;
    const valueLabel = row.querySelector(".settings-row-label");
    const originalLabel = valueLabel.textContent;
    valueLabel.textContent = t("refreshing");
    row.disabled = true;
    try {
      // force: true -- an explicit tap here is exactly the "manual retry
      // control" a needs-attention entry is waiting for; the automatic
      // passes (app boot, 'online' event) intentionally skip it.
      await flushQueue({ force: true });
      paintSyncStatus();
    } finally {
      valueLabel.textContent = originalLabel;
      row.disabled = false;
    }
  });

  root.querySelector("#row-refresh-catalog").addEventListener("click", async (e) => {
    const row = e.currentTarget;
    const valueLabel = row.querySelector(".settings-row-label");
    const originalLabel = valueLabel.textContent;
    valueLabel.textContent = t("refreshing");
    row.disabled = true;
    try {
      await refreshProductCatalog();
      valueLabel.textContent = t("product_catalog_refreshed");
    } catch {
      valueLabel.textContent = t("product_catalog_refresh_failed");
    } finally {
      row.disabled = false;
      setTimeout(() => {
        valueLabel.textContent = originalLabel;
      }, 2000);
    }
  });

  if (navigator.storage?.estimate) {
    navigator.storage.estimate().then((estimate) => {
      storageValue.textContent = `${formatStorageMb(estimate.usage || 0)} ${t("storage_used")}`;
    });
  } else {
    storageValue.textContent = "—";
  }

  // Map tile pre-caching -- just flips the stored preference; map.js's own
  // warmTileCache() already reads it fresh on every pan/zoom, so no need to
  // reach into the Map view (which may not even be mounted) from here.
  const tileCacheToggle = root.querySelector("#toggle-map-tile-cache");
  tileCacheToggle?.addEventListener("click", () => {
    const next = tileCacheToggle.getAttribute("aria-checked") !== "true";
    tileCacheToggle.setAttribute("aria-checked", String(next));
    tileCacheToggle.closest(".settings-list-row").querySelector(".settings-row-value").textContent = next ? t("toggle_on") : t("toggle_off");
    setMapTileCacheEnabled(next);
  });

  // --- Admin ---
  if (admin) {
    const radiusForm = root.querySelector("#radius-form");
    const radiusInput = radiusForm.querySelector('input[name="radius"]');
    const radiusSuccess = root.querySelector("#radius-success");
    const frequencyForm = root.querySelector("#visit-frequency-form");
    const frequencyInput = frequencyForm.querySelector('input[name="days"]');
    const frequencySuccess = root.querySelector("#visit-frequency-success");
    const incentiveForm = root.querySelector("#incentive-message-form");
    const incentiveInput = incentiveForm.querySelector('input[name="message"]');
    const incentiveSuccess = root.querySelector("#incentive-message-success");
    const pinForm = root.querySelector("#calculator-pin-form");
    const pinInput = pinForm.querySelector('input[name="pin"]');
    const pinSuccess = root.querySelector("#calculator-pin-success");
    const pinStatus = root.querySelector("#calculator-pin-status");
    const calcModeToggle = root.querySelector("#toggle-calculator-mode");
    const calcModeToggleValue = calcModeToggle.closest(".settings-toggle-row").querySelector(".settings-row-value");
    const calcModeHelp = root.querySelector("#calculator-mode-help");
    const bonusesToggle = root.querySelector("#toggle-bonuses-enabled");
    const bonusesToggleValue = bonusesToggle?.closest(".settings-toggle-row").querySelector(".settings-row-value");
    const disconnectBtn = root.querySelector("#emergency-disconnect-btn");
    const disconnectSuccess = root.querySelector("#emergency-disconnect-success");

    function paintCalcModeToggle(enabled) {
      calcModeToggle.setAttribute("aria-checked", String(enabled));
      calcModeToggleValue.textContent = enabled ? t("toggle_on") : t("toggle_off");
      calcModeHelp.textContent = enabled ? t("calculator_mode_help_on") : t("calculator_mode_help_off");
    }

    api.getSettings().then((s) => {
      radiusInput.value = s.checkin_radius_meters;
      frequencyInput.value = s.default_visit_frequency_days;
      incentiveInput.value = s.incentive_message || "";
      // Write-only field (see routes/settings.js) -- never pre-filled with
      // the actual code, just a status line saying whether one is set.
      pinStatus.textContent = s.calculator_pin_is_custom ? t("calculator_pin_help_custom") : t("calculator_pin_help");
      paintCalcModeToggle(s.calculator_mode_enabled);
      if (bonusesToggle) paintBonusesToggle(s.bonuses_enabled);
    });

    calcModeToggle.addEventListener("click", async () => {
      const turningOn = calcModeToggle.getAttribute("aria-checked") !== "true";
      if (!confirm(turningOn ? t("calculator_mode_confirm_on") : t("calculator_mode_confirm_off"))) return;
      calcModeToggle.disabled = true;
      try {
        const result = await api.updateSettings({ calculator_mode_enabled: turningOn });
        paintCalcModeToggle(result.calculator_mode_enabled);
      } catch (err) {
        alert(err.message);
      } finally {
        calcModeToggle.disabled = false;
      }
    });

    function paintBonusesToggle(enabled) {
      bonusesToggle.setAttribute("aria-checked", String(enabled));
      bonusesToggleValue.textContent = enabled ? t("toggle_on") : t("toggle_off");
    }

    if (bonusesToggle) {
      bonusesToggle.addEventListener("click", async () => {
        const turningOn = bonusesToggle.getAttribute("aria-checked") !== "true";
        bonusesToggle.disabled = true;
        try {
          const result = await api.updateSettings({ bonuses_enabled: turningOn });
          paintBonusesToggle(result.bonuses_enabled);
        } catch (err) {
          alert(err.message);
        } finally {
          bonusesToggle.disabled = false;
        }
      });
    }

    disconnectBtn.addEventListener("click", async () => {
      if (!confirm(t("emergency_disconnect_confirm"))) return;
      disconnectBtn.disabled = true;
      try {
        await api.engageLockdown();
        // Our own session just got invalidated along with everyone
        // else's -- reload so bootGate/app.js's lockdown check takes over
        // and shows the lockdown screen instead of a broken half-logged-in
        // state.
        location.reload();
      } catch (err) {
        alert(err.message);
        disconnectBtn.disabled = false;
      }
    });

    radiusForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      radiusSuccess.hidden = true;
      const submitBtn = radiusForm.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      try {
        await api.updateSettings({ checkin_radius_meters: Number(radiusInput.value) });
        radiusSuccess.hidden = false;
      } finally {
        submitBtn.disabled = false;
      }
    });

    frequencyForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      frequencySuccess.hidden = true;
      const submitBtn = frequencyForm.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      try {
        await api.updateSettings({ default_visit_frequency_days: Number(frequencyInput.value) });
        frequencySuccess.hidden = false;
      } finally {
        submitBtn.disabled = false;
      }
    });

    incentiveForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      incentiveSuccess.hidden = true;
      const submitBtn = incentiveForm.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      try {
        await api.updateSettings({ incentive_message: incentiveInput.value });
        incentiveSuccess.hidden = false;
      } finally {
        submitBtn.disabled = false;
      }
    });

    pinForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      pinSuccess.hidden = true;
      const value = pinInput.value.trim();
      if (value && !/^\d{4,8}$/.test(value)) {
        pinStatus.textContent = t("calculator_pin_error");
        return;
      }
      const submitBtn = pinForm.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      try {
        const result = await api.updateSettings({ calculator_pin: value });
        pinInput.value = "";
        pinStatus.textContent = result.calculator_pin_is_custom ? t("calculator_pin_help_custom") : t("calculator_pin_help");
        pinSuccess.hidden = false;
      } finally {
        submitBtn.disabled = false;
      }
    });

    root.querySelector("#row-team-management").addEventListener("click", (e) => {
      openAdminSection(root, e.currentTarget, t("team_management"), renderTeamSection);
    });
    root.querySelector("#row-notification-defaults").addEventListener("click", (e) => {
      openAdminSection(root, e.currentTarget, t("notification_defaults_title"), renderNotificationDefaultsSection);
    });
    root.querySelector("#row-points-closeout").addEventListener("click", (e) => {
      openAdminSection(root, e.currentTarget, t("points_closeout_title"), renderPointsCloseoutSection);
    });
    root.querySelector("#row-admin-sessions").addEventListener("click", async () => {
      if (!confirm(t("confirm_log_out_other_sessions"))) return;
      await api.logoutOtherSessions();
      alert(t("other_sessions_logged_out"));
    });
    root.querySelector("#row-reports-management").addEventListener("click", (e) => {
      openAdminSection(root, e.currentTarget, t("reports_management"), renderReportsManagementSection);
    });
    root.querySelector("#row-route-distribution").addEventListener("click", (e) => {
      openAdminSection(root, e.currentTarget, t("route_distribution_title"), renderRouteDistributionSection);
    });
    root.querySelector("#row-quick-actions").addEventListener("click", (e) => {
      openAdminSection(root, e.currentTarget, t("quick_action_visibility_title"), renderQuickActionVisibilitySection);
    });
    root.querySelector("#row-sales-channel-owners").addEventListener("click", (e) => {
      openAdminSection(root, e.currentTarget, t("sales_channel_owners_title"), renderSalesChannelOwnersSection);
    });
    root.querySelector("#row-data-quality").addEventListener("click", (e) => {
      openAdminSection(root, e.currentTarget, t("data_quality_title"), renderDataQualitySection);
    });
    root.querySelector("#row-notification-delivery-log").addEventListener("click", (e) => {
      openAdminSection(root, e.currentTarget, t("notification_delivery_log_title"), renderNotificationDeliveryLogSection);
    });
    root.querySelector("#row-client-error-log").addEventListener("click", (e) => {
      openAdminSection(root, e.currentTarget, t("client_error_log_title"), renderClientErrorLogSection);
    });
  }

  if (canManageChallenges) {
    root.querySelector("#row-bonus-challenges").addEventListener("click", (e) => {
      openAdminSection(root, e.currentTarget, t("bonuses_admin_challenges"), renderBonusChallengesSection);
    });
  }
  if (canReviewBonusRewards) {
    root.querySelector("#row-bonus-reward-claims").addEventListener("click", (e) => {
      openAdminSection(root, e.currentTarget, t("bonuses_reward_claims"), renderBonusRewardClaimsSection);
    });
  }

  if (canManageProducts()) {
    root.querySelector("#row-product-catalog").addEventListener("click", (e) => {
      openAdminSection(root, e.currentTarget, t("product_catalog"), renderProductsSection);
    });
    root.querySelector("#row-company-profile").addEventListener("click", (e) => {
      openAdminSection(root, e.currentTarget, t("company_profile"), renderCompanyProfileSection);
    });
  }

  if (canApprovePlans) {
    renderPlanApprovalsSection(root.querySelector("#plan-approvals-slot"));
  }

  if (admin) {
    renderEditRequestsSection(root.querySelector("#edit-requests-slot"));
  }

  root.querySelector("#row-user-guide").addEventListener("click", openGuideOverlay);

  const checkUpdatesRow = root.querySelector("#row-check-updates");
  const checkUpdatesValue = root.querySelector("#check-updates-value");
  checkUpdatesRow.addEventListener("click", async () => {
    checkUpdatesRow.disabled = true;
    checkUpdatesValue.textContent = t("checking_for_updates");
    const { updateFound } = await checkForUpdateManually();
    checkUpdatesValue.textContent = updateFound ? t("update_found") : t("up_to_date");
    if (!updateFound) {
      checkUpdatesRow.disabled = false;
      setTimeout(() => {
        checkUpdatesValue.textContent = "";
      }, 4000);
    }
    // Left disabled with its "found" message showing when an update is
    // found -- the update-overlay (see updateBanner.js) takes over from
    // here and reloads the page, so there's no useful "re-enabled" state
    // to return this row to.
  });

  // --- Contact ---
  root.querySelector("#row-phone").addEventListener("click", () => openPhoneSheet(root, onLogout, onLanguageChange));

  // --- Security ---
  root.querySelector("#row-change-password").addEventListener("click", openChangePasswordSheet);
  root.querySelector("#row-sessions").addEventListener("click", async () => {
    if (!confirm(t("confirm_log_out_other_sessions"))) return;
    await api.logoutOtherSessions();
    alert(t("other_sessions_logged_out"));
  });

  root.querySelector("#settings-logout").addEventListener("click", () => {
    unsubscribeQueue();
    onLogout();
  });
}

function formatAmdShort(value) {
  return `${Math.round(value).toLocaleString()} ${t("amd")}`;
}

function targetProgressHtml(salesAmd, budgetAmd) {
  const budget = Number(budgetAmd);
  if (!budget) return `<p class="muted perf-no-target">${t("no_target_set")}</p>`;
  const sales = Number(salesAmd) || 0;
  const pct = Math.max(0, sales / budget);
  const clamped = Math.min(1, pct);
  return `
    <div class="progress-bar" role="progressbar" aria-valuenow="${Math.round(pct * 100)}" aria-valuemin="0" aria-valuemax="100">
      <div class="progress-bar-fill" style="width:${clamped * 100}%"></div>
    </div>
    <p class="muted perf-progress-label">${Math.round(pct * 100)}% ${t("of_target")}</p>
  `;
}

async function loadSalesPerformance(slot, role) {
  slot.innerHTML = `<h2 class="section-title">${t("sales_performance_title")}</h2><p class="loading-state" role="status">${t("loading")}</p>`;

  const wantsOwn = role === "sales_manager" || role === "sales_director";

  let mine = null;
  try {
    mine = wantsOwn ? await api.getMySalesPerformance() : null;
  } catch {
    slot.innerHTML = "";
    return;
  }

  const sections = [];

  if (wantsOwn) {
    sections.push(`<h2 class="section-title">${t("sales_performance_title")}</h2>`);
    if (!mine?.synced) {
      sections.push(`<div class="card"><p class="muted">${t("no_sales_data_yet")}</p></div>`);
    } else {
      const cm = mine.current_month;
      sections.push(`
        <div class="card">
          <div class="perf-row"><span class="muted">${t("this_month_sales")}</span><strong>${formatAmdShort(cm?.sales_amd ?? 0)}</strong></div>
          <div class="perf-row"><span class="muted">${t("this_month_collected")}</span><strong>${formatAmdShort(cm?.collected_amd ?? 0)}</strong></div>
          <div class="perf-row"><span class="muted">${t("this_month_target")}</span><strong>${formatAmdShort(cm?.budget_amd ?? 0)}</strong></div>
          ${targetProgressHtml(cm?.sales_amd, cm?.budget_amd)}
          <div class="perf-divider"></div>
          <div class="perf-row"><span class="muted">${t("ytd_sales")}</span><strong>${formatAmdShort(mine.ytd.sales_amd)}</strong></div>
          <div class="perf-row"><span class="muted">${t("ytd_collected")}</span><strong>${formatAmdShort(mine.ytd.collected_amd)}</strong></div>
          <div class="perf-row"><span class="muted">${t("ytd_target")}</span><strong>${formatAmdShort(mine.ytd.budget_amd)}</strong></div>
          ${targetProgressHtml(mine.ytd.sales_amd, mine.ytd.budget_amd)}
        </div>
      `);
    }
  }

  // The cross-rep leaderboard used to live here, but it's now fully
  // superseded by the dedicated Team Performance module (reachable from the
  // dashboard's Quick Actions) -- keeping both would just be two different
  // numbers for the same thing in two different places.

  slot.innerHTML = sections.join("");
}

const NOTIFICATION_TYPES = ["plan_submitted", "plan_reviewed", "order_status_changed", "order_placed", "visit_reminder"];

async function loadNotificationPreferences(slot) {
  let prefs;
  try {
    prefs = await api.getMyNotificationSettings();
  } catch {
    slot.innerHTML = "";
    return;
  }

  const byType = new Map(prefs.map((p) => [p.notification_type, p]));
  slot.innerHTML = NOTIFICATION_TYPES.map((type) => {
    const p = byType.get(type) ?? { enabled: true, is_override: false };
    return settingsToggleRow({
      icon: ICON.bell,
      label: t(`notification_type_${type}`),
      value: p.enabled ? t("toggle_on") : t("toggle_off"),
      id: `notif-pref-${type}`,
      checked: p.enabled,
      resetId: p.is_override ? `notif-pref-reset-${type}` : null,
      color: "red",
    });
  }).join("");

  NOTIFICATION_TYPES.forEach((type) => {
    const toggle = slot.querySelector(`#notif-pref-${type}`);
    const valueEl = toggle.closest(".settings-list-row").querySelector(".settings-row-value");
    toggle.addEventListener("click", async () => {
      const nextEnabled = toggle.getAttribute("aria-checked") !== "true";
      toggle.disabled = true;
      try {
        await api.setMyNotificationSetting(type, nextEnabled);
        toggle.setAttribute("aria-checked", String(nextEnabled));
        valueEl.textContent = nextEnabled ? t("toggle_on") : t("toggle_off");
        loadNotificationPreferences(slot);
      } catch (err) {
        alert(err.message);
        toggle.disabled = false;
      }
    });

    const resetBtn = slot.querySelector(`#notif-pref-reset-${type}`);
    resetBtn?.addEventListener("click", async (e) => {
      e.stopPropagation();
      resetBtn.disabled = true;
      try {
        await api.clearMyNotificationOverride(type);
        loadNotificationPreferences(slot);
      } catch (err) {
        alert(err.message);
        resetBtn.disabled = false;
      }
    });
  });
}

const NOTIFICATION_ROLES = [
  "admin",
  "ceo",
  "operations_director",
  "sales_director",
  "sales_manager",
  "warehouse_manager",
  "delivery_manager",
  "accountant",
];

// A role-by-role dropdown instead of one flat 7-role x 4-type grid -- the
// full matrix doesn't fit a phone screen without horizontal scrolling,
// and most admins are only ever adjusting one role at a time anyway.
async function renderNotificationDefaultsSection(slot) {
  slot.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
  let matrix;
  try {
    matrix = await api.getNotificationDefaults();
  } catch {
    slot.innerHTML = "";
    return;
  }

  let selectedRole = NOTIFICATION_ROLES[0];

  slot.innerHTML = `
    <p class="muted radius-help">${t("notification_defaults_help")}</p>
    <div class="card" style="margin-bottom:10px;">
      <label>${t("role")}
        <select id="notif-default-role-select">
          ${NOTIFICATION_ROLES.map((r) => `<option value="${r}">${t(`role_${r}`)}</option>`).join("")}
        </select>
      </label>
    </div>
    <div class="card settings-list" id="notif-default-toggles"></div>
  `;

  const toggleList = slot.querySelector("#notif-default-toggles");

  function paintRole() {
    toggleList.innerHTML = NOTIFICATION_TYPES.map((type) => {
      const entry = matrix.find((m) => m.role === selectedRole && m.notification_type === type);
      const enabled = entry?.enabled ?? true;
      return settingsToggleRow({
        icon: ICON.bell,
        label: t(`notification_type_${type}`),
        value: enabled ? t("toggle_on") : t("toggle_off"),
        id: `notif-default-${type}`,
        checked: enabled,
        color: "red",
      });
    }).join("");

    NOTIFICATION_TYPES.forEach((type) => {
      const toggle = toggleList.querySelector(`#notif-default-${type}`);
      const valueEl = toggle.closest(".settings-list-row").querySelector(".settings-row-value");
      toggle.addEventListener("click", async () => {
        const nextEnabled = toggle.getAttribute("aria-checked") !== "true";
        toggle.disabled = true;
        try {
          await api.setNotificationDefault(selectedRole, type, nextEnabled);
          const entry = matrix.find((m) => m.role === selectedRole && m.notification_type === type);
          if (entry) entry.enabled = nextEnabled;
          else matrix.push({ role: selectedRole, notification_type: type, enabled: nextEnabled });
          toggle.setAttribute("aria-checked", String(nextEnabled));
          valueEl.textContent = nextEnabled ? t("toggle_on") : t("toggle_off");
        } catch (err) {
          alert(err.message);
        } finally {
          toggle.disabled = false;
        }
      });
    });
  }

  paintRole();
  slot.querySelector("#notif-default-role-select").addEventListener("change", (e) => {
    selectedRole = e.target.value;
    paintRole();
  });
}

// Which role sees which named report -- a report-by-report dropdown, same
// shape as the notification defaults above. Toggle state comes straight
// from the access matrix endpoint, which already resolves each role's
// current effective state (an explicit override, or the report's own
// code-default when no override exists).
async function renderReportsManagementSection(slot) {
  slot.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
  let matrix;
  try {
    matrix = await api.getReportAccessMatrix();
  } catch {
    slot.innerHTML = "";
    return;
  }

  let selectedReport = matrix[0];

  slot.innerHTML = `
    <div class="card" style="margin-bottom:10px;">
      <label>${t("reports")}
        <select id="report-access-select">
          ${matrix.map((r) => `<option value="${r.key}">${t(r.nameKey)}</option>`).join("")}
        </select>
      </label>
    </div>
    <div class="card settings-list" id="report-access-toggles"></div>
  `;

  const toggleList = slot.querySelector("#report-access-toggles");

  function paintReport() {
    toggleList.innerHTML = selectedReport.roles
      .map((r) =>
        settingsToggleRow({
          icon: ICON.chart,
          label: t(`role_${r.role}`),
          value: r.enabled ? t("toggle_on") : t("toggle_off"),
          id: `report-access-${r.role}`,
          checked: r.enabled,
        })
      )
      .join("");

    selectedReport.roles.forEach((r) => {
      const toggle = toggleList.querySelector(`#report-access-${r.role}`);
      const valueEl = toggle.closest(".settings-list-row").querySelector(".settings-row-value");
      toggle.addEventListener("click", async () => {
        const nextEnabled = toggle.getAttribute("aria-checked") !== "true";
        toggle.disabled = true;
        try {
          await api.setReportAccess(selectedReport.key, r.role, nextEnabled);
          r.enabled = nextEnabled;
          toggle.setAttribute("aria-checked", String(nextEnabled));
          valueEl.textContent = nextEnabled ? t("toggle_on") : t("toggle_off");
        } catch (err) {
          alert(err.message);
        } finally {
          toggle.disabled = false;
        }
      });
    });
  }

  paintReport();
  slot.querySelector("#report-access-select").addEventListener("change", (e) => {
    selectedReport = matrix.find((r) => r.key === e.target.value);
    paintReport();
  });
}

// Shown in-app full-screen with its own X to get back to Settings. The
// iframe preview is only best-effort: an installed iOS PWA's WKWebView
// can't render a PDF inside an iframe at all (it just renders blank),
// which is why the guide looked "not working" for reps using the
// home-screen app. Share/Open are the actual guaranteed-working path on
// every platform -- Share hands the real PDF file to the OS share sheet
// (save to Files, send in a chat, print, etc.), Open falls back to letting
// the browser/OS handle the PDF URL directly.
function openGuideOverlay() {
  const pdfUrl = "/docs/kad-motors-guide-hy.pdf";
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay guide-overlay";
  overlay.innerHTML = `
    <div class="guide-overlay-frame">
      <div class="guide-overlay-toolbar">
        <button type="button" class="icon-btn guide-overlay-close" id="guide-overlay-close" aria-label="${t("close")}">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
        <div class="guide-overlay-toolbar-actions">
          <button type="button" class="btn btn-sm" id="guide-share-btn">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-3px;margin-right:4px;"><path d="M12 3v12"/><path d="m7 8 5-5 5 5"/><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/></svg>${t("share_pdf")}
          </button>
          <a class="btn btn-sm" id="guide-open-btn" href="${pdfUrl}" target="_blank" rel="noopener">${t("open_pdf")}</a>
        </div>
      </div>
      <iframe src="${pdfUrl}" title="${t("user_guide")}"></iframe>
      <p class="muted guide-overlay-fallback-hint">${t("guide_preview_fallback_hint")}</p>
    </div>
  `;
  document.body.appendChild(overlay);
  activateDialog(overlay);

  function close() {
    overlay.remove();
  }
  overlay.querySelector("#guide-overlay-close").addEventListener("click", close);
  overlay.addEventListener("click", (e) => e.target === overlay && close());
  attachSwipeToDismiss(overlay, overlay.querySelector(".guide-overlay-frame"), close);

  const shareBtn = overlay.querySelector("#guide-share-btn");
  shareBtn.addEventListener("click", async () => {
    shareBtn.disabled = true;
    try {
      const res = await fetch(pdfUrl);
      const blob = await res.blob();
      const file = new File([blob], "KAD-Motors-Guide.pdf", { type: "application/pdf" });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: t("user_guide") });
      } else if (navigator.share) {
        // Some browsers support share() but not file sharing -- share the
        // absolute URL instead of nothing.
        await navigator.share({ url: new URL(pdfUrl, location.href).href, title: t("user_guide") });
      } else {
        window.open(pdfUrl, "_blank");
      }
    } catch (err) {
      if (err?.name !== "AbortError") window.open(pdfUrl, "_blank");
    } finally {
      shareBtn.disabled = false;
    }
  });
}

// Desktop shell (see the "Desktop shell" CSS section): at desktop width
// (matches the app's single 1024px breakpoint), a section row's content
// renders into the persistent right-hand #settings-section-pane sitting
// beside the row list, instead of opening the same full-screen modal
// mobile still gets -- no modal-over-modal, no full-screen takeover just to
// glance at team management on a monitor that has the room to show both at
// once. matchMedia is read fresh on every click (not cached/listened-to)
// deliberately: this app has no other viewport-reactive JS behavior, and a
// live mid-session resize retroactively converting an already-open pane/
// modal is not a case worth the added complexity for v1.
function openAdminSection(root, rowEl, title, renderFn) {
  if (!window.matchMedia("(min-width: 1024px)").matches) {
    openAdminSectionOverlay(title, renderFn);
    return;
  }
  const pane = root.querySelector("#settings-section-pane");
  root.querySelectorAll(".settings-list-row-active").forEach((el) => el.classList.remove("settings-list-row-active"));
  rowEl.classList.add("settings-list-row-active");
  pane.hidden = false;
  pane.innerHTML = `<h2>${escapeHtml(title)}</h2><div id="settings-section-pane-content"></div>`;
  renderFn(pane.querySelector("#settings-section-pane-content"));
}

// Product catalog and team management used to render as full inline
// sections directly on the Settings page -- with plan approvals, financial
// exports, notification defaults etc. also stacked there, the page got very
// long for an admin/director. Each now collapses to a single row that opens
// its content in a full-screen overlay instead, same shell as the guide
// viewer (mobile width -- see openAdminSection above for the desktop path).
function openAdminSectionOverlay(title, renderFn) {
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay guide-overlay";
  overlay.innerHTML = `
    <div class="guide-overlay-frame">
      <div class="admin-section-overlay-toolbar">
        <button type="button" class="icon-btn guide-overlay-close" id="admin-section-close" aria-label="${t("close")}">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>
      <div class="admin-section-overlay-body" id="admin-section-overlay-body">
        <h2>${escapeHtml(title)}</h2>
        <div id="admin-section-overlay-content"></div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  activateDialog(overlay);

  const frame = overlay.querySelector(".guide-overlay-frame");
  const body = overlay.querySelector("#admin-section-overlay-body");
  function close() {
    overlay.remove();
  }
  overlay.querySelector("#admin-section-close").addEventListener("click", close);
  overlay.addEventListener("click", (e) => e.target === overlay && close());
  attachSwipeToDismiss(overlay, frame, close);
  // Tapping the toolbar (the strip right below the real status bar) scrolls
  // this overlay's own content to top -- emulates iOS's native
  // tap-status-bar-to-scroll-top, which can't otherwise reach this overlay
  // (it's a plain DOM sheet, not the document itself).
  overlay.querySelector(".admin-section-overlay-toolbar").addEventListener("click", (e) => {
    if (e.target.closest("button")) return;
    body.scrollTo({ top: 0, behavior: "smooth" });
  });

  renderFn(overlay.querySelector("#admin-section-overlay-content"));
}

// Self-service phone number -- populates the "Prepared by" footer on a
// generated pricelist (see views/pricelist.js). Nothing else reads it yet.
function openPhoneSheet(root, onLogout, onLanguageChange) {
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `
    <div class="sheet">
      <h2>${t("phone")}</h2>
      <form id="phone-form">
        <label>${t("phone")}<input name="phone" type="tel" value="${state.user.phone ? escapeHtml(formatPhoneDisplay(state.user.phone)) : "+374 "}" placeholder="+374 ..." /></label>
        <p class="form-error" id="phone-form-error" hidden></p>
        <div class="sheet-actions">
          <button type="button" class="btn" id="cancel-phone">${t("cancel")}</button>
          <button type="submit" class="btn btn-primary">${t("save")}</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(overlay);
  activateDialog(overlay);

  function close() {
    overlay.remove();
  }
  overlay.querySelector("#cancel-phone").addEventListener("click", close);
  overlay.addEventListener("click", (e) => e.target === overlay && close());

  const form = overlay.querySelector("#phone-form");
  const errorEl = overlay.querySelector("#phone-form-error");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    const digits = normalizePhone(new FormData(form).get("phone"));
    const phone = digits.length > 3 ? `+${digits}` : null;
    try {
      await api.updateMyProfile({ phone });
      state.user.phone = phone;
      close();
      renderSettings(root, onLogout, onLanguageChange);
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
      submitBtn.disabled = false;
    }
  });
}

function openChangePasswordSheet() {
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `
    <div class="sheet">
      <h2>${t("change_password")}</h2>
      <form id="change-password-form">
        <label>${t("current_password")}<input name="current_password" type="password" required /></label>
        <label>${t("new_password")}<input name="new_password" type="password" minlength="8" required /></label>
        <p class="form-error" id="change-password-error" hidden></p>
        <p class="form-success" id="change-password-success" role="status" hidden>${t("password_updated")}</p>
        <div class="sheet-actions">
          <button type="button" class="btn" id="cancel-change-password">${t("cancel")}</button>
          <button type="submit" class="btn btn-primary">${t("save")}</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(overlay);
  activateDialog(overlay);

  function close() {
    overlay.remove();
  }
  overlay.querySelector("#cancel-change-password").addEventListener("click", close);
  overlay.addEventListener("click", (e) => e.target === overlay && close());

  const form = overlay.querySelector("#change-password-form");
  const errorEl = overlay.querySelector("#change-password-error");
  const successEl = overlay.querySelector("#change-password-success");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorEl.hidden = true;
    const data = new FormData(form);
    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    try {
      await api.changeMyPassword(data.get("current_password"), data.get("new_password"));
      successEl.hidden = false;
      form.reset();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    } finally {
      submitBtn.disabled = false;
    }
  });
}
