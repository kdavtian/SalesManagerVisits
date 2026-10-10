// "Waiting to send" sheet: opened by tapping the sync banner. Lists every check-in / order still in
// the offline queue (customer, when it was made, waiting or stuck and why), retries them all with
// one tap, and lets a stuck item be discarded (two taps -- the second one confirms inline, no
// dialog). Live: it repaints whenever the queue changes and closes itself when the queue is empty.
import { t } from "./i18n.js";
import { icons } from "./icons.js";
import { activateDialog, escapeHtml, formatAmd, formatDateTime } from "./util.js";
import { getQueue, onQueueChange, flushQueue, discardEntry, getLastSyncedAt } from "./offlineQueue.js";

let openSheet = null;

export function openSyncQueueSheet() {
  if (openSheet) return;
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `<div class="sheet sync-queue-sheet" role="dialog" aria-modal="true"></div>`;
  document.body.appendChild(overlay);
  activateDialog(overlay);
  openSheet = overlay;
  const sheet = overlay.querySelector(".sheet");
  let retrying = false;
  let armedDiscard = null; // entry id waiting for its confirming second tap

  const close = () => {
    unsubscribe();
    overlay.remove();
    openSheet = null;
  };
  overlay.addEventListener("click", (e) => e.target === overlay && close());

  function itemHtml(entry) {
    const isOrder = entry.type === "order";
    const stuck = Boolean(entry.needsAttention);
    const name = entry.customerName || `#${entry.customerId}`;
    const when = entry.createdAt ? formatDateTime(new Date(entry.createdAt).toISOString()) : "";
    const status = stuck
      ? `<span class="badge badge-danger">${t("sync_item_attention")}</span>`
      : `<span class="badge badge-neutral">${t(navigator.onLine ? "sync_item_sending" : "sync_item_waiting")}</span>`;
    const detail = stuck && entry.lastError ? `<span class="sync-queue-error">${escapeHtml(entry.lastError)}</span>` : "";
    const amount = isOrder && entry.totalAmd ? ` · ${formatAmd(entry.totalAmd)}` : "";
    const discard = stuck
      ? `<button type="button" class="btn sync-queue-discard ${armedDiscard === entry.id ? "sync-queue-discard-armed" : ""}" data-discard="${escapeHtml(entry.id)}">${t(armedDiscard === entry.id ? "sync_discard_confirm" : "sync_discard")}</button>`
      : "";
    return `
      <div class="sync-queue-item ${stuck ? "sync-queue-item-stuck" : ""}">
        <span class="sync-queue-icon">${isOrder ? icons.cart : icons.pin}</span>
        <span class="sync-queue-main">
          <strong>${escapeHtml(name)}</strong>
          <span class="muted">${t(isOrder ? "sync_item_order" : "sync_item_checkin")} · ${escapeHtml(when)}${escapeHtml(amount)}</span>
          ${detail}
        </span>
        <span class="sync-queue-side">${status}${discard}</span>
      </div>`;
  }

  function paint() {
    const queue = getQueue();
    if (!queue.length) {
      close();
      return;
    }
    const last = getLastSyncedAt();
    sheet.innerHTML = `
      <button type="button" class="icon-btn sheet-close-x" data-action="close" aria-label="${t("close")}">${icons.close}</button>
      <h2>${t("sync_sheet_title")}</h2>
      <p class="muted">${t(navigator.onLine ? "sync_sheet_online_hint" : "sync_sheet_offline_hint")}${last ? ` · ${t("sync_sheet_last")} ${escapeHtml(formatDateTime(new Date(last).toISOString()))}` : ""}</p>
      <div class="sync-queue-list">${queue.map(itemHtml).join("")}</div>
      <div class="sheet-actions">
        <button type="button" class="btn" data-action="close">${t("close")}</button>
        <button type="button" class="btn btn-primary" data-action="retry" ${retrying ? "disabled" : ""}>${t(retrying ? "sync_retrying" : "sync_retry_now")}</button>
      </div>`;
    sheet.querySelectorAll('[data-action="close"]').forEach((b) => b.addEventListener("click", close));
    sheet.querySelector('[data-action="retry"]').addEventListener("click", async () => {
      retrying = true;
      paint();
      try {
        await flushQueue({ force: true });
      } finally {
        retrying = false;
        if (openSheet) paint();
      }
    });
    sheet.querySelectorAll("[data-discard]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        const id = btn.dataset.discard;
        if (armedDiscard !== id) {
          armedDiscard = id;
          paint();
          return;
        }
        armedDiscard = null;
        await discardEntry(id);
      })
    );
  }

  const unsubscribe = onQueueChange(paint);
  paint();
}
