// Purchases > Import from Excel (owner, 2026-11-07: "I don't see the already bought products data"): the accountant picks the Castrol workbook
// (.xlsx); the server reads its Purchase_IN sheet (POST /api/purchases/import-excel) and the Excel copy on the Purchases screen is replaced
// whole -- exactly what the bot's push does, so the history shows without waiting for the bot. Nothing typed in the app changes.
import { api } from "../../api.js";
import { t } from "../../i18n.js";
import { icons } from "../../icons.js";
import { activateDialog, formatDateDMY, groupDigits, showToast } from "../../util.js";

export function openImportSheet({ onDone } = {}) {
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `
    <div class="sheet pu-import-sheet">
      <button type="button" class="icon-btn sheet-close-x" data-close aria-label="${t("close")}">${icons.close}</button>
      <h2>${t("pu_import_title")}</h2>
      <p class="muted">${t("pu_import_help")}</p>
      <label class="btn pu-file-btn"><span class="pu-icon-up" aria-hidden="true">${icons.download}</span><span id="pu-file-label">${t("pu_import_pick")}</span>
        <input type="file" id="pu-file" class="pu-file-input" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" /></label>
      <p class="form-error" id="pu-import-error" role="alert" hidden></p>
      <div class="sheet-actions">
        <button type="button" class="btn" data-close>${t("cancel")}</button>
        <button type="button" class="btn btn-primary" id="pu-import-go" disabled>${t("pu_import_go")}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  activateDialog(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener("click", (e) => e.target === overlay && close());
  overlay.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", close));
  const input = overlay.querySelector("#pu-file");
  const go = overlay.querySelector("#pu-import-go");
  const errorEl = overlay.querySelector("#pu-import-error");
  const label = overlay.querySelector("#pu-file-label");
  const say = (text) => {
    errorEl.textContent = text;
    errorEl.hidden = !text;
  };
  input.addEventListener("change", () => {
    say("");
    const file = input.files?.[0];
    label.textContent = file ? file.name : t("pu_import_pick");
    go.disabled = !file;
  });
  go.addEventListener("click", async () => {
    const file = input.files?.[0];
    if (!file) return say(t("pu_import_none_chosen"));
    say("");
    go.disabled = true;
    go.textContent = t("pu_import_reading");
    try {
      const r = await api.importPurchasesExcel(file);
      close();
      const done = t("pu_import_done")
        .replace("{rows}", groupDigits(r.rows))
        .replace("{invoices}", groupDigits(r.invoices))
        .replace("{from}", r.from ? formatDateDMY(r.from) : "—")
        .replace("{to}", r.to ? formatDateDMY(r.to) : "—");
      showToast(r.skipped ? `${done}. ${t("pu_import_skipped").replace("{n}", String(r.skipped))}` : done);
      onDone?.();
    } catch (err) {
      go.disabled = false;
      go.textContent = t("pu_import_go");
      say(err.message);
    }
  });
}
