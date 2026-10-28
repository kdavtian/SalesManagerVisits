// "Payments & expenses" (owner, 2026-10-26): the Home tiles Payments and Cash expense became one tile; it opens this page with the two
// as big buttons. Roles that never had the Payments tile (warehouse, delivery) only get Cash expense.
import { t } from "../i18n.js";
import { icons } from "../icons.js";
import { state } from "../state.js";
import { seesPaymentsOnMoney } from "../shared/roles.js";
import { applyPaymentBadge } from "../badges.js";


export function renderMoney(root, navigate) {
  const showPayments = seesPaymentsOnMoney(state.user.role);
  root.innerHTML = `
    <div class="detail-view money-view">
      <div class="detail-header">
        <button class="icon-btn" id="back-btn" aria-label="${t("back")}">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
        </button>
        <div class="detail-header-title"><h1>${t("qa_money")}</h1></div>
      </div>
      <div class="money-actions">
        ${
          showPayments
            ? `<button type="button" class="money-action" id="money-payments">
                 <span class="quick-action-icon quick-action-icon-payments">${icons.payment}<span class="nav-badge count-badge" id="qa-payments-badge" hidden></span></span>
                 <span class="money-action-label">${t("qa_payments")}</span>
                 <span class="chevron" aria-hidden="true">&#8250;</span>
               </button>`
            : ""
        }
        <button type="button" class="money-action" id="money-expenses">
          <span class="quick-action-icon quick-action-icon-cash">${icons.wallet}</span>
          <span class="money-action-label">${t("qa_cash_expense")}</span>
          <span class="chevron" aria-hidden="true">&#8250;</span>
        </button>
      </div>
    </div>`;
  // Back = one step back in history (the Home screen), like every other page.
  root.querySelector("#back-btn").addEventListener("click", () => navigate.goBack("#/dashboard"));
  root.querySelector("#money-payments")?.addEventListener("click", () => navigate("#/payments"));
  root.querySelector("#money-expenses").addEventListener("click", () => navigate("#/expenses"));
  applyPaymentBadge();
}
