// Home card for sales managers: "Visit first" -- the customers that most deserve the next
// visit (overdue debt, overdue visit, gone quiet), from GET /customers/visit-priorities.
import { api } from "./api.js";
import { escapeHtml, formatAmd } from "./util.js";
import { t } from "./i18n.js";

function reasonText(r) {
  if (r.type === "debt") return `${t("visit_first_debt")} ${formatAmd(r.amount)}`;
  if (r.type === "visit_overdue") return `${t("visit_first_overdue")} ${r.days} ${t("visit_first_days")}`;
  if (r.type === "never_visited") return t("visit_first_never");
  if (r.type === "dormant") return `${t("visit_first_dormant")} ${r.days} ${t("visit_first_days")}`;
  return "";
}

export async function renderVisitFirst(slot, navigate) {
  let rows;
  try {
    rows = await api.getVisitPriorities();
  } catch {
    return; // offline or not allowed: the card is optional
  }
  if (!rows.length) return;
  slot.innerHTML = `
    <div class="card" id="visit-first-card">
      <span class="progress-label">${t("visit_first_title")}</span>
      <div style="display:flex;flex-direction:column;gap:6px;margin-top:8px">
        ${rows
          .slice(0, 5)
          .map(
            (r) => `
          <button type="button" class="btn" data-customer="${r.customer_id}" style="text-align:left;min-height:44px;display:block;width:100%">
            <strong>${escapeHtml(r.name)}</strong><br>
            <span class="muted" style="font-size:0.85em">${r.reasons.map((x) => escapeHtml(reasonText(x))).filter(Boolean).join(" · ")}</span>
          </button>`
          )
          .join("")}
      </div>
    </div>`;
  slot.querySelectorAll("[data-customer]").forEach((btn) => btn.addEventListener("click", () => navigate(`#/customers/${btn.dataset.customer}`)));
}
