// Everything to do with "a new deploy is ready": registering the service
// worker, detecting a new version, showing a blurred, hard-to-miss prompt
// for it (re-shown on every later app open until the user actually taps
// Refresh), and the manual "Check for updates" action in Settings.
// Centralized here so app.js just calls init() once and settings.js can
// call checkForUpdateManually() without needing to know any of the
// service-worker plumbing.
//
// How an update is taken (owner, 2026-10-30: after an update a white screen,
// "Reload" spinning for ever): the new worker is installed in the background
// and WAITS (sw.js). The open page keeps working on its own version -- old
// scripts, old files -- so the two versions never meet. When the person taps
// Refresh (or opens the app again and finds one waiting), applyUpdate() asks
// the worker to take over and reloads the app onto the new version in one
// step, from the new files. A page of an older version of the app, which does
// not know this, gets the new worker at once as before (controllerchange).
import { t } from "./i18n.js";
import { cleanReload } from "./shell/slowRoute.js";

let container = null;
let registration = null;
let updateReady = false;
let refreshing = false;

// True once a newer version has taken over the service worker but this page still runs the old scripts (the person tapped "Later").
export function isUpdatePending() {
  return updateReady;
}

export function mountUpdateBanner(el) {
  container = el;
}

// Takes the waiting version: the worker takes over, then this page reloads onto it. Without a waiting worker (it already took over, or the
// update never installed) a clean reload (stored files thrown away and downloaded again) does the same job. At most once a minute by itself.
export async function applyUpdate() {
  const reg = registration || (await navigator.serviceWorker?.getRegistration?.().catch(() => null));
  const waiting = reg?.waiting;
  if (!waiting || !navigator.serviceWorker) {
    if (navigator.onLine) cleanReload();
    else location.reload();
    return;
  }
  let reloaded = false;
  const reloadOnce = () => {
    if (reloaded) return;
    reloaded = true;
    location.reload();
  };
  navigator.serviceWorker.addEventListener("controllerchange", reloadOnce, { once: true });
  waiting.postMessage({ type: "skip-waiting" });
  // the worker did not take over in time: start clean
  setTimeout(() => {
    if (!reloaded) {
      reloaded = true;
      if (navigator.onLine) cleanReload();
      else location.reload();
    }
  }, 5000);
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
    applyUpdate();
  });
  container.querySelector("#update-dismiss").addEventListener("click", () => {
    container.innerHTML = "";
  });
}

function maybeShowBanner() {
  if (updateReady) renderBanner();
}

export async function checkForUpdateManually() {
  // `registration` is only set once register("/sw.js").then(...) resolves
  // (see initServiceWorkerUpdates below) -- a tap on "Check for updates"
  // that lands before that promise settles (a slow cold start) used to
  // silently report "up to date" here instead of actually checking, since
  // there was nothing else to fall back to. navigator.serviceWorker.ready
  // resolves as soon as this page has *any* active registration, so it's a
  // reliable fallback for exactly that race.
  const reg = registration || (await navigator.serviceWorker.ready.catch(() => null));
  if (!reg) return { updateFound: false };
  registration = reg;
  return new Promise((resolve) => {
    let settled = false;
    function onUpdateFound() {
      finish(true);
    }
    function finish(found) {
      if (settled) return;
      settled = true;
      reg.removeEventListener("updatefound", onUpdateFound);
      resolve({ updateFound: found });
    }
    reg.addEventListener("updatefound", onUpdateFound);
    reg.update().catch(() => finish(false));
    // A rep in the field often has a slow/unstable connection (the whole
    // reason this app has an offline queue) -- 5s was long enough to
    // misreport "up to date" on a check that was still genuinely in
    // flight, not actually finished.
    setTimeout(() => finish(false), 12000);
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
  // sw.js asks every open page before it decides to wait: a page that answers is one that offers the update itself.
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type === "update-ping") event.ports?.[0]?.postMessage("update-pong");
  });
  // Safari delivers a worker's messages to a page only after this (Chrome does it by itself once the page has loaded)
  navigator.serviceWorker.startMessages?.();

  // A new version installed and is waiting: say so (only when this page already has a worker -- the very first install has nothing to update).
  function watchForWaiting(reg) {
    const announce = () => {
      if (!navigator.serviceWorker.controller) return;
      updateReady = true;
      renderBanner();
    };
    reg.addEventListener("updatefound", () => {
      const worker = reg.installing;
      worker?.addEventListener("statechange", () => {
        if (worker.state === "installed") announce();
      });
    });
    if (reg.waiting) {
      // One was already waiting when the app opened: nothing is on screen to lose yet, so the app starts on the new version straight away
      // (once a minute at most, so a version that cannot take over never makes the app reload in a loop).
      announce();
      try {
        const last = Number(sessionStorage.getItem("fv_boot_update") || 0);
        if (Date.now() - last > 60000) {
          sessionStorage.setItem("fv_boot_update", String(Date.now()));
          applyUpdate();
        }
      } catch {
        // no sessionStorage: the banner is enough
      }
    }
  }

  function registerServiceWorker() {
    navigator.serviceWorker
      .register("/sw.js")
      .then((reg) => {
        registration = reg;
        watchForWaiting(reg);
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
  }

  // This module only runs once index.html's bootGate.js has dynamically
  // import()-ed app.js (see bootGate.js's bootRealApp()) -- an async step
  // with no fixed timing relative to the page's own 'load' event. On a
  // small/fast/cached page load (every automated test, and plenty of real
  // repeat visits) 'load' can fire before that import resolves, so a
  // listener registered here would just never run and the service worker
  // would silently never register at all. document.readyState is already
  // "complete" by the time 'load' has fired, so checking it covers exactly
  // that race without waiting a second time for an event that already happened.
  if (document.readyState === "complete") {
    registerServiceWorker();
  } else {
    window.addEventListener("load", registerServiceWorker);
  }
}
