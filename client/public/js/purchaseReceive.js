// Receiving a purchase (Purchases P5, owner 2026-11-20: "Warehouse + office"): the lines of what was ordered, each with the pieces that
// really came (prefilled with the invoice's pieces: an untouched line = all came), a note, then Save -> Arrived. A difference is shown in
// red as it is typed; the server gives the accountant a task for it. Quantities only: the same sheet serves the warehouse, which sees no
// money. `purchase`: { id, supplier, invoice_no, lines: [{ id, product_name, brand, size_l, qty, received_qty }] }.
import { api } from "./api.js";
import { t } from "./i18n.js";
import { icons } from "./icons.js";
import { activateDialog, escapeHtml, groupDigits, showToast } from "./util.js";
import { parseAmount } from "./purchaseNumbers.js";

export function openReceiveSheet(purchase, { onDone } = {}) {
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  const lines = (purchase.lines ?? []).map((l) => ({ ...l, got: l.received_qty ?? l.qty }));
  overlay.innerHTML = `<div class="sheet pu-receive-sheet" role="dialog" aria-label="${escapeHtml(t("pu_receive_title"))}">
      <button type="button" class="icon-btn sheet-close-x" data-close aria-label="${t("close")}">${icons.close}</button>
      <h2>${t("pu_receive_title")}</h2>
      <p class="muted">${escapeHtml(purchase.supplier || "—")}${purchase.invoice_no ? ` · № ${escapeHtml(purchase.invoice_no)}` : ""}</p>
      <p class="muted pu-receive-hint">${t("pu_receive_hint")}</p>
      <div class="card pu-receive-lines">${lines
        .map(
          (l, i) => `<label class="pu-receive-row" data-i="${i}">
            <span class="pu-receive-name">${escapeHtml([l.brand, l.product_name].filter(Boolean).join(" "))}${l.size_l ? ` <span class="muted">· ${groupDigits(l.size_l)} L</span>` : ""}
              <small class="muted">${t("pu_of")}: ${groupDigits(l.qty)}</small></span>
            <input inputmode="decimal" data-got value="${l.got}" aria-label="${escapeHtml(`${l.product_name}: ${t("pu_received")}`)}" />
          </label>`
        )
        .join("")}</div>
      <label class="pu-field"><span>${t("pu_receive_note")}</span><input id="pu-receive-note" maxlength="1000" /></label>
      <p class="form-error" id="pu-receive-error" role="alert" hidden></p>
      <div class="sheet-actions sheet-actions-floating"><button type="button" class="btn btn-primary btn-block" id="pu-receive-save">${t("pu_receive_save")}</button></div>
    </div>`;
  document.body.appendChild(overlay);
  activateDialog(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener("click", (e) => e.target === overlay && close());
  overlay.querySelector("[data-close]").addEventListener("click", close);
  // a difference shows at once, in red
  overlay.querySelectorAll(".pu-receive-row").forEach((row) => {
    const l = lines[Number(row.dataset.i)];
    const input = row.querySelector("[data-got]");
    const paint = () => {
      const v = parseAmount(input.value);
      row.classList.toggle("pu-receive-diff", Number.isFinite(v) && Math.abs(v - l.qty) > 0.0005);
      input.setAttribute("aria-invalid", String(!(v === null || (Number.isFinite(v) && v >= 0))));
    };
    input.addEventListener("input", paint);
    input.addEventListener("focus", () => input.select());
    paint();
  });
  const err = overlay.querySelector("#pu-receive-error");
  overlay.querySelector("#pu-receive-save").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const body = { lines: [], note: overlay.querySelector("#pu-receive-note").value.trim() || null };
    for (const row of overlay.querySelectorAll(".pu-receive-row")) {
      const l = lines[Number(row.dataset.i)];
      const v = parseAmount(row.querySelector("[data-got]").value);
      if (v === null) {
        body.lines.push({ id: l.id, received_qty: l.qty });
        continue;
      }
      if (!Number.isFinite(v) || v < 0) {
        err.textContent = t("pu_err_qty");
        err.hidden = false;
        row.querySelector("[data-got]").focus();
        return;
      }
      body.lines.push({ id: l.id, received_qty: v });
    }
    btn.disabled = true;
    err.hidden = true;
    try {
      const res = await api.receivePurchase(purchase.id, body);
      close();
      showToast(res.differences?.length ? `${t("pu_difference")}: ${res.differences.length}` : t("pu_flow_arrived"));
      onDone?.(res);
    } catch (ex) {
      // changed or received meanwhile by someone else: the list is loaded again, the reason stays on screen as a toast
      if (ex.status === 409) {
        close();
        showToast(ex.message);
        onDone?.(null);
        return;
      }
      btn.disabled = false;
      err.textContent = ex.message;
      err.hidden = false;
    }
  });
}
