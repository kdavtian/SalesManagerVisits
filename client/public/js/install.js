import { t } from "./i18n.js";

const DISMISS_KEY = "fieldvisits_install_dismissed_at";
const DISMISS_DAYS = 14;

let deferredPrompt = null;
let container = null;

function isStandalone() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true
  );
}

function isIOS() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
}

function isSafari() {
  const ua = navigator.userAgent;
  return /safari/i.test(ua) && !/crios|fxios|edgios|chrome|android/i.test(ua);
}

function recentlyDismissed() {
  const at = Number(localStorage.getItem(DISMISS_KEY) || 0);
  return Date.now() - at < DISMISS_DAYS * 24 * 60 * 60 * 1000;
}

function dismiss() {
  localStorage.setItem(DISMISS_KEY, String(Date.now()));
  render();
}

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredPrompt = e;
  render();
});

window.addEventListener("appinstalled", () => {
  deferredPrompt = null;
  render();
});

export function mountInstallPrompt(el) {
  container = el;
  render();
}

function render() {
  if (!container) return;

  if (isStandalone() || recentlyDismissed()) {
    container.innerHTML = "";
    return;
  }

  if (deferredPrompt) {
    renderAndroidBanner();
  } else if (isIOS() && isSafari()) {
    renderIOSBanner();
  } else {
    container.innerHTML = "";
  }
}

function renderAndroidBanner() {
  container.innerHTML = `
    <div class="install-banner">
      <img src="icons/icon-192.png" alt="" class="install-icon" />
      <div class="install-copy">
        <strong>${t("install_title")}</strong>
        <span>${t("install_body")}</span>
      </div>
      <button class="btn btn-primary btn-sm" id="install-now">${t("install_now")}</button>
      <button class="install-dismiss" id="install-dismiss" aria-label="Dismiss">&times;</button>
    </div>
  `;
  container.querySelector("#install-now").addEventListener("click", async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    render();
  });
  container.querySelector("#install-dismiss").addEventListener("click", dismiss);
}

function renderIOSBanner() {
  container.innerHTML = `
    <div class="install-banner">
      <img src="icons/icon-192.png" alt="" class="install-icon" />
      <div class="install-copy">
        <strong>${t("install_title")}</strong>
        <span>${t("install_body")}</span>
      </div>
      <button class="btn btn-primary btn-sm" id="install-show-steps">${t("install_show_steps")}</button>
      <button class="install-dismiss" id="install-dismiss" aria-label="Dismiss">&times;</button>
    </div>
  `;
  container.querySelector("#install-show-steps").addEventListener("click", showIOSWalkthrough);
  container.querySelector("#install-dismiss").addEventListener("click", dismiss);
}

function showIOSWalkthrough() {
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `
    <div class="sheet install-sheet">
      <h2>${t("add_to_home_screen")}</h2>
      <ol class="ios-steps">
        <li>
          <span class="ios-step-icon ios-anim-share">
            <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 16V4"/>
              <path d="M7 8l5-5 5 5"/>
              <rect x="4" y="12" width="16" height="8" rx="2"/>
            </svg>
          </span>
          <span>${t("ios_step_1")} <strong>${t("ios_step_1b")}</strong> ${t("ios_step_1c")}</span>
        </li>
        <li>
          <span class="ios-step-icon">
            <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="4" y="4" width="16" height="16" rx="3"/>
              <path d="M12 8v8M8 12h8"/>
            </svg>
          </span>
          <span>${t("ios_step_2")} <strong>${t("ios_step_2b")}</strong></span>
        </li>
        <li>
          <span class="ios-step-icon">
            <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M20 6L9 17l-5-5"/>
            </svg>
          </span>
          <span>${t("ios_step_3")} <strong>${t("ios_step_3b")}</strong> ${t("ios_step_3c")}</span>
        </li>
      </ol>
      <button type="button" class="btn btn-primary btn-block" id="close-ios-steps">${t("got_it")}</button>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector("#close-ios-steps").addEventListener("click", () => overlay.remove());
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });
}
