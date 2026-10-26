import { test, expect, loginViaUi } from "./fixtures.mjs";

// Owner, 2026-10-26: Payments and Cash expense are one Home tile that opens a page with two buttons; every page has a back button.
test("Payments & expenses tile -> two buttons, each with a back button", async ({ page, fixtures }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const admin = await fixtures.createUser("admin");
  await loginViaUi(page, admin.email);
  await page.goto("/#/dashboard");
  await expect(page.locator("#qa-money")).toBeVisible();
  await expect(page.locator("#qa-payments, #qa-cash-expense")).toHaveCount(0);
  await page.locator("#qa-money").click();
  await expect(page).toHaveURL(/#\/money$/);
  await expect(page.locator("#money-payments")).toBeVisible();
  await expect(page.locator("#money-expenses")).toBeVisible();
  await page.locator("#money-payments").click();
  await expect(page).toHaveURL(/#\/payments/);
  await page.locator("#payments-back-btn").click();
  await expect(page).toHaveURL(/#\/money$/);
  await page.locator("#money-expenses").click();
  await expect(page).toHaveURL(/#\/expenses$/);
  await page.locator("#back-btn").click();
  await expect(page).toHaveURL(/#\/money$/);
  await page.locator("#back-btn").click();
  await expect(page).toHaveURL(/#\/dashboard$/);
});
