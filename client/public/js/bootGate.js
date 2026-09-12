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

// Same order the static <script type="module"> tags used to declare --
// preserved here since a couple of these attach page-wide listeners the
// first time they run and there's no reason to risk changing that.
const REAL_APP_MODULES = [
  "./competitorPolicySafe.js",
  "./activityDatePicker.js",
  "./ordersSearchEnhancements.js",
  "./unifiedSearchEnhancements.js",
  "./customerPortfolioUi.js",
  "./ordersRegionStatusEnhancements.js",
  "./mapDimensionFilterPlacement.js",
  "./fieldVisitEnhancements.js",
  "./customerSocialProfiles.js",
  "./mapMarkerEnhancements.js",
  "./app.js",
  "./mapSafeUi.js",
];

async function bootRealApp() {
  try {
    sessionStorage.setItem(UNLOCK_KEY, "1");
  } catch {
    // Private-browsing/storage-blocked: unlock just won't survive an
    // in-session reload, which is the safer failure direction here.
  }
  const themeColor = document.querySelector('meta[name="theme-color"]');
  if (themeColor) themeColor.content = "#f6f7f9";
  for (const path of REAL_APP_MODULES) {
    await import(path);
  }
}

async function showLockScreen() {
  const { renderCalculatorLock } = await import("./calculatorLock.js");
  renderCalculatorLock(document.getElementById("app"), bootRealApp);
}

let alreadyUnlocked = false;
try {
  alreadyUnlocked = sessionStorage.getItem(UNLOCK_KEY) === "1";
} catch {
  // Same fallback direction as above: treat as locked.
}

if (alreadyUnlocked) {
  bootRealApp();
} else {
  showLockScreen();
}
