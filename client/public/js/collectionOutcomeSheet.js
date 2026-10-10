// When the rep closes a "Հավաքագրիր պարտքը" task they say how the visit went.
// A promised payment needs a date: no new task is created until it passes
// (server: debtCollectionTasks.js). Resolves to { outcome, promise_date, note } or null.
import { activateDialog } from "./util.js";
import { t } from "./i18n.js";

export const COLLECTION_OUTCOMES = ["paid", "partial", "promised", "no_answer", "refused"];

export function openCollectionOutcomeSheet() {
  return new Promise((resolve) => {
    let outcome = null;
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const maxDate = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
    const overlay = document.createElement("div");
    overlay.className = "sheet-overlay";
    overlay.innerHTML = `
      <div class="sheet" role="dialog" aria-modal="true">
        <h2>${t("collect_outcome_title")}</h2>
        <div id="collect-outcomes" role="group" style="display:flex;flex-direction:column;gap:8px;margin:12px 0">
          ${COLLECTION_OUTCOMES.map((o) => `<button type="button" class="btn" data-outcome="${o}" aria-pressed="false" style="min-height:44px;text-align:left">${t(`collect_outcome_${o}`)}</button>`).join("")}
        </div>
        <label id="collect-date-wrap" style="display:flex;flex-direction:column;gap:4px;margin-top:8px" hidden>${t("collect_promise_date")}
          <input type="date" id="collect-date" min="${tomorrow}" max="${maxDate}" value="${tomorrow}" style="width:100%;min-height:44px" />
        </label>
        <label style="display:flex;flex-direction:column;gap:4px;margin-top:8px">${t("task_complete_note_prompt")}<input type="text" id="collect-note" maxlength="300" style="width:100%;min-height:44px" /></label>
        <p class="form-error" id="collect-error" hidden></p>
        <div class="sheet-actions">
          <button type="button" class="btn" id="collect-cancel">${t("cancel")}</button>
          <button type="button" class="btn btn-primary" id="collect-save">${t("save")}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    activateDialog(overlay);
    const close = (result) => {
      overlay.remove();
      resolve(result);
    };
    overlay.addEventListener("click", (e) => e.target === overlay && close(null));
    overlay.querySelector("#collect-cancel").addEventListener("click", () => close(null));
    const dateWrap = overlay.querySelector("#collect-date-wrap");
    const errorEl = overlay.querySelector("#collect-error");
    overlay.querySelectorAll("[data-outcome]").forEach((btn) =>
      btn.addEventListener("click", () => {
        outcome = btn.dataset.outcome;
        overlay.querySelectorAll("[data-outcome]").forEach((b) => {
          b.setAttribute("aria-pressed", String(b === btn));
          b.classList.toggle("btn-primary", b === btn);
        });
        dateWrap.hidden = outcome !== "promised";
        errorEl.hidden = true;
      })
    );
    overlay.querySelector("#collect-save").addEventListener("click", () => {
      if (!outcome) {
        errorEl.textContent = t("collect_choose_outcome");
        errorEl.hidden = false;
        return;
      }
      const date = overlay.querySelector("#collect-date").value;
      if (outcome === "promised" && !date) {
        errorEl.textContent = t("collect_promise_date");
        errorEl.hidden = false;
        return;
      }
      close({ outcome, promise_date: outcome === "promised" ? date : undefined, note: overlay.querySelector("#collect-note").value.trim() });
    });
  });
}
