import { api } from "../api.js";
import { t, getLang, setLang } from "../i18n.js";
import { getTheme, setTheme } from "../theme.js";
import { getPerfMode, setPerfMode } from "../perfMode.js";
import { getTextSize, setTextSize } from "../textSize.js";
import { state, isAdmin, canPlanForOthers, seesFinancialExports, canManageProducts, canReassignCustomers, isPerfCeo } from "../state.js";
import { renderTeamSection, renderPlanApprovalsSection, renderEditRequestsSection, renderProductsSection, renderPointsCloseoutSection, renderCompanyProfileSection, renderSalesChannelOwnersSection, renderQuickActionVisibilitySection, renderDataQualitySection, renderNotificationDeliveryLogSection, renderClientErrorLogSection } from "./admin.js";
import { renderSystemHealthSection } from "./systemHealth.js";
import { renderPinReviewSection } from "./pinReview.js";
import { renderBonusChallengesSection, renderBonusRewardClaimsSection } from "./bonusChallengesAdmin.js";
import { renderKadOsPerksSection, renderKadOsCampaignsSection } from "./kadOsAdmin.js";
import { renderDeliveryArrivalSection } from "./deliveryArrivalAdmin.js";
import { openInfoPopup, formatAmd, escapeHtml, compressImage, activateDialog, attachSwipeToDismiss, formatPhoneDisplay, normalizePhone, downloadFromUrl, formatDateTime } from "../util.js";
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
  user: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3.6"/><path d="M4.5 20.5v-1A5.5 5.5 0 0 1 10 14h4a5.5 5.5 0 0 1 5.5 5.5v1"/></svg>`,
  back: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg>`,
  coins: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M14.8 9.2c-.5-.8-1.5-1.2-2.8-1.2-1.6 0-2.6.8-2.6 1.9 0 2.7 5.4 1.2 5.4 4 0 1.1-1.1 1.9-2.8 1.9-1.4 0-2.5-.5-3-1.4M12 6v2M12 16v2"/></svg>`,
  star: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 16.9l-5.2 2.8 1-5.9-4.3-4.1 5.9-.8z"/></svg>`,
  link: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>`,
  bolt: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M13 3 5 13.5h5.5L11 21l8-10.5h-5.5z"/></svg>`,
};

// User guide PDFs (client/public/docs/kad-motors-guide-{hy,en}.pdf): update GUIDE_VERSION
// (and rebuild them with docs/user-guide/build.py + render.mjs) whenever a UI change is
// significant enough that the screenshots/steps in the guide would mislead a
// rep -- a new nav pattern, a changed order-creation flow, moved buttons,
// etc. A copy-fix or color tweak doesn't need a re-export.
const GUIDE_VERSION = "1.251.0";

// The small "!" that reveals an explanation: data-hint is the id of the hidden paragraph it toggles. A <span
// role="button"> rather than a <button>, since it often sits inside a row that is a button itself.
function hintIcon(textId, btnId = "") {
  return `<span role="button" tabindex="0" class="settings-inline-hint-icon" ${btnId ? `id="${btnId}"` : ""} data-hint="${textId}" aria-expanded="false" aria-controls="${textId}" aria-label="${t("more_info")}">!</span>`;
}

// The router's navigate(): phones open an Administration page as its own route so Back / swipe-back returns to the list.
let navigateFn = null;
let currentNav = { tab: "personal", page: null };
const currentPageId = () => currentNav.page;

// `color` picks a badge tint for the row's icon, iOS-Settings style (each
// row's icon sits in a colored rounded-square, not just a plain glyph) --
// one of the ICON_COLORS keys below. Reused across rows freely, same as
// iOS itself reuses a handful of system colors across many settings.
// hintBtnId: renders a small inline "!" button right next to the label
// (instead of a separate detached hint icon floating below the whole
// card) -- pairs with a hidden <p> (hintTextId) the caller places under the row;
// the "!" wiring is generic (data-hint), see renderSettings.
function settingsRow({ icon, label, value, id, interactive = true, color = "gray", hintBtnId, hintTextId }) {
  const tag = interactive ? "button" : "div";
  return `
    <${tag} ${interactive ? 'type="button"' : ""} class="settings-list-row" ${id ? `id="${id}"` : ""}>
      <span class="settings-row-icon settings-row-icon-${color}">${icon}</span>
      <span class="settings-row-label">
        ${label}
        ${hintBtnId ? `${hintIcon(hintTextId, hintBtnId)}` : ""}
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
        ${hintBtnId ? `${hintIcon(hintTextId, hintBtnId)}` : ""}
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

// Landing-cost rates editable in App configuration (server/src/landingCalc.js LANDING_RATE_FIELDS): [key, label key].
const LANDING_RATE_GROUPS = [
  { label: "lr_freight", fields: [["tRealCastrol", "lr_brand_castrol"], ["tRealRoyal", "lr_brand_royal"], ["tRealLotos", "lr_brand_lotos"], ["tRealOther", "lr_brand_other"]] },
  { label: "lr_legal", fields: [["tLegalCastrol", "lr_brand_castrol"], ["tLegalRoyal", "lr_brand_royal"], ["tLegalLotos", "lr_brand_lotos"], ["tLegalOther", "lr_brand_other"]] },
  { label: "lr_taxes", fields: [["customs", "lr_customs"], ["eco", "lr_eco"], ["excise", "lr_excise"], ["vat", "lr_vat"], ["handling", "lr_handling"], ["otherUsd", "lr_other"]] },
];

export async function renderSettings(root, onLogout, onLanguageChange, section = null, navigate = null) {
  navigateFn = navigate || navigateFn;
  // CSV exports are saved in place (see util.js downloadFromUrl), never by
  // navigating the app window to the file -- an installed PWA has no way back.
  root.addEventListener("click", async (e) => {
    const link = e.target.closest("a[data-download]");
    if (!link) return;
    e.preventDefault();
    if (link.getAttribute("aria-busy") === "true") return;
    link.setAttribute("aria-busy", "true");
    try {
      await downloadFromUrl(link.getAttribute("href"), link.dataset.download);
    } catch (err) {
      alert(err.message);
    } finally {
      link.removeAttribute("aria-busy");
    }
  });
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
  const canManageArrival = admin || state.user?.role === "ceo"; // the server lets only admin / CEO change driver arrival
  // Mirrors canApproveBonusRewards (admin/ceo/accountant) OR
  // canRecordBonusPayouts (admin/accountant) -- the union of who needs to
  // see the reward-claims review list at all, a strictly larger set than
  // canManageChallenges (an accountant reviews/pays claims but never
  // designs a challenge).
  const canReviewBonusRewards = admin || canManageChallenges || state.user?.role === "accountant";
  // Mirrors canManageCampaigns (admin/ceo/sales_director): campaigns for the customers that order through KAD OS.
  const canManageCampaigns = canManageChallenges || state.user?.role === "sales_director";
  const hasAdminWorkspace = admin || canApprovePlans || canExportFinancials || canManageChallenges || canReviewBonusRewards || canManageCampaigns;

  // Pages (iOS Settings / macOS System Settings structure): every page is a
  // group of related rows. Phone: Personal = one scrolling list of pages,
  // Administration = a list of categories that open as pages (Back returns).
  // Computer (>= 1024 px): a sidebar of pages and the chosen page beside it.
  const PAGES = [
    { id: "p-account", tab: "personal", title: t("sp_account"), icon: ICON.user, color: "blue", show: true },
    { id: "p-appearance", tab: "personal", title: t("sp_appearance"), icon: ICON.appearance, color: "indigo", show: true },
    { id: "p-notifications", tab: "personal", title: t("notifications_title"), icon: ICON.bell, color: "red", show: true },
    { id: "p-data", tab: "personal", title: t("sp_data"), icon: ICON.cloud, color: "teal", show: true },
    { id: "p-about", tab: "personal", title: t("sp_about"), icon: ICON.info, color: "gray", show: true },
    { id: "a-team", tab: "admin", title: t("admin_group_team_roles"), icon: ICON.team, color: "blue", show: admin },
    { id: "a-sales", tab: "admin", title: t("sa_sales"), icon: ICON.gps, color: "green", show: admin || canApprovePlans || canReassignCustomers() || canManageArrival },
    { id: "a-finance", tab: "admin", title: t("sa_finance"), icon: ICON.coins, color: "orange", show: admin || canManageProducts() || canExportFinancials },
    { id: "a-bonuses", tab: "admin", title: t("sa_bonuses"), icon: ICON.star, color: "purple", show: canManageChallenges || canReviewBonusRewards },
    { id: "a-integrations", tab: "admin", title: t("sa_integrations"), icon: ICON.link, color: "indigo", show: admin || canManageCampaigns },
    { id: "a-security", tab: "admin", title: t("security"), icon: ICON.lock, color: "gray", show: admin },
    { id: "a-system", tab: "admin", title: t("sa_system"), icon: ICON.shield, color: "red", show: admin },
  ].filter((p) => p.show && (p.tab === "personal" || hasAdminWorkspace));
  const pagesOf = (tab) => PAGES.filter((p) => p.tab === tab);
  const pageById = (id) => PAGES.find((p) => p.id === id);

  const pageOpen = (p) => `<section class="settings-page" data-page="${p.id}" data-tab="${p.tab}" data-title="${escapeHtml(p.title)}" hidden><h2 class="settings-page-title">${escapeHtml(p.title)}</h2>`;
  const navItems = (tab) =>
    pagesOf(tab)
      .map(
        (p) => `<button type="button" class="settings-list-row settings-nav-item" data-nav-page="${p.id}">
          <span class="settings-row-icon settings-row-icon-${p.color}">${p.icon}</span>
          <span class="settings-row-label">${escapeHtml(p.title)}</span>
          <span class="settings-row-chevron">${ICON.chevron}</span>
        </button>`
      )
      .join("");

  root.innerHTML = `
    <div class="settings-view" data-tab="personal" data-wide="0">
      <div class="settings-aside">
        <button type="button" class="settings-back" id="settings-back" hidden>${ICON.back}<span id="settings-back-label"></span></button>
        <h1 id="settings-title">${t("settings_title")}</h1>
        <div class="settings-search-wrap" id="settings-search-wrap">
          <input type="search" class="admin-search" id="settings-search" placeholder="${t("admin_search_placeholder")}" aria-label="${t("admin_search_placeholder")}" autocomplete="off" />
        </div>
        ${
          hasAdminWorkspace
            ? `<div class="settings-workspace-tabs" id="settings-tabs" role="tablist" aria-label="${t("settings_title")}">
                <button type="button" class="settings-workspace-tab settings-workspace-tab-active" id="settings-personal-tab" role="tab" aria-selected="true" aria-controls="settings-personal-panel">${t("personal_settings")}</button>
                <button type="button" class="settings-workspace-tab" id="settings-admin-tab" role="tab" aria-selected="false" aria-controls="settings-admin-panel" tabindex="-1">${t("admin_workspace")}</button>
              </div>`
            : ""
        }
        <div class="card settings-list settings-nav" id="settings-results" hidden></div>
        <p class="muted admin-search-empty" id="settings-search-empty" hidden>${t("admin_search_empty")}</p>
        <nav class="card settings-list settings-nav" id="settings-nav-personal" aria-label="${t("personal_settings")}" hidden>${navItems("personal")}</nav>
        ${hasAdminWorkspace ? `<nav class="card settings-list settings-nav" id="settings-nav-admin" aria-label="${t("admin_workspace")}" hidden>${navItems("admin")}</nav>` : ""}
      </div>

      <div class="settings-main">
      <section id="settings-personal-panel" ${hasAdminWorkspace ? 'role="tabpanel" aria-labelledby="settings-personal-tab"' : ""}>

      ${pageOpen(pageById("p-account"))}
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

      <div class="card settings-list">
        ${settingsRow({ icon: ICON.phone, label: t("phone"), value: state.user.phone ? escapeHtml(formatPhoneDisplay(state.user.phone)) : t("not_set"), id: "row-phone", color: "green" })}
        ${settingsRow({ icon: ICON.lock, label: t("change_password"), id: "row-change-password", color: "gray" })}
        ${settingsRow({ icon: ICON.shield, label: t("session_management"), id: "row-sessions", color: "green" })}
      </div>
      </section>

      ${pageOpen(pageById("p-appearance"))}
      <div class="card settings-list">
        ${settingsToggleRow({ icon: ICON.appearance, label: t("appearance"), value: getTheme() === "dark" ? t("dark") : t("light"), id: "toggle-appearance", checked: getTheme() === "dark", color: "indigo" })}
        ${settingsToggleRow({ icon: ICON.language, label: t("language"), value: getLang() === "hy" ? t("armenian") : t("english"), id: "toggle-language", checked: getLang() === "hy", color: "blue" })}
        ${settingsToggleRow({ icon: ICON.bolt, label: t("efficiency_mode"), value: getPerfMode() === "efficiency" ? t("toggle_on") : t("toggle_off"), id: "toggle-perf-mode", checked: getPerfMode() === "efficiency", color: "orange", hintBtnId: "efficiency-mode-hint-btn", hintTextId: "efficiency-mode-hint-text" })}
        <p class="muted settings-hint-text" id="efficiency-mode-hint-text" hidden>${t("efficiency_mode_hint")}</p>
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

      ${pageOpen(pageById("p-notifications"))}
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

      ${pageOpen(pageById("p-data"))}
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

      ${pageOpen(pageById("p-about"))}
      <div class="card settings-list">
        ${settingsRow({ icon: ICON.info, label: t("about_app"), value: `${t("version")} ${APP_VERSION}`, interactive: false, color: "blue" })}
        ${settingsRow({ icon: ICON.refresh, label: t("check_for_updates"), value: `<span id="check-updates-value"></span>`, id: "row-check-updates", color: "teal" })}
        ${settingsRow({ icon: ICON.book, label: t("user_guide"), value: "PDF", id: "row-user-guide", color: "orange", hintBtnId: "user-guide-hint-btn", hintTextId: "user-guide-hint-text" })}
        <p class="muted settings-hint-text" id="user-guide-hint-text" hidden>${t("user_guide_hint").replace("{v}", GUIDE_VERSION)}</p>
      </div>
      </section>

      <div class="settings-logout-wrap" id="settings-logout-wrap">
        <button class="btn btn-block btn-danger settings-logout" id="settings-logout">${t("log_out")}</button>
      </div>
      </section>

      ${
        hasAdminWorkspace
          ? `<section id="settings-admin-panel" role="tabpanel" aria-labelledby="settings-admin-tab" hidden>

      ${
        admin
          ? `${pageOpen(pageById("a-team"))}
        <div class="card settings-list">
          ${settingsRow({ icon: ICON.team, label: t("team_management"), id: "row-team-management", color: "blue" })}
          ${settingsRow({ icon: ICON.bell, label: t("notification_defaults_title"), id: "row-notification-defaults", color: "red" })}
          ${settingsRow({ icon: ICON.chart, label: t("quick_action_visibility_title"), id: "row-quick-actions", color: "indigo" })}
        </div>
        </section>`
          : ""
      }

      ${
        pageById("a-sales")
          ? `${pageOpen(pageById("a-sales"))}
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
          admin
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
          ${settingsRow({ icon: ICON.database, label: t("sales_channel_owners_title"), id: "row-sales-channel-owners", color: "purple" })}
          ${canReassignCustomers() ? settingsRow({ icon: ICON.gps, label: t("pin_review_title"), id: "row-pin-review", color: "red" }) : ""}
          ${canManageArrival ? settingsRow({ icon: ICON.gps, label: t("arrival_section"), id: "row-delivery-arrival", color: "green" }) : ""}
        </div>`
            : canReassignCustomers() || canManageArrival
              ? `<div class="card settings-list">
          ${canReassignCustomers() ? settingsRow({ icon: ICON.gps, label: t("pin_review_title"), id: "row-pin-review", color: "red" }) : ""}
          ${canManageArrival ? settingsRow({ icon: ICON.gps, label: t("arrival_section"), id: "row-delivery-arrival", color: "green" }) : ""}
        </div>`
              : ""
        }
        </section>`
          : ""
      }

      ${
        pageById("a-finance")
          ? `${pageOpen(pageById("a-finance"))}
        ${
          admin
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
          admin
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
          canExportFinancials
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
        pageById("a-bonuses")
          ? `${pageOpen(pageById("a-bonuses"))}
        ${
          admin
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
          ${canManageChallenges ? settingsRow({ icon: ICON.bolt, label: t("bonuses_admin_challenges"), id: "row-bonus-challenges", color: "orange" }) : ""}
          ${canReviewBonusRewards ? settingsRow({ icon: ICON.chart, label: t("bonuses_reward_claims"), id: "row-bonus-reward-claims", color: "green" }) : ""}
          ${admin ? settingsRow({ icon: ICON.chart, label: t("points_closeout_title"), id: "row-points-closeout", color: "teal" }) : ""}
        </div>
        </section>`
          : ""
      }

      ${
        pageById("a-integrations")
          ? `${pageOpen(pageById("a-integrations"))}
        ${
          admin
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
        </div>`
            : ""
        }
        ${
          canManageCampaigns
            ? `<h3 class="settings-subsection-title">${t("kos_section")}</h3>
          <div class="card settings-list">
          ${canManageChallenges ? settingsRow({ icon: ICON.bolt, label: t("kos_row"), id: "row-kos-perks", color: "orange" }) : ""}
          ${settingsRow({ icon: ICON.chart, label: t("kos_campaigns_row"), id: "row-kos-campaigns", color: "teal" })}
        </div>`
            : ""
        }
        </section>`
          : ""
      }

      ${
        admin
          ? `${pageOpen(pageById("a-security"))}
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

        ${pageOpen(pageById("a-system"))}
        <div class="card settings-list">
          ${settingsRow({ icon: ICON.shield, label: t("system_health_title"), id: "row-system-health", color: "green" })}
          ${settingsRow({ icon: ICON.chart, label: t("data_quality_title"), id: "row-data-quality", color: "red" })}
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

  // "!" explanations: a small icon on the label toggles the paragraph it points to (data-hint = that paragraph's id).
  // Attached to each icon (not delegated): the icon sits inside rows that are buttons themselves, and the row's own
  // click would run first.
  root.querySelectorAll("[data-hint]").forEach((btn) => {
    const toggle = (event) => {
      event.preventDefault();
      event.stopPropagation();
      const textEl = root.querySelector(`#${btn.dataset.hint}`);
      if (!textEl) return;
      const expanded = btn.getAttribute("aria-expanded") === "true";
      btn.setAttribute("aria-expanded", String(!expanded));
      textEl.hidden = expanded;
    };
    btn.addEventListener("click", toggle);
    btn.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") toggle(event);
    });
  });

  // --- Navigation state: tab + page ---
  const view = root.querySelector(".settings-view");
  const personalPanel = root.querySelector("#settings-personal-panel");
  const adminPanel = root.querySelector("#settings-admin-panel");
  const tabsEl = root.querySelector("#settings-tabs");
  const tabButtons = { personal: root.querySelector("#settings-personal-tab"), admin: root.querySelector("#settings-admin-tab") };
  const navLists = { personal: root.querySelector("#settings-nav-personal"), admin: root.querySelector("#settings-nav-admin") };
  const resultsEl = root.querySelector("#settings-results");
  const searchInput = root.querySelector("#settings-search");
  const searchWrap = root.querySelector("#settings-search-wrap");
  const searchEmpty = root.querySelector("#settings-search-empty");
  const backBtn = root.querySelector("#settings-back");
  const titleEl = root.querySelector("#settings-title");
  const logoutWrap = root.querySelector("#settings-logout-wrap");
  const pageEls = [...root.querySelectorAll(".settings-page")];
  const wideQuery = window.matchMedia("(min-width: 1024px)");
  const TAB_KEY = "settings.tab";

  // A route like #/settings?section=a-team (or an old notification link) decides the starting point.
  const SECTION_ALIASES = { "plan-approvals": "a-sales", "system-health": "a-system" };
  const wantedPage = pageById(SECTION_ALIASES[section] || section);
  let storedTab = null;
  try {
    storedTab = sessionStorage.getItem(TAB_KEY);
  } catch {
    // private mode: start on Personal
  }
  const nav = {
    tab: wantedPage ? wantedPage.tab : hasAdminWorkspace && storedTab === "admin" ? "admin" : "personal",
    page: wantedPage ? wantedPage.id : null,
  };
  // A computer keeps the page you were on across a re-render (theme, language, avatar) and when you come back to Settings.
  if (!wantedPage && wideQuery.matches && currentNav.tab === nav.tab && pageById(currentNav.page)) nav.page = currentNav.page;
  // Opened by a route (so Back is the browser's Back) or only changed inside the view (so Back is ours).
  const routeDriven = !!wantedPage;
  const remembered = {};
  let searching = false;

  function applyState() {
    const wide = wideQuery.matches;
    if (wide && !nav.page) nav.page = remembered[nav.tab] || pagesOf(nav.tab)[0]?.id || null;
    if (nav.page) remembered[nav.tab] = nav.page;
    currentNav = nav;
    view.dataset.wide = wide ? "1" : "0";
    view.dataset.tab = nav.tab;
    const phoneAdminPage = !wide && nav.tab === "admin" && !!nav.page;
    const phoneSearching = searching && !wide;

    if (tabsEl) {
      tabsEl.hidden = phoneAdminPage;
      for (const [tab, btn] of Object.entries(tabButtons)) {
        const selected = tab === nav.tab;
        btn.classList.toggle("settings-workspace-tab-active", selected);
        btn.setAttribute("aria-selected", String(selected));
        btn.tabIndex = selected ? 0 : -1;
      }
    }
    searchWrap.hidden = phoneAdminPage;
    backBtn.hidden = !phoneAdminPage;
    const current = pageById(nav.page);
    titleEl.textContent = phoneAdminPage && current ? current.title : t("settings_title");
    root.querySelector("#settings-back-label").textContent = t("admin_workspace");

    personalPanel.hidden = nav.tab !== "personal" || phoneSearching;
    if (adminPanel) adminPanel.hidden = nav.tab !== "admin" || phoneSearching || !wide && !nav.page;
    if (navLists.personal) navLists.personal.hidden = searching || !(wide && nav.tab === "personal");
    if (navLists.admin) navLists.admin.hidden = searching || !(nav.tab === "admin" && (wide || !nav.page));
    resultsEl.hidden = !searching;
    for (const el of pageEls) {
      const pageTab = el.dataset.tab;
      const shown = pageTab === nav.tab && (pageTab === "personal" && !wide ? true : el.dataset.page === nav.page);
      el.hidden = !shown;
    }
    logoutWrap.hidden = wide && nav.page !== "p-account";
    root.querySelectorAll("[data-nav-page]").forEach((item) => item.classList.toggle("settings-list-row-active", wide && item.dataset.navPage === nav.page));
  }

  function closeDrill() {
    view.removeAttribute("data-drill");
    const pane = root.querySelector("#settings-section-pane");
    if (pane) {
      pane.hidden = true;
      pane.innerHTML = "";
    }
  }

  function go(tab, page) {
    closeDrill();
    nav.tab = tab;
    nav.page = page;
    try {
      sessionStorage.setItem(TAB_KEY, tab);
    } catch {
      // not persisted
    }
    applyState();
  }

  Object.entries(tabButtons).forEach(([tab, btn]) => {
    btn?.addEventListener("click", () => {
      if (searching) clearSearch();
      go(tab, wideQuery.matches ? remembered[tab] || null : null);
    });
    btn?.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const other = tab === "personal" ? "admin" : "personal";
      tabButtons[other].focus();
      tabButtons[other].click();
    });
  });

  root.querySelectorAll("[data-nav-page]").forEach((item) =>
    item.addEventListener("click", () => {
      const page = pageById(item.dataset.navPage);
      // Phone: a category opens as its own route, so the phone's Back / swipe returns to the list.
      if (!wideQuery.matches && page.tab === "admin" && navigateFn) navigateFn(`#/settings?section=${page.id}`);
      else go(page.tab, page.id);
    })
  );

  backBtn.addEventListener("click", () => {
    if (routeDriven && navigateFn?.goBack) navigateFn.goBack("#/settings");
    else go("admin", null);
  });

  // --- Search: one box over every page; results name the page the row lives on ---
  const labelOf = (el) => {
    const labelEl = el.querySelector(".settings-row-label, .settings-form-label, summary");
    return labelEl ? labelEl.textContent.replace(/!/g, "").replace(/\s+/g, " ").trim() : "";
  };
  const searchIndex = [];
  for (const pageEl of pageEls) {
    const page = pageById(pageEl.dataset.page);
    searchIndex.push({ page, el: pageEl, label: page.title, key: page.title.toLowerCase(), isPage: true });
    pageEl.querySelectorAll(".settings-list-row, .settings-list-group-item").forEach((el) => {
      if (el.closest(".settings-expandable-content") || el.querySelector(".settings-list-row")) return;
      const label = labelOf(el);
      if (label) searchIndex.push({ page, el, label, key: label.toLowerCase() });
    });
  }

  function clearSearch() {
    searching = false;
    searchInput.value = "";
    searchEmpty.hidden = true;
    resultsEl.innerHTML = "";
  }

  searchInput.addEventListener("input", () => {
    const q = searchInput.value.trim().toLowerCase();
    searching = !!q;
    if (!q) {
      clearSearch();
      applyState();
      return;
    }
    const hits = searchIndex.filter((entry) => entry.key.includes(q)).slice(0, 40);
    resultsEl.innerHTML = hits
      .map(
        (entry, i) => `<button type="button" class="settings-list-row settings-result" data-result="${i}">
          <span class="settings-row-icon settings-row-icon-${entry.page.color}">${entry.page.icon}</span>
          <span class="settings-row-label">${escapeHtml(entry.label)}${entry.isPage ? "" : `<small class="settings-result-page">${escapeHtml(entry.page.title)}</small>`}</span>
          <span class="settings-row-chevron">${ICON.chevron}</span>
        </button>`
      )
      .join("");
    resultsEl.querySelectorAll("[data-result]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const entry = hits[Number(btn.dataset.result)];
        clearSearch();
        go(entry.page.tab, entry.page.id);
        if (!entry.isPage) {
          requestAnimationFrame(() => {
            entry.el.scrollIntoView({ block: "center" });
            entry.el.classList.add("settings-found");
            setTimeout(() => entry.el.classList.remove("settings-found"), 1600);
          });
        }
      })
    );
    searchEmpty.hidden = hits.length > 0;
    applyState();
  });
  searchInput.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && searching) {
      clearSearch();
      applyState();
    }
  });

  applyState();
  if (wantedPage?.tab === "personal") requestAnimationFrame(() => root.querySelector(`[data-page="${wantedPage.id}"]`)?.scrollIntoView({ block: "start" }));
  const onWideChange = () => {
    if (!view.isConnected) return wideQuery.removeEventListener("change", onWideChange);
    closeDrill();
    applyState();
  };
  wideQuery.addEventListener("change", onWideChange);

  // Old notification links and the Home "Excel sync" line point at a row inside a page.
  if (section === "plan-approvals" && hasAdminWorkspace) {
    requestAnimationFrame(() => root.querySelector("#plan-approvals-slot")?.scrollIntoView({ block: "start" }));
  }
  if (section === "system-health" && hasAdminWorkspace) {
    requestAnimationFrame(() => root.querySelector("#row-system-health")?.click());
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
      window.dispatchEvent(new Event("app-preferences-changed"));
      renderSettings(root, onLogout, onLanguageChange, currentPageId(), navigateFn);
    } catch (err) {
      alert(err.message);
    }
  });

  root.querySelector("#avatar-remove-btn")?.addEventListener("click", async () => {
    try {
      await api.deleteMyAvatar();
      state.user.has_avatar = false;
      window.dispatchEvent(new Event("app-preferences-changed"));
      renderSettings(root, onLogout, onLanguageChange, currentPageId(), navigateFn);
    } catch (err) {
      alert(err.message);
    }
  });

  // --- Preferences ---
  root.querySelector("#toggle-appearance").addEventListener("click", () => {
    setTheme(getTheme() === "dark" ? "light" : "dark");
    window.dispatchEvent(new Event("app-preferences-changed"));
    renderSettings(root, onLogout, onLanguageChange, currentPageId(), navigateFn);
  });
  root.querySelector("#toggle-language").addEventListener("click", () => {
    setLang(getLang() === "hy" ? "en" : "hy");
    window.dispatchEvent(new Event("app-preferences-changed"));
    onLanguageChange();
  });
  root.querySelectorAll("[data-text-size]").forEach((btn) =>
    btn.addEventListener("click", () => {
      setTextSize(btn.dataset.textSize);
      root.querySelectorAll("[data-text-size]").forEach((b) => {
        b.classList.toggle("is-on", b === btn);
        b.setAttribute("aria-checked", String(b === btn));
      });
    })
  );
  root.querySelector("#toggle-perf-mode").addEventListener("click", () => {
    setPerfMode(getPerfMode() === "efficiency" ? "performance" : "efficiency");
    window.dispatchEvent(new Event("app-preferences-changed"));
    renderSettings(root, onLogout, onLanguageChange, currentPageId(), navigateFn);
  });


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
      ? formatDateTime(new Date(lastSyncedAt).toISOString())
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
    const askKadToggle = root.querySelector("#toggle-ask-kad");
    const askKadCapForm = root.querySelector("#ask-kad-cap-form");
    const askKadCapInput = askKadCapForm.querySelector('input[name="usd"]');
    const askKadCapSuccess = root.querySelector("#ask-kad-cap-success");
    const landingToggle = root.querySelector("#toggle-landing-calc");
    const landingRateForm = root.querySelector("#landing-rate-form");
    const landingRateInput = landingRateForm.querySelector('input[name="rate"]');
    const landingRateSuccess = root.querySelector("#landing-rate-success");
    const landingRatesForm = root.querySelector("#landing-rates-form");
    const landingRatesSuccess = root.querySelector("#landing-rates-success");
    let landingRateDefaults = {};
    // A field shows its value only when it differs from the built-in one; an empty field shows the built-in value as its placeholder.
    const paintLandingRates = (rates, defaults) => {
      landingRateDefaults = defaults || {};
      for (const input of landingRatesForm.querySelectorAll("input[name]")) {
        const key = input.name;
        input.placeholder = landingRateDefaults[key] ?? "";
        input.value = rates?.[key] !== undefined && rates[key] !== landingRateDefaults[key] ? rates[key] : "";
      }
    };
    const retailToggle = root.querySelector("#toggle-retail-excel");
    const planSkipForm = root.querySelector("#plan-skip-form");
    const planSkipInput = planSkipForm.querySelector('input[name="days"]');
    const planSkipSuccess = root.querySelector("#plan-skip-success");
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

    const allowanceToggle = root.querySelector("#toggle-checkin-allowance");
    function paintAllowanceToggle(enabled) {
      allowanceToggle.setAttribute("aria-checked", String(enabled));
      radiusForm.classList.toggle("is-off", !enabled);
    }

    function paintCalcModeToggle(enabled) {
      calcModeToggle.setAttribute("aria-checked", String(enabled));
      calcModeToggleValue.textContent = enabled ? t("toggle_on") : t("toggle_off");
      calcModeHelp.textContent = enabled ? t("calculator_mode_help_on") : t("calculator_mode_help_off");
    }

    api.getSettings().then((s) => {
      radiusInput.value = s.checkin_radius_meters;
      paintAllowanceToggle(s.checkin_allowance_enabled !== false);
      frequencyInput.value = s.default_visit_frequency_days;
      planSkipInput.value = s.plan_skip_recent_visit_days ?? 4;
      incentiveInput.value = s.incentive_message || "";
      askKadToggle.setAttribute("aria-checked", String(s.ask_kad_enabled !== false));
      landingToggle.setAttribute("aria-checked", String(s.landing_calc_enabled !== false));
      landingRateInput.value = s.landing_usd_rate ?? 366;
      paintLandingRates(s.landing_rates, s.landing_rate_defaults);
      retailToggle.setAttribute("aria-checked", String(s.retail_from_excel === true));
      askKadCapInput.value = s.ask_kad_monthly_cap_usd ?? 20;
      // Write-only field (see routes/settings.js) -- never pre-filled with
      // the actual code, just a status line saying whether one is set.
      pinStatus.textContent = s.calculator_pin_is_custom ? t("calculator_pin_help_custom") : t("calculator_pin_help");
      paintCalcModeToggle(s.calculator_mode_enabled);
      if (bonusesToggle) paintBonusesToggle(s.bonuses_enabled);
    });

    // Instant save, no confirm(): switching it back is one tap.
    allowanceToggle.addEventListener("click", async () => {
      const turningOn = allowanceToggle.getAttribute("aria-checked") !== "true";
      allowanceToggle.disabled = true;
      try {
        const result = await api.updateSettings({ checkin_allowance_enabled: turningOn });
        paintAllowanceToggle(result.checkin_allowance_enabled);
      } catch (err) {
        alert(err.message);
      } finally {
        allowanceToggle.disabled = false;
      }
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

    // Instant save, like the check-in allowance switch: switching it back is one tap.
    askKadToggle.addEventListener("click", async () => {
      const turningOn = askKadToggle.getAttribute("aria-checked") !== "true";
      askKadToggle.disabled = true;
      try {
        const result = await api.updateSettings({ ask_kad_enabled: turningOn });
        askKadToggle.setAttribute("aria-checked", String(result.ask_kad_enabled));
      } catch (err) {
        alert(err.message);
      } finally {
        askKadToggle.disabled = false;
      }
    });
    // Landing cost from the pack price: the switch and the USD rate recalculate every product on the server at once.
    landingToggle.addEventListener("click", async () => {
      const turningOn = landingToggle.getAttribute("aria-checked") !== "true";
      landingToggle.disabled = true;
      try {
        const result = await api.updateSettings({ landing_calc_enabled: turningOn });
        landingToggle.setAttribute("aria-checked", String(result.landing_calc_enabled));
      } catch (err) {
        alert(err.message);
      } finally {
        landingToggle.disabled = false;
      }
    });
    landingRateForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      landingRateSuccess.hidden = true;
      const submitBtn = landingRateForm.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      try {
        await api.updateSettings({ landing_usd_rate: Number(landingRateInput.value) });
        landingRateSuccess.hidden = false;
      } catch (err) {
        alert(err.message);
      } finally {
        submitBtn.disabled = false;
      }
    });
    landingRatesForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      landingRatesSuccess.hidden = true;
      const submitBtn = landingRatesForm.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      try {
        const body = {};
        for (const input of landingRatesForm.querySelectorAll("input[name]")) body[input.name] = input.value.trim() === "" ? null : Number(input.value.replace(",", "."));
        const result = await api.updateSettings({ landing_rates: body });
        paintLandingRates(result.landing_rates, result.landing_rate_defaults);
        landingRatesSuccess.hidden = false;
      } catch (err) {
        alert(err.message);
      } finally {
        submitBtn.disabled = false;
      }
    });
    root.querySelector("#landing-rates-reset").addEventListener("click", () => {
      for (const input of landingRatesForm.querySelectorAll("input[name]")) input.value = "";
      landingRatesForm.requestSubmit();
    });
    // Retail price from Excel: the switch applies Excel's prices right away; the button lists what would change first.
    retailToggle.addEventListener("click", async () => {
      const turningOn = retailToggle.getAttribute("aria-checked") !== "true";
      retailToggle.disabled = true;
      try {
        const result = await api.updateSettings({ retail_from_excel: turningOn });
        retailToggle.setAttribute("aria-checked", String(result.retail_from_excel));
      } catch (err) {
        alert(err.message);
      } finally {
        retailToggle.disabled = false;
      }
    });
    root.querySelector("#retail-diff-btn").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        const { products } = await api.retailDifferences();
        const rows = products
          .map((p) => `<li><span>${escapeHtml([p.brand, p.name, p.unit].filter(Boolean).join(" "))}</span><b>${formatAmd(p.app_retail)} → ${formatAmd(p.excel_retail)}</b></li>`)
          .join("");
        openInfoPopup(`<h3>${t("retail_diff_title")}</h3>${rows ? `<ul class="retail-diff">${rows}</ul>` : `<p>${t("retail_diff_none")}</p>`}`);
      } catch (err) {
        alert(err.message);
      } finally {
        btn.disabled = false;
      }
    });
    askKadCapForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      askKadCapSuccess.hidden = true;
      const submitBtn = askKadCapForm.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      try {
        await api.updateSettings({ ask_kad_monthly_cap_usd: Number(askKadCapInput.value) });
        askKadCapSuccess.hidden = false;
      } finally {
        submitBtn.disabled = false;
      }
    });

    planSkipForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      planSkipSuccess.hidden = true;
      const submitBtn = planSkipForm.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      try {
        await api.updateSettings({ plan_skip_recent_visit_days: Number(planSkipInput.value) });
        planSkipSuccess.hidden = false;
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
    root.querySelector("#row-quick-actions").addEventListener("click", (e) => {
      openAdminSection(root, e.currentTarget, t("quick_action_visibility_title"), renderQuickActionVisibilitySection);
    });
    root.querySelector("#row-sales-channel-owners").addEventListener("click", (e) => {
      openAdminSection(root, e.currentTarget, t("sales_channel_owners_title"), renderSalesChannelOwnersSection);
    });
    root.querySelector("#row-data-quality").addEventListener("click", (e) => {
      openAdminSection(root, e.currentTarget, t("data_quality_title"), renderDataQualitySection);
    });
    root.querySelector("#row-system-health").addEventListener("click", (e) => {
      openAdminSection(root, e.currentTarget, t("system_health_title"), renderSystemHealthSection);
    });
    root.querySelector("#row-notification-delivery-log").addEventListener("click", (e) => {
      openAdminSection(root, e.currentTarget, t("notification_delivery_log_title"), renderNotificationDeliveryLogSection);
    });
    root.querySelector("#row-client-error-log").addEventListener("click", (e) => {
      openAdminSection(root, e.currentTarget, t("client_error_log_title"), renderClientErrorLogSection);
    });
  }

  // Pin review: admin and the director roles (canReassignCustomers), so outside the admin-only block above.
  root.querySelector("#row-pin-review")?.addEventListener("click", (e) => {
    openAdminSection(root, e.currentTarget, t("pin_review_title"), renderPinReviewSection);
  });

  if (canManageChallenges) {
    root.querySelector("#row-bonus-challenges").addEventListener("click", (e) => {
      openAdminSection(root, e.currentTarget, t("bonuses_admin_challenges"), renderBonusChallengesSection);
    });
  }
  if (canManageChallenges) {
    root.querySelector("#row-kos-perks").addEventListener("click", (e) => {
      openAdminSection(root, e.currentTarget, t("kos_row"), renderKadOsPerksSection);
    });
  }
  if (canManageArrival) {
    root.querySelector("#row-delivery-arrival").addEventListener("click", (e) => {
      openAdminSection(root, e.currentTarget, t("arrival_section"), renderDeliveryArrivalSection);
    });
  }
  if (canManageCampaigns) {
    root.querySelector("#row-kos-campaigns").addEventListener("click", (e) => {
      openAdminSection(root, e.currentTarget, t("kos_campaigns_row"), renderKadOsCampaignsSection);
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
  return `${Math.round(value).toLocaleString("en-US")} ${t("amd")}`;
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

const NOTIFICATION_TYPES = ["plan_submitted", "plan_reviewed", "order_status_changed", "order_placed", "visit_reminder", "task_assigned", "task_deadline", "task_completed", "accounting_update", "vaghinak"];

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
  const pdfUrl = `/docs/kad-motors-guide-${getLang() === "en" ? "en" : "hy"}.pdf`;
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

// Computer width (the app's single 1024px breakpoint): a row's screen (Team management, ...) opens inside the main
// column in place of the page, with a Back button named after the page -- the macOS System Settings drill-down.
// Phones open the same screen as a full-screen overlay (openAdminSectionOverlay). matchMedia is read on every click
// on purpose; a resize closes any open pane (see onWideChange in renderSettings).
function openAdminSection(root, rowEl, title, renderFn) {
  if (!window.matchMedia("(min-width: 1024px)").matches) {
    openAdminSectionOverlay(title, renderFn);
    return;
  }
  const view = root.querySelector(".settings-view");
  const pane = root.querySelector("#settings-section-pane");
  const pageTitle = rowEl.closest(".settings-page")?.dataset.title || t("settings_title");
  pane.hidden = false;
  view.dataset.drill = "1";
  pane.innerHTML = `<button type="button" class="settings-back settings-pane-back">${ICON.back}<span>${escapeHtml(pageTitle)}</span></button><h2>${escapeHtml(title)}</h2><div id="settings-section-pane-content"></div>`;
  pane.querySelector(".settings-pane-back").addEventListener("click", () => {
    view.removeAttribute("data-drill");
    pane.hidden = true;
    pane.innerHTML = "";
  });
  pane.scrollIntoView({ block: "start" });
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
      window.dispatchEvent(new Event("app-preferences-changed"));
      close();
      renderSettings(root, onLogout, onLanguageChange, currentPageId(), navigateFn);
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
