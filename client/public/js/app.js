import { api } from "./api.js";
import { state, setUser, isAdmin } from "./state.js";
import { getLang, t } from "./i18n.js";
import { icons } from "./icons.js";
import { renderLogin } from "./views/login.js";
import { renderMap } from "./views/map.js";
import { renderCustomers } from "./views/customers.js";
import { renderCustomerDetail } from "./views/customerDetail.js";
import { renderCustomerOrders } from "./views/customerOrders.js";
import { renderCheckin } from "./views/checkin.js";
import { renderDashboard } from "./views/dashboard.js";
import { renderActivity } from "./views/activity.js";
import { renderSettings } from "./views/settings.js";
import { flushQueue, getQueue, onQueueChange } from "./offlineQueue.js";
import { mountInstallPrompt } from "./install.js";
import { startLocationBroadcast, stopLocationBroadcast } from "./locationBroadcast.js";
import { escapeHtml } from "./util.js";

const app = document.getElementById("app");
const navBar = document.getElementById("nav-bar");
const topBar = document.getElementById("top-bar");
const syncBanner = document.getElementById("sync-banner");
const installRoot = document.getElementById("install-root");

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

function navigate(hash) {
  if (location.hash === hash) {
    render();
  } else {
    location.hash = hash;
  }
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
  } else if (customerMatch) {
    renderCustomerDetail(app, navigate, customerMatch[1]);
  } else if (checkinMatch) {
    renderCheckin(app, navigate, checkinMatch[1]);
  } else if (path === "#/settings") {
    renderSettings(
      app,
      async () => {
        await api.logout();
        setUser(null);
        stopLocationBroadcast();
        location.hash = "";
        render();
      },
      render
    );
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
    { hash: "#/settings", label: t("nav_settings"), icon: icons.settings },
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
        <span class="nav-icon">${item.icon}</span>
        <span>${item.label}</span>
      </button>
    `
    )
    .join("");

  navBar.querySelectorAll("[data-hash]").forEach((el) => {
    el.addEventListener("click", () => navigate(el.dataset.hash));
  });

  topBar.innerHTML = `
    <span class="topbar-brand">
      <img class="topbar-logo" src="/brand/kad-k-mark.png" alt="" />
      <span class="topbar-title">${t("app_name")}</span>
    </span>
    <span class="topbar-user">${escapeHtml(state.user.name)}</span>
  `;
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
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err) => {
      console.error("Service worker registration failed:", err);
    });
  });
}

init();
