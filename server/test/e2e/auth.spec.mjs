import { test, expect, loginViaUi } from "./fixtures.mjs";

test.describe("Login and logout", () => {
  test("@smoke a sales_manager can log in and out through the real UI", async ({ page, fixtures }) => {
    const user = await fixtures.createUser("sales_manager");

    await loginViaUi(page, user.email);
    await expect(page.locator("#top-bar")).toBeVisible();
    // A logged-in load lands on the dashboard by default.
    await expect(page).toHaveURL(/#\/dashboard/);

    await page.goto("/#/settings");
    await page.locator("#settings-logout").click();
    await expect(page.locator('input[name="email"]')).toBeVisible();
    await expect(page.locator("#top-bar")).toBeHidden();
  });

  test("a wrong password shows an inline error, not a silent failure", async ({ page, fixtures }) => {
    const user = await fixtures.createUser("sales_manager");
    await page.goto("/");
    await page.locator('input[name="email"]').fill(user.email);
    await page.locator('input[name="password"]').fill("definitely-wrong-password");
    await page.locator('button[type="submit"]').click();
    await expect(page.locator("#login-error")).toBeVisible();
    await expect(page.locator('input[name="email"]')).toBeVisible();
  });
});
