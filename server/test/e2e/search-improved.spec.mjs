import { test, expect, loginViaUi } from "./fixtures.mjs";

// Owner, 2026-11-05: "improve search in app". An empty box is a menu (recent, quick actions, screens) and products are found too.
test("Search: the empty box offers actions and screens; typing finds a product", async ({ page, fixtures }) => {
  const admin = await fixtures.createUser("admin");
  await fixtures.createProduct({ name: "E2E Search Oil 5W-30" });
  await page.setViewportSize({ width: 390, height: 844 });
  await loginViaUi(page, admin.email);
  await page.goto("/#/dashboard");
  await page.locator("#topbar-search-btn").click();
  await expect(page.locator(".search-group-title").first()).toBeVisible({ timeout: 10000 });
  const titles = await page.locator(".search-group-title").allTextContents();
  expect(titles.length).toBeGreaterThanOrEqual(2); // actions + screens (+ recent)
  await page.waitForTimeout(500);
  await page.screenshot({ path: "/tmp/search-empty.png" });
  await page.locator("#search-sheet-input").fill("search oil");
  await expect(page.locator(".search-row-label", { hasText: "E2E Search Oil 5W-30" })).toBeVisible({ timeout: 10000 });
  await page.screenshot({ path: "/tmp/search-product.png" });
  await page.locator(".search-row-label", { hasText: "E2E Search Oil 5W-30" }).click();
  await expect(page).toHaveURL(/#\/product\/\d+/);
});
