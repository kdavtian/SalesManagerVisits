// After management confirms an order (and from the order sheet afterwards):
// offers to send it to accounting (Lily) for a waybill (Բեռնագիր, cash) or a
// tax invoice (Հաշիվ ապրանքագիր, invoice). The payment method can be
// changed right here; it decides which document is created.
import { api } from "./api.js";
import { activateDialog } from "./util.js";
import { t } from "./i18n.js";

export function accountingDocLabel(method) {
  return t(method === "cash" ? "acc_waybill" : "acc_invoice");
}

export const ACCOUNTING_STATUS_BADGE = {
  pending: "badge-neutral",
  in_progress: "badge-info",
  waybill_created: "badge-info",
  partially_created: "badge-warning",
  exported_unsigned: "badge-warning",
  signed: "badge-success",
  needs_attention: "badge-danger",
};

// Resolves true if a request was sent, false if dismissed.
// Built ONCE: switching Cash/Invoice only swaps the text and the active
// button in place -- it used to rebuild the whole sheet, which replayed the
// slide-in animation and looked like the page reloading.
export function openAccountingDocSheet(order) {
  return new Promise((resolve) => {
    let method = order.payment_method === "cash" ? "cash" : "invoice";
    const overlay = document.createElement("div");
    overlay.className = "sheet-overlay";
    overlay.innerHTML = `
      <div class="sheet acc-sheet" role="dialog" aria-modal="true">
        <h2 id="acc-title"></h2>
        <p class="acc-body" id="acc-body"></p>
        <p class="acc-method-label muted">${t("acc_payment_method")}</p>
        <div class="acc-method" role="group" aria-label="${t("acc_payment_method")}">
          <button type="button" class="acc-method-btn acc-method-cash" data-method="cash">${t("payment_method_cash")}</button>
          <button type="button" class="acc-method-btn acc-method-invoice" data-method="invoice">${t("payment_method_invoice")}</button>
        </div>
        <p class="form-error" id="acc-error" hidden></p>
        <div class="acc-actions">
          <button type="button" class="btn" id="acc-later">${t("acc_later")}</button>
          <button type="button" class="btn acc-create" id="acc-create"></button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    activateDialog(overlay);

    function close(result) {
      overlay.remove();
      resolve(result);
    }
    overlay.addEventListener("click", (e) => e.target === overlay && close(false));

    const titleEl = overlay.querySelector("#acc-title");
    const bodyEl = overlay.querySelector("#acc-body");
    const createBtn = overlay.querySelector("#acc-create");
    const errorEl = overlay.querySelector("#acc-error");

    function update() {
      const isCash = method === "cash";
      titleEl.textContent = t(isCash ? "acc_prompt_title_waybill" : "acc_prompt_title_invoice");
      bodyEl.textContent = t(isCash ? "acc_prompt_body_cash" : "acc_prompt_body_invoice");
      createBtn.textContent = t(isCash ? "acc_create_waybill" : "acc_create_invoice");
      createBtn.classList.toggle("acc-create-cash", isCash);
      createBtn.classList.toggle("acc-create-invoice", !isCash);
      overlay.querySelectorAll("[data-method]").forEach((btn) => btn.setAttribute("aria-pressed", String(btn.dataset.method === method)));
      errorEl.hidden = true;
    }
    overlay.querySelectorAll("[data-method]").forEach((btn) =>
      btn.addEventListener("click", () => {
        method = btn.dataset.method;
        update();
      })
    );
    overlay.querySelector("#acc-later").addEventListener("click", () => close(false));
    createBtn.addEventListener("click", async () => {
      createBtn.disabled = true;
      try {
        await api.requestAccountingDocument(order.id, method);
        close(true);
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.hidden = false;
        createBtn.disabled = false;
      }
    });
    update();
  });
}
