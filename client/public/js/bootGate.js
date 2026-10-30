// The whole app is disguised as a plain calculator until the correct code
// is entered (see calculatorLock.js) -- for security/data-protection
// reasons, per the feature this implements. This file is the ONLY script
// index.html loads unconditionally: every real-app module (app.js and the
// enhancement scripts it used to sit alongside as static <script> tags) is
// imported from here instead, and only once the gate has actually opened.
// That matters more than it looks: it's not just "show a calculator on top"
// -- until unlocked, none of the real app's code ever runs, and it never
// touches the network, so there's nothing for a casual inspection (or a
// network tab) to find beyond "this loads a calculator".
//
// Unlock state is sessionStorage, not localStorage: it re-arms on every
// fresh launch (a closed-and-reopened PWA/tab is a new sessionStorage), and
// once unlocked for this tab's session, in-app navigation (hash changes,
// re-renders) never re-shows the calculator.
const UNLOCK_KEY = "kad_calc_unlocked";

// The app itself (the "enhancer" scripts that used to load next to it are gone: each screen builds its own parts now, roadmap step 7).
// Written out in the import, not taken from a list: the deploy build (server/scripts/build-client.mjs) follows only imports it can read.

// The app did not start (owner, 2026-10-30: after an update "Reload" spun for ever): one of its files did not load, or nothing happened. This
// file knows nothing of the app's own modules (they are what failed), so it carries its own plain texts and its own "clean start": the app's
// stored copy (service worker + file caches) is thrown away and downloaded again, once by itself, and with a button when that was not enough.
const BOOT_WAIT_MS = 20000;
const BOOT_CLEAN_KEY = "fv_boot_clean";
// Safari keeps a file that failed to load, for about a second or two, when the page asked for it to be preloaded (index.html's modulepreload
// hints): a reload straight after the failure gets the same failure again, and so did the person's quick second "Reload" -- only closing the
// app cleared it. So no reload happens sooner than RETRY_GAP_MS after the failure.
const RETRY_GAP_MS = 3000;
let failedAt = Date.now();
async function cleanStart() {
  // The browser's own answer can fail to come at all (a stuck worker): the reload happens after 3 s whatever the clearing is doing.
  const clearing = (async () => {
    const regs = (await navigator.serviceWorker?.getRegistrations?.()) ?? [];
    await Promise.all(regs.map((r) => r.unregister()));
    const keys = (await globalThis.caches?.keys?.()) ?? [];
    await Promise.all(keys.map((k) => caches.delete(k)));
  })().catch(() => {}); // whatever could be cleared is cleared; the reload below still helps
  await Promise.race([clearing, new Promise((resolve) => setTimeout(resolve, 3000))]);
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, RETRY_GAP_MS - (Date.now() - failedAt))));
  // a new address (and the page without preload hints, see server/src/app.js); app.js removes the mark again once it runs
  location.replace(`${location.pathname}?fv_retry=${Date.now()}${location.hash}`);
}
function reportBootFailure(reason) {
  try {
    // the same CSRF header the app's own requests carry (the report needs a signed-in session)
    const csrf = document.cookie.match(/(?:^|; )csrf_token=([^;]+)/)?.[1];
    fetch("/api/client-errors", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(csrf ? { "X-CSRF-Token": csrf } : {}) },
      body: JSON.stringify({ kind: "error", message: `App did not start: ${reason}`.slice(0, 1500), url: location.href, user_agent: navigator.userAgent }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    // reporting is best effort
  }
}
let bootFailureShown = false;
function bootFailed(reason) {
  if (bootFailureShown || document.documentElement.dataset.fvBooted) return;
  bootFailureShown = true;
  failedAt = Date.now();
  reportBootFailure(reason);
  try {
    const last = Number(sessionStorage.getItem(BOOT_CLEAN_KEY) || 0);
    if (Date.now() - last > 60000) {
      sessionStorage.setItem(BOOT_CLEAN_KEY, String(Date.now()));
      cleanStart();
      return;
    }
  } catch {
    // no sessionStorage: show the card
  }
  const hy = (localStorage.getItem("fieldvisits_lang") || "hy") !== "en";
  const text = hy
    ? { title: "Հավելվածը չբացվեց", body: "Ֆայլերից մեկը չբեռնվեց։ «Մաքուր վերաբեռնում»-ը նորից կբեռնի հավելվածը։", clean: "Մաքուր վերաբեռնում", reload: "Վերաբեռնել" }
    : { title: "The app did not open", body: "One of its files did not load. A clean reload downloads the app again.", clean: "Clean reload", reload: "Reload" };
  const splash = document.querySelector(".boot-splash");
  if (splash) splash.remove();
  const host = document.getElementById("app") || document.body;
  host.innerHTML = `<div style="max-width:420px;margin:18vh auto 0;padding:0 20px;text-align:center;font-family:-apple-system,system-ui,sans-serif">
    <h2 style="margin:0 0 8px">${text.title}</h2><p style="margin:0 0 20px;color:#5b6270">${text.body}</p>
    <button id="boot-clean" style="width:100%;min-height:48px;border:0;border-radius:12px;background:#0969da;color:#fff;font-size:16px;font-weight:600">${text.clean}</button>
    <button id="boot-reload" style="width:100%;min-height:48px;margin-top:10px;border:1px solid #d0d5dd;border-radius:12px;background:#fff;color:#1f2430;font-size:16px">${text.reload}</button></div>`;
  document.getElementById("boot-clean").addEventListener("click", cleanStart);
  document.getElementById("boot-reload").addEventListener("click", () => location.reload());
}

async function bootRealApp() {
  try {
    sessionStorage.setItem(UNLOCK_KEY, "1");
  } catch {
    // Private-browsing/storage-blocked: unlock just won't survive an
    // in-session reload, which is the safer failure direction here.
  }
  const themeColor = document.querySelector('meta[name="theme-color"]');
  if (themeColor) themeColor.content = "#f6f7f9";
  // app.js sets data-fv-booted on <html> once its first screen is drawn
  setTimeout(() => bootFailed(`no first screen after ${BOOT_WAIT_MS / 1000}s`), BOOT_WAIT_MS);
  try {
    // After a failed start the retry asks for app.js under a new address: Safari answers the old one from its memory, without asking the
    // server, even on a fresh page (seen in the browser tests; the app's other files are asked for as usual).
    const retry = location.search.match(/fv_retry=\d+/)?.[0];
    if (retry) {
      // (an address held in a variable: the build would otherwise turn this import into a lookup of known files)
      const address = new URL("./app.js", import.meta.url);
      address.search = retry;
      await import(address.href);
      history.replaceState(null, "", location.pathname + location.hash);
    } else await import("./app.js");
  } catch (err) {
    bootFailed(String(err?.message || err));
  }
}

async function showLockScreen() {
  const { renderCalculatorLock } = await import("./calculatorLock.js");
  renderCalculatorLock(document.getElementById("app"), bootRealApp);
}

// Set server-side into a <meta> tag on every response (see index.js) --
// not fetched, so whether the feature is on or off, this file still never
// makes a network request before deciding what to show. Admin-toggled via
// Settings > Administration; defaults to off (normal app boot).
const calculatorModeEnabled = document.querySelector('meta[name="calc-mode"]')?.content === "true";

let alreadyUnlocked = false;
try {
  alreadyUnlocked = sessionStorage.getItem(UNLOCK_KEY) === "1";
} catch {
  // Same fallback direction as above: treat as locked.
}

// browser-check.js sets this when the browser is too old to run the app
// (it shows its own "update your browser" screen); do not boot underneath.
if (window.__fvBrowserBlocked) {
  // nothing to boot
} else if (!calculatorModeEnabled || alreadyUnlocked) {
  bootRealApp();
} else {
  showLockScreen();
}
