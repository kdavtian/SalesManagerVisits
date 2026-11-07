import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Owner, 2026-11-07: admin / CEO / accountant correct a delivered order from its sheet, with a reason; the correction shows on the order.
test("@smoke the accountant corrects a delivered order with a reason and the correction shows on it", async ({ page, fixtures }) => {
  const acc = await fixtures.createUser("accountant");
  const rep = await fixtures.createUser("sales_manager");
  const product = await fixtures.createProduct({ unit_price_amd: 5000 });
  const customer = await fixtures.createCustomer({ name: "Correct Me Garage", created_by: rep.id, assigned_manager_id: rep.id });
  const order = await fixtures.createOrder({ customer_id: customer.id, user_id: rep.id, status: "delivered", total_amd: 10000, product, quantity: 2, payment_method: "invoice" });
  await page.setViewportSize({ width: 390, height: 844 });
  await loginViaUi(page, acc.email);
  await page.goto(`/#/orders?open=${order.id}`);
  const sheet = page.locator(".order-detail-sheet");
  await sheet.locator('[data-action="correct-order"]').click({ timeout: 15000 });
  await sheet.locator('.order-edit-row [data-action="dec"]').first().click();
  await sheet.locator("#edit-order-save").click();
  await expect(sheet.locator("#order-detail-error")).toBeVisible(); // no reason yet
  await sheet.locator("#edit-correct-reason").fill("2 typed instead of 1");
  await page.screenshot({ path: "test-results/order-correct-sheet.png" });
  await sheet.locator("#edit-order-save").click();
  await expect(page.locator(".order-correction")).toContainText("2 typed instead of 1", { timeout: 10000 });
  await expect(page.locator(".order-correction")).toContainText("10,000");
  await page.screenshot({ path: "test-results/order-corrected.png" });
  const { rows } = await pool.query("SELECT quantity FROM order_items WHERE order_id = $1", [order.id]);
  expect(Number(rows[0].quantity)).toBe(1);
});
