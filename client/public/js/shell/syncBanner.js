// The "N changes waiting to sync" banner over the app (moved out of app.js, docs/architecture-roadmap.md step 6).
import { getLang, t } from "../i18n.js";
import { getQueue } from "../offlineQueue.js";
import { openSyncQueueSheet } from "../syncQueueSheet.js";

export const syncBanner = document.getElementById("sync-banner");

export function renderSyncBanner() {
  const queue = getQueue();
  const pending = queue.length;
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
  const template = needsAttention ? t("sync_needs_attention_banner") : t(navigator.onLine ? "syncing_checkins" : "offline_checkins_waiting");
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
