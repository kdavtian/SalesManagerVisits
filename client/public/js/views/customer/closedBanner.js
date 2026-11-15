// The "Closed" note on a closed customer's card (server: customers/customerLifecycle.js, owner 2026-11-15): when, who and why, and a
// Reopen button for those who may close customers. A closed customer keeps its history and payments; it takes no new orders.
import { api } from "../../api.js";
import { escapeHtml, formatDayMonth, labelColon, showToast } from "../../util.js";
import { t } from "../../i18n.js";
import { canCloseCustomers } from "../../state.js";

export function closedBannerHtml(customer) {
  if (!customer.closed_at) return "";
  const lines = [
    `${t("customer_closed_on")}${labelColon()}${formatDayMonth(new Date(customer.closed_at), { year: true })}${customer.closed_by_name ? ` · ${escapeHtml(customer.closed_by_name)}` : ""}`,
    customer.close_reason ? `${t("customer_close_reason")}${labelColon()}${escapeHtml(customer.close_reason)}` : null,
  ].filter(Boolean);
  return `
    <div class="card cd-closed-banner" role="status">
      <div class="cd-closed-banner-head">
        <strong>${t("customer_closed_title")}</strong>
        ${canCloseCustomers() ? `<button type="button" class="btn btn-sm" id="reopen-customer-btn">${t("customer_reopen")}</button>` : ""}
      </div>
      ${lines.map((l) => `<span>• ${l}</span>`).join("")}
    </div>`;
}

export function bindClosedBanner(container, customer, reload) {
  const btn = container.querySelector("#reopen-customer-btn");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      await api.reopenCustomer(customer.id);
      showToast(t("customer_reopened"));
      reload();
    } catch (err) {
      btn.disabled = false;
      showToast(err.message);
    }
  });
}
