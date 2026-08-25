import { api } from "../api.js";
import { t, getLang, setLang } from "../i18n.js";
import { getTheme, setTheme } from "../theme.js";
import { state, isAdmin, canPlanForOthers, seesFinancialExports } from "../state.js";
import { renderTeamSection, renderPlanApprovalsSection, renderProductsSection, renderPointsCloseoutSection } from "./admin.js";
import { escapeHtml, compressImage, activateDialog } from "../util.js";
import { getQueue, onQueueChange, flushQueue, getLastSyncedAt } from "../offlineQueue.js";
import { getPushSubscriptionState, enablePushNotifications, disablePushNotifications } from "../pushNotifications.js";

const APP_VERSION = "1.1.0";

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
};

function settingsRow({ icon, label, value, id, interactive = true }) {
  const tag = interactive ? "button" : "div";
  return `
    <${tag} ${interactive ? 'type="button"' : ""} class="settings-list-row" ${id ? `id="${id}"` : ""}>
      <span class="settings-row-icon">${icon}</span>
      <span class="settings-row-label">${label}</span>
      ${value !== undefined ? `<span class="settings-row-value muted">${value}</span>` : ""}
      ${interactive ? `<span class="settings-row-chevron">${ICON.chevron}</span>` : ""}
    </${tag}>
  `;
}

function settingsToggleRow({ icon, label, value, id, checked }) {
  return `
    <div class="settings-list-row settings-toggle-row">
      <span class="settings-row-icon">${icon}</span>
      <span class="settings-row-label">${label}</span>
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
  const canApprovePlans = canPlanForOthers(state.user.role);
  const canExportFinancials = seesFinancialExports();
  const hasAdminWorkspace = admin || canApprovePlans || canExportFinancials;

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
        </div>
      </div>

      ${
        ["sales_manager", "sales_director", "ceo", "admin"].includes(state.user.role)
          ? `<div id="sales-performance-slot"></div>`
          : ""
      }

      <h2 class="section-title">${t("preferences")}</h2>
      <div class="card settings-list">
        ${settingsToggleRow({ icon: ICON.appearance, label: t("appearance"), value: getTheme() === "dark" ? t("dark") : t("light"), id: "toggle-appearance", checked: getTheme() === "dark" })}
        ${settingsToggleRow({ icon: ICON.language, label: t("language"), value: getLang() === "hy" ? t("armenian") : t("english"), id: "toggle-language", checked: getLang() === "hy" })}
        ${settingsToggleRow({ icon: ICON.bell, label: t("push_notifications"), value: "…", id: "toggle-push-notifications", checked: false })}
      </div>

      <h2 class="section-title">${t("notification_preferences_title")}</h2>
      <div class="card settings-list" id="notification-prefs-list">
        <p class="loading-state" role="status">${t("loading")}</p>
      </div>

      <h2 class="section-title">${t("data_sync")}</h2>
      <div class="card settings-list">
        ${settingsRow({ icon: ICON.cloud, label: t("sync_status"), value: `<span id="sync-status-value"></span>`, interactive: false })}
        ${settingsRow({ icon: ICON.clock, label: t("last_sync"), value: `<span id="last-sync-value"></span>`, interactive: false })}
        ${settingsRow({ icon: ICON.refresh, label: t("refresh_data"), id: "row-refresh" })}
        ${settingsRow({ icon: ICON.database, label: t("offline_storage"), value: `<span id="storage-value">…</span>`, interactive: false })}
      </div>

      <h2 class="section-title">${t("security")}</h2>
      <div class="card settings-list">
        ${settingsRow({ icon: ICON.lock, label: t("change_password"), id: "row-change-password" })}
        ${settingsRow({ icon: ICON.shield, label: t("session_management"), id: "row-sessions" })}
      </div>

      <h2 class="section-title">${t("about")}</h2>
      <div class="card settings-list">
        ${settingsRow({ icon: ICON.info, label: t("about_app"), value: `${t("version")} ${APP_VERSION}`, interactive: false })}
      </div>

      <button class="btn btn-block btn-danger settings-logout" id="settings-logout">${t("log_out")}</button>
      </section>

      <section id="settings-admin-panel" role="tabpanel" aria-labelledby="settings-admin-tab" hidden>

      ${
        admin
          ? `
        <h2 class="section-title">${t("admin_section")}</h2>
        <div class="card">
          <form id="radius-form">
            <label>
              <span class="settings-form-label">${ICON.gps}${t("gps_verification_settings")}</span>
              <input type="number" name="radius" min="10" max="5000" required />
            </label>
            <p class="muted radius-help">${t("checkin_radius_help")}</p>
            <p class="form-success" id="radius-success" role="status" hidden>${t("saved")}</p>
            <button type="submit" class="btn btn-primary">${t("save")}</button>
          </form>
        </div>
        <div class="card">
          <form id="visit-frequency-form">
            <label>
              <span class="settings-form-label">${ICON.calendar}${t("default_visit_frequency")}</span>
              <input type="number" name="days" min="1" max="365" required />
            </label>
            <p class="muted radius-help">${t("default_visit_frequency_help")}</p>
            <p class="form-success" id="visit-frequency-success" role="status" hidden>${t("saved")}</p>
            <button type="submit" class="btn btn-primary">${t("save")}</button>
          </form>
        </div>

        <h2 class="section-title">${t("product_catalog")}</h2>
        <div id="products-section"></div>

        <h2 class="section-title">${t("points_closeout_title")}</h2>
        <div id="points-closeout-section"></div>

        <h2 class="section-title">${t("team")}</h2>
        <div id="team-section"></div>

        <h2 class="section-title">${t("notification_defaults_title")}</h2>
        <p class="muted radius-help">${t("notification_defaults_help")}</p>
        <div id="notification-defaults-section"></div>
      `
          : ""
      }

      ${
        canApprovePlans
          ? `
        <h2 class="section-title">${t("plan_approvals")}</h2>
        <div id="plan-approvals-slot"></div>
      `
          : ""
      }

      ${
        canExportFinancials
          ? `
        <h2 class="section-title">${t("financial_exports")}</h2>
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
        </div>
      `
          : ""
      }
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
      paintAvatar();
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

  // --- Data & Sync ---
  const syncStatusValue = root.querySelector("#sync-status-value");
  const lastSyncValue = root.querySelector("#last-sync-value");
  const storageValue = root.querySelector("#storage-value");

  function paintSyncStatus() {
    const pending = getQueue().length;
    syncStatusValue.textContent = pending ? `${pending} ${t("sync_status_pending")}` : t("sync_status_synced");
    const lastSyncedAt = getLastSyncedAt();
    lastSyncValue.textContent = lastSyncedAt
      ? new Date(lastSyncedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
      : t("never_synced");
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
      await flushQueue();
      paintSyncStatus();
    } finally {
      valueLabel.textContent = originalLabel;
      row.disabled = false;
    }
  });

  if (navigator.storage?.estimate) {
    navigator.storage.estimate().then((estimate) => {
      storageValue.textContent = `${formatStorageMb(estimate.usage || 0)} ${t("storage_used")}`;
    });
  } else {
    storageValue.textContent = "—";
  }

  // --- Admin ---
  if (admin) {
    const radiusForm = root.querySelector("#radius-form");
    const radiusInput = radiusForm.querySelector('input[name="radius"]');
    const radiusSuccess = root.querySelector("#radius-success");
    const frequencyForm = root.querySelector("#visit-frequency-form");
    const frequencyInput = frequencyForm.querySelector('input[name="days"]');
    const frequencySuccess = root.querySelector("#visit-frequency-success");

    api.getSettings().then((s) => {
      radiusInput.value = s.checkin_radius_meters;
      frequencyInput.value = s.default_visit_frequency_days;
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

    renderProductsSection(root.querySelector("#products-section"));
    renderPointsCloseoutSection(root.querySelector("#points-closeout-section"));
    renderTeamSection(root.querySelector("#team-section"));
    renderNotificationDefaultsSection(root.querySelector("#notification-defaults-section"));
  }

  if (canApprovePlans) {
    renderPlanApprovalsSection(root.querySelector("#plan-approvals-slot"));
  }

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
  const wantsTeam = role === "sales_director" || role === "ceo" || role === "admin";

  let mine = null;
  let team = null;
  try {
    [mine, team] = await Promise.all([
      wantsOwn ? api.getMySalesPerformance() : Promise.resolve(null),
      wantsTeam ? api.getSalesPerformanceTeam() : Promise.resolve(null),
    ]);
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

  if (wantsTeam && team?.length) {
    sections.push(`<h2 class="section-title">${t("team_performance")}</h2>`);
    sections.push(
      `<div class="card-list">${team
        .map((r, i) => {
          const pct = Number(r.budget_amd) > 0 ? Number(r.sales_amd) / Number(r.budget_amd) : null;
          return `
        <div class="card leaderboard-row">
          <span class="leaderboard-rank">${i === 0 ? "🏆" : `#${i + 1}`}</span>
          <span class="leaderboard-name">${escapeHtml(r.rep_name)}</span>
          <span class="leaderboard-points">
            ${formatAmdShort(r.sales_amd)}
            ${pct != null ? `<span class="muted perf-pct-inline">${Math.round(pct * 100)}% ${t("of_target")}</span>` : ""}
          </span>
        </div>
      `;
        })
        .join("")}</div>`
    );
  }

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
    const p = byType.get(type) ?? { enabled: true };
    return settingsToggleRow({
      icon: ICON.bell,
      label: t(`notification_type_${type}`),
      value: p.enabled ? t("toggle_on") : t("toggle_off"),
      id: `notif-pref-${type}`,
      checked: p.enabled,
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
      } catch (err) {
        alert(err.message);
      } finally {
        toggle.disabled = false;
      }
    });
  });
}

const NOTIFICATION_ROLES = [
  "admin",
  "ceo",
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
