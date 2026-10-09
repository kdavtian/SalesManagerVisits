// "Print blank": the print-ready delivery-acceptance act for one or more
// orders (server/src/orderBlankPdf.js). A small bottom sheet asks which
// version (automatic: small orders share an A4 sheet two by two, big ones get
// a whole sheet; or always full / always half), then hands the PDF to
// saveBlob (share sheet / download -- never navigates the app to the file).
import { api } from "./api.js";
import { t } from "./i18n.js";
import { activateDialog, saveBlob, escapeHtml } from "./util.js";

const VARIANTS = [
  ["auto", "print_blank_auto", "print_blank_auto_hint"],
  ["full", "print_blank_full", "print_blank_full_hint"],
  ["half", "print_blank_half", "print_blank_half_hint"],
];

// orders: [{ id, order_code }]  (the codes only name the file)
export function openPrintBlankSheet(orders) {
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `
    <div class="sheet" role="dialog" aria-modal="true">
      <h2>${t("print_blank_title")}</h2>
      <p class="muted">${escapeHtml(t("print_blank_count").replace("{n}", orders.length))}</p>
      <div class="print-blank-options" role="radiogroup">
        ${VARIANTS.map(
          ([v, label, hint], i) => `
          <label class="print-blank-option">
            <input type="radio" name="print-blank-variant" value="${v}" ${i === 0 ? "checked" : ""} />
            <span><strong>${t(label)}</strong><span class="muted">${t(hint)}</span></span>
          </label>`
        ).join("")}
      </div>
      <p class="form-error" id="print-blank-error" hidden></p>
      <div class="sheet-actions">
        <button type="button" class="btn" data-action="cancel">${t("cancel")}</button>
        <button type="button" class="btn btn-primary" data-action="create">${t("print_blank_create")}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  activateDialog(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener("click", (e) => e.target === overlay && close());
  overlay.querySelector('[data-action="cancel"]').addEventListener("click", close);
  const errorEl = overlay.querySelector("#print-blank-error");
  const createBtn = overlay.querySelector('[data-action="create"]');
  createBtn.addEventListener("click", async () => {
    const variant = overlay.querySelector('input[name="print-blank-variant"]:checked').value;
    createBtn.disabled = true;
    errorEl.hidden = true;
    try {
      const blob = await api.buildOrderBlanks(
        orders.map((o) => o.id),
        variant === "auto" ? null : variant
      );
      const name = orders.length === 1 && orders[0].order_code ? `Order-${orders[0].order_code}.pdf` : "Order-blanks.pdf";
      close();
      await saveBlob(blob, name);
    } catch (err) {
      errorEl.textContent = err.message || t("pdf_failed");
      errorEl.hidden = false;
      createBtn.disabled = false;
    }
  });
}
