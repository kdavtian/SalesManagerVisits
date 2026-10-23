// Settings -> Driver arrival (admin / CEO): what the app does when the delivery driver reaches a customer of today's route.
// Off = nothing detected; One-tap Delivered = a banner with a "Delivered" button; Automatic = the orders are marked Delivered by themselves.
import { api } from "../api.js";
import { t } from "../i18n.js";
import { escapeHtml, showToast } from "../util.js";

const MODES = ["off", "suggest", "auto"];

export async function renderDeliveryArrivalSection(container) {
  container.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
  let s;
  try {
    s = await api.getArrivalSettings();
  } catch (err) {
    container.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    return;
  }

  const save = async (patch, okEl) => {
    try {
      s = await api.saveArrivalSettings(patch);
      if (okEl) {
        okEl.hidden = false;
        setTimeout(() => (okEl.hidden = true), 1500);
      }
      return true;
    } catch (err) {
      showToast(err.message);
      return false;
    }
  };

  function paint() {
    container.innerHTML = `
      <div class="card settings-list-group">
        <div class="settings-list-group-item kos-row">
          <span class="settings-row-label">${t("arrival_mode_label")} <span role="button" tabindex="0" class="settings-inline-hint-icon" id="arrival-hint-btn" aria-expanded="false" aria-controls="arrival-hint-text" aria-label="${t("more_info")}">!</span></span>
          <p class="muted settings-hint" id="arrival-hint-text" hidden>${t("arrival_hint")}</p>
          <div class="arrival-modes" role="group" aria-label="${escapeHtml(t("arrival_mode_label"))}">
            ${MODES.map((m) => `<button type="button" class="btn ${s.mode === m ? "btn-primary" : ""}" data-mode="${m}" aria-pressed="${s.mode === m}">${t(`arrival_mode_${m}`)}</button>`).join("")}
          </div>
        </div>
        <div class="settings-list-group-item kos-row" ${s.mode === "off" ? "hidden" : ""}>
          <label class="arrival-field"><span class="settings-row-label">${t("arrival_radius_label")}</span><span class="arrival-input"><input type="number" inputmode="numeric" data-key="radius_m" value="${s.radius_m}" min="20" max="500" step="10" /><span class="muted">${t("arrival_unit_m")}</span></span></label>
          <label class="arrival-field"><span class="settings-row-label">${t("arrival_dwell_label")}</span><span class="arrival-input"><input type="number" inputmode="numeric" data-key="dwell_seconds" value="${s.dwell_seconds}" min="0" max="600" step="5" /><span class="muted">${t("arrival_unit_s")}</span></span></label>
        </div>
        <p class="form-success kos-saved" id="arrival-saved" role="status" hidden>${t("saved")}</p>
      </div>`;
    const saved = container.querySelector("#arrival-saved");
    const hintBtn = container.querySelector("#arrival-hint-btn");
    const hintText = container.querySelector("#arrival-hint-text");
    const toggleHint = (e) => {
      e.stopPropagation();
      const open = hintBtn.getAttribute("aria-expanded") === "true";
      hintBtn.setAttribute("aria-expanded", String(!open));
      hintText.hidden = open;
    };
    hintBtn.addEventListener("click", toggleHint);
    hintBtn.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), toggleHint(e)));
    container.querySelectorAll("[data-mode]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        if (btn.dataset.mode === s.mode) return;
        btn.disabled = true;
        if (await save({ mode: btn.dataset.mode }, saved)) paint();
        else btn.disabled = false;
      })
    );
    container.querySelectorAll("input[data-key]").forEach((input) =>
      input.addEventListener("change", async () => {
        const ok = await save({ [input.dataset.key]: Number(input.value) }, saved);
        if (!ok) input.value = s[input.dataset.key];
      })
    );
  }
  paint();
}
