// Prompts an already-installed PWA session to reload once a new deploy's
// service worker has taken over. Without this, an installed home-screen
// app has no address bar or refresh button -- the only way a rep would
// ever see a new deploy is fully closing and relaunching the app (and on
// iOS, even that isn't reliable if the OS just resumes the backgrounded
// page instead of a fresh navigation). See app.js for how this gets wired
// up to the service worker's controllerchange event.
import { t } from "./i18n.js";

let container = null;

export function mountUpdateBanner(el) {
  container = el;
}

export function showUpdateBanner(onRefresh) {
  if (!container || container.childElementCount) return;
  container.innerHTML = `
    <div class="install-banner">
      <div class="install-copy">
        <strong>${t("update_available_title")}</strong>
        <span>${t("update_available_body")}</span>
      </div>
      <button class="btn btn-primary btn-sm" id="update-refresh-btn">${t("refresh_now")}</button>
      <button class="install-dismiss" id="update-dismiss" aria-label="${t("cancel")}">&times;</button>
    </div>
  `;
  container.querySelector("#update-refresh-btn").addEventListener("click", onRefresh);
  container.querySelector("#update-dismiss").addEventListener("click", () => {
    container.innerHTML = "";
  });
}
