// The "N changes waiting to sync" banner over the app (moved out of app.js, docs/architecture-roadmap.md step 6).
import { getLang, t } from "../i18n.js";
import { getQueue } from "../offlineQueue.js";
import { openSyncQueueSheet } from "../syncQueueSheet.js";

export const syncBanner = document.getElementById("sync-banner");

// A screen is showing a saved copy because the internet dropped (api/core.js, "fv:offline-copy"; owner, 2026-11-07): the banner says so
// and how old the copy is, until the connection is back (or for a few minutes after the last such copy).
let offlineCopy = null; // { at: oldest copy shown, until }
const OFFLINE_NOTE_MS = 3 * 60 * 1000;
window.addEventListener("fv:offline-copy", (e) => {
  const at = Number(e.detail?.at) || Date.now();
  offlineCopy = { at: offlineCopy && offlineCopy.until > Date.now() ? Math.min(offlineCopy.at, at) : at, until: Date.now() + OFFLINE_NOTE_MS };
  renderSyncBanner();
  setTimeout(renderSyncBanner, OFFLINE_NOTE_MS + 100);
});
window.addEventListener("online", () => {
  offlineCopy = null;
});
const hhmm = (ms) => {
  const d = new Date(ms);
  const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return new Date().toDateString() === d.toDateString() ? time : `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")} ${time}`;
};

export function renderSyncBanner() {
  const queue = getQueue();
  const pending = queue.length;
  if (!pending && offlineCopy && offlineCopy.until > Date.now()) {
    syncBanner.hidden = false;
    syncBanner.onclick = null;
    syncBanner.onkeydown = null;
    syncBanner.removeAttribute("tabindex");
    syncBanner.setAttribute("role", "status");
    syncBanner.classList.remove("sync-banner-link");
    syncBanner.textContent = t("offline_copy_banner").replace("{time}", hhmm(offlineCopy.at));
    return;
  }
  if (!pending) {
    syncBanner.hidden = true;
    syncBanner.onclick = null;
    syncBanner.onkeydown = null;
    syncBanner.removeAttribute("tabindex");
    syncBanner.setAttribute("role", "status");
    syncBanner.classList.remove("sync-banner-link");
    return;
  }
  syncBanner.hidden = false;
  const needsAttention = queue.filter((e) => e.needsAttention).length;
  // Either way the banner opens the "waiting to send" sheet (what is queued, retry now, discard a
  // stuck item); stuck items keep the red button look from before.
  // only stock counts waiting (the warehouse): "check-ins" would be the wrong word
  const onlyCounts = queue.every((e) => e.type === "stock_count");
  // only payments typed in the Payments "+" sheet (release 3b): "payments", not "check-ins"
  const onlyPayments = queue.every((e) => e.type === "payment");
  const template = needsAttention
    ? t("sync_needs_attention_banner")
    : onlyCounts
      ? t(navigator.onLine ? "syncing_counts" : "offline_counts_waiting")
      : onlyPayments
        ? t(navigator.onLine ? "syncing_payments" : "offline_payments_waiting")
        : t(navigator.onLine ? "syncing_checkins" : "offline_checkins_waiting");
  const count = needsAttention || pending;
  // "{s}" is the English plural ending only; the Armenian texts have none.
  syncBanner.textContent = template.replace("{n}", count).replace("{s}", count > 1 && getLang() !== "hy" ? "s" : "");
  syncBanner.setAttribute("role", "button");
  syncBanner.setAttribute("tabindex", "0");
  syncBanner.classList.toggle("sync-banner-link", !needsAttention);
  syncBanner.onclick = openSyncQueueSheet;
  syncBanner.onkeydown = (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openSyncQueueSheet();
    }
  };
}
