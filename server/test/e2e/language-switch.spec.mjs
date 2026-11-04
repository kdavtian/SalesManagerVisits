import { test, expect, loginViaUi } from "./fixtures.mjs";

// Screens kept for Back are DOM snapshots; a language change must not bring the
// old language back when returning to Home (or any kept screen).
test.describe("Language switch", () => {
  test("changing the language updates Home when returning from Settings and screens reached with Back", async ({ page, fixtures }) => {
    const user = await fixtures.createUser("sales_manager");
    await loginViaUi(page, user.email);
    await expect(page.locator("#qa-check-in")).toBeVisible();
    const before = (await page.locator("#qa-check-in").innerText()).trim();

    // the menu button opens the More sheet; Settings is its last row (1.516.0)
    await page.locator("#topbar-menu-btn").click();
    await page.locator('.more-sheet [data-hash="#/settings"]').click();
    await page.locator('[data-nav-page="p-appearance"]').click(); // the language switch lives on the Appearance page since the Settings redesign (1.405.0)
    await page.locator("#toggle-language").click();
    // Home again, which must now be in the other language.
    await page.locator('[data-hash="#/dashboard"]:visible').first().click();
    await expect(page.locator("#qa-check-in")).toBeVisible();
    await expect(page.locator("#qa-check-in")).not.toHaveText(before);

    // A screen visited before the change and reached with Back is fresh too.
    await page.goto("/#/reports");
    const heading = (await page.locator("h1").first().innerText()).trim();
    await page.locator("#topbar-menu-btn").click();
    await page.locator('.more-sheet [data-hash="#/settings"]').click();
    await page.locator('[data-nav-page="p-appearance"]').click(); // the language switch lives on the Appearance page since the Settings redesign (1.405.0)
    await page.locator("#toggle-language").click();
    await page.goBack();
    await expect(page.locator("h1").first()).not.toHaveText(heading);
  });
});
