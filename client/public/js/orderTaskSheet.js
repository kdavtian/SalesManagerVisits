// Check-in submit with an open "make an order" task and no order: instead of silently letting the
// rep leave, show the task as a bottom sheet. They either make the order (the check-in is
// submitted with the "order placed" outcome) or close the task with a one-tap reason.
// Resolves to { action: "order" } | { action: "skip", reason } | null (cancelled).
import { activateDialog, escapeHtml } from "./util.js";
import { t } from "./i18n.js";

export const NO_ORDER_REASONS = ["stock_full", "no_money", "closed", "other"];

export function openOrderTaskSheet(tasks) {
  return new Promise((resolve) => {
    let reason = null;
    const overlay = document.createElement("div");
    overlay.className = "sheet-overlay";
    overlay.innerHTML = `
      <div class="sheet" role="dialog" aria-modal="true">
        <h2>${t("order_task_sheet_title")}</h2>
        <p class="muted">${tasks.map((task) => escapeHtml(task.title)).join("<br>")}</p>
        <button type="button" class="btn btn-primary btn-block" id="order-task-make" style="min-height:44px">${t("order_task_make_order")}</button>
        <p class="muted" style="margin:16px 0 8px">${t("order_task_or_reason")}</p>
        <div role="group" style="display:flex;flex-wrap:wrap;gap:8px">
          ${NO_ORDER_REASONS.map((r) => `<button type="button" class="btn" data-reason="${r}" aria-pressed="false" style="min-height:44px">${t(`order_task_reason_${r}`)}</button>`).join("")}
        </div>
        <div class="sheet-actions" style="margin-top:16px">
          <button type="button" class="btn" id="order-task-cancel">${t("cancel")}</button>
          <button type="button" class="btn" id="order-task-skip" disabled>${t("order_task_skip")}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    activateDialog(overlay);
    const close = (result) => {
      overlay.remove();
      resolve(result);
    };
    overlay.addEventListener("click", (e) => e.target === overlay && close(null));
    overlay.querySelector("#order-task-cancel").addEventListener("click", () => close(null));
    overlay.querySelector("#order-task-make").addEventListener("click", () => close({ action: "order" }));
    const skip = overlay.querySelector("#order-task-skip");
    overlay.querySelectorAll("[data-reason]").forEach((btn) =>
      btn.addEventListener("click", () => {
        reason = btn.dataset.reason;
        overlay.querySelectorAll("[data-reason]").forEach((b) => {
          b.setAttribute("aria-pressed", String(b === btn));
          b.classList.toggle("btn-primary", b === btn);
        });
        skip.disabled = false;
        skip.classList.add("btn-primary");
      })
    );
    skip.addEventListener("click", () => reason && close({ action: "skip", reason }));
  });
}
