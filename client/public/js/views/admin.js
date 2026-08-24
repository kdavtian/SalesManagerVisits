import { api } from "../api.js";
import { activateDialog, escapeHtml, formatDateTime } from "../util.js";
import { t } from "../i18n.js";
import { state } from "../state.js";

// Real territory/channel names from the Castrol sales data (see
// work/build_sales_director_data.py's CHANNEL_ORDER in the castrol_ceo_report
// repo) -- offered as suggestions, but the field stays free text since new
// territories get added over time (e.g. "SM YVN3").
const POSITION_SUGGESTIONS = ["SM YVN", "SM Davtashen", "SM CAS", "SM Shirak", "SM B2B"];

const ROLE_BADGE = {
  admin: { key: "role_admin", cls: "badge-accent" },
  ceo: { key: "role_ceo", cls: "badge-accent" },
  sales_manager: { key: "role_sales_manager", cls: "badge-neutral" },
  sales_director: { key: "role_sales_director", cls: "badge-info" },
  warehouse_manager: { key: "role_warehouse_manager", cls: "badge-info" },
  delivery_manager: { key: "role_delivery_manager", cls: "badge-info" },
};

export async function renderTeamSection(container) {
  container.innerHTML = `
    <div id="user-list" class="card-list"><p class="loading-state" role="status">${t("loading")}</p></div>
    <div class="team-add-btn-wrap">
      <button type="button" class="btn btn-block" id="add-team-member-btn">+ ${t("add_team_member")}</button>
    </div>
  `;

  const listEl = container.querySelector("#user-list");

  async function loadUsers() {
    const users = await api.listUsers();
    listEl.innerHTML = users
      .map((u) => {
        const roleBadge = ROLE_BADGE[u.role] ?? { key: "role_sales_manager", cls: "badge-neutral" };
        return `
        <div class="card user-row">
          <div class="user-row-top">
            <div>
              <strong>${escapeHtml(u.name)}</strong>
              <span class="muted">${escapeHtml(u.email)}${u.position ? ` · ${escapeHtml(u.position)}` : ""}</span>
            </div>
            <span class="badge ${roleBadge.cls}">${t(roleBadge.key)}</span>
          </div>
          <div class="user-row-meta">
            <span class="muted">${formatDateTime(u.created_at)}</span>
            <span class="user-row-actions">
              <button class="btn-link" data-action="reset" data-id="${u.id}" data-name="${escapeHtml(u.name)}">${t("reset_password")}</button>
              ${u.id !== state.user.id ? `<button class="btn-link btn-link-danger" data-action="delete" data-id="${u.id}" data-name="${escapeHtml(u.name)}">${t("delete_user")}</button>` : ""}
            </span>
          </div>
        </div>
      `;
      })
      .join("");

    listEl.querySelectorAll('[data-action="reset"]').forEach((btn) => {
      btn.addEventListener("click", () => openResetPasswordSheet(btn.dataset.id, btn.dataset.name));
    });
    listEl.querySelectorAll('[data-action="delete"]').forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm(t("confirm_delete_user"))) return;
        await api.deleteUser(btn.dataset.id);
        loadUsers();
      });
    });
  }

  function openResetPasswordSheet(userId, userName) {
    const overlay = document.createElement("div");
    overlay.className = "sheet-overlay";
    overlay.innerHTML = `
      <div class="sheet">
        <h2>${t("reset_password")}</h2>
        <p class="muted">${escapeHtml(userName)}</p>
        <form id="reset-password-form">
          <label>${t("new_password")}<input name="password" type="password" minlength="8" required /></label>
          <p class="form-error" id="reset-password-error" hidden></p>
          <div class="sheet-actions">
            <button type="button" class="btn" id="cancel-reset">${t("cancel")}</button>
            <button type="submit" class="btn btn-primary">${t("save")}</button>
          </div>
        </form>
      </div>
    `;
    document.body.appendChild(overlay);
    activateDialog(overlay);
    overlay.querySelector("#cancel-reset").addEventListener("click", () => overlay.remove());
    overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());

    const form = overlay.querySelector("#reset-password-form");
    const errorEl = overlay.querySelector("#reset-password-error");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const password = new FormData(form).get("password");
      const submitBtn = form.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      try {
        await api.resetUserPassword(userId, password);
        overlay.remove();
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.hidden = false;
        submitBtn.disabled = false;
      }
    });
  }

  function openAddTeamMemberSheet() {
    const overlay = document.createElement("div");
    overlay.className = "sheet-overlay";
    overlay.innerHTML = `
      <div class="sheet">
        <h2>${t("add_team_member")}</h2>
        <form id="new-user-form">
          <label>${t("name")}<input name="name" required /></label>
          <label>${t("email")}<input name="email" type="email" required /></label>
          <label>${t("temp_password")}<input name="password" type="password" minlength="8" required /></label>
          <label>${t("role")}
            <select name="role" id="new-user-role">
              <option value="sales_manager">${t("role_sales_manager")}</option>
              <option value="sales_director">${t("role_sales_director")}</option>
              <option value="warehouse_manager">${t("role_warehouse_manager")}</option>
              <option value="delivery_manager">${t("role_delivery_manager")}</option>
              <option value="ceo">${t("role_ceo")}</option>
              <option value="admin">${t("role_admin")}</option>
            </select>
          </label>
          <label id="new-user-position-field">${t("position")}
            <input name="position" list="position-suggestions" placeholder="${t("position_placeholder")}" />
            <datalist id="position-suggestions">
              ${POSITION_SUGGESTIONS.map((p) => `<option value="${escapeHtml(p)}"></option>`).join("")}
            </datalist>
          </label>
          <p class="form-error" id="new-user-error" hidden></p>
          <div class="sheet-actions">
            <button type="button" class="btn" id="cancel-add-user">${t("cancel")}</button>
            <button type="submit" class="btn btn-primary">${t("create_account")}</button>
          </div>
        </form>
      </div>
    `;
    document.body.appendChild(overlay);
    activateDialog(overlay);
    overlay.querySelector("#cancel-add-user").addEventListener("click", () => overlay.remove());
    overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());

    const form = overlay.querySelector("#new-user-form");
    const errorEl = overlay.querySelector("#new-user-error");
    const roleSelect = overlay.querySelector("#new-user-role");
    const positionField = overlay.querySelector("#new-user-position-field");

    function togglePositionField() {
      positionField.hidden = roleSelect.value !== "sales_manager";
    }
    roleSelect.addEventListener("change", togglePositionField);
    togglePositionField();

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      errorEl.hidden = true;
      const data = new FormData(form);
      const submitBtn = form.querySelector('button[type="submit"]');
      submitBtn.disabled = true;

      try {
        await api.createUser({
          name: data.get("name"),
          email: data.get("email"),
          password: data.get("password"),
          role: data.get("role"),
          position: data.get("role") === "sales_manager" ? data.get("position") || null : null,
        });
        overlay.remove();
        loadUsers();
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.hidden = false;
        submitBtn.disabled = false;
      }
    });
  }

  container.querySelector("#add-team-member-btn").addEventListener("click", openAddTeamMemberSheet);

  loadUsers();
}

export async function renderPlanApprovalsSection(container) {
  container.innerHTML = `<div id="plan-approvals-section"><p class="loading-state" role="status">${t("loading")}</p></div>`;
  const section = container.querySelector("#plan-approvals-section");

  async function load() {
    const plans = await api.getPendingVisitPlans();
    if (!plans.length) {
      section.innerHTML = `<p class="muted">${t("plan_approvals_empty")}</p>`;
      return;
    }
    section.innerHTML = plans
      .map((p) => {
        const dateLabel = new Date(p.plan_date).toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
        });
        const names = p.customer_names.map(escapeHtml).join(", ") || t("no_customers_found");
        return `
        <div class="card plan-approval-row">
          <div class="pending-request-header">
            <span class="badge badge-accent">${t("review")}</span>
            <span class="muted">${escapeHtml(p.user_name)} · ${t("plan_for_date")} ${dateLabel}</span>
          </div>
          <p class="proposed-changes-label">${names}</p>
          <div class="sheet-actions">
            <button class="btn" data-action="reject" data-id="${p.id}">${t("reject")}</button>
            <button class="btn btn-primary" data-action="approve" data-id="${p.id}">${t("approve")}</button>
          </div>
        </div>
      `;
      })
      .join("");

    section.querySelectorAll("[data-action]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        btn.closest(".plan-approval-row").querySelectorAll("button").forEach((b) => (b.disabled = true));
        await api.reviewVisitPlan(btn.dataset.id, btn.dataset.action);
        load();
      });
    });
  }

  load();
}
