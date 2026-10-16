import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Order sheet round (owner, 2026-10-16): no "Reorder" on an order that is not delivered, the payment terms are spelled out,
// Delete carries a bin, and an order that waits for review can change its payment type / due days and get products added.
test.describe("Order sheet: terms, edit, delete", () => {
  test("terms line, no Reorder, bin on Delete; edit payment terms + add a product", async ({ page, fixtures }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const admin = await fixtures.createUser("admin");
    const rep = await fixtures.createUser("sales_manager");
    const customer = await fixtures.createCustomer({ created_by: rep.id, erp_customer_id: `E2E-OE-${Date.now()}` });
    const product = await fixtures.createProduct({ unit_price_amd: 10000 });
    const extra = await fixtures.createProduct({ unit_price_amd: 4000, name: "Extra Oil 1L" });
    const order = await fixtures.createOrder({ customer_id: customer.id, user_id: rep.id, status: "submitted", total_amd: 20000, payment_method: "invoice", product, quantity: 2 });
    await pool.query("UPDATE orders SET payment_term_days = 45 WHERE id = $1", [order.id]);

    await loginViaUi(page, admin.email);
    await page.goto("/#/orders");
    await page.locator(".card", { hasText: order.order_code }).first().click();

    const sheet = page.locator(".order-detail-sheet");
    await expect(sheet.locator(".order-terms-line")).toContainText("45");
    await expect(sheet.locator('[data-action="reorder-order"]')).toHaveCount(0);
    await expect(sheet.locator('[data-action="delete-order"] svg')).toHaveCount(1);

    await sheet.locator('[data-action="edit-order"]').click();
    await page.locator('#edit-method [data-method="cash"]').click();
    await page.locator("#edit-due-days").fill("0");
    await page.locator("#edit-add-product-btn").click();
    await expect(page.locator("#edit-add-product-results")).toContainText("Extra Oil 1L", { timeout: 10000 });
    // the product list really has room (it used to collapse to nothing on iPhone Safari)
    const room = await page.locator("#edit-add-product-results").evaluate((el) => el.getBoundingClientRect().height);
    expect(room).toBeGreaterThan(150);
    await page.locator(`[data-add-product-id="${extra.id}"] [data-action="add-product"]`).click();
    await page.locator("#edit-add-product-btn").click(); // "Done"
    await page.locator("#edit-order-save").click();

    await expect(sheet.locator(".order-terms-line")).toContainText(/on delivery|առաքման/i, { timeout: 10000 });
    const row = (await pool.query("SELECT payment_method, payment_term_days, total_amd FROM orders WHERE id = $1", [order.id])).rows[0];
    expect(row.payment_method).toBe("cash");
    expect(row.payment_term_days).toBe(0);
    expect(Number(row.total_amd)).toBe(24000);
  });
});
