import { test, expect, loginViaUi } from "./fixtures.mjs";

// Owner, 2026-11-03: "From product page the user cannot go back to home." The Home tap on a product page used to land on the Products list
// (the Home screen opened last); it must land on Home. Back still steps back to Products, then Home.
test("Product page: the Home tab and Back both lead home", async ({ page, fixtures }) => {
  const rep = await fixtures.createUser("sales_manager");
  await fixtures.createProduct({ name: "E2E Home Nav Oil 5W-30" });
  await page.setViewportSize({ width: 390, height: 844 });
  await loginViaUi(page, rep.email);
  await page.goto("/#/pricelist");
  await page.locator("[data-open-id]").first().click();
  await expect(page).toHaveURL(/#\/product\/\d+/);
  await page.locator("[data-hash='#/dashboard']:visible").first().click();
  await expect(page).toHaveURL(/#\/dashboard/);
  // Back route: Products -> product -> Back -> Back
  await page.goto("/#/pricelist");
  await page.locator("[data-open-id]").first().click();
  await expect(page).toHaveURL(/#\/product\/\d+/);
  await page.locator("#back-btn").first().click();
  await expect(page).toHaveURL(/#\/pricelist/);
  await page.locator("#back-btn").first().click();
  await expect(page).toHaveURL(/#\/dashboard/);
});
