// Admin > Pin review: customers whose PIN is probably wrong (not the rep's GPS) -- two or more check-ins from
// the same spot, all farther than the Check-in allowance from the pin (server/src/pinReview.js). Move the pin
// to that spot in one tap, say "pin is fine", or open the map to look first.
import { api } from "../api.js";
import { t } from "../i18n.js";
import { escapeHtml, formatDateDMY } from "../util.js";

export async function renderPinReviewSection(container) {
  container.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
  let rows;
  try {
    rows = await api.getPinReview();
  } catch (err) {
    container.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    return;
  }
  const rowHtml = (r) => `
    <div class="card pin-review-row" data-customer="${r.customer_id}">
      <button type="button" class="pin-review-main" data-open="${r.customer_id}" data-suggest="${r.suggested_lat.toFixed(6)},${r.suggested_lng.toFixed(6)}">
        <strong>${escapeHtml(r.name)}</strong>
        <span class="muted">${[r.region, r.manager_name].filter(Boolean).map(escapeHtml).join(" · ")}</span>
        <span class="pin-review-line">${t("pin_review_line").replace("{n}", String(r.points)).replace("{m}", String(r.shift_m))}
          <span class="badge ${r.confidence === "high" ? "badge-success" : "badge-warning"}">${t(`pin_review_confidence_${r.confidence}`)}</span></span>
        <span class="muted">${t("pin_review_last").replace("{d}", escapeHtml(formatDateDMY(r.last_at)))}</span>
      </button>
      <div class="pin-review-actions">
        <button type="button" class="btn btn-primary btn-sm" data-accept="${r.customer_id}">${t("pin_review_move")}</button>
        <button type="button" class="btn btn-sm" data-dismiss="${r.customer_id}">${t("pin_review_dismiss")}</button>
      </div>
      <p class="form-error" hidden></p>
    </div>`;

  container.innerHTML = `
    <p class="muted pin-review-help">${t("pin_review_help")}</p>
    <div class="card-list card-list-spaced" id="pin-review-list">${rows.map(rowHtml).join("")}</div>
    <p class="empty-state" id="pin-review-empty" ${rows.length ? "hidden" : ""}>${t("pin_review_empty")}</p>`;

  const list = container.querySelector("#pin-review-list");
  const empty = container.querySelector("#pin-review-empty");
  const drop = (id) => {
    list.querySelector(`[data-customer="${id}"]`)?.remove();
    if (!list.children.length) empty.hidden = false;
  };
  list.addEventListener("click", async (e) => {
    const open = e.target.closest("[data-open]");
    if (open) {
      document.querySelector(".guide-overlay")?.remove(); // leave the Settings section sheet
      location.hash = `#/customers/${open.dataset.open}/spots?suggest=${open.dataset.suggest}`;
      return;
    }
    const accept = e.target.closest("[data-accept]");
    const dismiss = e.target.closest("[data-dismiss]");
    const btn = accept || dismiss;
    if (!btn) return;
    const id = Number((accept || dismiss).dataset.accept || dismiss.dataset.dismiss);
    const card = btn.closest(".pin-review-row");
    const errorEl = card.querySelector(".form-error");
    card.querySelectorAll("button").forEach((b) => (b.disabled = true));
    try {
      if (accept) await api.acceptPinReview(id);
      else await api.dismissPinReview(id);
      drop(id);
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
      card.querySelectorAll("button").forEach((b) => (b.disabled = false));
    }
  });
}
