import { test, expect, loginViaUi, newIdentityPage } from "./fixtures.mjs";

test.describe("Warehouse packing and delivery", () => {
  test("a confirmed order moves through staging (marked packed) to delivered", async ({ browser, fixtures }) => {
    const manager = await fixtures.createUser("sales_manager");
    const warehouseManager = await fixtures.createUser("warehouse_manager");
    const deliveryManager = await fixtures.createUser("delivery_manager");
    const customer = await fixtures.createCustomer({ created_by: manager.id });
    const product = await fixtures.createProduct({ unit_price_amd: 8000 });
    const order = await fixtures.createOrder({
      customer_id: customer.id,
      user_id: manager.id,
      status: "confirmed",
      total_amd: 8000,
      product,
    });

    // Two independent sessions -- one cookie jar/page can't hold both the
    // warehouse manager and delivery manager logged in at once, and a
    // second loginViaUi() on the same already-authenticated page would
    // just land back on that user's own dashboard instead of a login form.
    // --- Warehouse: pack the order ---
    const { context: warehouseContext, page: warehousePage } = await newIdentityPage(browser);
    await loginViaUi(warehousePage, warehouseManager.email);
    await warehousePage.goto("/#/warehouse");
    await warehousePage.getByRole("button", { name: /staging/i }).click();
    const stagingRow = warehousePage.locator(`[data-mark-packed="${order.id}"]`);
    await expect(stagingRow).toBeVisible({ timeout: 10000 });
    await Promise.all([
      warehousePage.waitForResponse((res) => res.url().includes(`/warehouse/orders/${order.id}/packed`)),
      stagingRow.click(),
    ]);
    await expect(warehousePage.locator(`[data-mark-packed="${order.id}"]`)).toHaveCount(0, { timeout: 10000 });
    await warehouseContext.close();

    // --- Delivery: mark delivered without a planned route ---
    const { context: deliveryContext, page: deliveryPage } = await newIdentityPage(browser);
    deliveryPage.on("dialog", (d) => d.accept());
    await loginViaUi(deliveryPage, deliveryManager.email);
    await deliveryPage.goto("/#/orders");
    // The order is now packed_stock_out, not the default "submitted" filter.
    await deliveryPage.locator('[data-status=""]').click();
    await deliveryPage.locator(`[data-order-id="${order.id}"]`).click();
    await expect(deliveryPage.locator("#order-detail-actions")).toBeVisible();
    const [response] = await Promise.all([
      deliveryPage.waitForResponse((res) => res.url().includes(`/orders/${order.id}/mark-delivered`)),
      deliveryPage.locator('[data-action="mark-delivered"]').click(),
    ]);
    expect(response.ok()).toBeTruthy();
    await deliveryContext.close();
  });
});
