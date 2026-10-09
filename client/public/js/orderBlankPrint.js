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
      <div class="print-blank-progress" id="print-blank-progress" hidden role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
        <div class="print-blank-progress-label"><span>${t("print_blank_creating")}</span><span id="print-blank-pct">0%</span></div>
        <div class="print-blank-bar"><span id="print-blank-fill"></span></div>
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
  const progressEl = overlay.querySelector("#print-blank-progress");
  const fillEl = overlay.querySelector("#print-blank-fill");
  const pctEl = overlay.querySelector("#print-blank-pct");
  const setProgress = (p) => {
    const v = Math.max(0, Math.min(100, Math.round(p)));
    fillEl.style.width = `${v}%`;
    pctEl.textContent = `${v}%`;
    progressEl.setAttribute("aria-valuenow", String(v));
  };
  // The server builds the PDF in one go, so the bar eases towards ~92% over an
  // estimate based on the number of orders and jumps to 100% when the file lands.
  function startProgress() {
    const estimateMs = 1400 + 500 * orders.length;
    const t0 = Date.now();
    progressEl.hidden = false;
    setProgress(2);
    const timer = setInterval(() => setProgress(92 * (1 - Math.exp(-(Date.now() - t0) / (estimateMs / 2.2)))), 120);
    return () => clearInterval(timer);
  }
  // The PDF is kept in the sheet so it can be opened to look at before it is
  // shared/saved (Open uses a blob URL in a new tab -- the sheet stays here, so
  // the app is never left on the file with no way back).
  function showReady(blob, name) {
    const url = URL.createObjectURL(blob);
    const sheet = overlay.querySelector(".sheet");
    sheet.innerHTML = `
      <h2>${t("file_ready")}</h2>
      <p class="muted">${escapeHtml(name)}</p>
      <div class="sheet-actions">
        <button type="button" class="btn" data-action="done">${t("close")}</button>
        <button type="button" class="btn" data-action="share">${t("file_share")}</button>
        <button type="button" class="btn btn-primary" data-action="open">${t("file_open")}</button>
      </div>`;
    const finish = () => {
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      close();
    };
    sheet.querySelector('[data-action="done"]').addEventListener("click", finish);
    sheet.querySelector('[data-action="share"]').addEventListener("click", () => saveBlob(blob, name));
    sheet.querySelector('[data-action="open"]').addEventListener("click", () => {
      if (!window.open(url, "_blank")) saveBlob(blob, name); // popup blocked
    });
  }
  createBtn.addEventListener("click", async () => {
    const variant = overlay.querySelector('input[name="print-blank-variant"]:checked').value;
    overlay.querySelectorAll("input, button").forEach((el) => (el.disabled = true));
    errorEl.hidden = true;
    const stop = startProgress();
    try {
      const blob = await api.buildOrderBlanks(
        orders.map((o) => o.id),
        variant === "auto" ? null : variant
      );
      stop();
      setProgress(100);
      await new Promise((r) => setTimeout(r, 350));
      const name = orders.length === 1 && orders[0].order_code ? `Order-${orders[0].order_code}.pdf` : "Order-blanks.pdf";
      showReady(blob, name);
    } catch (err) {
      stop();
      progressEl.hidden = true;
      overlay.querySelectorAll("input, button").forEach((el) => (el.disabled = false));
      errorEl.textContent = err.message || t("pdf_failed");
      errorEl.hidden = false;
    }
  });
}
