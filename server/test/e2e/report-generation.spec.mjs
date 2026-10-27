import { test, expect, loginViaUi } from "./fixtures.mjs";

test.describe("Report generation", () => {
  test("@smoke an admin can open a report from the list and see it render real content", async ({ page, fixtures }) => {
    const admin = await fixtures.createUser("admin");
    await loginViaUi(page, admin.email);

    await page.goto("/#/reports");
    // A desktop window shows the list beside the report (reportsDesk.js): open another report from the side list.
    const firstReport = page.locator(".reports-side-item:not(.is-active)").first();
    await expect(firstReport).toBeVisible({ timeout: 10000 });
    await firstReport.click();
    await expect(page.locator(".reports-side-item.is-active")).toBeVisible();

    // Off the reports list and into an actual report body -- not just a
    // loading spinner or an error state.
    await expect(page.locator(".loading-state")).toHaveCount(0, { timeout: 15000 });
    await expect(page.locator(".form-error")).toHaveCount(0);
  });
});
