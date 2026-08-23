import { api } from "../api.js";
import { t, getLang, setLang } from "../i18n.js";
import { getTheme, setTheme } from "../theme.js";
import { state, isAdmin } from "../state.js";
import { renderTeamSection } from "./admin.js";

export async function renderSettings(root, onLogout, onLanguageChange) {
  root.innerHTML = `
    <div class="settings-view">
      <h1>${t("settings_title")}</h1>

      <h2 class="section-title">${t("appearance")}</h2>
      <div class="card settings-row">
        <span>${t("dark_mode")}</span>
        <label class="switch">
          <input type="checkbox" id="theme-toggle" ${getTheme() === "dark" ? "checked" : ""} />
          <span class="switch-track"></span>
        </label>
      </div>

      <h2 class="section-title">${t("language")}</h2>
      <div class="card settings-row">
        <span>${t("armenian")}</span>
        <label class="switch">
          <input type="checkbox" id="lang-toggle" ${getLang() === "hy" ? "checked" : ""} />
          <span class="switch-track"></span>
        </label>
      </div>

      <h2 class="section-title">${t("account")}</h2>
      <div class="card">
        <div class="settings-account-row">
          <span class="muted">${t("signed_in_as")}</span>
          <strong>${state.user.name}</strong>
          <span class="muted">${state.user.email}</span>
        </div>
      </div>
      <button class="btn btn-block" id="settings-logout">${t("log_out")}</button>

      ${
        isAdmin()
          ? `
        <h2 class="section-title">${t("admin_section")}</h2>
        <div class="card">
          <form id="radius-form">
            <label>
              ${t("checkin_radius")}
              <input type="number" name="radius" min="10" max="5000" required />
            </label>
            <p class="muted radius-help">${t("checkin_radius_help")}</p>
            <p class="form-success" id="radius-success" hidden>${t("saved")}</p>
            <button type="submit" class="btn btn-primary">${t("save")}</button>
          </form>
        </div>

        <h2 class="section-title">${t("team")}</h2>
        <div id="team-section"></div>
      `
          : ""
      }
    </div>
  `;

  root.querySelector("#theme-toggle").addEventListener("change", (e) => {
    setTheme(e.target.checked ? "dark" : "light");
  });

  root.querySelector("#lang-toggle").addEventListener("change", (e) => {
    setLang(e.target.checked ? "hy" : "en");
    onLanguageChange();
  });

  root.querySelector("#settings-logout").addEventListener("click", onLogout);

  if (isAdmin()) {
    const radiusForm = root.querySelector("#radius-form");
    const radiusInput = radiusForm.querySelector('input[name="radius"]');
    const radiusSuccess = root.querySelector("#radius-success");

    api.getSettings().then((s) => {
      radiusInput.value = s.checkin_radius_meters;
    });

    radiusForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      radiusSuccess.hidden = true;
      const submitBtn = radiusForm.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      try {
        await api.updateSettings({ checkin_radius_meters: Number(radiusInput.value) });
        radiusSuccess.hidden = false;
      } finally {
        submitBtn.disabled = false;
      }
    });

    renderTeamSection(root.querySelector("#team-section"));
  }
}
