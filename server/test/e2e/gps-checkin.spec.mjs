import { test, expect, loginViaUi } from "./fixtures.mjs";

test.describe("GPS check-in", () => {
  test("@smoke permission allowed: location resolves, submit enables, and the check-in saves", async ({
    page,
    context,
    fixtures,
  }) => {
    const manager = await fixtures.createUser("sales_manager");
    const customer = await fixtures.createCustomer({ created_by: manager.id, lat: 40.18, lng: 44.51 });

    await context.grantPermissions(["geolocation"]);
    await context.setGeolocation({ latitude: 40.18, longitude: 44.51 });

    await loginViaUi(page, manager.email);
    await page.goto(`/#/checkin/${customer.id}`);

    const submitBtn = page.locator("#checkin-submit");
    await expect(page.locator("#gps-status")).toContainText(/captured/i, { timeout: 10000 });
    await expect(submitBtn).toBeEnabled();

    // The real checkbox is visually hidden (width/height 0, opacity 0 --
    // see .outcome-chip input in styles.css, a custom chip-style toggle) so
    // a user always clicks the visible label/chip, never the input itself;
    // Playwright's actionability check agrees and refuses .check() on it.
    await page.locator('label.outcome-chip:has(input[value="no_order"])').click();
    const [response] = await Promise.all([
      page.waitForResponse((res) => res.url().includes("/api/checkins") && res.request().method() === "POST"),
      submitBtn.click(),
    ]);
    expect(response.ok()).toBeTruthy();
    const created = await response.json();
    fixtures.trackRow("checkins", created.id);
  });

  test("permission denied: GPS status shows an error and submit stays disabled", async ({ page, context, fixtures }) => {
    const manager = await fixtures.createUser("sales_manager");
    const customer = await fixtures.createCustomer({ created_by: manager.id });

    // Playwright/Chromium has no first-class "deny geolocation" toggle --
    // an ungranted permission request under CDP automation just hangs
    // pending (no prompt ever appears headless), it doesn't auto-reject.
    // Simulating the browser's real PERMISSION_DENIED callback directly is
    // the deterministic way to reach this state.
    await context.clearPermissions();
    await page.addInitScript(() => {
      navigator.geolocation.getCurrentPosition = (_success, error) => {
        error({ code: 1, message: "User denied Geolocation" });
      };
      navigator.geolocation.watchPosition = (_success, error) => {
        error({ code: 1, message: "User denied Geolocation" });
        return 0;
      };
    });

    await loginViaUi(page, manager.email);
    await page.goto(`/#/checkin/${customer.id}`);

    // The displayed copy is "Could not get your location: ..." -- it never
    // actually says the word "error" itself, only the element's own CSS
    // class (gps-error) does, so assert on that instead.
    await expect(page.locator("#gps-status")).toHaveClass(/gps-error/, { timeout: 10000 });
    await expect(page.locator("#checkin-submit")).toBeDisabled();
    await expect(page.locator(".gps-retry-btn")).toBeVisible();
  });
});
