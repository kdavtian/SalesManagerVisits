import { api } from "../api.js";
import { escapeHtml, formatAmd, activateDialog } from "../util.js";
import { t } from "../i18n.js";
import { state, seesFinancialExports } from "../state.js";

function formatDateTime(value) {
  return new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export async function renderCashExpenses(root, navigate) {
  root.innerHTML = `
    <div class="detail-view">
      <div class="detail-header">
        <button class="icon-btn" id="back-btn" aria-label="${t("cancel")}">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
        </button>
        <div class="detail-header-title">
          <h1>${t("cash_expenses")}</h1>
        </div>
      </div>
      <button type="button" class="btn btn-primary btn-block" id="add-expense-btn">+ ${t("add_expense")}</button>
      <div class="expenses-filters">
        <input type="search" id="expenses-search" placeholder="${t("search_expenses")}" />
        <input type="date" id="expenses-date" />
      </div>
      <p class="form-error" id="expenses-error" hidden></p>
      <div id="expenses-list" class="card-list" style="margin-top:12px;"></div>
    </div>
  `;
  const container = root.querySelector(".detail-view");
  container.querySelector("#back-btn").addEventListener("click", () => navigate("#/dashboard"));

  const listEl = container.querySelector("#expenses-list");
  const errorEl = container.querySelector("#expenses-error");
  const searchInput = container.querySelector("#expenses-search");
  const dateInput = container.querySelector("#expenses-date");

  let allExpenses = [];

  async function load() {
    listEl.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
    try {
      allExpenses = await api.listCashExpenses();
      paintFiltered();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  }

  function paintFiltered() {
    const query = searchInput.value.trim().toLowerCase();
    const date = dateInput.value;
    const filtered = allExpenses.filter((e) => {
      if (query && !e.purpose.toLowerCase().includes(query)) return false;
      if (date && e.created_at.slice(0, 10) !== date) return false;
      return true;
    });
    paint(filtered);
  }

  searchInput.addEventListener("input", paintFiltered);
  dateInput.addEventListener("change", paintFiltered);

  function paint(expenses) {
    if (!expenses.length) {
      listEl.innerHTML = `<p class="empty-state">${t("no_expenses_yet")}</p>`;
      return;
    }
    const showOwner = seesFinancialExports();
    listEl.innerHTML = expenses
      .map((e) => {
        const canModify = e.user_id === state.user.id || state.user.role === "admin";
        return `
      <button type="button" class="card expense-card${canModify ? "" : " expense-card-readonly"}" data-id="${e.id}">
        <div class="expense-card-main">
          <strong>${escapeHtml(e.purpose)}</strong>
          <span class="muted">${formatDateTime(e.created_at)}${showOwner ? ` &middot; ${escapeHtml(e.user_name)}` : ""}</span>
        </div>
        <span class="expense-card-amount">${formatAmd(Number(e.amount_amd))}</span>
      </button>`;
      })
      .join("");

    listEl.querySelectorAll(".expense-card").forEach((el) => {
      const expense = expenses.find((e) => e.id === Number(el.dataset.id));
      el.addEventListener("click", () => {
        const canModify = expense.user_id === state.user.id || state.user.role === "admin";
        if (canModify) openExpenseSheet(expense, load);
      });
    });
  }

  container.querySelector("#add-expense-btn").addEventListener("click", () => openExpenseSheet(null, load));

  await load();
}

function openExpenseSheet(expense, onDone) {
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `
    <div class="sheet">
      <h2>${expense ? t("edit_expense") : t("add_expense")}</h2>
      <form id="expense-form">
        <label>${t("amount_amd")}<input name="amount_amd" type="number" min="1" step="1" inputmode="numeric" value="${expense ? Number(expense.amount_amd) : ""}" required /></label>
        <label>${t("purpose")}<input name="purpose" type="text" value="${expense ? escapeHtml(expense.purpose) : ""}" required /></label>
        <p class="form-error" id="expense-form-error" hidden></p>
        <div class="sheet-actions">
          <button type="button" class="btn" id="cancel-expense">${t("cancel")}</button>
          <button type="submit" class="btn btn-primary">${t("save")}</button>
        </div>
      </form>
      ${expense ? `<button type="button" class="btn-link btn-link-danger" id="delete-expense-btn" style="margin-top:14px;">${t("delete_expense")}</button>` : ""}
    </div>
  `;
  document.body.appendChild(overlay);
  activateDialog(overlay);

  function close() {
    overlay.remove();
  }
  overlay.querySelector("#cancel-expense").addEventListener("click", close);
  overlay.addEventListener("click", (e) => e.target === overlay && close());

  const form = overlay.querySelector("#expense-form");
  const errorEl = overlay.querySelector("#expense-form-error");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = new FormData(form);
    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = t("saving");
    const payload = { amount_amd: Number(data.get("amount_amd")), purpose: data.get("purpose") };
    try {
      if (expense) await api.updateCashExpense(expense.id, payload);
      else await api.createCashExpense(payload);
      close();
      onDone();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
      submitBtn.disabled = false;
      submitBtn.textContent = t("save");
    }
  });

  overlay.querySelector("#delete-expense-btn")?.addEventListener("click", async () => {
    if (!confirm(t("confirm_delete_expense"))) return;
    try {
      await api.deleteCashExpense(expense.id);
      close();
      onDone();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  });
}
