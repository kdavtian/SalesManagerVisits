import { api } from "../api.js";
import { setUser } from "../state.js";

export function renderLogin(root, onSuccess) {
  root.innerHTML = `
    <div class="login-screen">
      <div class="login-card">
        <div class="login-brand">
          <span class="brand-mark">FV</span>
          <h1>Field Visits</h1>
        </div>
        <form id="login-form">
          <label>
            Email
            <input type="email" name="email" autocomplete="username" required />
          </label>
          <label>
            Password
            <input type="password" name="password" autocomplete="current-password" required />
          </label>
          <p class="form-error" id="login-error" hidden></p>
          <button type="submit" class="btn btn-primary btn-block">Log in</button>
        </form>
      </div>
    </div>
  `;

  const form = root.querySelector("#login-form");
  const errorEl = root.querySelector("#login-error");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorEl.hidden = true;
    const submitBtn = form.querySelector("button");
    submitBtn.disabled = true;
    submitBtn.textContent = "Logging in…";

    const data = new FormData(form);
    try {
      const user = await api.login(data.get("email"), data.get("password"));
      setUser(user);
      onSuccess();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
      submitBtn.disabled = false;
      submitBtn.textContent = "Log in";
    }
  });
}
