// Order return / cancellation request (owner, 2026-10-24): a delivered order -> choose what comes back (some products or all); an order that is not
// delivered yet -> cancel it. Reason, then Send; management decides (see views/returns.js).
import { api } from "./api.js";
import { t } from "./i18n.js";
import { activateDialog, escapeHtml, showToast } from "./util.js";

const REASONS = ["damaged", "wrong_product", "expired", "changed_mind", "quality", "other"];

export async function openReturnSheet(orderId, onDone) {
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `<div class="sheet rt-sheet"><p class="loading-state" role="status">${escapeHtml(t("loading"))}</p></div>`;
  document.body.appendChild(overlay);
  activateDialog(overlay);
  overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());
  const sheet = overlay.querySelector(".sheet");
  let info;
  try {
    info = await api.getReturnable(orderId);
  } catch (err) {
    sheet.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    return;
  }
  if (!info.kind) {
    sheet.innerHTML = `<p class="muted">${escapeHtml(t(info.cancelled ? "rt_already_cancelled" : "rt_not_possible"))}</p><div class="sheet-actions"><button type="button" class="btn" id="rt-close">${escapeHtml(t("done"))}</button></div>`;
    sheet.querySelector("#rt-close").addEventListener("click", () => overlay.remove());
    return;
  }
  const isReturn = info.kind === "return";
  const qty = new Map(info.items.map((i) => [i.id, 0]));
  let reason = "";
  sheet.innerHTML = `
    <h2>${escapeHtml(t(isReturn ? "rt_return_title" : "rt_cancel_title"))}</h2>
    ${isReturn ? `<button type="button" class="btn btn-block" id="rt-all">${escapeHtml(t("rt_whole_order"))}</button>` : `<p class="muted">${escapeHtml(t("rt_cancel_hint"))}</p>`}
    <div class="rt-lines">
      ${info.items
        .map(
          (i) => `<div class="rt-line" data-line="${i.id}">
            <span class="rt-line-name">${escapeHtml(i.product_name)}<small class="muted">${isReturn ? `${escapeHtml(t("rt_left"))} ${i.left}` : `× ${i.quantity}`}</small></span>
            ${isReturn ? (i.left > 0 ? `<span class="rt-step"><button type="button" class="icon-btn" data-dec aria-label="−">−</button><b data-q>0</b><button type="button" class="icon-btn" data-inc aria-label="+">+</button></span>` : `<span class="muted">${escapeHtml(t("rt_all_returned"))}</span>`) : ""}
          </div>`
        )
        .join("")}
    </div>
    <div class="pl-section-title">${escapeHtml(t("rt_reason"))}</div>
    <div class="pl-reasons" id="rt-reasons">${REASONS.map((r) => `<button type="button" class="pl-reason-chip" data-reason="${r}" aria-pressed="false">${escapeHtml(t(`rt_reason_${r}`))}</button>`).join("")}</div>
    <label class="st-field">${escapeHtml(t("rt_note"))}<input id="rt-note" maxlength="500" /></label>
    <p class="form-error" id="rt-error" hidden></p>
    <div class="sheet-actions sheet-actions-floating">
      <button type="button" class="btn" id="rt-cancel">${escapeHtml(t("cancel"))}</button>
      <button type="button" class="btn btn-primary" id="rt-send">${escapeHtml(t(isReturn ? "rt_send_return" : "rt_send_cancel"))}</button>
    </div>`;
  const paint = () => sheet.querySelectorAll("[data-line]").forEach((row) => {
    const q = qty.get(Number(row.dataset.line));
    const el = row.querySelector("[data-q]");
    if (el) el.textContent = String(q);
    row.classList.toggle("rt-line-on", q > 0);
  });
  const left = (id) => info.items.find((i) => i.id === id).left;
  sheet.querySelector(".rt-lines").addEventListener("click", (e) => {
    const row = e.target.closest("[data-line]");
    if (!row || !isReturn) return;
    const id = Number(row.dataset.line);
    if (e.target.closest("[data-inc]")) qty.set(id, Math.min(left(id), qty.get(id) + 1));
    else if (e.target.closest("[data-dec]")) qty.set(id, Math.max(0, qty.get(id) - 1));
    else return;
    paint();
  });
  sheet.querySelector("#rt-all")?.addEventListener("click", () => {
    for (const i of info.items) qty.set(i.id, i.left);
    paint();
  });
  sheet.querySelector("#rt-reasons").addEventListener("click", (e) => {
    const b = e.target.closest("[data-reason]");
    if (!b) return;
    reason = b.dataset.reason;
    sheet.querySelectorAll("#rt-reasons [data-reason]").forEach((x) => {
      x.classList.toggle("pl-reason-on", x === b);
      x.setAttribute("aria-pressed", String(x === b));
    });
  });
  sheet.querySelector("#rt-cancel").addEventListener("click", () => overlay.remove());
  const errorEl = sheet.querySelector("#rt-error");
  sheet.querySelector("#rt-send").addEventListener("click", async (e) => {
    const note = sheet.querySelector("#rt-note").value.trim();
    const lines = [...qty].filter(([, q]) => q > 0).map(([id, q]) => ({ order_item_id: id, quantity: q }));
    const problem = isReturn && !lines.length ? t("rt_choose_items") : !reason ? t("rt_choose_reason") : reason === "other" && !note ? t("rt_explain_other") : "";
    errorEl.hidden = !problem;
    errorEl.textContent = problem;
    if (problem) return;
    e.currentTarget.disabled = true;
    try {
      await api.requestReturn({ order_id: orderId, reason, note, ...(isReturn ? { items: lines } : {}) });
      overlay.remove();
      showToast(t("rt_sent"));
      window.dispatchEvent(new Event("orders-changed"));
      onDone?.();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
      e.currentTarget.disabled = false;
    }
  });
}
