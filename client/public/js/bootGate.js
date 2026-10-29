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

async function bootRealApp() {
  try {
    sessionStorage.setItem(UNLOCK_KEY, "1");
  } catch {
    // Private-browsing/storage-blocked: unlock just won't survive an
    // in-session reload, which is the safer failure direction here.
  }
  const themeColor = document.querySelector('meta[name="theme-color"]');
  if (themeColor) themeColor.content = "#f6f7f9";
  await import("./app.js");
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
