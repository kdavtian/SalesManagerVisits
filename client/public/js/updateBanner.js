// Everything to do with "a new deploy is ready": registering the service
// worker, detecting when a new one has taken over, showing a blurred,
// hard-to-miss prompt for it (re-shown on every later app open until the
// user actually taps Refresh), and the manual "Check for updates" action
// in Settings. Centralized here so app.js just calls init() once and
// settings.js can call checkForUpdateManually() without needing to know
// any of the service-worker plumbing.
//
// Why the prompt has to be re-shown rather than shown once: sw.js calls
// self.skipWaiting() unconditionally, so by the time this module can
// observe an update at all, the new worker has already activated and
// claimed every open page -- there's no "waiting" state left to poll
// later. The only thing that's still stale is this page's own
// already-loaded JS in memory, and the only way to know that is to
// remember it ourselves (updateReady) until an actual reload happens.
import { t } from "./i18n.js";

let container = null;
let registration = null;
let updateReady = false;
let refreshing = false;

export function mountUpdateBanner(el) {
  container = el;
}

function renderBanner() {
  if (!container || container.childElementCount) return;
  container.innerHTML = `
    <div class="update-overlay" id="update-overlay">
      <div class="update-banner" role="alertdialog" aria-labelledby="update-banner-title">
        <strong id="update-banner-title">${t("update_available_title")}</strong>
        <span>${t("update_available_body")}</span>
        <button type="button" class="btn btn-primary btn-block" id="update-refresh-btn">${t("refresh_now")}</button>
        <button type="button" class="btn-link" id="update-dismiss">${t("later")}</button>
      </div>
    </div>
  `;
  container.querySelector("#update-refresh-btn").addEventListener("click", (event) => {
    if (refreshing) return;
    refreshing = true;
    const btn = event.currentTarget;
    btn.disabled = true;
    let seconds = 0;
    const tick = () => {
      btn.textContent = seconds > 0 ? `${t("updating")}… ${seconds}s` : `${t("updating")}…`;
    };
    tick();
    const interval = setInterval(() => {
      seconds += 1;
      tick();
    }, 1000);
    // A safety net in case the reload itself somehow doesn't happen (a
    // stalled network fetch of the new shell, say) -- without this the
    // button would just count up forever with no way out.
    setTimeout(() => {
      clearInterval(interval);
      refreshing = false;
      btn.disabled = false;
      btn.textContent = t("refresh_now");
    }, 15000);
    window.location.reload();
  });
  container.querySelector("#update-dismiss").addEventListener("click", () => {
    container.innerHTML = "";
  });
}

function maybeShowBanner() {
  if (updateReady) renderBanner();
}

export function checkForUpdateManually() {
  if (!registration) return Promise.resolve({ updateFound: false });
  return new Promise((resolve) => {
    let settled = false;
    function onUpdateFound() {
      finish(true);
    }
    function finish(found) {
      if (settled) return;
      settled = true;
      registration.removeEventListener("updatefound", onUpdateFound);
      resolve({ updateFound: found });
    }
    registration.addEventListener("updatefound", onUpdateFound);
    registration.update().catch(() => finish(false));
    setTimeout(() => finish(false), 5000);
  });
}

export function initServiceWorkerUpdates() {
  if (!("serviceWorker" in navigator)) return;

  // A truthy .controller here means this page load was already being
  // served by a previously-installed service worker -- so a later
  // controllerchange means a real update just took over, not just this
  // page's first-ever activation (which also fires controllerchange, but
  // there's nothing stale to refresh away from in that case).
  const hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController) return;
    updateReady = true;
    renderBanner();
  });

  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js")
      .then((reg) => {
        registration = reg;
        // The browser only checks for a changed sw.js on its own schedule
        // (throttled to roughly once a day), which is much too slow for an
        // app under active daily development -- and an installed PWA
        // reopened from the home screen doesn't reliably trigger even that
        // check, especially on iOS. Force a check, and re-show the prompt
        // if it was dismissed earlier, every time the app comes back to
        // the foreground.
        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState !== "visible") return;
          reg.update().catch(() => {});
          maybeShowBanner();
        });
        window.addEventListener("pageshow", maybeShowBanner);
      })
      .catch((err) => {
        console.error("Service worker registration failed:", err);
      });
  });
}
