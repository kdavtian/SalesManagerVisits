import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Owner, 2026-11-03 and again 2026-11-05: "from product page the user cannot go back to home. Navigation not working."
test.describe("Product page: the Home tab goes Home", () => {
  let productId;
  test.beforeAll(async () => {
    const r = await pool.query("INSERT INTO products (name, brand, unit_price_amd) VALUES ('E2E Nav Oil 4L', 'Castrol', 1000) RETURNING id");
    productId = r.rows[0].id;
  });
  test.afterAll(async () => {
    await pool.query("DELETE FROM products WHERE name = 'E2E Nav Oil 4L'");
  });

  const homeTap = (page) => page.locator('.nav-item[data-hash="#/dashboard"]').click();
  const hashIs = async (page, re) => expect.poll(() => page.evaluate(() => location.hash), { timeout: 6000 }).toMatch(re);

  test("straight from Home -> Products -> product", async ({ page, fixtures }) => {
    const admin = await fixtures.createUser("admin");
    await page.setViewportSize({ width: 390, height: 844 });
    await loginViaUi(page, admin.email);
    await page.goto("/#/pricelist");
    await page.goto(`/#/product/${productId}`);
    await expect(page.locator("#back-btn")).toBeVisible({ timeout: 10000 });
    await homeTap(page);
    await hashIs(page, /^#\/dashboard$/);
  });

  test("after hopping tabs: Home -> Orders tab -> Home -> Products -> product -> Home", async ({ page, fixtures }) => {
    const admin = await fixtures.createUser("admin");
    await page.setViewportSize({ width: 390, height: 844 });
    await loginViaUi(page, admin.email);
    await page.locator('.nav-item[data-hash="#/orders"]').click();
    await hashIs(page, /^#\/orders/);
    await homeTap(page);
    await hashIs(page, /^#\/dashboard$/);
    await page.evaluate(() => (location.hash = "#/pricelist"));
    await hashIs(page, /^#\/pricelist/);
    await page.evaluate((id) => (location.hash = `#/product/${id}`), productId);
    await expect(page.locator("#back-btn")).toBeVisible({ timeout: 10000 });
    await homeTap(page);
    await hashIs(page, /^#\/dashboard$/);
    await expect(page.locator(".nav-item-active")).toHaveAttribute("data-hash", "#/dashboard");
  });

  test("a product opened from Home, another tab, then the Home tab: Home opens, not the product", async ({ page, fixtures }) => {
    const admin = await fixtures.createUser("admin");
    await page.setViewportSize({ width: 390, height: 844 });
    await loginViaUi(page, admin.email);
    await page.evaluate((id) => (location.hash = `#/product/${id}`), productId); // e.g. from the search: no Products screen in between
    await expect(page.locator("#back-btn")).toBeVisible({ timeout: 10000 });
    await page.locator('.nav-item[data-hash="#/customers"]').click();
    await hashIs(page, /^#\/customers/);
    await homeTap(page);
    await hashIs(page, /^#\/dashboard$/);
    await expect(page.locator(".nav-item-active")).toHaveAttribute("data-hash", "#/dashboard");
  });

  test("Home -> Products -> product -> Orders tab -> Home (the last Home screen opens, as before; Home again = Home)", async ({ page, fixtures }) => {
    const admin = await fixtures.createUser("admin");
    await page.setViewportSize({ width: 390, height: 844 });
    await loginViaUi(page, admin.email);
    await page.evaluate(() => (location.hash = "#/pricelist"));
    await hashIs(page, /^#\/pricelist/);
    await page.evaluate((id) => (location.hash = `#/product/${id}`), productId);
    await expect(page.locator("#back-btn")).toBeVisible({ timeout: 10000 });
    await page.locator('.nav-item[data-hash="#/orders"]').click();
    await hashIs(page, /^#\/orders/);
    await homeTap(page);
    await hashIs(page, /^#\/(dashboard|pricelist)/);
    await page.waitForTimeout(1200); // the screen has settled
    await homeTap(page);
    await hashIs(page, /^#\/dashboard$/);
  });

  for (const role of ["sales_manager", "sales_director", "ceo", "warehouse_manager"]) {
    test(`reopened ON the product page (${role}) -> Home tab`, async ({ page, fixtures }) => {
      const user = await fixtures.createUser(role);
      await page.setViewportSize({ width: 390, height: 844 });
      await loginViaUi(page, user.email);
      await page.goto(`/#/product/${productId}`);
      await page.reload();
      await expect(page.locator("#back-btn")).toBeVisible({ timeout: 10000 });
      await homeTap(page);
      await hashIs(page, /^#\/(dashboard|wh-home|delivery-home|[a-z-]+)$/);
      expect(await page.evaluate(() => location.hash)).not.toMatch(/product/);
    });
  }
});
