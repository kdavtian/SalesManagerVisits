// Manual link between an app order and its Excel order. The automatic match
// (server/src/erpAutoMatch.js) only acts on a unique customer + date + total
// twin; when the accountant changed the order in Excel it finds none and the
// order would wait for ever. This sheet lists the free Excel orders of the
// same customer (closest total first) and links the one the user taps.
import { api } from "./api.js";
import { activateDialog, escapeHtml, formatAmd, formatDateDMY } from "./util.js";
import { t } from "./i18n.js";

export function openErpLinkSheet(order) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "sheet-overlay";
    overlay.innerHTML = `
      <div class="sheet erp-link-sheet" role="dialog" aria-modal="true">
        <h2>${t("erp_link_title")}</h2>
        <p class="muted">${t("erp_link_hint")}</p><p><strong>${formatAmd(order.total_amd)}}</p>
        <div id="erp-link-list" class="erp-link-list"><p class="muted">${t("loading")}</p></div>
        <p class="form-error" id="erp-link-error" hidden></p>
        <div class="acc-actions"><button type="button" class="btn" id="erp-link-close">${t("cancel")}</button></div>
      </div>`;
    document.body.appendChild(overlay);
    activateDialog(overlay);
    const close = (result) => {
      overlay.remove();
      resolve(result);
    };
    overlay.addEventListener("click", (e) => e.target === overlay && close(false));
    overlay.querySelector("#erp-link-close").addEventListener("click", () => close(false));
    const listEl = overlay.querySelector("#erp-link-list");
    const errorEl = overlay.querySelector("#erp-link-error");

    api
      .getErpCandidates(order.id)
      .then((rows) => {
        if (!rows.length) {
          listEl.innerHTML = `<p class="muted">${t("erp_link_none")}</p>`;
          return;
        }
        listEl.innerHTML = rows
          .map(
            (r) => `
          <button type="button" class="btn erp-link-row" data-id="${escapeHtml(String(r.erp_order_id))}" style="width:100%;min-height:44px;text-align:left;margin-bottom:8px">
            <strong>${escapeHtml(String(r.erp_order_id))}</strong> · ${formatDateDMY(r.order_date)}
            <span style="float:right">${formatAmd(r.total_amd)}${r.diff_amd ? ` <span class="muted">(${r.diff_amd > 0 ? "±" : ""}${formatAmd(r.diff_amd)})</span>` : ""}</span>
          </button>`
          )
          .join("");
        listEl.querySelectorAll(".erp-link-row").forEach((btn) =>
          btn.addEventListener("click", async () => {
            if (!confirm(`${t("erp_link_confirm")} ${btn.dataset.id}`)) return;
            listEl.querySelectorAll("button").forEach((b) => (b.disabled = true));
            try {
              await api.linkOrderToErp(order.id, btn.dataset.id);
              close(true);
            } catch (err) {
              errorEl.textContent = err.message;
              errorEl.hidden = false;
              listEl.querySelectorAll("button").forEach((b) => (b.disabled = false));
            }
          })
        );
      })
      .catch((err) => {
        listEl.innerHTML = "";
        errorEl.textContent = err.message;
        errorEl.hidden = false;
      });
  });
}
