import { api } from "./api.js";
import { t } from "./i18n.js";
import { escapeHtml } from "./util.js";

// Takes the whole tab over: no other app code renders anything else once
// this is up, and nothing from before it (dashboard data, nav, badges)
// stays visible underneath -- it replaces #app's entire subtree and hides
// the nav chrome, same elements bootGate briefly owns before login.
let shown = false;

export function showLockdownOverlay(status) {
  if (shown) return;
  shown = true;

  document.getElementById("sidebar")?.setAttribute("hidden", "");
  document.getElementById("top-bar")?.setAttribute("hidden", "");
  document.getElementById("nav-bar")?.setAttribute("hidden", "");

  const app = document.getElementById("app");
  if (!app) return;

  const byLine =
    status?.by_name && status?.at
      ? t("emergency_disconnect_active_by")
          .replace("{name}", escapeHtml(status.by_name))
          .replace("{time}", new Date(status.at).toLocaleString())
      : "";

  app.innerHTML = `
    <div class="lockdown-screen">
      <div class="lockdown-card">
        <h1>${t("lockdown_screen_title")}</h1>
        <p>${t("lockdown_screen_body")}</p>
        ${byLine ? `<p class="muted">${byLine}</p>` : ""}
        <p class="muted">${t("lockdown_screen_login_hint")}</p>
        <form id="lockdown-login-form">
          <label>
            <span>${t("email")}</span>
            <input type="email" name="email" required autocomplete="username" />
          </label>
          <label>
            <span>${t("password")}</span>
            <input type="password" name="password" required autocomplete="current-password" />
          </label>
          <p class="form-error" id="lockdown-login-error" role="alert" hidden></p>
          <button type="submit" class="btn btn-primary">${t("log_in")}</button>
        </form>
        <div id="lockdown-lift-panel" hidden>
          <p>${t("emergency_disconnect_active")}</p>
          <button type="button" class="btn btn-danger" id="lockdown-lift-btn">${t("emergency_disconnect_lift_button")}</button>
        </div>
      </div>
    </div>
  `;

  const style = document.createElement("style");
  style.id = "lockdown-screen-style";
  style.textContent = `
    .lockdown-screen { position: fixed; inset: 0; z-index: 9998; display: flex; align-items: center; justify-content: center; background: #1c1c1e; color: #fff; padding: 24px; box-sizing: border-box; }
    .lockdown-card { max-width: 360px; width: 100%; text-align: center; }
    .lockdown-card h1 { font-size: 1.3rem; margin-bottom: 8px; }
    .lockdown-card form { display: flex; flex-direction: column; gap: 12px; margin-top: 20px; text-align: left; }
    .lockdown-card label { display: flex; flex-direction: column; gap: 4px; font-size: 0.85rem; }
    .lockdown-card input { padding: 10px; border-radius: 8px; border: 1px solid #555; background: #2c2c2e; color: #fff; }
  `;
  document.head.appendChild(style);

  const form = document.getElementById("lockdown-login-form");
  const errorEl = document.getElementById("lockdown-login-error");
  const liftPanel = document.getElementById("lockdown-lift-panel");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorEl.hidden = true;
    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    try {
      const user = await api.login(form.email.value, form.password.value);
      if (user.role !== "admin") {
        // Non-admin sessions get nothing beyond this screen even after a
        // successful login -- lockdown means no data on any device, not
        // "unless you happen to have the right password".
        await api.logout().catch(() => {});
        errorEl.textContent = t("lockdown_screen_body");
        errorEl.hidden = false;
        return;
      }
      form.hidden = true;
      liftPanel.hidden = false;
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    } finally {
      submitBtn.disabled = false;
    }
  });

  document.getElementById("lockdown-lift-btn").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      await api.liftLockdown();
      location.reload();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
      btn.disabled = false;
    }
  });
}
