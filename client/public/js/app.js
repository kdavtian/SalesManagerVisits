import { api } from "./api.js";
import { state, setUser, isAdmin } from "./state.js";
import { getLang, t } from "./i18n.js";
import { icons } from "./icons.js";
import { renderLogin } from "./views/login.js";
import { renderMap } from "./views/map.js";
import { renderCustomers } from "./views/customers.js";
import { renderCustomerDetail } from "./views/customerDetail.js";
import { renderCustomerOrders } from "./views/customerOrders.js";
import { renderOrderCreate } from "./views/orderCreate.js";
import { renderOrders } from "./views/orders.js";
import { renderCheckin } from "./views/checkin.js";
import { renderDashboard } from "./views/dashboard.js";
import { renderActivity } from "./views/activity.js";
import { renderSettings } from "./views/settings.js";
import { renderNotifications } from "./views/notifications.js";
import { renderCashExpenses } from "./views/cashExpenses.js";
import { renderReports } from "./views/reports.js";
import { renderRoutePlans } from "./views/routePlans.js";
import { renderTeamPerformance } from "./views/teamPerformance.js";
import { flushQueue, getQueue, onQueueChange } from "./offlineQueue.js";
import { mountInstallPrompt } from "./install.js";
import { mountUpdateBanner, initServiceWorkerUpdates } from "./updateBanner.js";
import { startLocationBroadcast, stopLocationBroadcast } from "./locationBroadcast.js";
import { escapeHtml } from "./util.js";

const app = document.getElementById("app");
const navBar = document.getElementById("nav-bar");
const topBar = document.getElementById("top-bar");
const syncBanner = document.getElementById("sync-banner");
const installRoot = document.getElementById("install-root");
const updateRoot = document.getElementById("update-root");
mountUpdateBanner(updateRoot);
// Dynamic views and sheets share the same feedback classes. Assign live
// semantics as they appear so async errors/success messages are announced.
new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (!(node instanceof HTMLElement)) continue;
      const feedback = [node, ...node.querySelectorAll(".form-error, .form-success")];
      feedback.forEach((el) => el.classList.contains("form-error") ? el.setAttribute("role", "alert") : el.setAttribute("role", "status"));
    }
  }
}).observe(document.body, { childList: true, subtree: true });

let currentCleanup = null;
let currentPath = null;
let fieldErrorId = 0;
// Remembers the hash we were on right before navigating into Settings, so
// tapping the top-bar menu button a second time can act as a "close" and
// return there, instead of just re-navigating to #/settings every time.
let preSettingsHash = "#/dashboard";

// How many orders are sitting in "submitted" waiting on a director's
// confirm/reject/edit -- shown as a badge on the Orders nav icon. The
// server returns 0 for anyone who isn't a director/admin, so this is safe
// to poll unconditionally rather than gating it on the logged-in role here
// too. orders.js fires "orders-changed" on the window after a confirm/
// reject/edit so the badge updates immediately instead of waiting for the
// next poll.
let orderBadgeCount = 0;

function applyOrderBadge() {
  const el = document.getElementById("orders-nav-badge");
  if (!el) return;
  if (orderBadgeCount > 0) {
    el.textContent = orderBadgeCount > 99 ? "99+" : String(orderBadgeCount);
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

async function refreshOrderBadge() {
  if (!state.user) return;
  try {
    const { count } = await api.getOrdersPendingCount();
    orderBadgeCount = count;
  } catch {
    // Transient network/auth failure -- leave the last known count showing
    // rather than flashing the badge away.
    return;
  }
  applyOrderBadge();
}

window.addEventListener("orders-changed", refreshOrderBadge);

// Same pattern as the Orders badge above -- polled and also refreshed
// on-demand (here, whenever the Notifications page marks something read)
// so the bell badge doesn't lag behind what the user just saw.
let unreadNotificationCount = 0;

function applyNotificationBadge() {
  const el = document.getElementById("topbar-bell-badge");
  if (!el) return;
  if (unreadNotificationCount > 0) {
    el.textContent = unreadNotificationCount > 99 ? "99+" : String(unreadNotificationCount);
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

async function refreshNotificationBadge() {
  if (!state.user) return;
  try {
    const { count } = await api.getUnreadNotificationCount();
    unreadNotificationCount = count;
  } catch {
    return;
  }
  applyNotificationBadge();
}

function navigate(hash) {
  if (location.hash === hash) {
    render();
  } else {
    location.hash = hash;
  }
}

async function doLogout() {
  await api.logout();
  setUser(null);
  stopLocationBroadcast();
  location.hash = "";
  render();
}

async function render() {
  document.documentElement.lang = getLang();
  if (currentCleanup) {
    currentCleanup();
    currentCleanup = null;
  }

  if (!state.user) {
    topBar.hidden = true;
    navBar.hidden = true;
    renderLogin(app, async () => {
      location.hash = "#/dashboard";
      startLocationBroadcast();
      render();
      refreshOrderBadge();
      refreshNotificationBadge();
    });
    return;
  }

  topBar.hidden = false;
  navBar.hidden = false;
  renderNav();
  mountInstallPrompt(installRoot);

  const hash = location.hash || "#/dashboard";
  const [path, queryString] = hash.split("?");
  if (path !== currentPath) {
    currentPath = path;
    requestAnimationFrame(() => app.focus({ preventScroll: true }));
  }
  const query = new URLSearchParams(queryString || "");
  const customerMatch = path.match(/^#\/customers\/(\d+)$/);
  const customerOrdersMatch = path.match(/^#\/customers\/(\d+)\/orders$/);
  const checkinMatch = path.match(/^#\/checkin\/(\d+)$/);
  const orderCreateMatch = path.match(/^#\/orders\/new\/(\d+)$/);

  if (path === "#/dashboard") {
    renderDashboard(app, navigate);
  } else if (path === "#/activity") {
    renderActivity(app, navigate);
  } else if (path === "#/map") {
    currentCleanup = renderMap(app, navigate, query.get("relocate"), query.get("add") === "1", query.get("plan") === "1");
  } else if (path === "#/customers") {
    renderCustomers(app, navigate, query.get("visited"));
  } else if (customerOrdersMatch) {
    renderCustomerOrders(app, navigate, customerOrdersMatch[1]);
  } else if (orderCreateMatch) {
    renderOrderCreate(app, navigate, orderCreateMatch[1], query.get("checkin"));
  } else if (path === "#/orders") {
    renderOrders(app, navigate);
  } else if (path === "#/expenses") {
    renderCashExpenses(app, navigate);
  } else if (path === "#/reports") {
    renderReports(app, navigate, query.get("r"));
  } else if (path === "#/route-plans") {
    renderRoutePlans(app, navigate);
  } else if (path === "#/team-performance") {
    renderTeamPerformance(app, navigate);
  } else if (customerMatch) {
    renderCustomerDetail(app, navigate, customerMatch[1]);
  } else if (checkinMatch) {
    renderCheckin(app, navigate, checkinMatch[1]);
  } else if (path === "#/settings") {
    renderSettings(app, doLogout, render);
  } else if (path === "#/notifications") {
    renderNotifications(app, navigate, refreshNotificationBadge);
  } else {
    navigate("#/dashboard");
  }
}

function renderNav() {
  const hash = (location.hash || "#/dashboard").split("?")[0];
  const items = [
    { hash: "#/dashboard", label: t("nav_dashboard"), icon: icons.dashboard },
    { hash: "#/activity", label: t("nav_activity"), icon: icons.activity },
    { hash: "#/map", label: t("nav_map"), icon: icons.map, center: true },
    { hash: "#/customers", label: t("nav_customers"), icon: icons.customers },
    { hash: "#/orders", label: t("nav_orders"), icon: icons.cart },
  ];

  navBar.innerHTML = items
    .map((item) =>
      item.center
        ? `
      <div class="nav-item-center-wrap">
        <button class="nav-item-center ${hash === item.hash ? "nav-item-center-active" : ""}" data-hash="${item.hash}" aria-label="${item.label}" ${hash === item.hash ? 'aria-current="page"' : ""}>
          <span class="nav-icon-center">${item.icon}</span>
        </button>
        <span class="nav-item-center-label">${item.label}</span>
      </div>
    `
        : `
      <button class="nav-item ${hash === item.hash ? "nav-item-active" : ""}" data-hash="${item.hash}" aria-label="${item.label}" ${hash === item.hash ? 'aria-current="page"' : ""}>
        <span class="nav-icon">
          ${item.icon}
          ${item.hash === "#/orders" ? `<span class="nav-badge" id="orders-nav-badge" hidden></span>` : ""}
        </span>
        <span>${item.label}</span>
      </button>
    `
    )
    .join("");

  navBar.querySelectorAll("[data-hash]").forEach((el) => {
    el.addEventListener("click", () => navigate(el.dataset.hash));
  });
  applyOrderBadge();

  topBar.innerHTML = `
    <span class="topbar-brand">
      <img class="topbar-logo topbar-logo-wordmark" src="/brand/kad-wordmark.png" alt="KAD" />
      <span class="topbar-title">${t("app_name_suffix")}</span>
    </span>
    <div class="topbar-right">
      <span class="topbar-user">${escapeHtml(state.user.name)}</span>
      <button type="button" class="topbar-menu-btn" id="topbar-bell-btn" aria-label="${t("notifications_title")}" ${hash === "#/notifications" ? 'aria-current="page"' : ""}>
        ${icons.bell}
        <span class="nav-badge" id="topbar-bell-badge" hidden></span>
      </button>
      <button type="button" class="topbar-menu-btn" id="topbar-menu-btn" aria-label="${t("nav_settings")}" ${hash === "#/settings" ? 'aria-current="page"' : ""}>
        ${icons.menu}
      </button>
    </div>
  `;
  topBar.querySelector("#topbar-bell-btn").addEventListener("click", () => navigate("#/notifications"));
  topBar.querySelector("#topbar-menu-btn").addEventListener("click", () => {
    if (hash === "#/settings") {
      navigate(preSettingsHash);
    } else {
      preSettingsHash = hash;
      navigate("#/settings");
    }
  });
  applyNotificationBadge();
}

function renderSyncBanner() {
  const pending = getQueue().length;
  if (!pending) {
    syncBanner.hidden = true;
    return;
  }
  syncBanner.hidden = false;
  const template = t(navigator.onLine ? "syncing_checkins" : "offline_checkins_waiting");
  syncBanner.textContent = template
    .replace("{n}", pending)
    .replace("{s}", pending > 1 ? "s" : "");
}

onQueueChange(renderSyncBanner);
window.addEventListener("online", renderSyncBanner);
window.addEventListener("offline", renderSyncBanner);
window.addEventListener("hashchange", render);

document.addEventListener("invalid", (event) => {
  const field = event.target;
  field.setAttribute("aria-invalid", "true");
  let error = field.parentElement?.querySelector(":scope > .field-error");
  if (!error) {
    error = document.createElement("span");
    error.className = "field-error";
    error.id = `field-error-${++fieldErrorId}`;
    error.setAttribute("role", "alert");
    field.insertAdjacentElement("afterend", error);
  }
  error.textContent = field.validationMessage;
  field.setAttribute("aria-describedby", error.id);
}, true);
document.addEventListener("input", (event) => {
  if (event.target.matches("input, select, textarea") && event.target.validity?.valid) {
    const field = event.target;
    field.removeAttribute("aria-invalid");
    const error = field.parentElement?.querySelector(":scope > .field-error");
    if (error) error.remove();
    field.removeAttribute("aria-describedby");
  }
});

async function init() {
  try {
    setUser(await api.me());
    startLocationBroadcast();
  } catch {
    setUser(null);
  }
  renderSyncBanner();
  flushQueue();
  render();
  refreshOrderBadge();
  refreshNotificationBadge();
  setInterval(refreshOrderBadge, 60000);
  setInterval(refreshNotificationBadge, 60000);
}

initServiceWorkerUpdates();

init();
