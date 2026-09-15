import { test, expect, loginViaUi } from "./fixtures.mjs";

test.describe("Discount approval", () => {
  test("a discounted order needs a director's approval before it can proceed", async ({ browser, fixtures }) => {
    const manager = await fixtures.createUser("sales_manager");
    const director = await fixtures.createUser("sales_director");
    const customer = await fixtures.createCustomer({
      created_by: manager.id,
      erp_customer_id: `E2E-${Date.now()}`,
    });
    const product = await fixtures.createProduct({ unit_price_amd: 10000 });

    // Two independent sessions -- the rep placing the order and the
    // director reviewing it are two different logged-in identities, which
    // a single browser context (one cookie jar) can't represent.
    const repContext = await browser.newContext();
    const repPage = await repContext.newPage();
    await loginViaUi(repPage, manager.email);
    await repPage.goto(`/#/orders/new/${customer.id}`);
    // The picker navigates brand-first -- a brand chip, not the flat product
    // list, is what actually renders until one is picked (or a search is typed).
    await repPage.locator(`.chip[data-value="${product.brand}"]`).click();
    await expect(repPage.locator("#order-product-list")).toContainText(product.name, { timeout: 10000 });
    await repPage.locator(`[data-product-id="${product.id}"]`).locator('[data-action="add"]').click();
    await repPage.locator("#order-discount-input").fill("10");

    const [orderResponse] = await Promise.all([
      repPage.waitForResponse((res) => res.url().includes("/api/orders") && res.request().method() === "POST"),
      repPage.locator("#save-order-btn").click(),
    ]);
    const order = await orderResponse.json();
    fixtures.trackRow("orders", order.id);
    expect(order.approval_status).toBe("pending");
    await repContext.close();

    const directorContext = await browser.newContext();
    const directorPage = await directorContext.newPage();
    await loginViaUi(directorPage, director.email);
    await directorPage.goto("/#/orders");
    // Default filter is "submitted" (see orders.js) -- the pending-discount
    // order is exactly that, so it's already on-screen with no extra filter tap.
    await directorPage.locator(`[data-order-id="${order.id}"]`).click();
    await expect(directorPage.locator("#order-detail-actions")).toBeVisible();
    await Promise.all([
      directorPage.waitForResponse((res) => res.url().includes(`/orders/${order.id}/approve-discount`)),
      directorPage.locator('[data-action="approve-discount"]').click(),
    ]);

    // approve-discount only clears approval_status (order.status stays
    // "submitted" -- fulfillment confirmation is a separate action) -- the
    // sheet re-rendering with the discount button gone and the ordinary
    // confirm/reject-order actions in its place is what actually proves
    // the approval landed, not just that the click didn't error.
    await expect(directorPage.locator('[data-action="approve-discount"]')).toHaveCount(0);
    await expect(directorPage.locator('[data-status="confirmed"]')).toBeVisible({ timeout: 10000 });
    await directorContext.close();
  });
});
