import { api } from "../api.js";
import { escapeHtml, formatDateTime } from "../util.js";

export async function renderAdminUsers(root) {
  root.innerHTML = `
    <div class="admin-view">
      <h1>Team</h1>
      <div id="user-list" class="card-list"><p class="muted">Loading…</p></div>

      <h2 class="section-title">Add manager</h2>
      <form id="new-user-form">
        <label>Name<input name="name" required /></label>
        <label>Email<input name="email" type="email" required /></label>
        <label>Temporary password<input name="password" type="password" minlength="8" required /></label>
        <label>Role
          <select name="role">
            <option value="manager">Manager</option>
            <option value="admin">Admin</option>
          </select>
        </label>
        <p class="form-error" id="new-user-error" hidden></p>
        <p class="form-success" id="new-user-success" hidden></p>
        <button type="submit" class="btn btn-primary btn-block">Create account</button>
      </form>
    </div>
  `;

  const listEl = root.querySelector("#user-list");

  async function loadUsers() {
    const users = await api.listUsers();
    listEl.innerHTML = users
      .map(
        (u) => `
        <div class="card user-row">
          <div>
            <strong>${escapeHtml(u.name)}</strong>
            <span class="muted">${escapeHtml(u.email)}</span>
          </div>
          <div class="user-row-meta">
            <span class="badge ${u.role === "admin" ? "badge-accent" : "badge-neutral"}">${u.role}</span>
            <span class="muted">joined ${formatDateTime(u.created_at)}</span>
          </div>
        </div>
      `
      )
      .join("");
  }

  const form = root.querySelector("#new-user-form");
  const errorEl = root.querySelector("#new-user-error");
  const successEl = root.querySelector("#new-user-success");

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
      successEl.textContent = "Account created.";
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
