// "Print blank": the print-ready delivery-acceptance act for one or more orders (server/src/orderBlankPdf.js). Always the
// automatic layout (small orders share an A4 sheet two by two, big ones get a whole sheet) -- nobody ever picked
// another one, so the sheet goes straight to building the PDF (with a progress bar) and then hands it over through the
// file-ready step (open / share / save; never navigates the app to the file).
import { api } from "./api.js";
import { t } from "./i18n.js";
import { activateDialog, escapeHtml } from "./util.js";
import { renderFileReady } from "./fileReadySheet.js";

// orders: [{ id, order_code }]  (the codes only name the file)
export function openPrintBlankSheet(orders) {
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `
    <div class="sheet" role="dialog" aria-modal="true">
      <h2>${t("print_blank_title")}</h2>
      <p class="muted">${escapeHtml(t("print_blank_count").replace("{n}", orders.length))}</p>
      <div class="print-blank-progress" id="print-blank-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
        <div class="print-blank-progress-label"><span>${t("print_blank_creating")}</span><span id="print-blank-pct">0%</span></div>
        <div class="print-blank-bar"><span id="print-blank-fill"></span></div>
      </div>
      <p class="form-error" id="print-blank-error" hidden></p>
      <div class="sheet-actions">
        <button type="button" class="btn" data-action="cancel">${t("cancel")}</button>
        <button type="button" class="btn btn-primary" data-action="retry" hidden>${t("retry")}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  activateDialog(overlay);
  let cancelled = false;
  const close = () => {
    cancelled = true;
    overlay.remove();
  };
  overlay.addEventListener("click", (e) => e.target === overlay && close());
  overlay.querySelector('[data-action="cancel"]').addEventListener("click", close);
  const errorEl = overlay.querySelector("#print-blank-error");
  const retryBtn = overlay.querySelector('[data-action="retry"]');
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
  async function build() {
    errorEl.hidden = true;
    retryBtn.hidden = true;
    const stop = startProgress();
    try {
      const blob = await api.buildOrderBlanks(orders.map((o) => o.id), null);
      stop();
      if (cancelled) return;
      setProgress(100);
      await new Promise((r) => setTimeout(r, 250));
      if (cancelled) return;
      const name = orders.length === 1 && orders[0].order_code ? `Order-${orders[0].order_code}.pdf` : "Order-blanks.pdf";
      renderFileReady(overlay.querySelector(".sheet"), blob, name, close);
    } catch (err) {
      stop();
      if (cancelled) return;
      progressEl.hidden = true;
      errorEl.textContent = err.message || t("pdf_failed");
      errorEl.hidden = false;
      retryBtn.hidden = false;
    }
  }
  retryBtn.addEventListener("click", build);
  build();
}
