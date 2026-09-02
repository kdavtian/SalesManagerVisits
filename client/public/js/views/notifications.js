import { api } from "../api.js";
import { escapeHtml, activateDialog, formatDateTime, formatRelative } from "../util.js";
import { t } from "../i18n.js";

const PAGE_SIZE = 30;

export async function renderNotifications(root, navigate, onCountChange) {
  root.innerHTML = `
    <div class="detail-view">
      <div class="detail-header">
        <button class="icon-btn" id="back-btn" aria-label="${t("back")}">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
        </button>
        <div class="detail-header-title">
          <h1>${t("notifications_title")}</h1>
        </div>
        <div class="detail-header-actions">
          <button type="button" class="btn-link" id="mark-all-read-btn" hidden>${t("mark_all_read")}</button>
        </div>
      </div>
      <p class="form-error" id="notifications-error" hidden></p>
      <div id="notifications-list" class="card-list" style="margin-top:12px;"></div>
      <button type="button" class="btn btn-block" id="notifications-load-more" style="margin-top:12px;" hidden>${t("load_more")}</button>
    </div>
  `;
  const container = root.querySelector(".detail-view");
  container.querySelector("#back-btn").addEventListener("click", () => navigate("#/dashboard"));

  const listEl = container.querySelector("#notifications-list");
  const errorEl = container.querySelector("#notifications-error");
  const markAllBtn = container.querySelector("#mark-all-read-btn");
  const loadMoreBtn = container.querySelector("#notifications-load-more");

  let items = [];
  let offset = 0;
  let hasMore = true;

  function paint() {
    if (!items.length) {
      listEl.innerHTML = `<p class="empty-state">${t("no_notifications_yet")}</p>`;
    } else {
      listEl.innerHTML = items
        .map(
          (n) => `
        <button type="button" class="card notification-card${n.read_at ? "" : " notification-card-unread"}" data-id="${n.id}">
          <span class="notification-card-dot" aria-hidden="true"></span>
          <div class="notification-card-main">
            <strong>${escapeHtml(n.title)}</strong>
            <span class="notification-card-body muted">${escapeHtml(n.body)}</span>
            <span class="notification-card-time muted">${formatRelative(n.created_at)}</span>
          </div>
        </button>`
        )
        .join("");
    }
    listEl.querySelectorAll(".notification-card").forEach((el) => {
      const n = items.find((i) => i.id === Number(el.dataset.id));
      el.addEventListener("click", () => openNotificationSheet(n, navigate, markAsRead));
    });
    markAllBtn.hidden = !items.some((n) => !n.read_at);
    loadMoreBtn.hidden = !hasMore;
  }

  async function load(initial = false) {
    if (initial) listEl.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
    try {
      const page = await api.listNotifications({ limit: PAGE_SIZE, offset });
      hasMore = page.length === PAGE_SIZE;
      items = initial ? page : [...items, ...page];
      offset = items.length;
      paint();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  }

  async function markAsRead(n) {
    if (n.read_at) return;
    n.read_at = new Date().toISOString();
    paint();
    try {
      await api.markNotificationRead(n.id);
      // Only refresh the topbar badge once the server confirms the read --
      // calling this beforehand would race the PATCH and could re-fetch
      // the still-unread server count, leaving the badge stuck showing one
      // too many.
      onCountChange?.();
    } catch {
      // Best-effort -- if this fails the badge/list will just re-sync on
      // the next load rather than leaving the user stuck on an error.
    }
  }

  markAllBtn.addEventListener("click", async () => {
    markAllBtn.disabled = true;
    try {
      await api.markAllNotificationsRead();
      items.forEach((n) => (n.read_at = n.read_at || new Date().toISOString()));
      paint();
      onCountChange?.();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    } finally {
      markAllBtn.disabled = false;
    }
  });

  loadMoreBtn.addEventListener("click", () => load(false));

  await load(true);
}

function openNotificationSheet(notification, navigate, markAsRead) {
  markAsRead(notification);

  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `
    <div class="sheet">
      <h2>${escapeHtml(notification.title)}</h2>
      <p class="notification-sheet-time muted">${formatDateTime(notification.created_at)}</p>
      <p class="notification-sheet-body">${escapeHtml(notification.body)}</p>
      <div class="sheet-actions">
        ${notification.url ? `<button type="button" class="btn" id="notification-open-btn">${t("open")}</button>` : ""}
        <button type="button" class="btn btn-primary" id="notification-close-btn">${t("close")}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  activateDialog(overlay);

  function close() {
    overlay.remove();
  }
  overlay.addEventListener("click", (e) => e.target === overlay && close());
  overlay.querySelector("#notification-close-btn").addEventListener("click", close);
  overlay.querySelector("#notification-open-btn")?.addEventListener("click", () => {
    close();
    navigate(notification.url.replace(/^\/?#?/, "#"));
  });
}
