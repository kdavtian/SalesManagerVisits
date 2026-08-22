import { api } from "./api.js";
import { state, setUser, isAdmin } from "./state.js";
import { renderLogin } from "./views/login.js";
import { renderMap } from "./views/map.js";
import { renderCustomers } from "./views/customers.js";
import { renderCustomerDetail } from "./views/customerDetail.js";
import { renderCheckin } from "./views/checkin.js";
import { renderDashboard } from "./views/dashboard.js";
import { renderAdminUsers } from "./views/admin.js";
import { flushQueue, getQueue, onQueueChange } from "./offlineQueue.js";

const app = document.getElementById("app");
const navBar = document.getElementById("nav-bar");
const topBar = document.getElementById("top-bar");
const syncBanner = document.getElementById("sync-banner");

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
  } else if (hash === "#/admin/users" && isAdmin()) {
    renderAdminUsers(app);
  } else {
    navigate("#/map");
  }
}

function renderNav() {
  const hash = location.hash || "#/map";
  const items = [
    { hash: "#/map", label: "Map", icon: "🗺️" },
    { hash: "#/customers", label: "Customers", icon: "📋" },
    { hash: "#/dashboard", label: "Activity", icon: "📊" },
  ];
  if (isAdmin()) items.push({ hash: "#/admin/users", label: "Team", icon: "⚙️" });

  navBar.innerHTML = items
    .map(
      (item) => `
      <button class="nav-item ${hash === item.hash ? "nav-item-active" : ""}" data-hash="${item.hash}">
        <span class="nav-icon">${item.icon}</span>
        <span>${item.label}</span>
      </button>
    `
    )
    .join("");

  navBar.querySelectorAll(".nav-item").forEach((el) => {
    el.addEventListener("click", () => navigate(el.dataset.hash));
  });

  topBar.innerHTML = `
    <span class="topbar-title">Field Visits</span>
    <span class="topbar-user">${state.user.name}</span>
    <button id="logout-btn" class="btn-link">Log out</button>
  `;
  topBar.querySelector("#logout-btn").addEventListener("click", async () => {
    await api.logout();
    setUser(null);
    location.hash = "";
    render();
  });
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

init();
