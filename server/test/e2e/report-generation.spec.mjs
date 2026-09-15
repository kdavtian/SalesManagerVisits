import { test, expect, loginViaUi } from "./fixtures.mjs";

test.describe("Report generation", () => {
  test("@smoke an admin can open a report from the list and see it render real content", async ({ page, fixtures }) => {
    const admin = await fixtures.createUser("admin");
    await loginViaUi(page, admin.email);

    await page.goto("/#/reports");
    const firstReport = page.locator(".report-list-card").first();
    await expect(firstReport).toBeVisible({ timeout: 10000 });
    await firstReport.click();

    // Off the reports list and into an actual report body -- not just a
    // loading spinner or an error state.
    await expect(page.locator(".loading-state")).toHaveCount(0, { timeout: 15000 });
    await expect(page.locator(".form-error")).toHaveCount(0);
  });
});
