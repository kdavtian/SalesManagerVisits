// After management confirms an order (and from the order sheet afterwards):
// offers to send it to accounting (Lily) for a waybill (Բեռնագիր, cash) or a
// tax invoice (Հաշիվ ապրանքագիր, invoice). The payment method can be
// changed right here; it decides which document is created.
import { api } from "./api.js";
import { escapeHtml, activateDialog } from "./util.js";
import { t } from "./i18n.js";

export function accountingDocLabel(method) {
  return t(method === "cash" ? "acc_waybill" : "acc_invoice");
}

export const ACCOUNTING_STATUS_BADGE = {
  pending: "badge-neutral",
  in_progress: "badge-info",
  document_created: "badge-info",
  exported_unsigned: "badge-warning",
  signed: "badge-success",
  needs_attention: "badge-danger",
};

// Resolves true if a request was sent, false if dismissed.
export function openAccountingDocSheet(order) {
  return new Promise((resolve) => {
    let method = order.payment_method === "cash" ? "cash" : "invoice";
    const overlay = document.createElement("div");
    overlay.className = "sheet-overlay";
    document.body.appendChild(overlay);
    activateDialog(overlay);

    function close(result) {
      overlay.remove();
      resolve(result);
    }
    overlay.addEventListener("click", (e) => e.target === overlay && close(false));

    function paint(errorText = "") {
      const isCash = method === "cash";
      overlay.innerHTML = `
        <div class="sheet" role="dialog" aria-modal="true">
          <h2>${t(isCash ? "acc_prompt_title_waybill" : "acc_prompt_title_invoice")}</h2>
          <p>${t(isCash ? "acc_prompt_body_cash" : "acc_prompt_body_invoice")}</p>
          <p class="muted">${t("acc_payment_method")}</p>
          <div class="segmented" role="group" aria-label="${t("acc_payment_method")}">
            <button type="button" class="chip ${isCash ? "chip-active" : ""}" data-method="cash" aria-pressed="${isCash}">${t("payment_method_cash")}</button>
            <button type="button" class="chip ${isCash ? "" : "chip-active"}" data-method="invoice" aria-pressed="${!isCash}">${t("payment_method_invoice")}</button>
          </div>
          <p class="form-error" id="acc-error" ${errorText ? "" : "hidden"}>${escapeHtml(errorText)}</p>
          <div class="sheet-actions">
            <button type="button" class="btn" id="acc-later">${t("acc_later")}</button>
            <button type="button" class="btn btn-primary" id="acc-create">${t(isCash ? "acc_create_waybill" : "acc_create_invoice")}</button>
          </div>
        </div>`;
      overlay.querySelectorAll("[data-method]").forEach((btn) =>
        btn.addEventListener("click", () => {
          method = btn.dataset.method;
          paint();
        })
      );
      overlay.querySelector("#acc-later").addEventListener("click", () => close(false));
      overlay.querySelector("#acc-create").addEventListener("click", async (e) => {
        e.currentTarget.disabled = true;
        try {
          await api.requestAccountingDocument(order.id, method);
          close(true);
        } catch (err) {
          paint(err.message);
        }
      });
    }
    paint();
  });
}
