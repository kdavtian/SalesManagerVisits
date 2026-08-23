import { api } from "./api.js";
import { state, setUser, isAdmin } from "./state.js";
import { t } from "./i18n.js";
import { renderLogin } from "./views/login.js";
import { renderMap } from "./views/map.js";
import { renderCustomers } from "./views/customers.js";
import { renderCustomerDetail } from "./views/customerDetail.js";
import { renderCheckin } from "./views/checkin.js";
import { renderDashboard } from "./views/dashboard.js";
import { renderSettings } from "./views/settings.js";
import { renderPlan } from "./views/plan.js";
import { flushQueue, getQueue, onQueueChange } from "./offlineQueue.js";
import { mountInstallPrompt } from "./install.js";

const app = document.getElementById("app");
const navBar = document.getElementById("nav-bar");
const topBar = document.getElementById("top-bar");
const syncBanner = document.getElementById("sync-banner");
const installRoot = document.getElementById("install-root");

let currentCleanup = null;

function navigate(hash) {
  if (location.hash === hash) {
    render();
  } else {
    location.hash = hash;
  }
}

async function render() {
  if (currentCleanup) {
    currentCleanup();
    currentCleanup = null;
  }

  if (!state.user) {
    topBar.hidden = true;
    navBar.hidden = true;
    renderLogin(app, async () => {
      location.hash = "#/map";
      render();
    });
    return;
  }

  topBar.hidden = false;
  navBar.hidden = false;
  renderNav();
  mountInstallPrompt(installRoot);

  const hash = location.hash || "#/map";
  const customerMatch = hash.match(/^#\/customers\/(\d+)$/);
  const checkinMatch = hash.match(/^#\/checkin\/(\d+)$/);

  if (hash === "#/map") {
    currentCleanup = renderMap(app, navigate);
  } else if (hash === "#/customers") {
    renderCustomers(app, navigate);
  } else if (customerMatch) {
    renderCustomerDetail(app, navigate, customerMatch[1]);
  } else if (checkinMatch) {
    renderCheckin(app, navigate, checkinMatch[1]);
  } else if (hash === "#/dashboard") {
    renderDashboard(app, navigate);
  } else if (hash === "#/plan") {
    renderPlan(app);
  } else if (hash === "#/settings") {
    renderSettings(
      app,
      async () => {
        await api.logout();
        setUser(null);
        location.hash = "";
        render();
      },
      render
    );
  } else {
    navigate("#/map");
  }
}

function renderNav() {
  const hash = location.hash || "#/map";
  const items = [
    { hash: "#/dashboard", label: t("nav_activity"), icon: "📊" },
    { hash: "#/plan", label: t("nav_plan"), icon: "🗓️" },
    { hash: "#/map", label: t("nav_map"), icon: "🗺️", center: true },
    { hash: "#/customers", label: t("nav_customers"), icon: "📋" },
    { hash: "#/settings", label: t("nav_settings"), icon: "⚙️" },
  ];

  navBar.innerHTML = items
    .map((item) =>
      item.center
        ? `
      <div class="nav-item-center-wrap">
        <button class="nav-item-center ${hash === item.hash ? "nav-item-center-active" : ""}" data-hash="${item.hash}">
          <span class="nav-icon-center">${item.icon}</span>
        </button>
        <span class="nav-item-center-label">${item.label}</span>
      </div>
    `
        : `
      <button class="nav-item ${hash === item.hash ? "nav-item-active" : ""}" data-hash="${item.hash}">
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
    <span class="topbar-title">${t("app_name")}</span>
    <span class="topbar-user">${state.user.name}</span>
  `;
}

function renderSyncBanner() {
  const pending = getQueue().length;
  if (!pending) {
    syncBanner.hidden = true;
    return;
  }
  syncBanner.hidden = false;
  syncBanner.textContent = navigator.onLine
    ? `Syncing ${pending} pending check-in${pending > 1 ? "s" : ""}…`
    : `Offline — ${pending} check-in${pending > 1 ? "s" : ""} waiting to sync`;
}

onQueueChange(renderSyncBanner);
window.addEventListener("online", renderSyncBanner);
window.addEventListener("offline", renderSyncBanner);
window.addEventListener("hashchange", render);

async function init() {
  try {
    setUser(await api.me());
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
