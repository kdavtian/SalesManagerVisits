import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Owner, 2026-10-16: "the badge is not updating, the orders are not updating properly". The open Orders screen refreshes
// itself when something changed elsewhere (and the chips' counts and the nav badge with it), and a Back-restored copy
// refreshes too.
test.describe("Orders stay current", () => {
  test("an order created by someone else shows up (list, status count, nav badge) without leaving the screen", async ({ page, fixtures }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const director = await fixtures.createUser("sales_director");
    const rep = await fixtures.createUser("sales_manager");
    const customer = await fixtures.createCustomer({ created_by: rep.id, name: "Fresh Orders Garage", erp_customer_id: `E2E-FR-${Date.now()}` });
    const product = await fixtures.createProduct({ unit_price_amd: 5000 });

    await loginViaUi(page, director.email);
    await page.goto("/#/orders");
    await expect(page.locator("#orders-list")).toBeVisible();
    await expect(page.locator("#orders-list")).not.toContainText("Fresh Orders Garage");
    const countBefore = Number((await page.locator('#order-status-filters [data-status="submitted"] .order-status-count-badge').textContent({ timeout: 10000 })) ?? 0);
    const navBefore = await page.locator("#orders-nav-badge").textContent().catch(() => "0");

    // someone else places an order
    await fixtures.createOrder({ customer_id: customer.id, user_id: rep.id, status: "submitted", total_amd: 5000, product, quantity: 1 });

    // another device's change reaches this screen through the same event the app's own actions fire
    await page.evaluate(() => window.dispatchEvent(new Event("orders-changed")));
    await expect(page.locator("#orders-list")).toContainText("Fresh Orders Garage", { timeout: 10000 });
    await expect(page.locator('#order-status-filters [data-status="submitted"] .order-status-count-badge')).toHaveText(String(countBefore + 1), { timeout: 10000 });
    await expect(page.locator("#orders-nav-badge")).not.toHaveText(navBefore ?? "", { timeout: 10000 });
  });

  test("switching tabs quickly never leaves the previous tab's rows on screen", async ({ page, fixtures }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const director = await fixtures.createUser("sales_director");
    const rep = await fixtures.createUser("sales_manager");
    const customer = await fixtures.createCustomer({ created_by: rep.id, name: "Race Garage", erp_customer_id: `E2E-RC-${Date.now()}` });
    const product = await fixtures.createProduct({ unit_price_amd: 5000 });
    await fixtures.createOrder({ customer_id: customer.id, user_id: rep.id, status: "submitted", total_amd: 5000, product, quantity: 1 });
    await fixtures.createOrder({ customer_id: customer.id, user_id: rep.id, status: "delivered", total_amd: 7000, product, quantity: 1 });

    await loginViaUi(page, director.email);
    // the Submitted answer is slow, the Delivered one fast: the slow one must not paint over the tab the user is on
    await page.route("**/api/orders?*status=submitted*", async (route) => {
      await new Promise((r) => setTimeout(r, 1500));
      await route.continue();
    });
    await page.goto("/#/orders");
    await page.locator('#order-status-filters [data-status="delivered"]').click();
    await expect(page.locator("#orders-list")).toContainText("Race Garage", { timeout: 10000 });
    await page.waitForTimeout(2200); // the slow Submitted answer has arrived by now
    const badges = await page.locator("#orders-list .list-row-bottom .badge").allInnerTexts();
    expect(badges.join(" ").toLowerCase()).not.toContain("submitted");
    void pool;
  });
});
