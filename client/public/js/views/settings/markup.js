// Settings: the screen's markup (personal and admin pages) (moved out of settings.js with the refactor tool,
// docs/architecture-roadmap.md step 6). Takes the screen's state as `ctx` (the ctx object in renderSettings).
import { GUIDE_VERSION, LANDING_RATE_GROUPS, launchSpeedValue } from "../settings.js";
import { ICON, hintIcon, settingsRow, settingsToggleRow } from "./rows.js";
import { getLang, t } from "../../i18n.js";
import { escapeHtml, formatPhoneDisplay } from "../../util.js";
import { canManageProducts, canReassignCustomers, state } from "../../state.js";
import { signsHandoverActs } from "../../shared/roles.js";
import { getTheme } from "../../theme.js";
import { getPerfMode } from "../../perfMode.js";
import { getStatusBarTapPref, statusBarTapAvailable } from "../../statusBarTap.js";
import { getMapTileCacheEnabled, isStrongDevice } from "../../mapPrefs.js";
import { APP_VERSION } from "../../version.js";
import { getTextSize } from "../../textSize.js";

export function paintSettingsMarkup(ctx) {
  ctx.root.innerHTML = `
    <div class="settings-view" data-tab="personal" data-wide="0">
      <div class="settings-aside">
        <button type="button" class="settings-back" id="settings-back" hidden>${ICON.back}<span id="settings-back-label"></span></button>
        <h1 id="settings-title">${t("settings_title")}</h1>
        <div class="settings-search-wrap" id="settings-search-wrap">
          <input type="search" class="admin-search" id="settings-search" placeholder="${t("admin_search_placeholder")}" aria-label="${t("admin_search_placeholder")}" autocomplete="off" />
        </div>
        ${
          ctx.hasAdminWorkspace
            ? `<div class="settings-workspace-tabs" id="settings-tabs" role="tablist" aria-label="${t("settings_title")}">
                <button type="button" class="settings-workspace-tab settings-workspace-tab-active" id="settings-personal-tab" role="tab" aria-selected="true" aria-controls="settings-personal-panel">${t("personal_settings")}</button>
                <button type="button" class="settings-workspace-tab" id="settings-admin-tab" role="tab" aria-selected="false" aria-controls="settings-admin-panel" tabindex="-1">${t("admin_workspace")}<span class="settings-count settings-tab-count" id="settings-admin-tab-count" hidden></span></button>
              </div>`
            : ""
        }
        <div class="card settings-list settings-nav" id="settings-results" hidden></div>
        <p class="muted admin-search-empty" id="settings-search-empty" hidden>${t("admin_search_empty")}</p>
        <nav class="card settings-list settings-nav" id="settings-nav-personal" aria-label="${t("personal_settings")}" hidden>${ctx.navItems("personal")}</nav>
        ${ctx.hasAdminWorkspace ? `<nav class="card settings-list settings-nav" id="settings-nav-admin" aria-label="${t("admin_workspace")}" hidden>${ctx.navItems("admin")}</nav>` : ""}
      </div>

      <div class="settings-main">
      <section id="settings-personal-panel" ${ctx.hasAdminWorkspace ? 'role="tabpanel" aria-labelledby="settings-personal-tab"' : ""}>

      ${ctx.pageOpen(ctx.pageById("p-account"))}
      <div class="card profile-card">
        <div class="profile-avatar-wrap">
          <div class="profile-avatar" id="profile-avatar">${escapeHtml(state.user.name.slice(0, 1).toUpperCase())}</div>
          <input type="file" id="avatar-input" accept="image/*" class="visually-hidden" />
          <button type="button" class="profile-avatar-badge" id="avatar-btn" aria-label="${t("change_photo")}">${ICON.camera}</button>
        </div>
        <div class="profile-info">
          <strong>${escapeHtml(state.user.name)}</strong>
          <span class="muted">${t(`role_${state.user.role_title || state.user.role}`)}${state.user.position ? ` · ${escapeHtml(state.user.position)}` : ""}</span>
          <span class="muted">${escapeHtml(state.user.email)}</span>
          ${state.user.has_avatar ? `<button type="button" class="settings-reset-link" id="avatar-remove-btn">${t("remove_avatar")}</button>` : ""}
          ${signsHandoverActs(state.user.role) ? `<button type="button" class="settings-reset-link" id="signature-btn">${t(state.user.has_signature ? "signature_redraw" : "signature_draw")}</button>` : ""}
        </div>
      </div>

      ${
        // Per explicit request: removed entirely for sales_manager (a
        // sales_director still sees their own performance card).
        state.user.role === "sales_director" ? `<div id="sales-performance-slot"></div>` : ""
      }

      <div class="card settings-list">
        ${settingsRow({ icon: ICON.phone, label: t("phone"), value: state.user.phone ? escapeHtml(formatPhoneDisplay(state.user.phone)) : t("not_set"), id: "row-phone", color: "green" })}
        ${settingsRow({ icon: ICON.lock, label: t("change_password"), id: "row-change-password", color: "gray" })}
        ${settingsRow({ icon: ICON.shield, label: t("session_management"), id: "row-sessions", color: "green" })}
      </div>
      </section>

      ${ctx.pageOpen(ctx.pageById("p-appearance"))}
      <div class="card settings-list">
        ${settingsToggleRow({ icon: ICON.appearance, label: t("appearance"), value: getTheme() === "dark" ? t("dark") : t("light"), id: "toggle-appearance", checked: getTheme() === "dark", color: "indigo" })}
        ${settingsToggleRow({ icon: ICON.language, label: t("language"), value: getLang() === "hy" ? t("armenian") : t("english"), id: "toggle-language", checked: getLang() === "hy", color: "blue" })}
        ${settingsToggleRow({ icon: ICON.bolt, label: t("efficiency_mode"), value: getPerfMode() === "efficiency" ? t("toggle_on") : t("toggle_off"), id: "toggle-perf-mode", checked: getPerfMode() === "efficiency", color: "orange", hintBtnId: "efficiency-mode-hint-btn", hintTextId: "efficiency-mode-hint-text" })}
        <p class="muted settings-hint-text" id="efficiency-mode-hint-text" hidden>${t("efficiency_mode_hint")}</p>
        ${statusBarTapAvailable() ? `${settingsToggleRow({ icon: ICON.bolt, label: t("statusbar_tap"), value: getStatusBarTapPref() ? t("toggle_on") : t("toggle_off"), id: "toggle-statusbar-tap", checked: getStatusBarTapPref(), color: "blue", hintBtnId: "statusbar-tap-hint-btn", hintTextId: "statusbar-tap-hint-text" })}
        <p class="muted settings-hint-text" id="statusbar-tap-hint-text" hidden>${t("statusbar_tap_hint")}</p>` : ""}
      </div>
      <div class="card settings-list">
        <div class="settings-list-row"><span class="settings-row-label">${t("text_size")}</span></div>
        <div class="settings-textsize" id="text-size-picker" role="radiogroup" aria-label="${t("text_size")}">
          ${[["normal", "ts-a1", "text_size_normal"], ["large", "ts-a2", "text_size_large"], ["xlarge", "ts-a3", "text_size_xlarge"]]
            .map(([v, cls, key]) => `<button type="button" role="radio" class="${cls}${getTextSize() === v ? " is-on" : ""}" aria-checked="${getTextSize() === v}" data-text-size="${v}">${t(key)}</button>`)
            .join("")}
        </div>
      </div>
      </section>

      ${ctx.pageOpen(ctx.pageById("p-notifications"))}
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
      </section>

      ${ctx.pageOpen(ctx.pageById("p-data"))}
      <div class="card settings-list">
        ${settingsRow({ icon: ICON.cloud, label: t("sync_status"), value: `<span id="sync-status-value"></span>`, interactive: false, color: "teal" })}
        ${settingsRow({ icon: ICON.clock, label: t("last_sync"), value: `<span id="last-sync-value"></span>`, interactive: false, color: "gray" })}
        ${settingsRow({ icon: ICON.refresh, label: t("refresh_data"), id: "row-refresh", color: "green" })}
        ${settingsRow({ icon: ICON.refresh, label: t("refresh_product_catalog"), id: "row-refresh-catalog", color: "green" })}
        ${settingsRow({ icon: ICON.database, label: t("offline_storage"), value: `<span id="storage-value">…</span>`, interactive: false, color: "purple" })}
        ${
          isStrongDevice()
            ? `${settingsToggleRow({ icon: ICON.database, label: t("map_tile_cache"), value: getMapTileCacheEnabled() ? t("toggle_on") : t("toggle_off"), id: "toggle-map-tile-cache", checked: getMapTileCacheEnabled(), color: "purple", hintBtnId: "map-tile-hint-btn", hintTextId: "map-tile-hint-text" })}
               <p class="muted settings-hint-text" id="map-tile-hint-text" hidden>${t("map_tile_cache_hint")}</p>`
            : ""
        }
      </div>
      <p class="settings-hint sync-needs-attention-hint" id="sync-needs-attention-hint" role="status" hidden></p>
      </section>

      ${ctx.pageOpen(ctx.pageById("p-about"))}
      <div class="card settings-list">
        ${settingsRow({ icon: ICON.info, label: t("about_app"), value: `${t("version")} ${APP_VERSION}`, interactive: false, color: "blue" })}
        ${settingsRow({ icon: ICON.refresh, label: t("check_for_updates"), value: `<span id="check-updates-value"></span>`, id: "row-check-updates", color: "teal" })}
        ${settingsRow({ icon: ICON.clock, label: t("launch_speed"), value: launchSpeedValue(), id: "row-launch-speed", color: "gray" })}
        ${settingsRow({ icon: ICON.book, label: t("user_guide"), value: "PDF", id: "row-user-guide", color: "orange", hintBtnId: "user-guide-hint-btn", hintTextId: "user-guide-hint-text" })}
        <p class="muted settings-hint-text" id="user-guide-hint-text" hidden>${t("user_guide_hint").replace("{v}", GUIDE_VERSION)}</p>
      </div>
      </section>

      <div class="settings-logout-wrap" id="settings-logout-wrap">
        <button class="btn btn-block btn-danger settings-logout" id="settings-logout">${t("log_out")}</button>
      </div>
      </section>

      ${
        ctx.hasAdminWorkspace
          ? `<section id="settings-admin-panel" role="tabpanel" aria-labelledby="settings-admin-tab" hidden>

      ${
        ctx.admin
          ? `${ctx.pageOpen(ctx.pageById("a-team"))}
        <div class="card settings-list">
          ${settingsRow({ icon: ICON.team, label: t("team_management"), id: "row-team-management", color: "blue" })}
          ${settingsRow({ icon: ICON.bell, label: t("notification_defaults_title"), id: "row-notification-defaults", color: "red" })}
          ${settingsRow({ icon: ICON.chart, label: t("quick_action_visibility_title"), id: "row-quick-actions", color: "indigo" })}
        </div>
        </section>`
          : ""
      }

      ${
        ctx.pageById("a-sales")
          ? `${ctx.pageOpen(ctx.pageById("a-sales"))}
        ${
          ctx.canApprovePlans
            ? `<h3 class="settings-subsection-title">${t("plan_approvals")}</h3>
          <div id="plan-approvals-slot"></div>`
            : ""
        }
        ${
          ctx.admin
            ? `<h3 class="settings-subsection-title">${t("edit_requests_title")}</h3>
          <div id="edit-requests-slot"></div>`
            : ""
        }
        ${
          ctx.admin
            ? `<h3 class="settings-subsection-title">${t("settings_group_visits")}</h3>
          <div class="card settings-list-group">
          ${settingsToggleRow({ icon: ICON.gps, label: t("checkin_allowance_label"), value: "", id: "toggle-checkin-allowance", checked: true, color: "green" })}
          <form id="radius-form" class="settings-list-group-item">
            <label>
              <span class="settings-form-label">${ICON.gps}${t("gps_verification_settings")}${hintIcon("radius-help-text")}</span>
              <input type="number" name="radius" min="10" max="5000" required />
            </label>
            <p class="muted radius-help" id="radius-help-text" hidden>${t("checkin_radius_help")}</p>
            <p class="form-success" id="radius-success" role="status" hidden>${t("saved")}</p>
            <button type="submit" class="btn btn-primary">${t("save")}</button>
          </form>
          <form id="visit-frequency-form" class="settings-list-group-item">
            <label>
              <span class="settings-form-label">${ICON.calendar}${t("default_visit_frequency")}${hintIcon("visit-frequency-help-text")}</span>
              <input type="number" name="days" min="1" max="365" required />
            </label>
            <p class="muted radius-help" id="visit-frequency-help-text" hidden>${t("default_visit_frequency_help")}</p>
            <p class="form-success" id="visit-frequency-success" role="status" hidden>${t("saved")}</p>
            <button type="submit" class="btn btn-primary">${t("save")}</button>
          </form>
          <form id="plan-skip-form" class="settings-list-group-item">
            <label>
              <span class="settings-form-label">${ICON.calendar}${t("plan_skip_recent_label")}${hintIcon("plan-skip-help-text")}</span>
              <input type="number" name="days" min="0" max="60" required />
            </label>
            <p class="muted radius-help" id="plan-skip-help-text" hidden>${t("plan_skip_recent_help")}</p>
            <p class="form-success" id="plan-skip-success" role="status" hidden>${t("saved")}</p>
            <button type="submit" class="btn btn-primary">${t("save")}</button>
          </form>
        </div>
        <div class="card settings-list">
          ${settingsRow({ icon: ICON.calendar, label: t("visit_types_title"), id: "row-visit-types", color: "green" })}
          ${settingsRow({ icon: ICON.book, label: t("doc_texts_title"), id: "row-doc-texts", color: "orange" })}
          ${settingsRow({ icon: ICON.database, label: t("sales_channel_owners_title"), id: "row-sales-channel-owners", color: "purple" })}
          ${canReassignCustomers() ? settingsRow({ icon: ICON.gps, label: t("pin_review_title"), id: "row-pin-review", color: "red" }) : ""}
          ${ctx.canManageArrival ? settingsRow({ icon: ICON.gps, label: t("arrival_section"), id: "row-delivery-arrival", color: "green" }) : ""}
        </div>`
            : canReassignCustomers() || ctx.canManageArrival
              ? `<div class="card settings-list">
          ${canReassignCustomers() ? settingsRow({ icon: ICON.gps, label: t("pin_review_title"), id: "row-pin-review", color: "red" }) : ""}
          ${ctx.canManageArrival ? settingsRow({ icon: ICON.gps, label: t("arrival_section"), id: "row-delivery-arrival", color: "green" }) : ""}
        </div>`
              : ""
        }
        </section>`
          : ""
      }

      ${
        ctx.pageById("a-finance")
          ? `${ctx.pageOpen(ctx.pageById("a-finance"))}
        ${
          ctx.admin
            ? `<div class="card settings-list">
          ${settingsRow({ icon: ICON.chart, label: t("reports_management"), id: "row-reports-management", color: "green" })}
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
          ctx.admin
            ? `<h3 class="settings-subsection-title">${t("settings_group_pricing")}</h3>
          <div class="card settings-list-group">
          ${settingsToggleRow({ icon: ICON.bolt, label: t("landing_calc_label"), value: "", id: "toggle-landing-calc", checked: true, color: "orange" })}
          <form id="landing-rate-form" class="settings-list-group-item">
            <label>
              <span class="settings-form-label">${ICON.bolt}${t("landing_rate_label")}${hintIcon("landing-rate-help-text")}</span>
              <input type="number" name="rate" min="100" max="1000" step="0.01" required />
            </label>
            <p class="muted radius-help" id="landing-rate-help-text" hidden>${t("landing_rate_help")}</p>
            <p class="form-success" id="landing-rate-success" role="status" hidden>${t("saved")}</p>
            <button type="submit" class="btn btn-primary">${t("save")}</button>
          </form>
          <details class="settings-list-group-item lr-details" id="landing-rates-details">
            <summary class="settings-form-label">${ICON.bolt}${t("lr_title")}</summary>
            <form id="landing-rates-form" class="lr-form" novalidate>
              ${LANDING_RATE_GROUPS.map(
                (g) => `<fieldset class="lr-group"><legend>${t(g.label)}</legend><div class="lr-grid">${g.fields
                  .map(([key, label]) => `<label class="lr-field"><span>${t(label)}</span><input type="number" inputmode="decimal" name="${key}" min="0" step="any" /></label>`)
                  .join("")}</div></fieldset>`
              ).join("")}
              <p class="muted radius-help" id="lr-help-text" hidden>${t("lr_help")}</p>
              <p class="form-success" id="landing-rates-success" role="status" hidden>${t("saved")}</p>
              <div class="lr-actions">
                <button type="button" class="btn" id="landing-rates-reset">${t("lr_reset")}</button>
                <button type="submit" class="btn btn-primary">${t("save")}</button>
              </div>
            </form>
          </details>
          ${settingsToggleRow({ icon: ICON.bolt, label: t("retail_excel_label"), value: "", id: "toggle-retail-excel", checked: false, color: "orange", hintBtnId: "retail-excel-hint-btn", hintTextId: "retail-excel-help-text" })}
          <div class="settings-list-group-item">
            <p class="muted radius-help" id="retail-excel-help-text" hidden>${t("retail_excel_help")}</p>
            <button type="button" class="btn" id="retail-diff-btn">${t("retail_diff_btn")}</button>
          </div>
        </div>`
            : ""
        }
        ${
          ctx.canExportFinancials
            ? `<h3 class="settings-subsection-title">${t("financial_exports")}</h3>
          <div class="card settings-list">
          <a class="settings-list-row" href="/api/exports/payments.csv" data-download="payments.csv">
            <span class="settings-row-label">${t("export_payments")}</span>
          </a>
          <a class="settings-list-row" href="/api/exports/debt.csv" data-download="debt.csv">
            <span class="settings-row-label">${t("export_debt")}</span>
          </a>
          <a class="settings-list-row" href="/api/exports/orders.csv" data-download="orders.csv">
            <span class="settings-row-label">${t("export_orders")}</span>
          </a>
        </div>`
            : ""
        }
        </section>`
          : ""
      }

      ${
        ctx.pageById("a-bonuses")
          ? `${ctx.pageOpen(ctx.pageById("a-bonuses"))}
        ${
          ctx.admin
            ? `
          <div class="card settings-list-group">
            ${settingsToggleRow({ icon: ICON.bolt, label: t("bonuses_enabled_label"), value: "", id: "toggle-bonuses-enabled", checked: false, color: "orange" })}
            <form id="incentive-message-form" class="settings-list-group-item">
              <label>
                <span class="settings-form-label">${ICON.gps}${t("incentive_message_label")}${hintIcon("incentive-message-help-text")}</span>
                <input type="text" name="message" maxlength="200" placeholder="${t("points_leaderboard_prize_hint")}" />
              </label>
              <p class="muted radius-help" id="incentive-message-help-text" hidden>${t("incentive_message_help")}</p>
              <p class="form-success" id="incentive-message-success" role="status" hidden>${t("saved")}</p>
              <button type="submit" class="btn btn-primary">${t("save")}</button>
            </form>
          </div>
        `
            : ""
        }
        <div class="card settings-list">
          ${ctx.canManageChallenges ? settingsRow({ icon: ICON.bolt, label: t("bonuses_admin_challenges"), id: "row-bonus-challenges", color: "orange" }) : ""}
          ${ctx.canReviewBonusRewards ? settingsRow({ icon: ICON.chart, label: t("bonuses_reward_claims"), id: "row-bonus-reward-claims", color: "green" }) : ""}
          ${ctx.admin ? settingsRow({ icon: ICON.chart, label: t("points_closeout_title"), id: "row-points-closeout", color: "teal" }) : ""}
        </div>
        </section>`
          : ""
      }

      ${
        ctx.pageById("a-integrations")
          ? `${ctx.pageOpen(ctx.pageById("a-integrations"))}
        ${
          ctx.admin
            ? `<h3 class="settings-subsection-title">${t("ask_kad_label")}</h3>
          <div class="card settings-list-group">
          ${settingsToggleRow({ icon: ICON.bolt, label: t("ask_kad_label"), value: "", id: "toggle-ask-kad", checked: true, color: "purple" })}
          <form id="ask-kad-cap-form" class="settings-list-group-item">
            <label>
              <span class="settings-form-label">${ICON.bolt}${t("ask_kad_cap_label")}${hintIcon("ask-kad-cap-help-text")}</span>
              <input type="number" name="usd" min="1" max="5000" step="1" required />
            </label>
            <p class="muted radius-help" id="ask-kad-cap-help-text" hidden>${t("ask_kad_cap_help")}</p>
            <p class="form-success" id="ask-kad-cap-success" role="status" hidden>${t("saved")}</p>
            <button type="submit" class="btn btn-primary">${t("save")}</button>
          </form>
        </div>
          <h3 class="settings-subsection-title">${t("ai_check_label")}${hintIcon("ai-check-help-text")}</h3>
          <p class="muted radius-help" id="ai-check-help-text" hidden>${t("ai_check_help")}</p>
          <div class="card settings-list-group">
          ${settingsToggleRow({ icon: ICON.bolt, label: t("ai_check_label"), value: "", id: "toggle-ai-check", checked: false, color: "purple" })}
          <form id="ai-check-cap-form" class="settings-list-group-item">
            <label>
              <span class="settings-form-label">${ICON.bolt}${t("ai_check_cap_label")}</span>
              <input type="number" name="usd" min="1" max="5000" step="1" required />
            </label>
            <p class="form-error" id="ai-check-no-key" hidden>${t("ai_check_no_key")}</p>
            <p class="form-success" id="ai-check-cap-success" role="status" hidden>${t("saved")}</p>
            <button type="submit" class="btn btn-primary">${t("save")}</button>
          </form>
        </div>`
            : ""
        }
        ${
          ctx.canManageCampaigns
            ? `<h3 class="settings-subsection-title">${t("kos_section")}</h3>
          <div class="card settings-list">
          ${ctx.canManageChallenges ? settingsRow({ icon: ICON.bolt, label: t("kos_row"), id: "row-kos-perks", color: "orange" }) : ""}
          ${settingsRow({ icon: ICON.chart, label: t("kos_campaigns_row"), id: "row-kos-campaigns", color: "teal" })}
        </div>`
            : ""
        }
        </section>`
          : ""
      }

      ${
        ctx.admin
          ? `${ctx.pageOpen(ctx.pageById("a-security"))}
        <div class="card settings-list-group">
          <form id="calculator-pin-form" class="settings-list-group-item">
            <label>
              <span class="settings-form-label">${ICON.lock}${t("calculator_pin_label")}${hintIcon("calculator-pin-status")}</span>
              <input type="text" inputmode="numeric" pattern="\\d{4,8}" name="pin" placeholder="${t("calculator_pin_placeholder")}" autocomplete="off" />
            </label>
            <p class="muted radius-help" id="calculator-pin-status" hidden>${t("calculator_pin_help")}</p>
            <p class="form-success" id="calculator-pin-success" role="status" hidden>${t("saved")}</p>
            <button type="submit" class="btn btn-primary">${t("save")}</button>
          </form>
          ${settingsToggleRow({ icon: ICON.lock, label: t("calculator_mode_label"), value: "", id: "toggle-calculator-mode", checked: false, color: "gray", hintBtnId: "calculator-mode-hint-btn", hintTextId: "calculator-mode-help" })}
          <p class="muted settings-hint-text" id="calculator-mode-help" hidden>${t("calculator_mode_help_off")}</p>
        </div>
        <div class="card settings-list">
          ${settingsRow({ icon: ICON.shield, label: t("session_management"), id: "row-admin-sessions", color: "green" })}
        </div>
        <div class="card settings-list-group settings-danger-card">
          <div class="settings-list-group-item">
            <span class="settings-form-label settings-danger-label">${ICON.shield}${t("emergency_disconnect_title")}${hintIcon("emergency-disconnect-help-text")}</span>
            <p class="muted radius-help" id="emergency-disconnect-help-text" hidden>${t("emergency_disconnect_help")}</p>
            <p class="form-success" id="emergency-disconnect-success" role="status" hidden>${t("emergency_disconnect_lifted")}</p>
            <button type="button" class="btn btn-danger" id="emergency-disconnect-btn">${t("emergency_disconnect_button")}</button>
          </div>
        </div>
        </section>

        ${ctx.pageOpen(ctx.pageById("a-system"))}
        <div class="card settings-list">
          ${settingsRow({ icon: ICON.shield, label: t("system_health_title"), id: "row-system-health", color: "green" })}
          ${settingsRow({ icon: ICON.chart, label: t("data_quality_title"), id: "row-data-quality", color: "red" })}
          ${settingsRow({ icon: ICON.cloud, label: t("places_title"), id: "row-places", color: "blue" })}
          ${settingsRow({ icon: ICON.database, label: t("notification_delivery_log_title"), id: "row-notification-delivery-log", color: "teal" })}
          ${settingsRow({ icon: ICON.database, label: t("client_error_log_title"), id: "row-client-error-log", color: "gray" })}
        </div>
        </section>`
          : ""
      }

      <!-- Computer layout: a row's own screen (Team management, ...) opens here in place of the page, with a
           Back button -- like the System Settings drill-down. On a phone openAdminSectionOverlay is used. -->
      <div class="settings-section-pane" id="settings-section-pane" hidden></div>
      </section>`
          : ""
      }
      </div>
    </div>
  `;
}
