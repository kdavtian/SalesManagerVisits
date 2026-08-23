import { api } from "../api.js";
import { escapeHtml, formatDateTime } from "../util.js";
import { t } from "../i18n.js";
import { state } from "../state.js";

export async function renderTeamSection(container) {
  container.innerHTML = `
    <div id="user-list" class="card-list"><p class="muted">…</p></div>

    <form id="new-user-form">
      <label>${t("name")}<input name="name" required /></label>
      <label>${t("email")}<input name="email" type="email" required /></label>
      <label>${t("temp_password")}<input name="password" type="password" minlength="8" required /></label>
      <label>${t("role")}
        <select name="role">
          <option value="manager">${t("manager")}</option>
          <option value="admin">${t("admin")}</option>
        </select>
      </label>
      <p class="form-error" id="new-user-error" hidden></p>
      <p class="form-success" id="new-user-success" hidden></p>
      <button type="submit" class="btn btn-primary btn-block">${t("create_account")}</button>
    </form>
  `;

  const listEl = container.querySelector("#user-list");

  async function loadUsers() {
    const users = await api.listUsers();
    listEl.innerHTML = users
      .map(
        (u) => `
        <div class="card user-row">
          <div class="user-row-top">
            <div>
              <strong>${escapeHtml(u.name)}</strong>
              <span class="muted">${escapeHtml(u.email)}</span>
            </div>
            <span class="badge ${u.role === "admin" ? "badge-accent" : "badge-neutral"}">${u.role}</span>
          </div>
          <div class="user-row-meta">
            <span class="muted">${formatDateTime(u.created_at)}</span>
            <span class="user-row-actions">
              <button class="btn-link" data-action="reset" data-id="${u.id}" data-name="${escapeHtml(u.name)}">${t("reset_password")}</button>
              ${u.id !== state.user.id ? `<button class="btn-link btn-link-danger" data-action="delete" data-id="${u.id}" data-name="${escapeHtml(u.name)}">${t("delete_user")}</button>` : ""}
            </span>
          </div>
        </div>
      `
      )
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

  const form = container.querySelector("#new-user-form");
  const errorEl = container.querySelector("#new-user-error");
  const successEl = container.querySelector("#new-user-success");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorEl.hidden = true;
    successEl.hidden = true;
    const data = new FormData(form);
    const submitBtn = form.querySelector("button");
    submitBtn.disabled = true;

    try {
      await api.createUser({
        name: data.get("name"),
        email: data.get("email"),
        password: data.get("password"),
        role: data.get("role"),
      });
      form.reset();
      successEl.textContent = t("account_created");
      successEl.hidden = false;
      loadUsers();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    } finally {
      submitBtn.disabled = false;
    }
  });

  loadUsers();
}
