// Read-only Debt Balances viewer (item 4). Pulls from the ERP-synced
// erp_customer_data.debt_amd (see server/src/routes/debtBalances.js) --
// no write-back, no new ledger/aging workflow. A sales_manager gets a flat
// list already scoped to their own book server-side; director/admin/ceo/
// accountant additionally get a Flat/By-manager toggle and a manager
// filter, grouping the same payload client-side.
import { api } from "../api.js";
import { escapeHtml, formatAmd } from "../util.js";
import { state } from "../state.js";
import { t } from "../i18n.js";

function formatDate(value) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export async function renderDebtBalances(root, navigate) {
  const canGroup = state.user.role !== "sales_manager";
  let mode = "flat";
  let managerFilter = "";

  root.innerHTML = `
    <div class="detail-view">
      <div class="detail-header">
        <button class="icon-btn" id="back-btn" aria-label="${t("back")}">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
        </button>
        <div class="detail-header-title"><h1>${t("debt_balances_title")}</h1></div>
      </div>
      ${
        canGroup
          ? `<div class="segmented" id="debt-mode-tabs">
               <button type="button" class="chip chip-active" data-mode="flat">${t("debt_balances_flat")}</button>
               <button type="button" class="chip" data-mode="by-manager">${t("debt_balances_by_manager")}</button>
             </div>
             <label class="debt-manager-filter-wrap" id="debt-manager-filter-wrap" hidden>${t("debt_balances_manager_filter")}
               <select id="debt-manager-filter">
                 <option value="">${t("all_statuses")}</option>
               </select>
             </label>`
          : ""
      }
      <p class="form-error" id="debt-error" hidden></p>
      <div id="debt-list" class="card-list" style="margin-top:12px;"></div>
    </div>
  `;

  const container = root.querySelector(".detail-view");
  container.querySelector("#back-btn").addEventListener("click", () => navigate.goBack("#/dashboard"));
  const listEl = container.querySelector("#debt-list");
  const errorEl = container.querySelector("#debt-error");

  if (canGroup) {
    const tabsEl = container.querySelector("#debt-mode-tabs");
    const filterWrap = container.querySelector("#debt-manager-filter-wrap");
    tabsEl.querySelectorAll("[data-mode]").forEach((btn) => {
      btn.addEventListener("click", () => {
        mode = btn.dataset.mode;
        tabsEl.querySelectorAll("[data-mode]").forEach((b) => b.classList.toggle("chip-active", b.dataset.mode === mode));
        filterWrap.hidden = mode !== "by-manager";
        render();
      });
    });
    container.querySelector("#debt-manager-filter").addEventListener("change", (e) => {
      managerFilter = e.target.value;
      render();
    });
  }

  function rowHtml(r) {
    return `
      <div class="card">
        <div class="order-detail-ids">
          <span>${t("customer_id_label")}: ${escapeHtml(r.customer_id || "")}</span>
        </div>
        <strong>${escapeHtml(r.customer_name || "")}</strong>
        <p><span class="text-amount">${formatAmd(Number(r.remaining_balance))}</span></p>
        <p class="muted">${t("debt_balances_last_payment")}: ${formatDate(r.last_payment_date)}</p>
        ${canGroup && mode === "flat" ? `<p class="muted">${escapeHtml(r.assigned_manager_name || t("unassigned"))}</p>` : ""}
      </div>`;
  }

  let rows = [];

  function render() {
    let visible = rows;
    if (canGroup && mode === "by-manager" && managerFilter) {
      visible = visible.filter((r) => String(r.assigned_manager_id || "") === managerFilter);
    }
    if (!visible.length) {
      listEl.innerHTML = `<p class="empty-state">${t("debt_balances_empty")}</p>`;
      return;
    }
    if (canGroup && mode === "by-manager") {
      const groups = new Map();
      for (const r of visible) {
        const key = r.assigned_manager_id || "unassigned";
        const label = r.assigned_manager_name || t("unassigned");
        if (!groups.has(key)) groups.set(key, { label, rows: [] });
        groups.get(key).rows.push(r);
      }
      listEl.innerHTML = [...groups.values()]
        .map(
          (g) => `
        <div class="section-heading-row"><h2 class="section-title section-title-inline">${escapeHtml(g.label)}</h2></div>
        ${g.rows.map(rowHtml).join("")}
      `
        )
        .join("");
    } else {
      listEl.innerHTML = visible.map(rowHtml).join("");
    }
  }

  async function load() {
    listEl.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
    errorEl.hidden = true;
    try {
      rows = await api.getDebtBalances();
      if (canGroup) {
        const managerFilterEl = container.querySelector("#debt-manager-filter");
        const managers = new Map();
        for (const r of rows) {
          if (r.assigned_manager_id) managers.set(r.assigned_manager_id, r.assigned_manager_name);
        }
        managerFilterEl.innerHTML =
          `<option value="">${t("all_statuses")}</option>` +
          [...managers.entries()].map(([id, name]) => `<option value="${id}">${escapeHtml(name || "")}</option>`).join("");
      }
      render();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
      listEl.innerHTML = "";
    }
  }

  load();
}
