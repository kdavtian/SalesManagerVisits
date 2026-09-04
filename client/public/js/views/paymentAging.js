import { api } from "../api.js";
import { escapeHtml, formatAmd } from "../util.js";
import { t } from "../i18n.js";

function formatDate(value) {
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export async function renderPaymentAging(root, navigate) {
  root.innerHTML = `
    <div class="detail-view">
      <div class="detail-header">
        <button class="icon-btn" id="back-btn" aria-label="${t("back")}">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
        </button>
        <div class="detail-header-title"><h1>${t("qa_payment_aging")}</h1></div>
      </div>
      <p class="form-error" id="aging-error" hidden></p>
      <div id="aging-list" class="card-list" style="margin-top:12px;"></div>
    </div>
  `;
  const container = root.querySelector(".detail-view");
  container.querySelector("#back-btn").addEventListener("click", () => navigate.goBack("#/dashboard"));
  const listEl = container.querySelector("#aging-list");
  const errorEl = container.querySelector("#aging-error");

  listEl.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
  let rows;
  try {
    rows = await api.getPaymentAging();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
    listEl.innerHTML = "";
    return;
  }

  listEl.innerHTML = rows.length
    ? rows
        .map((r) => {
          const outstanding = Number(r.total_amd) - Number(r.collected_amd);
          const overdue = r.days_past_due > 0;
          return `
        <div class="card">
          <div class="order-detail-ids">
            <span>${t("customer_id_label")}: ${escapeHtml(r.erp_customer_id || "")}</span>
            ${r.order_code ? `<span>${t("order_id_label")}: ${escapeHtml(r.order_code)}</span>` : ""}
          </div>
          <strong>${escapeHtml(r.customer_name)}</strong>
          <p class="muted">${t("payment_aging_due_date")}: ${formatDate(r.due_date)} (${r.credit_term_days} ${t("payment_aging_days_term")})</p>
          <p><strong>${formatAmd(outstanding)}</strong> ${t("payment_aging_outstanding")}</p>
          ${overdue ? `<span class="badge badge-danger">${r.days_past_due} ${t("payment_aging_days_overdue")}</span>` : `<span class="badge badge-neutral">${t("payment_aging_not_due")}</span>`}
        </div>`;
        })
        .join("")
    : `<p class="empty-state">${t("payment_aging_empty")}</p>`;
}
