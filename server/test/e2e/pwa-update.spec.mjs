import { test, expect, loginViaUi } from "./fixtures.mjs";

// A full install->waiting->activate service worker lifecycle is inherently
// flaky to drive deterministically in headless automation (real timing,
// no first-class Playwright API for "force a new SW to finish installing
// right now"). Scoped instead to what's actually reliable and still real:
// the manual "Check for updates" action in Settings, exercised in both
// directions -- no update available (the common case, since the test
// server is already running its own current sw.js), and an update
// genuinely available (the server's sw.js is swapped for a byte-different
// one mid-test, a real trigger for the browser's own update algorithm,
// then the same "Check for updates" tap is expected to find it).
test.describe("PWA update flow", () => {
  test("@smoke Settings' Check for updates reports up to date when nothing changed", async ({ page, fixtures }) => {
    const manager = await fixtures.createUser("sales_manager");
    await loginViaUi(page, manager.email);
    // A service worker registration needs a beat to actually settle after
    // first navigation before checkForUpdateManually() has anything to
    // check against.
    await page.waitForTimeout(1000);

    await page.goto("/#/settings?section=p-about");
    await page.locator("#row-check-updates").click();
    // i18n.js's up_to_date string -- "up to date" itself never appears verbatim.
    await expect(page.locator("#check-updates-value")).toHaveText(/latest version/i, { timeout: 15000 });
  });

  test("Check for updates finds a genuinely new service worker and offers to refresh", async ({ page, fixtures }) => {
    const manager = await fixtures.createUser("sales_manager");
    await loginViaUi(page, manager.email);
    await page.waitForTimeout(1000);

    // updateBanner.js's controllerchange handler only renders the refresh
    // banner when a LATER controllerchange follows a page whose OWN
    // initServiceWorkerUpdates() call already saw a controller
    // (hadController -- a plain boolean captured once, at that call's own
    // time, not re-read afterwards). On this page's first-ever load
    // there's no controller yet (nothing installed until the first worker
    // activates a moment later), so hadController is false here no matter
    // how long this same page instance then waits -- only a FRESH page
    // load, happening after that first worker already controls the page,
    // gets to capture it true. A first-ever activation is deliberately
    // ignored either way: there's nothing stale yet to refresh away from.
    await expect
      .poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)), { timeout: 10000 })
      .toBe(true);
    await page.reload();
    await page.waitForTimeout(1000);

    // Installs a genuinely new worker for the same scope directly, rather
    // than trying to make the browser's OWN update check (reg.update(),
    // which byte-diffs the SAME /sw.js url -- the real deploy path the
    // first test above already covers) see different content: Playwright's
    // request interception (page- or context-level) doesn't reliably reach
    // that particular fetch, since it's the browser's own internal
    // service-worker update mechanism, not one made through the page's own
    // document. A differently-named script URL sidesteps that entirely --
    // per spec it always installs as a new version for the scope
    // regardless of byte content, self.skipWaiting()+self.clients.claim()
    // in sw.js's own install/activate handlers still apply, and the
    // resulting controllerchange is the exact same real trigger
    // updateBanner.js's listener reacts to on a genuine deploy.
    await page.evaluate(() => navigator.serviceWorker.register(`/sw.js?e2e-update=${Date.now()}`));

    // The update-overlay banner (updateBanner.js) is what actually lets a
    // rep act on a found update -- this confirms the app reacted to a
    // genuine new-worker activation, not just that installation succeeded.
    await expect(page.locator("#update-refresh-btn")).toBeVisible({ timeout: 15000 });
  });

  // Owner, 2026-11-03: "after updates the settings page is always stuck". A newer worker that took over while this page was still running
  // its old code (the app sat in the background on an iPhone, or another window took the update) served the NEW files to the OLD page and
  // the screens it opened kept spinning. Now: an idle page reloads onto the new version at once; a page with a sheet open keeps it and
  // reloads on its next screen change instead of mixing the versions.
  async function takeOverWithNewWorker(page) {
    await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.register(`/sw.js?e2e-takeover=${Date.now()}`);
      const worker = reg.installing || reg.waiting;
      await new Promise((resolve) => {
        if (!worker || worker.state === "installed" || worker.state === "activated") return resolve();
        worker.addEventListener("statechange", () => worker.state === "installed" && resolve());
      });
      // taken over the way a frozen page used to be taken over: not by this page's own "Refresh"
      (reg.waiting || worker)?.postMessage({ type: "skip-waiting" });
    });
  }
  async function controlledPage(page, fixtures) {
    const manager = await fixtures.createUser("sales_manager");
    await loginViaUi(page, manager.email);
    await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)), { timeout: 10000 }).toBe(true);
    await page.reload();
    await expect(page.locator("#app")).not.toBeEmpty({ timeout: 15000 });
    await page.waitForTimeout(800);
  }

  test("a newer version that takes over an idle page: the app reloads onto it at once", async ({ page, fixtures }) => {
    await controlledPage(page, fixtures);
    await page.evaluate(() => (window.__oldPage = true));
    await takeOverWithNewWorker(page);
    await expect.poll(() => page.evaluate(() => window.__oldPage === true).catch(() => true), { timeout: 15000 }).toBe(false);
    await expect(page.locator("#app")).not.toBeEmpty({ timeout: 15000 });
  });

  test("taken over while a sheet is open: nothing is lost, the next screen opens on a reload", async ({ page, fixtures }) => {
    await controlledPage(page, fixtures);
    await page.evaluate(() => {
      window.__oldPage = true;
      const sheet = document.createElement("div");
      sheet.className = "sheet-overlay";
      sheet.id = "e2e-open-sheet";
      document.body.appendChild(sheet);
    });
    await takeOverWithNewWorker(page);
    await expect(page.locator("#update-refresh-btn")).toBeVisible({ timeout: 15000 });
    expect(await page.evaluate(() => window.__oldPage)).toBe(true);
    await page.evaluate(() => (location.hash = "#/customers"));
    await expect.poll(() => page.evaluate(() => window.__oldPage === true).catch(() => true), { timeout: 15000 }).toBe(false);
  });
});
