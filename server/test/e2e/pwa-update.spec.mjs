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

    await page.goto("/#/settings");
    await page.locator("#row-check-updates").click();
    await expect(page.locator("#check-updates-value")).toHaveText(/up to date/i, { timeout: 15000 });
  });

  test("Check for updates finds a genuinely new service worker and offers to refresh", async ({ page, fixtures }) => {
    const manager = await fixtures.createUser("sales_manager");
    await loginViaUi(page, manager.email);
    await page.waitForTimeout(1000);

    // Serve a byte-different sw.js for the rest of this test only -- same
    // cache-busting mechanism a real deploy uses (CLAUDE.md's own
    // CACHE_VERSION-bump rule), reproduced here as a runtime route
    // override instead of an actual second deploy.
    await page.route("**/sw.js", async (route) => {
      const response = await route.fetch();
      const body = await response.text();
      await route.fulfill({
        response,
        body: body.replace(/field-visits-v\d+/, `field-visits-v${Date.now()}`),
      });
    });

    await page.goto("/#/settings");
    await page.locator("#row-check-updates").click();
    await expect(page.locator("#check-updates-value")).toHaveText(/update/i, { timeout: 15000 });
    // The update-overlay banner (updateBanner.js) is what actually lets
    // the rep act on it -- confirming it's there, not just the row's own
    // text, is what proves the found update is reachable, not only detected.
    await expect(page.locator("#update-refresh-btn")).toBeVisible({ timeout: 10000 });
  });
});
