import { redrawOwnSignature } from "../signaturePad.js";
import { api } from "../api.js";
import { t, getLang, setLang } from "../i18n.js";
import { readLaunchTimings } from "../launchTiming.js";
import { getTheme, setTheme } from "../theme.js";
import { getPerfMode, setPerfMode } from "../perfMode.js";
import { setTextSize } from "../textSize.js";
import { state, isAdmin, canPlanForOthers, seesFinancialExports, canManageProducts, canReassignCustomers, isPerfCeo } from "../state.js";
import { renderPlanApprovalsSection, renderEditRequestsSection, renderCompanyProfileSection } from "./admin.js";
import { renderProductsSection } from "./admin/products.js";
import { renderPinReviewSection } from "./pinReview.js";
import { renderBonusChallengesSection, renderBonusRewardClaimsSection } from "./bonusChallengesAdmin.js";
import { renderKadOsPerksSection, renderKadOsCampaignsSection } from "./kadOsAdmin.js";
import { renderDeliveryArrivalSection } from "./deliveryArrivalAdmin.js";
import { openInfoPopup, escapeHtml, compressImage, activateDialog, formatPhoneDisplay, normalizePhone, downloadFromUrl, formatDateTime } from "../util.js";
import { getQueue, onQueueChange, flushQueue, getLastSyncedAt } from "../offlineQueue.js";
import { getPushSubscriptionState, enablePushNotifications, disablePushNotifications } from "../pushNotifications.js";
import { getStatusBarTapPref, setStatusBarTapPref } from "../statusBarTap.js";
import { checkForUpdateManually } from "../updateBanner.js";
import { refreshProductCatalog } from "../productCatalog.js";
import { setMapTileCacheEnabled } from "../mapPrefs.js";
import * as settingsAdmin from "./settings/adminRows.js";
import * as settingsMarkup from "./settings/markup.js";
import { ICON, formatStorageMb } from "./settings/rows.js";
import { loadNotificationPreferences } from "./settings/notifications.js";
import { openGuideOverlay, openAdminSection, openChangePasswordSheet, loadSalesPerformance } from "./settings/sheets.js";

// Who hands over delivery-acceptance acts and so has a signature on the profile (owner, 2026-10-26).

// User guide PDFs (client/public/docs/kad-motors-guide-{hy,en}.pdf): update GUIDE_VERSION
// (and rebuild them with docs/user-guide/build.py + render.mjs) whenever a UI change is
// significant enough that the screenshots/steps in the guide would mislead a
// rep -- a new nav pattern, a changed order-creation flow, moved buttons,
// etc. A copy-fix or color tweak doesn't need a re-export.
export const GUIDE_VERSION = "1.408.0";

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
// Launch speed (launchTiming.js): the last launch on the row, the last eight in a popup.
const seconds = (ms) => (ms == null ? "-" : `${(ms / 1000).toFixed(1)} ${t("unit_s")}`);
export function launchSpeedValue() {
  const last = readLaunchTimings()[0];
  return last ? seconds(last.ready) : "-";
}
function openLaunchSpeedPopup() {
  const list = readLaunchTimings();
  const rows = list
    .map(
      (e) => `<p><strong>${escapeHtml(formatDateTime(new Date(e.at).toISOString()))}</strong> &middot; v${escapeHtml(e.v)}
        <br><span class="muted">${t("launch_white")} ${seconds(e.fp)} &middot; ${t("launch_ready")} ${seconds(e.ready)}
        <br>${t("launch_sw")} ${e.sw ? seconds(e.swStart) : t("launch_sw_off")} &middot; ${t("launch_reply")} ${seconds(e.reply)}</span></p>`
    )
    .join("");
  openInfoPopup(`<h3>${t("launch_speed")}</h3>${rows || `<p>${t("launch_none")}</p>`}<p class="muted">${t("launch_hint")}</p>`);
}

// Landing-cost rates editable in App configuration (server/src/products/landingCalc.js LANDING_RATE_FIELDS): [key, label key].
export const LANDING_RATE_GROUPS = [
  { label: "lr_freight", fields: [["tRealCastrol", "lr_brand_castrol"], ["tRealRoyal", "lr_brand_royal"], ["tRealLotos", "lr_brand_lotos"], ["tRealOther", "lr_brand_other"]] },
  { label: "lr_legal", fields: [["tLegalCastrol", "lr_brand_castrol"], ["tLegalRoyal", "lr_brand_royal"], ["tLegalLotos", "lr_brand_lotos"], ["tLegalOther", "lr_brand_other"]] },
  { label: "lr_taxes", fields: [["customs", "lr_customs"], ["eco", "lr_eco"], ["excise", "lr_excise"], ["vat", "lr_vat"], ["handling", "lr_handling"], ["otherUsd", "lr_other"]] },
];

export async function renderSettings(root, onLogout, onLanguageChange, section = null, navigate = null) {
  // The screen's variables, for its parts in other files (read and written through getters / setters, so they always see the current value).
  const ctx = {
    get admin() { return admin; },
    get root() { return root; },
    get canApprovePlans() { return canApprovePlans; },
    get canExportFinancials() { return canExportFinancials; },
    get canManageArrival() { return canManageArrival; },
    get canManageCampaigns() { return canManageCampaigns; },
    get canManageChallenges() { return canManageChallenges; },
    get canReviewBonusRewards() { return canReviewBonusRewards; },
    get hasAdminWorkspace() { return hasAdminWorkspace; },
    get navItems() { return navItems; },
    get pageById() { return pageById; },
    get pageOpen() { return pageOpen; },
  };
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
  // Mirrors server/src/shared/roles.js's canManageBonusChallenges (admin/ceo) --
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
          <span class="settings-count" data-count-for="${p.id}" hidden></span>
          <span class="settings-row-chevron">${ICON.chevron}</span>
        </button>`
      )
      .join("");

  function paintSettingsMarkup(...args) { return settingsMarkup.paintSettingsMarkup(ctx, ...args); }
  paintSettingsMarkup();

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
  // What is waiting, beside each category (and the total on the tab): plans to approve, edit requests, reward claims, a stale Excel file.
  // Fetched once per render and again when plans / edit requests change (the sidebar stays on screen while you approve on a computer).
  async function paintCounts() {
    if (!hasAdminWorkspace) return;
    try {
      const counts = await api.getAdminCounts();
      let total = 0;
      root.querySelectorAll("[data-count-for]").forEach((el) => {
        const n = Number(counts[el.dataset.countFor]) || 0;
        total += n;
        el.hidden = n === 0;
        el.textContent = n > 99 ? "99+" : String(n);
        el.closest("button")?.setAttribute("title", n ? `${n} ${t("settings_waiting")}` : "");
      });
      const tabCount = root.querySelector("#settings-admin-tab-count");
      if (tabCount) {
        tabCount.hidden = total === 0;
        tabCount.textContent = total > 99 ? "99+" : String(total);
      }
    } catch {
      // counts are a nicety: the list works without them
    }
  }
  paintCounts();
  const onCountsChanged = () => (view.isConnected ? paintCounts() : ["plans-changed", "edit-requests-changed"].forEach((ev) => window.removeEventListener(ev, onCountsChanged)));
  window.addEventListener("plans-changed", onCountsChanged);
  window.addEventListener("edit-requests-changed", onCountsChanged);

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

  // The signature that is placed silently on every delivery-acceptance act the user hands over (owner, 2026-10-26).
  root.querySelector("#signature-btn")?.addEventListener("click", async () => {
    try {
      if (await redrawOwnSignature()) renderSettings(root, onLogout, onLanguageChange, currentPageId(), navigateFn);
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
  root.querySelector("#toggle-language").addEventListener("click", async () => {
    await setLang(getLang() === "hy" ? "en" : "hy"); // loads the other language's texts first
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
  root.querySelector("#toggle-statusbar-tap")?.addEventListener("click", () => {
    setStatusBarTapPref(!getStatusBarTapPref());
    renderSettings(root, onLogout, onLanguageChange, currentPageId(), navigateFn);
  });
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

  function wireAdminRows(...args) { return settingsAdmin.wireAdminRows(ctx, ...args); }
  wireAdminRows();

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
  root.querySelector("#row-launch-speed").addEventListener("click", openLaunchSpeedPopup);

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

